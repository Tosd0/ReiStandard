/**
 * Web Push — RFC 8030 (transport) + RFC 8291 (aes128gcm payload encryption)
 *           + RFC 8292 (VAPID).
 *
 * 实现已上移到 @rei-standard/amsg-shared（纯 WebCrypto，与 amsg-server
 * 共用同一份，wire format 与 `web-push` npm 包逐字节一致）。本模块保留
 * 原有路径与导出面，薄薄地 re-export。
 */

// hmacSha256 一并 re-export，`index.js` 校验 Bearer JWT 时不用另开
// import 路径。Keeps the public surface tight.
export {
  sendWebPush,
  buildVapidJwt,
  verifyVapidJwt,
  hmacSha256,
} from '@rei-standard/amsg-shared';
