---
"@rei-standard/amsg-server": minor
"@rei-standard/amsg-shared": patch
---

代码评审加固：存量任务订阅兜底、串行分组写偏斜收口、重试状态重置、错误分类与门禁去重

**@rei-standard/amsg-server**

- **升级前创建的任务不再必然投递失败。** 投递时解析订阅新增兜底：用户级 `push_subscriptions` 存储里没有订阅时，回退到旧任务 payload 里内嵌的 `pushSubscription`（存储里有则永远优先用存储的那份）。普通投递路径和 agentic 路径都生效——存量部署升级后，用户来不及打开新客户端登记订阅，旧任务照样发得出去。
- **pg / neon 串行分组占位补上写偏斜收口。** READ COMMITTED 下两个并发 tick 各领同组「不同」行时，`NOT EXISTS` 互相看不见对方未提交的租约，同组两条任务可能并发执行。现在占位提交后再复查一次同组活租约，撞上就放掉自己刚写的租约、这一跳不跑（两边都让路也安全：行保持 pending，下一跳重试）。`claimTask` 与 `push_subscriptions` 三方法同时收拢到 `adapters/pg-shared.js`，pg / neon 共用一份 SQL，语义不再可能分歧。
- **tick 内串行分组预占用按用户隔离。** 内存侧的占坑键带上 `user_id`，与落库侧 per-user HMAC 的隔离语义对齐——多用户部署下两个用户恰好返回同一个分组 key（如共用的默认角色名）不再互相顶掉对方的任务。
- **`PUT /update-message` 重置重试状态。** 更新任务时 `retry_count` 归零、`retry_after` 清空（后者仅在支持 `claimTask` 的适配器上写）——刚修好 apiKey / 改好排期的任务不再背着耗尽的重试预算，下一次瞬时故障不会直接把它打成永久 failed。
- **`POST /schedule-message` 的订阅预检改为存在性检查。** 不再解密（解出来的值本来也用不上）；查询本身失败时报可重试的 503 `PUSH_SUBSCRIPTION_LOOKUP_FAILED`，不再把瞬时 DB 故障伪装成 409 `PUSH_SUBSCRIPTION_MISSING` 引导客户端去走多余的重订阅流程。
- **订阅类错误带稳定 `code`，投递失败按类别处置。** `resolvePushSubscription` 抛出的错误带 `err.code`（`PUSH_SUBSCRIPTION_MISSING` / `PUSH_SUBSCRIPTION_STORE_UNSUPPORTED`），消费方按 code 分支即可、不必匹配 message 文案；tick 的失败处置对这两类「重试也好不了」的错误短路退避阶梯——一次性任务直接进终审处置，循环任务直接作废本次 occurrence，不再每次白跑 3 轮重试。
- **过期守卫两处收紧 / 放开。** 重试链上的任务（`retry_count > 0`）在排定的重试时刻（`retry_after`）本身也被拖过阈值时同样按过期处理——停摆恰好落在重试窗口里的任务不再于恢复后把几天前的旧内容推出去（`getPendingTasks` 随之在返回行里带上 `retry_after`）。阈值本身可用 `ctx.staleAfterMs` 覆盖（单用户 worker 从 config 的 `staleAfterMs` 透传），依赖「再晚也送达」语义的宿主有了官方出口。
- **单用户 worker 的两处错误边界补齐。** `cors.origin` 回调抛错按「不放行这个 origin」处理，不再逃出 `fetch()` 变成 Cloudflare 1101 错误页；`scheduled()` 的配置构建失败改为记日志跳过这一跳，不再以未捕获异常崩掉 cron 调用。
- **存量多租户租户自动补列。** 多租户侧每个进程首次取得适配器时补跑一遍幂等的 `initSchema`（建表 / `ADD COLUMN IF NOT EXISTS`），升级加列后第一个请求就把 schema 补齐——不再依赖 CHANGELOG 里的手工 DDL 步骤（同 tenantId 重放 `/init-tenant` 到不了 `initSchema` 就 409，此前存量租户没有任何自动迁移路径）。
- **门禁与工具函数去重。** X-User-Id 门禁（8 个 handler 里的复制粘贴，文案已分裂成两种）收拢为 `lib/request.js` 的 `requireUserId()`，对同一错误码的 message 统一为「缺少用户标识符」；`UPDATABLE_COLUMNS` 白名单三个适配器共用 `schema.js` 一份；`isValidUrl` 改为 re-export shared 的实现；tenant/blob-store 的 base64url 改用 shared 实现；tick 的预解密 payload 直通投递侧（`processSingleMessage` 新增 `predecrypted` 参数），同一份密文不再解两遍，相关失实注释一并修正；过期跳过的循环/一次性两个近似复制的分支收拢为单一尾部。

**@rei-standard/amsg-shared**

- `verifyVapidJwt` 的 JWT payload 解码改用 `webcrypto-utils` 的 `utf8Decode`，兑现本模块「编码辅助只住在 webcrypto-utils」的约定（行为不变）。
