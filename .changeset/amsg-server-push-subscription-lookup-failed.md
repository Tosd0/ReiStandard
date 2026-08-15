---
"@rei-standard/amsg-server": patch
---

`GET /push-subscription` 读不到库时说实话，不再谎报「没登记过」

原来这个端点把整段取订阅的过程包在一个 catch 里：不管是订阅表没建好、数据库读超时，还是这一行的密文解不开，一律回 200 `{ exists: false, updatedAt: null, endpoint: null }`，服务端连一行日志都不留。故障期间设置页显示「推送未登记」，客户端照着这个答案去走一遍重新订阅 + `PUT /push-subscription`，真正的原因谁都看不到；同一次故障下 `POST /schedule-message` 报的却是 503 `PUSH_SUBSCRIPTION_LOOKUP_FAILED`，两个端点各说各的。

现在两类失败分开：

- 查询本身失败 → 503 `PUSH_SUBSCRIPTION_LOOKUP_FAILED`，与 `POST /schedule-message` 用同一个 code，客户端可以直接按「稍后重试」处理，别去重订阅。
- 行还在、密文解不开（换过 masterKey 之类）→ 仍然回 200 `exists: false`，因为此时重新 PUT 一份确实是唯一有意义的动作；但服务端会记一行日志说明是解密失败，不再无声降级。

`PUT` / `DELETE` 的行为没有变化。
