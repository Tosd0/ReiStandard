---
"@rei-standard/amsg-client": patch
---

`deleteLlmCredentials()` 对 `all` 与 `credIds` 同时出现的入参直接抛错，不再静默按全删执行

以前 `{ all: true, credIds: [...] }` 这种两个字段都传的调用，SDK 会悄悄取 `all: true`、只发 `{ all: true }` 出去——同样的 body 直接发 HTTP 会被服务端 400 拒掉（「all 与 credIds 不能同时出现」），经 SDK 反而变成把该用户所有凭据行全删。典型踩法是用两份 UI 状态拼 opts：一个过期的「全删」标志加上一行勾选，云端凭据就被清空了，之后所有带 `credRefs` 的任务到点都记 `CREDENTIAL_MISSING`。

现在 SDK 跟服务端同一口径：`all: true` 且 `credIds` 出现（空数组也算）时本地抛 `TypeError`（「all 与 credIds 不能同时出现」），请求不会发出。只传其中一个字段的调用行为不变。JSDoc 和 README 补上了两种删法互斥的说明。
