---
"@rei-standard/amsg-shared": minor
"@rei-standard/amsg-instant": patch
"@rei-standard/amsg-server": patch
---

Web Push 加密栈上移 amsg-shared，instant / server 共用同一份实现

此前 amsg-instant 的 `src/webpush.js` 与 amsg-server 的 `lib/webpush-webcrypto.js` 是逐字相同的两份拷贝（RFC 8030 传输 / RFC 8291 aes128gcm / RFC 8292 VAPID，纯 WebCrypto）。现在实现只有一份，放在 amsg-shared 的独立模块 `src/webpush.js`，从包根导出：

- `sendWebPush` / `buildVapidJwt` / `verifyVapidJwt`
- 顺带上移它依赖的 runtime-neutral 帮手：`utf8`、`bytesToBase64Url`、`jsonToBase64Url`、`hmacSha256`、`randomBytes`

instant 与 server 的对应模块变薄，re-export shared 实现；两个包的公开导出面与 wire format 不变。server 独有的部分原样保留在自己包里：payload 大小护栏（`measurePushPayload` / `MAX_PUSH_PAYLOAD_BYTES` 等，`sendWebPush` 超限仍抛 `PUSH_PAYLOAD_TOO_LARGE`）、scheduled 默认 4 周 TTL 与 `createWebCryptoWebPush`。
