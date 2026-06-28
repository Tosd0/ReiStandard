---
"@rei-standard/amsg-server": patch
---

修正 VAPID subject 规范化：`https:` 形式的 subject 不再被错误地加上 `mailto:` 前缀（RFC 8292 允许 `https:` subject）。此前 server 仅识别 `mailto:`，会把 `https://example.com/contact` 拼成 `mailto:https://...`。reasoning 私有思考过滤、`avatarUrl` 校验、VAPID subject 规范化现统一改用 `@rei-standard/amsg-shared` 的实现。
