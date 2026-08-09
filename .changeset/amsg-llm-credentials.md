---
"@rei-standard/amsg-server": minor
"@rei-standard/amsg-client": minor
---

用户级 LLM 凭据存储（llm_credentials 表）+ 任务凭据引用（credRefs）

凭据（apiUrl / apiKey / primaryModel）可以先用 `PUT /llm-credentials` 集中登记（`cred_id` 由客户端起名的不透明字符串，per-user key 加密落库），排程 payload 里带 `credRefs: { chat: '<credId>' }` 引用它——任务到点按引用现读，换 Key 覆盖对应行就够，所有引用它的任务（包括角色在 fire 里给自己排的、客户端不知道存在的那些）下次触发自动用新凭据。内联三件套继续支持（存量任务不迁移，fire 时作为表行缺失的兜底）。

服务端：`PUT/GET/DELETE /llm-credentials` 三端点（GET 只回 credId + updatedAt，凭据本体永远不回传）；schedule/update 对 credRefs 做存在性检查（缺的 `409 CREDENTIAL_NOT_FOUND` 点名）、credRefs.chat 与内联同传 `400`；fire 解析顺序为表 → 内联兜底 → `CREDENTIAL_MISSING` 常规重试；`ctx.scheduleTask()` 自排任务复制引用而不是凭据本体；fire hook ctx 新增 `resolveLlmCredential(credId)`（每次返回新对象，供宿主取非 chat 用途的副 API）；任务投影带 `credRefs`；capabilities 新增 `'llm-credentials'`。D1 / pg / neon 适配器都实现了新表，自定义适配器需补四个方法（缺则相关端点 501）。

客户端 SDK：新增 `putLlmCredentials()` / `listLlmCredentials()` / `deleteLlmCredentials()`；`scheduleMessage` / `updateMessage` 的 payload 原样透传 `credRefs`。
