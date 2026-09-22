---
"@rei-standard/amsg-server": minor
---

后台投递少花冤枉钱：LLM 拒了请求不再重试、推送失败只补推送不重新生成、用量按整次 fire 累计

**LLM 上游明确拒了这次请求，一跳终审。** 上游回 400 / 401 / 402 / 403 / 404 / 405 / 413 / 422（Key 错了、余额不足、模型名写错、请求体不合法……）时，任务不再进退避阶梯：一次性任务直接标 `failed`，循环任务作废本次、推进到下一次。这类错误重试几次都是同一个结果，而每重试一次都要把整条生成重跑一遍。错误上带 `permanent: true`，fire hook（`onFireSettled` / `onAfterSend`）拿到的就是这个对象，宿主用 `error.permanent === true` 判断「终态、该告诉用户了」即可。408 / 409 / 425 / 429、所有 5xx、网络错误（没有 `llmStatus`）、中转站 200 装报错、其余没列出的 4xx 照旧重试。`messageType: 'instant'` 的请求内重试同样适用。

**生成成功之后推送失败，重试只补推送。** 一次触发的整批 push 落进收件箱之后推送才失败（推送服务 5xx 之类）的，重试那一跳不再调 LLM、也不调任何 fire hook，只把这一批里还没送到的几条原样再推一遍：已推出去的、客户端已 ack 的不重推，推的是收件箱里那一份原文。同一次触发只花一次生成的钱，客户端也只会见到一份内容。冻结 prompt 老链路和 hook 链路都是这样，tick 汇总新增 `details.redeliveredTasks`。落收件箱这一步也提前到了查 VAPID / 推送订阅之前，所以生成之后读订阅超时、VAPID 暂时没配齐这类失败同样只补推送；订阅压根没登记的任务照旧一跳终审，但这次的内容会留在收件箱里，客户端上线补收得到。

没落进收件箱的批次（pg / neon 没有收件箱，或这一次落行失败）没有这条退路：一条都没推出去的照旧重试并重新生成；已经推出去几条的一跳终审（`permanent: true`），不再重新生成拼出第二份内容。

**hook 载荷新增字段**（`onAfterSend` 与 `onFireSettled` 都带，原有字段语义不变）：

| 字段 | 是什么 |
|---|---|
| `usageTotal` | 本次 fire 所有 LLM 轮次的 `{ prompt_tokens, completion_tokens, total_tokens }` 合计，形状不齐时尽量相加（也认 `input_tokens` / `output_tokens`），都没报 → `null` |
| `llmCalls` | 本次 fire 实际发出的 LLM 请求数，失败的那次也算 |
| `outboxed` | finish 的整批是否已落进收件箱。`status: 'failed'` 且 `outboxed: true` = 内容已生成并落定、只是推送没发完：客户端补收拿得到全部 `total` 段，库会补推，补推那一跳不再调这两个 hook |

`usage` 仍是最后一轮的原样。失败结局一样带用量。

**新配置 `maxDeliveryRetries`**：定时任务投递失败后最多再重试几次，默认 3（与之前一致），`0` = 第一次失败就终审。单用户 Worker、`createSingleUserServer`、`createReiServer` 的 config 与 `runScheduledTick` 的 ctx 都认；默认值导出为 `DEFAULT_MAX_DELIVERY_RETRIES`。宿主自己按「重试到 3 次」判终态的，调低之后要跟着改。

D1 适配器新增 `listOutboxForTask`（补推时找这次触发落定的那一批），走已有的 `idx_outbox_created` 索引，不用重跑 `/init-tenant`。特性位：`llm-permanent-errors`、`redeliver-committed-batch`、`hook-usage-total`、`max-delivery-retries`。
