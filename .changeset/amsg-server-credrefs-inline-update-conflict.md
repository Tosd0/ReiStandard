---
"@rei-standard/amsg-server": patch
---

`PUT /update-message`：任务已存 `credRefs.chat` 时，内联凭据刷新改为报错

任务通过 `credRefs.chat` 引用凭据时，触发时的解析以凭据表那行为准，任务里的内联 `apiUrl` / `apiKey` / `primaryModel` 只是表行缺失时的兜底。原来对这种任务用内联字段做「凭据刷新」会返回 200 并列进 `updatedFields`，但改动不会生效——泄漏密钥轮换的场景里，客户端以为换 Key 成功，之后每次触发用的仍是表里的旧 Key。

现在这种组合返回 `409 TASK_USES_CRED_REFS`，错误信息说明换 Key 应走 `PUT /llm-credentials` 覆盖对应凭据，或在本次请求里改用 `credRefs` 指向新凭据。只带非 chat 引用（如仅 `emotion`）的任务不受影响：它的聊天凭据就是内联那份，刷新照常生效。
