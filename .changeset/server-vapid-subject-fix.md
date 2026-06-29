---
"@rei-standard/amsg-server": patch
---

VAPID subject 规范化支持 `https:` 形式：RFC 8292 允许 subject 使用 `https:`，规范化时按原样保留，不另加 `mailto:` 前缀。reasoning 私有思考过滤、`avatarUrl` 校验、VAPID subject 规范化统一改用 `@rei-standard/amsg-shared` 的实现。
