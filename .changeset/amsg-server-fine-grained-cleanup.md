---
"@rei-standard/amsg-server": minor
---

云端数据可以按角色 / 按命名空间清理，不再只有「整表全清」一个粒度

宿主常把角色身份编进 `client_state` 的命名空间和 `llm_credentials` 的 `cred_id` 里（库只当它们是不透明字符串）。角色在本地删掉之后，云端那份原来没有对应的清理口——要么整表全清，要么绕过库直接对数据库跑 SQL，而后者会漏掉大值分块留下的切片行。这一版把这条路补成库的正经能力，一共四条，都带各自的 feature 名（`GET /capabilities` 探不到就说明用户那台 worker 还没更新，可以走降级路径）。

| 端点 | 干什么 | feature 名 |
|---|---|---|
| `GET /client-state/namespaces[?limit=<n>]` | 云端有哪些命名空间：`{ namespaces: [{ namespace, entryCount, byteSize, updatedAt }], truncated, limit }`（加密信封，默认最多 200 条） | `client-state-namespaces` |
| `DELETE /client-state?namespace=<ns>` | 只清这一个命名空间，连它的大值切片行一起，返回 `{ deleted, namespace }` | `client-state-delete-namespace` |
| `DELETE /llm-credentials { credIdPrefix }` | 按 `cred_id` 前缀删（`char:<charId>/` 一把清掉一个角色名下的几行） | `llm-credentials-delete-prefix` |
| `DELETE /outbox` | 主动删收件箱的行：`{ messageIds: [...] }`（一次 ≤200 条）或 `{ all: true }` | `outbox-delete` |

用法是三步：拉一份命名空间清单，跟本地对一遍，本地已经没有的逐个删。

几个说清楚的点：

- **命名空间清单里没有库的保留命名空间。** 单条 value 超过 200KB 时库会把它切片存进一个内部命名空间，那是存储实现细节。统计把它折算进原命名空间：`byteSize` 和 `updatedAt` 算进去，`entryCount` 不算（切片是一个逻辑条目的几段，不是几个条目）。按命名空间删也是原命名空间和它的切片命名空间在同一个事务里删完，不会留下读不出来的孤儿行。
- **`byteSize` 是存储字节，不是原文字节。** 值落库前都加密过，这个数比明文大一截——它回答的是「这个命名空间在云端占多大地方」。
- **清单有条数上限。** 被截断时 `truncated: true`，手上这份就不是全集，别拿它反推「本地有、云端没有 = 可以删」。
- **`DELETE /outbox` 和 ack 是两回事。** ack 之后行还在（等 cron 的 TTL 老化），只是不再被 `GET /outbox` 返回；删是把行拿掉，补收不回来，只该在确认对完账之后用。它也跟取消任务时的「撤回未投递」不同——那个只动没发出去的行，这个不看 `delivered_at` / `acked_at`。
- **`credIdPrefix` 是字典序前缀，不是通配符**，前缀里的 `%` `_` `\` 都只是普通字符；三种入参（`all` / `credIds` / `credIdPrefix`）一次只能给一个，混着传返回 400。

`DELETE /client-state` 不带 `namespace` 参数时仍是整表全清，`DELETE /llm-credentials` 的 `credIds` / `all` 两种入参行为一字未改，老调用方不受影响。

适配器接口新增四个可选方法（`listClientStateNamespaces` / `deleteClientStateNamespaces` / `deleteLlmCredentialsByPrefix` / `deleteOutboxMessages`），内置只有 D1 实现；没实现的适配器对应端点返回 501，其余入参照常。按前缀删凭据走的是字典序范围比较而不是 `LIKE`——D1 把 LIKE / GLOB 的 pattern 压到 50 字节，`char:<uuid>/` 就已经 42 字节了，用 LIKE 写整条语句会在真实 D1 上报 `pattern too complex`。
