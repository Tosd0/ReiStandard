---
"@rei-standard/amsg-server": patch
---

单用户 Worker 的 instant 起跳器在 alarm 重试时领回自己上一轮的租约

起跳器实例被重置（部署新版本后的代码更新、Cloudflare 的运行时更新）会打断正在跑的 alarm，Cloudflare 随后重试。起跳器在第一次投递前生成一个租约 token 存进实例存储，重试时用同一个 token 占位，能直接领回上一轮没放掉的租约接着投递。上一轮已经把结果写进收件箱的，重试只补推送，不重新生成。租约在 cron 或别的执行者手里时照旧不发，并打一行 warn。

- `runTask(ctx, uuid, options?)` 多一个可选的 `options.leaseToken`：占位用这个 token，不现生成。
- `claimTask` 的租约契约多一条：行上的 `lease_token` 已经等于传入的 `leaseToken` 时，租约没过期也领得走。内置的 D1 / Postgres / Neon 适配器都已支持；自定义适配器不支持时只认空着 / 已过期的租约，行为不变。
- 示例 `wrangler.toml` 加了 `[durable_objects.code_update_strategy]`（`mode = "deferred"`、`max_delay = 900`），让正在跑的生成尽量在旧代码上跑完。
