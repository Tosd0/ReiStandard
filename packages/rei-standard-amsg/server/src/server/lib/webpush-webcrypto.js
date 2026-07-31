/**
 * Web Push — RFC 8030 (transport) + RFC 8291 (aes128gcm payload encryption)
 *           + RFC 8292 (VAPID).
 *
 * 加密栈本体已上移到 @rei-standard/amsg-shared（纯 WebCrypto，与
 * amsg-instant 共用同一份，wire format 与 `web-push` npm 包逐字节一致）。
 * 本模块 re-export 之外只保留 server 独有的部分：payload 大小护栏、
 * scheduled 默认 TTL 与 web-push 兼容的 `createWebCryptoWebPush`。
 */

import { sendWebPush as sharedSendWebPush } from '@rei-standard/amsg-shared';
export { buildVapidJwt, verifyVapidJwt, hmacSha256 } from '@rei-standard/amsg-shared';

// ─── Payload budget ────────────────────────────────────────────────────
//
// 推送服务（FCM / APNs / Mozilla autopush）限的是 POST 上去的**密文** body，
// 上限 4096 字节，超了当场 413，消息就没了。明文能塞多少要把 aes128gcm 的固
// 定开销减掉：
//
//   密文 body = header(86) + 明文 + 填充分隔符(1) + GCM auth tag(16)
//   header    = salt(16) + record size(4) + keyid 长度(1) + keyid(65)
//
// keyid 是应用服务器的 P-256 公钥，恒定 65 字节；单记录只带一个 0x02 分隔符
// （RFC 8188 §2），不额外填充。所以开销是固定的 103 字节，明文上限
// 4096 - 103 = 3993 字节（UTF-8 计，不是字符数）。
// 这个换算由 webpush-webcrypto.test.mjs 钉住：上限大小的 payload 编出来的
// body 恰好 4096 字节。

/** 推送服务对加密后 body 的上限（字节）。 */
export const WEB_PUSH_MAX_BODY_BYTES = 4096;
/** aes128gcm 固定开销：header 86 + 填充分隔符 1 + GCM tag 16。 */
export const WEB_PUSH_ENCRYPTION_OVERHEAD_BYTES = 16 + 4 + 1 + 65 + 1 + 16;
/** 一条 push 的明文（JSON 字符串）上限，UTF-8 字节数。 */
export const MAX_PUSH_PAYLOAD_BYTES = WEB_PUSH_MAX_BODY_BYTES - WEB_PUSH_ENCRYPTION_OVERHEAD_BYTES;

const payloadEncoder = new TextEncoder();

/**
 * 组 payload 前做预算用：先量骨架有多大，剩下多少字节才是能塞附加数据的额度。
 *
 * @example
 * const { remainingBytes } = measurePushPayload(JSON.stringify(basePush));
 * const excerpt = remainingBytes > 0 ? text.slice(0, remainingBytes) : '';
 *
 * @param {string} payload - 待发送的 payload 字符串（通常是 JSON.stringify 的结果）。
 * @returns {{ bytes: number, maxBytes: number, remainingBytes: number, withinLimit: boolean }}
 *   `bytes` 是 payload 的 UTF-8 字节数；`remainingBytes` 是还能加多少字节
 *   （已超限时为负）；`withinLimit` 为 false 时 sendWebPush 会抛
 *   `PUSH_PAYLOAD_TOO_LARGE`。
 */
export function measurePushPayload(payload) {
  const bytes = payloadEncoder.encode(typeof payload === 'string' ? payload : String(payload)).length;
  return {
    bytes,
    maxBytes: MAX_PUSH_PAYLOAD_BYTES,
    remainingBytes: MAX_PUSH_PAYLOAD_BYTES - bytes,
    withinLimit: bytes <= MAX_PUSH_PAYLOAD_BYTES,
  };
}

/**
 * Send a single Web Push notification. 委托 shared 的 `sendWebPush`（参数、
 * 返回值与之完全一致），只在加密前多做一步 payload 大小护栏——超限的
 * payload 发出去只会被推送服务 413 掉，用户什么也收不到。加密之前就拦下
 * 来，让调用方拿到一个说得清的错误（宿主可以退回一条短消息 + 引用键）。
 *
 * @param {Object} args - 同 shared `sendWebPush`：{ subscription, payload, vapid, ttl, fetch }。
 * @returns {Promise<{ statusCode: number, body: string, headers: Headers }>}
 * @throws  {Error}  err.code = 'PUSH_PAYLOAD_TOO_LARGE' when the payload
 *                   exceeds MAX_PUSH_PAYLOAD_BYTES (nothing is sent);
 *                   err.code = 'PUSH_SEND_FAILED' on push-service error.
 */
export async function sendWebPush(args) {
  const { payload } = args || {};
  // 非字符串 payload 交给 shared 实现抛统一的 'payload must be a string'。
  if (typeof payload === 'string') {
    const size = measurePushPayload(payload);
    if (!size.withinLimit) {
      const err = new Error(
        `sendWebPush: payload is ${size.bytes} bytes, over the ${MAX_PUSH_PAYLOAD_BYTES}-byte limit ` +
        `(push services cap the encrypted body at ${WEB_PUSH_MAX_BODY_BYTES} bytes; ` +
        `aes128gcm adds ${WEB_PUSH_ENCRYPTION_OVERHEAD_BYTES} bytes)`
      );
      err.code = 'PUSH_PAYLOAD_TOO_LARGE';
      err.bytes = size.bytes;
      err.maxBytes = MAX_PUSH_PAYLOAD_BYTES;
      throw err;
    }
  }
  return sharedSendWebPush(args);
}

// Scheduled reminders must survive an offline device, so default to the same
// 4-week TTL the web-push npm backend applies. shared sendWebPush's default
// TTL (60s) is tuned for single-shot instant pushes; using it for durable
// schedules would drop any reminder whose device was offline > 1 min.
const SCHEDULED_DEFAULT_TTL = 2419200; // 4 weeks, in seconds

/**
 * web-push-compatible sender backed by the shared Web Crypto implementation.
 * message-processor calls `ctx.webpush.sendNotification(subscription, payloadString)`,
 * so we only need that one method. VAPID keys are baked in at construction.
 *
 * @param {{ email: string, publicKey: string, privateKey: string }} [vapid]
 * @param {{ ttl?: number }} [options] - Push TTL in seconds; defaults to 4 weeks
 *   (matches the web-push backend) so scheduled pushes outlive an offline device.
 * @returns {{ sendNotification: (subscription: Object, payload: string) => Promise<any> }}
 */
export function createWebCryptoWebPush(vapid = {}, { ttl = SCHEDULED_DEFAULT_TTL } = {}) {
  return {
    async sendNotification(subscription, payload) {
      return sendWebPush({
        subscription,
        payload,
        ttl,
        vapid: {
          email: vapid.email,
          publicKey: vapid.publicKey,
          privateKey: vapid.privateKey
        },
        fetch: globalThis.fetch
      });
    }
  };
}
