/**
 * Handler: push-subscription
 *
 * 用户级 Web Push 订阅的读写口。一个用户一份，任务行不再各自携带订阅，到点
 * 投递时现读这一份。
 *
 *   PUT    /push-subscription   登记 / 覆盖订阅（body 加密：{ subscription }）
 *   GET    /push-subscription   有没有登记过、什么时候登记的
 *   DELETE /push-subscription   删掉（设置页的「停止接收推送」）
 *
 * 什么时候调 PUT：拿到 `pushManager.subscribe()` 的结果之后调一次，之后每次
 * 应用启动确认订阅仍然有效时再调一次（幂等覆盖）。用户清了站点数据、重装了
 * PWA、或者推送服务轮换了 endpoint，覆盖这一份就全好了——已经排好的任务、
 * 包括角色在 fire 里给自己排的那些，下次触发时读到的都是新订阅。
 *
 * GET 给的是 `{ exists, updatedAt, endpoint }`，不含订阅的密钥部分：客户端要
 * 判断的是「服务端登记过没有、登记的是不是我手里这一个」，`endpoint` 就够对
 * 上了。密钥留在服务端，不必再在网络上跑一遍。
 *
 * 鉴权与加密跟其它端点完全一样：X-Client-Token 走 resolveTenant，PUT 的 body
 * 必须加密（X-Payload-Encrypted / X-Encryption-Version），订阅落库前用
 * per-user key 加密。
 */

import { deriveUserEncryptionKey, decryptPayload } from '../lib/encryption.js';
import { getHeader, isPlainObject, parseEncryptedBody, requireUserId } from '../lib/request.js';
import {
  isPushSubscriptionShape,
  loadPushSubscription,
  savePushSubscription,
  supportsPushSubscriptionStore,
} from '../lib/push-subscription-store.js';

function err(status, code, message, details) {
  const error = details === undefined ? { code, message } : { code, message, details };
  return { status, body: { success: false, error } };
}

const UNSUPPORTED = err(
  501,
  'PUSH_SUBSCRIPTION_NOT_SUPPORTED',
  '当前数据库适配器不支持用户级推送订阅存储'
);

export function createPushSubscriptionHandler(ctx) {
  async function PUT(headers, body) {
    const tenantResult = await ctx.tenantManager.resolveTenant(headers);
    if (!tenantResult.ok) return tenantResult.error;
    const { db, masterKey } = tenantResult.context;

    if (getHeader(headers, 'x-payload-encrypted') !== 'true') {
      return err(400, 'ENCRYPTION_REQUIRED', '请求体必须加密');
    }
    const gate = requireUserId(headers);
    if (gate.error) return gate.error;
    const { userId } = gate;
    if (getHeader(headers, 'x-encryption-version') !== '1') {
      return err(400, 'UNSUPPORTED_ENCRYPTION_VERSION', '加密版本不支持');
    }

    const parsedBody = parseEncryptedBody(body);
    if (!parsedBody.ok) return { status: 400, body: { success: false, error: parsedBody.error } };

    const userKey = await deriveUserEncryptionKey(userId, masterKey);
    let payload;
    try {
      payload = await decryptPayload(parsedBody.data, userKey);
    } catch (error) {
      if (error instanceof SyntaxError) {
        return err(400, 'INVALID_PAYLOAD_FORMAT', '解密后的数据不是有效 JSON');
      }
      return err(400, 'DECRYPTION_FAILED', '请求体解密失败');
    }
    if (!isPlainObject(payload)) return err(400, 'INVALID_PAYLOAD_FORMAT', '解密后的数据必须是 JSON 对象');

    const subscription = payload.subscription;
    if (!isPushSubscriptionShape(subscription)) {
      return err(400, 'INVALID_PUSH_SUBSCRIPTION', 'subscription 必须是带非空 endpoint 的对象');
    }
    if (
      payload.updatedAt !== undefined &&
      (!Number.isInteger(payload.updatedAt) || payload.updatedAt <= 0)
    ) {
      return err(400, 'INVALID_UPDATED_AT', 'updatedAt 必须是正整数（epoch 毫秒）');
    }

    if (!supportsPushSubscriptionStore(db)) return UNSUPPORTED;

    const { updatedAt } = await savePushSubscription({
      db,
      userId,
      userKey,
      subscription,
      updatedAt: payload.updatedAt,
    });
    return { status: 200, body: { success: true, data: { updatedAt } } };
  }

  async function GET(url, headers) {
    const effectiveHeaders = headers || url || {};
    const tenantResult = await ctx.tenantManager.resolveTenant(effectiveHeaders);
    if (!tenantResult.ok) return tenantResult.error;
    const { db, masterKey } = tenantResult.context;

    const gate = requireUserId(effectiveHeaders);
    if (gate.error) return gate.error;
    const { userId } = gate;

    if (!supportsPushSubscriptionStore(db)) return UNSUPPORTED;

    const userKey = await deriveUserEncryptionKey(userId, masterKey);
    let stored = null;
    try {
      stored = await loadPushSubscription({ db, userId, userKey });
    } catch (_error) {
      // 密文解不开（换过 masterKey 之类）就当没登记过：客户端会重新 PUT 一份，
      // 那正是这种情况下唯一有意义的动作。
      stored = null;
    }
    return {
      status: 200,
      body: {
        success: true,
        data: {
          exists: !!stored,
          updatedAt: stored ? stored.updatedAt : null,
          // 客户端拿它跟手里的订阅对一下，就知道服务端登记的是不是同一个。
          endpoint: stored ? stored.subscription.endpoint : null,
        },
      },
    };
  }

  async function DELETE(url, headers) {
    const effectiveHeaders = headers || url || {};
    const tenantResult = await ctx.tenantManager.resolveTenant(effectiveHeaders);
    if (!tenantResult.ok) return tenantResult.error;
    const { db } = tenantResult.context;

    const gate = requireUserId(effectiveHeaders);
    if (gate.error) return gate.error;
    const { userId } = gate;

    if (!supportsPushSubscriptionStore(db)) return UNSUPPORTED;

    const deleted = await db.deletePushSubscription(userId);
    return { status: 200, body: { success: true, data: { deleted } } };
  }

  return { PUT, GET, DELETE };
}
