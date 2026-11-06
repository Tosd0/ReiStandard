/**
 * Web Push — RFC 8030 (transport) + RFC 8291 (aes128gcm payload encryption)
 *           + RFC 8292 (VAPID).
 *
 * 实现已上移到 @rei-standard/amsg-shared（纯 WebCrypto，与 amsg-server
 * 共用同一份，wire format 与 `web-push` npm 包逐字节一致）。本模块保留
 * 原有路径与导出面，薄薄地 re-export。
 */

import { sendWebPush as sharedSendWebPush, redactCredentials } from '@rei-standard/amsg-shared';

// hmacSha256 一并 re-export，`index.js` 校验 Bearer JWT 时不用另开
// import 路径。Keeps the public surface tight.
export {
  buildVapidJwt,
  verifyVapidJwt,
  hmacSha256,
} from '@rei-standard/amsg-shared';

/** 推送失败文案的上限（字符），与 LLM 失败文案走同一档。 */
const PUSH_ERROR_MESSAGE_MAX_CHARS = 300;

/**
 * 同 shared 的 `sendWebPush`，只多一步：推送服务回的失败原文会被 instant 原样
 * 回显给客户端，这里先压平空白、遮凭据、截断，跟 LLM 失败文案同一套处理。
 *
 * @type {typeof sharedSendWebPush}
 */
export async function sendWebPush(args) {
  try {
    return await sharedSendWebPush(args);
  } catch (err) {
    if (err && err.code === 'PUSH_SEND_FAILED' && typeof err.message === 'string') {
      const safe = redactCredentials(err.message.replace(/\s+/g, ' ').trim());
      err.message = safe.length > PUSH_ERROR_MESSAGE_MAX_CHARS
        ? `${safe.slice(0, PUSH_ERROR_MESSAGE_MAX_CHARS - 1)}…`
        : safe;
    }
    throw err;
  }
}
