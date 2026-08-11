/**
 * Handler: update-message
 *
 * @param {Object} ctx - Server context.
 * @returns {{ PUT: function }}
 */

import { deriveUserEncryptionKey, decryptPayload, encryptForStorage, decryptFromStorage } from '../lib/encryption.js';
import { getHeader, isPlainObject, parseEncryptedBody, requireUserId } from '../lib/request.js';
import { isValidISO8601, isValidTimeZoneId, validateLlmMessagesArray, validateSplitPattern, validateAvatarUrl, validateTaskPayloadSize, taskPayloadByteLength } from '../lib/validation.js';
import { supportsLlmCredentialsStore, findMissingCredIds, validateCredRefs } from '../lib/llm-credentials-store.js';

export function createUpdateMessageHandler(ctx) {
  async function PUT(url, headers, body) {
    const tenantResult = await ctx.tenantManager.resolveTenant(headers, { url });
    if (!tenantResult.ok) {
      return tenantResult.error;
    }

    const tenantCtx = tenantResult.context;
    const db = tenantCtx.db;
    const masterKey = tenantCtx.masterKey;
    const u = new URL(url, 'https://dummy');
    const taskUuid = u.searchParams.get('id');

    if (!taskUuid) {
      return { status: 400, body: { success: false, error: { code: 'TASK_ID_REQUIRED', message: '缺少任务ID' } } };
    }

    const gate = requireUserId(headers);
    if (gate.error) return gate.error;
    const { userId } = gate;

    const isEncrypted = getHeader(headers, 'x-payload-encrypted') === 'true';
    const encryptionVersion = getHeader(headers, 'x-encryption-version');

    if (!isEncrypted) {
      return { status: 400, body: { success: false, error: { code: 'ENCRYPTION_REQUIRED', message: '请求体必须加密' } } };
    }

    if (encryptionVersion !== '1') {
      return { status: 400, body: { success: false, error: { code: 'UNSUPPORTED_ENCRYPTION_VERSION', message: '加密版本不支持' } } };
    }

    const parsedBody = parseEncryptedBody(body);
    if (!parsedBody.ok) {
      return { status: 400, body: { success: false, error: parsedBody.error } };
    }

    const encryptedBody = parsedBody.data;
    const userKey = await deriveUserEncryptionKey(userId, masterKey);
    let updates;

    try {
      updates = await decryptPayload(encryptedBody, userKey);
    } catch (_error) {
      return { status: 400, body: { success: false, error: { code: 'DECRYPTION_FAILED', message: '请求体解密失败' } } };
    }

    if (!isPlainObject(updates)) {
      return { status: 400, body: { success: false, error: { code: 'INVALID_UPDATE_DATA', message: '更新数据格式错误' } } };
    }

    if (updates.nextSendAt && !isValidISO8601(updates.nextSendAt)) {
      return { status: 400, body: { success: false, error: { code: 'INVALID_UPDATE_DATA', message: '更新数据格式错误', details: { invalidFields: ['nextSendAt'] } } } };
    }

    // contactName：用户给角色改了名之后，已经排好的任务推送出来的通知标题
    // （「来自 <contactName>」）还得跟着改。校验口径对齐 schedule-message 的
    // 必填项——非空字符串。空串 / null 直接打回，不做「传了就忽略」：那会写出
    // 一条标题是「来自 undefined」的任务，而调用方以为改成功了。
    if (
      Object.prototype.hasOwnProperty.call(updates, 'contactName') &&
      (typeof updates.contactName !== 'string' || !updates.contactName.trim())
    ) {
      return { status: 400, body: { success: false, error: { code: 'INVALID_UPDATE_DATA', message: 'contactName 必须是非空字符串', details: { invalidFields: ['contactName'] } } } };
    }

    // userMessage 给了就必须是字符串（口径同 POST /schedule-message）：正文
    // 到点要过正则切分，传个数字进来这一步收得下、投递时才炸。
    if (
      Object.prototype.hasOwnProperty.call(updates, 'userMessage') &&
      updates.userMessage !== null &&
      typeof updates.userMessage !== 'string'
    ) {
      return { status: 400, body: { success: false, error: { code: 'INVALID_UPDATE_DATA', message: 'userMessage 必须是字符串', details: { invalidFields: ['userMessage'] } } } };
    }

    // messageSubtype：自由字符串标签，只查类型不查取值（分类法是调用方的事）。
    // 显式传 null = 改回默认，所以走 hasOwnProperty。
    if (
      Object.prototype.hasOwnProperty.call(updates, 'messageSubtype') &&
      updates.messageSubtype !== null &&
      typeof updates.messageSubtype !== 'string'
    ) {
      return { status: 400, body: { success: false, error: { code: 'INVALID_UPDATE_DATA', message: 'messageSubtype 必须是字符串', details: { invalidFields: ['messageSubtype'] } } } };
    }

    // llmExtraBody：透传给 LLM 中转的非标准参数，只查形状（普通对象）。
    // 显式传 null = 不再透传。
    if (
      Object.prototype.hasOwnProperty.call(updates, 'llmExtraBody') &&
      updates.llmExtraBody !== null &&
      !isPlainObject(updates.llmExtraBody)
    ) {
      return { status: 400, body: { success: false, error: { code: 'INVALID_UPDATE_DATA', message: 'llmExtraBody 必须是普通对象', details: { invalidFields: ['llmExtraBody'] } } } };
    }

    if (updates.recurrenceType && !['none', 'daily', 'weekly'].includes(updates.recurrenceType)) {
      return { status: 400, body: { success: false, error: { code: 'INVALID_UPDATE_DATA', message: '更新数据格式错误', details: { invalidFields: ['recurrenceType'] } } } };
    }

    // tzId：显式传 null 表示改回「按 UTC 推进」，所以走 hasOwnProperty 而不是
    // truthy 判断——用户从「按东京墙钟」改回不设时区，这个改动不能被吞掉。
    if (
      Object.prototype.hasOwnProperty.call(updates, 'tzId') &&
      updates.tzId !== null &&
      !isValidTimeZoneId(updates.tzId)
    ) {
      return { status: 400, body: { success: false, error: { code: 'INVALID_UPDATE_DATA', message: 'tzId 必须是可用的 IANA 时区 id（如 Asia/Tokyo），或 null 表示按 UTC 推进', details: { invalidFields: ['tzId'] } } } };
    }

    if (
      Object.prototype.hasOwnProperty.call(updates, 'maxTokens') &&
      updates.maxTokens !== null &&
      (!Number.isInteger(updates.maxTokens) || updates.maxTokens <= 0)
    ) {
      return { status: 400, body: { success: false, error: { code: 'INVALID_UPDATE_DATA', message: '更新数据格式错误', details: { invalidFields: ['maxTokens'] } } } };
    }

    // Reject updates that try to set both completePrompt and messages at
    // once. We don't enforce one-of-required here (callers may patch other
    // fields), but the two prompt sources are mutually exclusive and must
    // stay that way in storage too.
    if (
      updates.completePrompt &&
      updates.messages !== undefined && updates.messages !== null
    ) {
      return { status: 400, body: { success: false, error: { code: 'INVALID_UPDATE_DATA', message: 'completePrompt 与 messages 不能同时更新（二选一）', details: { invalidFields: ['completePrompt', 'messages'] } } } };
    }
    if (updates.messages !== undefined && updates.messages !== null) {
      const msgErr = validateLlmMessagesArray(updates.messages);
      if (msgErr) {
        return { status: 400, body: { success: false, error: { code: 'INVALID_UPDATE_DATA', message: msgErr, details: { invalidFields: ['messages'] } } } };
      }
    }
    if (
      Object.prototype.hasOwnProperty.call(updates, 'temperature') &&
      updates.temperature !== null &&
      (typeof updates.temperature !== 'number' || !Number.isFinite(updates.temperature))
    ) {
      return { status: 400, body: { success: false, error: { code: 'INVALID_UPDATE_DATA', message: '更新数据格式错误', details: { invalidFields: ['temperature'] } } } };
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'splitPattern')) {
      const splitErr = validateSplitPattern(updates.splitPattern);
      if (splitErr) {
        return { status: 400, body: { success: false, error: { code: 'INVALID_UPDATE_DATA', message: splitErr, details: { invalidFields: ['splitPattern'] } } } };
      }
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'avatarUrl')) {
      const avatarErr = validateAvatarUrl(updates.avatarUrl);
      if (avatarErr) {
        // Soft-strip: drop the bad avatarUrl from the patch (keeps the
        // existing stored avatar untouched) and continue applying the rest
        // of the update. See standards §6.2.
        console.warn('[amsg-server] update-message avatarUrl 不合法，已忽略：', avatarErr);
        delete updates.avatarUrl;
      }
    }

    // 凭据刷新：消费方换了聊天 API 配置之后，用 apiUrl / apiKey /
    // primaryModel 刷新任务里冻结的旧值。校验口径对齐 schedule-message：
    // 只要求 truthy、不做格式校验。三个字段都走 truthy spread——传 null 不
    // 清空、只是忽略（清掉任何一个，任务到点就发不出去，「清空」没有合法用途）。
    //
    // 推送订阅不在这里改：它是用户级的一份，`PUT /push-subscription` 覆盖那
    // 一份就够了，所有任务（包括角色在 fire 里给自己排的、客户端根本不知道
    // 存在的那些）下次触发时读到的都是新订阅。
    if (updates.pushSubscription !== undefined) {
      return { status: 400, body: { success: false, error: { code: 'PUSH_SUBSCRIPTION_NOT_ACCEPTED', message: 'pushSubscription 不再随任务更新，改用 PUT /push-subscription 覆盖用户级订阅', details: { invalidFields: ['pushSubscription'] } } } };
    }

    // credRefs：整体替换（语义同 metadata，不做深合并），同样做存在性检查。
    // 与内联三件套在同一个请求里混着传打回——两份 chat 凭据来源到底改哪个说
    // 不清。传了 credRefs 不动存量内联三件套：那份留作 fire 时表行缺失的兜底。
    if (updates.credRefs !== undefined && updates.credRefs !== null) {
      const credRefsErr = validateCredRefs(updates.credRefs);
      if (credRefsErr) {
        return { status: 400, body: { success: false, error: { code: 'INVALID_UPDATE_DATA', message: credRefsErr, details: { invalidFields: ['credRefs'] } } } };
      }
      if (updates.apiUrl || updates.apiKey || updates.primaryModel) {
        return { status: 400, body: { success: false, error: { code: 'INVALID_UPDATE_DATA', message: 'credRefs 与内联 apiUrl / apiKey / primaryModel 不能同时更新（二选一）', details: { invalidFields: ['credRefs', 'apiUrl', 'apiKey', 'primaryModel'] } } } };
      }
      if (!supportsLlmCredentialsStore(db)) {
        return { status: 501, body: { success: false, error: { code: 'LLM_CREDENTIALS_NOT_SUPPORTED', message: '当前数据库适配器不支持用户级 LLM 凭据存储' } } };
      }
      let missingCredIds;
      try {
        missingCredIds = await findMissingCredIds({ db, userId, credRefs: updates.credRefs });
      } catch (_error) {
        return { status: 503, body: { success: false, error: { code: 'LLM_CREDENTIALS_LOOKUP_FAILED', message: '凭据读取失败，请稍后重试' } } };
      }
      if (missingCredIds.length > 0) {
        return { status: 409, body: { success: false, error: { code: 'CREDENTIAL_NOT_FOUND', message: `credRefs 引用的凭据不存在：${missingCredIds.join(', ')}（先 PUT /llm-credentials 登记）`, details: { missingCredIds } } } };
      }
    }

    // Fetch existing task
    const existingTask = await db.getTaskByUuid(taskUuid, userId);

    if (!existingTask) {
      const taskStatus = await db.getTaskStatus(taskUuid, userId);
      if (!taskStatus) {
        return { status: 404, body: { success: false, error: { code: 'TASK_NOT_FOUND', message: '指定的任务不存在或已被删除' } } };
      }
      return { status: 409, body: { success: false, error: { code: 'TASK_ALREADY_COMPLETED', message: '任务已完成或已失败，无法更新' } } };
    }

    const existingData = JSON.parse(await decryptFromStorage(existingTask.encrypted_payload, userKey));

    // When the caller switches prompt source (completePrompt ↔ messages),
    // null out the other so storage stays one-of (matches schedule-message
    // shape and prevents buildAiRequestBody from accidentally seeing both).
    const promptUpdates = {};
    if (updates.completePrompt) {
      promptUpdates.completePrompt = updates.completePrompt;
      promptUpdates.messages = null;
    } else if (updates.messages !== undefined && updates.messages !== null) {
      promptUpdates.messages = updates.messages;
      promptUpdates.completePrompt = null;
    }

    // 这次真正落进 payload 的那些改动。跟 existingData 分开建，是为了下面回
    // 报 updatedFields 时能说清「哪些字段确实改了」。
    const appliedPatch = {
      ...promptUpdates,
      ...(Object.prototype.hasOwnProperty.call(updates, 'contactName') && { contactName: updates.contactName }),
      ...(updates.userMessage && { userMessage: updates.userMessage }),
      ...(updates.recurrenceType && { recurrenceType: updates.recurrenceType }),
      ...(Object.prototype.hasOwnProperty.call(updates, 'tzId') && { tzId: updates.tzId ?? null }),
      // avatarUrl 走 truthy spread：显式传 null 只是「不改」，不是「清空」。
      // 与 tzId / splitPattern 那几个 hasOwnProperty 的字段不一样，是因为
      // §6.2 的软清空策略要求非法头像从 patch 里被摘掉、旧头像原样保留，而
      // 「摘掉」和「传了个 null」在这一层看起来是同一件事。真要支持清空，得
      // 先把这两件事区分开，不能只把判断换成 hasOwnProperty。
      ...(updates.avatarUrl && { avatarUrl: updates.avatarUrl }),
      ...(updates.metadata && { metadata: updates.metadata }),
      ...(updates.apiUrl && { apiUrl: updates.apiUrl }),
      ...(updates.apiKey && { apiKey: updates.apiKey }),
      ...(updates.primaryModel && { primaryModel: updates.primaryModel }),
      // credRefs 整体替换；truthy spread——显式传 null 只是「不改」，摘掉引用
      // 退回内联没有已知用途，真要清就 DELETE 凭据行让 fire 走兜底。
      ...(updates.credRefs && { credRefs: updates.credRefs }),
      ...(Object.prototype.hasOwnProperty.call(updates, 'maxTokens') && { maxTokens: updates.maxTokens ?? null }),
      ...(Object.prototype.hasOwnProperty.call(updates, 'temperature') && { temperature: updates.temperature ?? null }),
      // splitPattern: hasOwnProperty so that explicit `null` (= revert to
      // default) doesn't get swallowed by truthy-spread the way the optional
      // string fields above are.
      ...(Object.prototype.hasOwnProperty.call(updates, 'splitPattern') && { splitPattern: updates.splitPattern ?? null }),
      // messageSubtype / llmExtraBody：显式传 null 表示改回默认（分别是投递时
      // 的 'chat' 和「不透传额外参数」），所以跟 tzId 那几个一样走
      // hasOwnProperty，不被 truthy spread 吞掉。
      ...(Object.prototype.hasOwnProperty.call(updates, 'messageSubtype') && { messageSubtype: updates.messageSubtype ?? null }),
      ...(Object.prototype.hasOwnProperty.call(updates, 'llmExtraBody') && { llmExtraBody: updates.llmExtraBody ?? null })
    };

    const updatedData = { ...existingData, ...appliedPatch };

    // 大小闸门量的是合并之后的正文，不是这次的 patch：patch 本身可能很小，但
    // 叠到存量正文上就顶穿了 D1 的单行上限（口径与 schedule-message 同一份，
    // 见 lib/validation.js）。
    //
    // 只拦「这次改动把它变大了」：上限是后加的，比它更早建出来的大任务本来跑得
    // 好好的，一律按合并后的大小拒的话，那条任务连把 nextSendAt 往后挪一小时都
    // 做不到，只能删掉重建。改小、或者大小没变的改动照常放行。
    const serializedUpdatedData = JSON.stringify(updatedData);
    const sizeError = validateTaskPayloadSize(serializedUpdatedData);
    if (sizeError
        && taskPayloadByteLength(serializedUpdatedData) > taskPayloadByteLength(JSON.stringify(existingData))) {
      return { status: 400, body: { success: false, error: sizeError } };
    }

    const encryptedPayload = await encryptForStorage(serializedUpdatedData, userKey);
    // 更新即视为「重新出发」：把重试计数清零、把退避放掉。不清的话，刚修好
    // apiKey / 改好排期的任务还背着之前攒下的 retry_count，下一次哪怕是瞬时
    // 故障也可能直接触发终审处置。retry_after 只在支持占位的适配器上写
    //（与 run-tick 的 updateAndRelease 同一判据——没实现 claimTask 的适配器
    // 未必有这一列）。
    const extraFields = {
      retry_count: 0,
      ...(typeof db.claimTask === 'function' ? { retry_after: null } : {}),
      ...(updates.nextSendAt ? { next_send_at: updates.nextSendAt } : {})
    };

    const result = await db.updateTaskByUuid(taskUuid, userId, encryptedPayload, extraFields);

    if (!result) {
      return { status: 409, body: { success: false, error: { code: 'UPDATE_CONFLICT', message: '任务更新失败，任务可能已被修改或删除' } } };
    }

    // 只报真正生效的字段。请求里带了但没被应用的键（这个接口不接受的、拼错
    // 的、或者传了 null 走 truthy spread 被忽略的），照单报成「改了」会让调用
    // 方以为生效了，其实库里一个字节没动。
    const appliedFieldNames = new Set(Object.keys(appliedPatch));
    if (updates.nextSendAt) appliedFieldNames.add('nextSendAt');
    const updatedFields = Object.keys(updates).filter(name => appliedFieldNames.has(name));

    return {
      status: 200,
      body: {
        success: true,
        data: {
          uuid: taskUuid,
          updatedFields,
          updatedAt: result.updated_at
        }
      }
    };
  }

  return { PUT };
}
