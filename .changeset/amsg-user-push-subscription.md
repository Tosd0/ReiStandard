---
"@rei-standard/amsg-server": minor
"@rei-standard/amsg-client": minor
---

推送订阅改成用户级的一份，任务不再携带它

- **新增 `push_subscriptions` 表与 `PUT` / `GET` / `DELETE /push-subscription` 三个端点。** 一个用户一份订阅，落库前用 per-user key 加密；`GET` 返回 `{ exists, updatedAt, endpoint }`，不含订阅的密钥部分。内置的 D1 / pg / neon 适配器都实现了对应的 `getPushSubscription` / `upsertPushSubscription` / `deletePushSubscription`，`initSchema()` 会建表；自定义适配器缺任何一个，这三个端点返回 501。
- **任务不再携带订阅，到点投递时现读那一份。** 订阅冻结在每条任务里的话，用户清站点数据 / 重装 PWA / 推送服务轮换 endpoint 之后，每条老任务都拿着一个已死的订阅，而「刷新订阅」只能按客户端本地已知的任务清单逐行 PUT——它不知道的任务（角色在 fire 里给自己排的那些）就永远刷不到，成了死循环：推不出去 → 状态记不下来 → 客户端不知道这条任务存在 → 更刷不到它。现在覆盖用户级那一份就全好了，已排的任务一条都不用碰。
- **`POST /schedule-message` 与 `PUT /update-message` 都不收 `pushSubscription` 字段**（带了返回 `400 PUSH_SUBSCRIPTION_NOT_ACCEPTED`）：静默丢弃会让人以为「这条任务用的是我传的这个订阅」。排程时这个用户还没登记订阅 → `409 PUSH_SUBSCRIPTION_MISSING`，建了也永远发不出去。投递时读不到订阅 → 任务按投递失败处理，原因记进 payload 的 `lastError`，`GET /messages` 上看得见。
- **`ctx.scheduleTask()` 建的任务同样不携带订阅**，也不需要继承——到点读的就是当时最新的那份。
- **客户端 SDK 新增** `putPushSubscription(subscription, opts?)` / `getPushSubscription()` / `deletePushSubscription()`。`putPushSubscription` 直接收 `pushManager.subscribe()` 的结果（内部取 `toJSON()`），什么时候调：拿到订阅之后一次，之后每次应用启动确认订阅仍然有效时再一次（幂等覆盖）。
- **`GET /capabilities` 的 features 追加** `user-push-subscription`。
