---
"@rei-standard/amsg-server": minor
---

`/cloudflare` 路径去掉 node `crypto` 依赖，载荷加密改用 Web Crypto。单用户 Worker 现在可以用 esbuild `--platform=neutral` 打成自包含单文件直接粘进 Cloudflare Dashboard，不再需要 `nodejs_compat` 兼容开关（示例 wrangler.toml 已同步去掉该 flag）。

- `lib/encryption.js` 的 5 个导出（`deriveUserEncryptionKey` / `encryptPayload` / `decryptPayload` / `encryptForStorage` / `decryptFromStorage`）改为基于 `globalThis.crypto.subtle` 实现。线格式与旧实现逐字节兼容——老数据、老客户端不受影响，并有跨实现互通测试钉住。
- 迁移注意：这 5 个函数全部从同步改为 async，直接 import 它们的调用方需要补 `await`。
- `randomUUID` 改从 runtime-neutral 的 webcrypto helper 获取，不再 import node `crypto`。
- 多租户入口（Netlify/Neon）行为不变。
