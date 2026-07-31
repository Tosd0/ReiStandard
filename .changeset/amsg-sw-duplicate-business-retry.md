---
"@rei-standard/amsg-sw": minor
---

duplicate 分支的业务自愈：首投 `onBusinessPayload` 失败后，同 key 重复包会重跑一次

- dedupe 记录上带着 `businessError`（首投业务回调失败）时，同 key 的重复包（发送方重试 / 另一条 transport 的 backup）到达会重跑一次 `onBusinessPayload`：重跑成功 → 清掉记录上的 `businessError`，本次 ack 不带该字段，之后的重复包恢复纯去重；重跑仍失败 → 用新的失败信息更新记录，照旧在 ack 上报。此前修复通道只有通知这半边（首投没弹成、重复包会补弹一次），业务这半边没有：首投落库失败被持久化后，所有重复包只如实上报、永不重跑，结果是「横幅弹了、收件箱永远没写上」，任何重投都救不回。现在通知和业务走同一套 duplicate 自愈。
- 记录上没有 `businessError` 时（首投业务成功，或业务还在 in-flight——失败要等 settle 后才落到记录上），重复包行为与之前完全一致：不重跑业务、不双写。
- 注意：`onBusinessPayload` 现在可能对同一 key 被调用多次（仅发生在上一次调用失败之后）。按 key（如 `messageId`）幂等覆盖写的消费方天然安全；README「在 SW 内执行 tool_request 的安全边界」中的幂等建议，对「失败自动重试」场景从建议升级为前提。
