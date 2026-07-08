---
"@rei-standard/amsg-server": minor
---

单用户 / Cloudflare 入口（`@rei-standard/amsg-server/cloudflare`）的载荷加密改用 Web Crypto（`globalThis.crypto.subtle`），不再依赖 Node 的 `crypto`。整条子路径现在只用 WHATWG 标准 API，Worker bundle 打包免开 `nodejs_compat` 兼容开关，可直接粘进 Cloudflare Dashboard。

加密线格式（AES-256-GCM、载荷 base64、入库 hex `iv:authTag:data`）保持不变，旧数据照常解密。因实现改为异步，`@rei-standard/amsg-server/cloudflare` 重新导出的 `deriveUserEncryptionKey`、`decryptPayload`、`encryptForStorage`、`decryptFromStorage` 现在返回 Promise，直接调用需 `await`。
