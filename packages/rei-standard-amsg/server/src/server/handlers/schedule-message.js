/**
 * Handler: schedule-message
 *
 * @param {Object} ctx - Server context.
 * @returns {{ POST: function }}
 */

import { randomUUID } from '../lib/webcrypto-utils.js';
import { deriveUserEncryptionKey, decryptPayload, encryptForStorage } from '../lib/encryption.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { getHeader, isPlainObject, parseEncryptedBody, requireUserId } from '../lib/request.js';
import { validateScheduleMessagePayload, validateTaskPayloadSize } from '../lib/validation.js';
import { supportsPushSubscriptionStore } from '../lib/push-subscription-store.js';
import { supportsLlmCredentialsStore, findMissingCredIds } from '../lib/llm-credentials-store.js';
import { processMessagesByUuid } from '../lib/message-processor.js';

export function createScheduleMessageHandler(ctx) {
  async function POST(headers, body) {
    const tenantResult = await ctx.tenantManager.resolveTenant(headers);
    if (!tenantResult.ok) {
      return tenantResult.error;
    }

    const tenantCtx = tenantResult.context;
    const db = tenantCtx.db;
    const masterKey = tenantCtx.masterKey;
    const isEncrypted = getHeader(headers, 'x-payload-encrypted') === 'true';
    const encryptionVersion = getHeader(headers, 'x-encryption-version');

    if (!isEncrypted) {
      return { status: 400, body: { success: false, error: { code: 'ENCRYPTION_REQUIRED', message: '请求体必须加密' } } };
    }
    const gate = requireUserId(headers);
    if (gate.error) return gate.error;
    const { userId } = gate;
    if (encryptionVersion !== '1') {
      return { status: 400, body: { success: false, error: { code: 'UNSUPPORTED_ENCRYPTION_VERSION', message: '加密版本不支持' } } };
    }

    // Decrypt request body
    const parsedBody = parseEncryptedBody(body);
    if (!parsedBody.ok) {
      return { status: 400, body: { success: false, error: parsedBody.error } };
    }

    const encryptedBody = parsedBody.data;
    const userKey = await deriveUserEncryptionKey(userId, masterKey);

    let payload;
    try {
      payload = await decryptPayload(encryptedBody, userKey);
    } catch (error) {
      if (error instanceof SyntaxError) {
        return { status: 400, body: { success: false, error: { code: 'INVALID_PAYLOAD_FORMAT', message: '解密后的数据不是有效 JSON' } } };
      }

      return { status: 400, body: { success: false, error: { code: 'DECRYPTION_FAILED', message: '请求体解密失败' } } };
    }

    if (!isPlainObject(payload)) {
      return { status: 400, body: { success: false, error: { code: 'INVALID_PAYLOAD_FORMAT', message: '解密后的数据必须是 JSON 对象' } } };
    }

    // Validate
    const validationResult = validateScheduleMessagePayload(payload);
    if (!validationResult.valid) {
      return { status: 400, body: { success: false, error: { code: validationResult.errorCode, message: validationResult.errorMessage, details: validationResult.details } } };
    }

    // 到点要往哪推：用户级订阅必须已经登记过。没登记就建任务的话，这条任务
    // 到点只会失败一次又一次——早点说清楚比让它安静地烂在库里强。
    if (!supportsPushSubscriptionStore(db)) {
      return { status: 501, body: { success: false, error: { code: 'PUSH_SUBSCRIPTION_NOT_SUPPORTED', message: '当前数据库适配器不支持用户级推送订阅存储' } } };
    }
    // 只做存在性检查（不解密——解出来的订阅这里也用不上）。查询本身失败是
    // 基础设施问题，按可重试的 503 报出去，别伪装成「没登记」把客户端引去
    // 走一遍多余的重订阅流程。
    let subscriptionRow;
    try {
      subscriptionRow = await db.getPushSubscription(userId);
    } catch (_error) {
      return {
        status: 503,
        body: {
          success: false,
          error: {
            code: 'PUSH_SUBSCRIPTION_LOOKUP_FAILED',
            message: '推送订阅读取失败，请稍后重试'
          }
        }
      };
    }
    if (!subscriptionRow || typeof subscriptionRow.subscription !== 'string' || !subscriptionRow.subscription) {
      return {
        status: 409,
        body: {
          success: false,
          error: {
            code: 'PUSH_SUBSCRIPTION_MISSING',
            message: '该用户还没有登记推送订阅，请先调用 PUT /push-subscription'
          }
        }
      };
    }

    // credRefs 引用的凭据必须已经登记过（PUT /llm-credentials）。没登记就建
    // 任务的话，这条任务到点只会失败一次又一次——早点点名比让它安静地烂在库
    // 里强（先例：上面那段推送订阅的存在性检查）。检查过后被 DELETE 掉属
    // TOCTOU 竞态，由 fire 时的 CREDENTIAL_MISSING 兜底。
    if (payload.credRefs) {
      if (!supportsLlmCredentialsStore(db)) {
        return { status: 501, body: { success: false, error: { code: 'LLM_CREDENTIALS_NOT_SUPPORTED', message: '当前数据库适配器不支持用户级 LLM 凭据存储' } } };
      }
      let missingCredIds;
      try {
        missingCredIds = await findMissingCredIds({ db, userId, credRefs: payload.credRefs });
      } catch (_error) {
        // 查询失败是基础设施问题，按可重试的 503 报，别伪装成「没登记」。
        return { status: 503, body: { success: false, error: { code: 'LLM_CREDENTIALS_LOOKUP_FAILED', message: '凭据读取失败，请稍后重试' } } };
      }
      if (missingCredIds.length > 0) {
        return {
          status: 409,
          body: {
            success: false,
            error: {
              code: 'CREDENTIAL_NOT_FOUND',
              message: `credRefs 引用的凭据不存在：${missingCredIds.join(', ')}（先 PUT /llm-credentials 登记）`,
              details: { missingCredIds }
            }
          }
        };
      }
    }

    const taskUuid = payload.uuid || randomUUID();

    // immediate：不排未来，next_send_at = 现在，下一跳 cron（最多一分钟后）
    // 直接捞走。客户端不用再为「严格在未来」预留提前量。
    const effectiveSendTime = payload.immediate === true
      ? new Date().toISOString()
      : payload.firstSendTime;

    const fullTaskData = {
      contactName: payload.contactName,
      avatarUrl: payload.avatarUrl || null,
      messageType: payload.messageType,
      messageSubtype: payload.messageSubtype || 'chat',
      userMessage: payload.userMessage || null,
      firstSendTime: effectiveSendTime,
      recurrenceType: payload.recurrenceType || 'none',
      // daily / weekly 按这个时区的墙钟推进（同一钟点，日期 +1 天 / +7 天）。
      // 不传 → null → 按 UTC 推进。
      tzId: payload.tzId || null,
      apiUrl: payload.apiUrl || null,
      apiKey: payload.apiKey || null,
      primaryModel: payload.primaryModel || null,
      // 凭据引用（{ <purpose>: <cred_id> }）。带它的任务到点按引用现读
      // llm_credentials，凭据本体不冻结在行里。
      credRefs: payload.credRefs || null,
      // Prompt is one-of: legacy completePrompt (string) OR messages (OpenAI-
      // style array). Validation has already enforced exactly-one-of, so
      // exactly one of these will be non-null when an AI config is provided.
      completePrompt: payload.completePrompt || null,
      messages: Array.isArray(payload.messages) ? payload.messages : null,
      maxTokens: payload.maxTokens ?? null,
      temperature: payload.temperature ?? null,
      // 0.6.0+: optional caller-provided regex (string or string[]) used by
      // the message processor to chunk LLM output into individual pushes.
      // null → processor falls back to the default /([。！？!?]+)/ regex.
      splitPattern: payload.splitPattern ?? null,
      // 透传给 LLM 中转的非标准参数（thinking 之类），buildLlmRequestBody 会
      // 把它展开进请求体（核心字段优先）。
      llmExtraBody: payload.llmExtraBody ?? null,
      metadata: payload.metadata || {}
    };

    // 正文落库前先量一次大小。加密后走 hex，字节数正好翻倍，D1 的单行上限就是
    // 这么被顶穿的——在这里 400 并报出实际字节数，好过到 D1 那儿换回一句
    // `string or blob too big` 的 500。量的是真正要加密的那个字符串，不是请求
    // 里的 payload：两者不是同一份（这里补了默认值、丢了不认识的字段）。
    const serializedTaskData = JSON.stringify(fullTaskData);
    const sizeError = validateTaskPayloadSize(serializedTaskData);
    if (sizeError) {
      return { status: 400, body: { success: false, error: sizeError } };
    }

    const encryptedPayload = await encryptForStorage(serializedTaskData, userKey);

    /**
     * In-server instant path. Delivers an instant message through this
     * server's own task queue (create task → process by UUID → delete task).
     * The task is written to the database before processing, so delivery is
     * not tied to the request connection: even if the client disconnects, the
     * row stays and the generation keeps running (and can be retried) for as
     * long as it needs. Use this when you have a database and want long or
     * guaranteed-complete generations with no dropped messages.
     *
     * The stateless alternative is `@rei-standard/amsg-instant`: it streams
     * over SSE with a Web Push backup and needs no database, which makes it a
     * good fit for edge runtimes (e.g. Cloudflare Workers). Its work rides the
     * response connection, so after the client disconnects it only has the
     * platform's brief grace window to finish (≈20-30s observed on Deno
     * Deploy) — ideal for short instant messages that complete quickly.
     */
    // Instant type: check VAPID before creating the task to avoid orphaned rows
    if (payload.messageType === 'instant') {
      if (!ctx.vapid.email || !ctx.vapid.publicKey || !ctx.vapid.privateKey) {
        return {
          status: 500,
          body: {
            success: false,
            error: {
              code: 'VAPID_CONFIG_ERROR',
              message: 'VAPID 配置缺失，无法发送即时消息',
              details: {
                missingKeys: [
                  !ctx.vapid.email && 'VAPID_EMAIL',
                  !ctx.vapid.publicKey && 'NEXT_PUBLIC_VAPID_PUBLIC_KEY',
                  !ctx.vapid.privateKey && 'VAPID_PRIVATE_KEY'
                ].filter(Boolean)
              }
            }
          }
        };
      }
    }

    // Insert into database
    const createParams = {
      user_id: userId,
      uuid: taskUuid,
      encrypted_payload: encryptedPayload,
      next_send_at: effectiveSendTime,
      message_type: payload.messageType
    };
    // supersede：建这条的同时取消旧的那条。适配器支持原子形态（删旧 + 建新落
    // 在同一事务，见 D1 的 createTaskSuperseding）就走它；不支持的退回「先删
    // 再建」两步——语义相同，只是失去原子性和那次省下的往返。
    const supersedesUuid = payload.supersedesUuid || null;
    let superseded = false;
    let dbResult;
    try {
      if (supersedesUuid && typeof db.createTaskSuperseding === 'function') {
        dbResult = await db.createTaskSuperseding(createParams, supersedesUuid);
        superseded = !!(dbResult && dbResult.superseded);
      } else {
        if (supersedesUuid) {
          superseded = await db.deleteTaskByUuid(supersedesUuid, userId);
        }
        dbResult = await db.createTask(createParams);
      }
    } catch (error) {
      if (isUniqueViolation(error)) {
        return {
          status: 409,
          body: {
            success: false,
            error: {
              code: 'TASK_UUID_CONFLICT',
              message: '任务 UUID 已存在，请使用新的 uuid 重新提交'
            }
          }
        };
      }
      throw error;
    }

    if (!dbResult) {
      return { status: 500, body: { success: false, error: { code: 'TASK_CREATE_FAILED', message: '创建任务失败' } } };
    }

    // In-server instant path — rationale documented above the VAPID pre-check.
    // Instant type: send immediately
    if (payload.messageType === 'instant') {
      try {
        const sendResult = await processMessagesByUuid(taskUuid, {
          ...ctx,
          db,
          masterKey
        }, 2, userId, masterKey);

        if (!sendResult.success) {
          return { status: 500, body: { success: false, error: { code: 'MESSAGE_SEND_FAILED', message: '消息发送失败', details: sendResult.error } } };
        }

        return {
          status: 200,
          body: {
            success: true,
            data: {
              uuid: taskUuid,
              contactName: payload.contactName,
              messagesSent: sendResult.messagesSent,
              sentAt: new Date().toISOString(),
              status: 'sent',
              retriesUsed: sendResult.retriesUsed || 0,
              ...(supersedesUuid ? { superseded } : {})
            }
          }
        };
      } catch (error) {
        return { status: 500, body: { success: false, error: { code: 'MESSAGE_SEND_FAILED', message: '消息发送失败', details: { error: error.message } } } };
      }
    }

    // Non-instant: return scheduled response
    return {
      status: 201,
      body: {
        success: true,
        data: {
          id: dbResult.id,
          uuid: dbResult.uuid,
          contactName: payload.contactName,
          nextSendAt: dbResult.next_send_at,
          status: dbResult.status,
          createdAt: dbResult.created_at,
          // supersede 的结果：true = 旧行确实被取消了；false = 旧行本就不存在
          // （已发出 / 已删除），新任务照常建立。
          ...(supersedesUuid ? { superseded } : {})
        }
      }
    };
  }

  return { POST };
}
