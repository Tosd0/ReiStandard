---
"@rei-standard/amsg-shared": minor
---

新增三组共享纯函数，让 server / instant / client 复用同一份规则、不再各自维护副本：

- `validateAvatarUrl`（含 `isValidUrl` 与 `AVATAR_URL_MAX_LENGTH`）—— 头像 URL 校验
- `normalizeVapidSubject` —— VAPID subject 规范化（`mailto:` / `https:` 均保留，裸邮箱补 `mailto:`）
- `readReasoningContent` / `stripReasoningTags` —— 读取推理内容与剥离私有 `<think>` 链式思考
