---
"@rei-standard/amsg-client": minor
---

新增 `getOutbox()` / `ackOutbox()`，对接服务端的消息收件箱（amsg-server 的 `/outbox` 与 `/outbox/ack`）

服务端在每条 Web Push 发出去之前先把它记进账本，「哪些消息客户端还没收下」因此是查得出来的事实。此前这套账本只有服务端一半，SDK 没有对应方法，而加密与 userKey 封在客户端内部、没有通用出口，调用方没法自己拼请求。补上这两个方法之后，补收不再需要拿本地最近几条记录去比对着猜。

- `getOutbox({ since, limit })`：拉还没确认收到的消息，返回 `{ entries, cursor, hasMore }`。响应走加密信封，方法内解密后返回明文。每条 entry 的 `push` 就是推送信封本身，与 Service Worker 收到的那一份逐字一致，可以原样交给已有的推送处理逻辑。翻页时把上一页的 `cursor` 当下一页的 `since`；两个参数都不传就从头拉、由服务端定页大小。
- `ackOutbox(messageIds)`：销账，之后 `getOutbox()` 不再返回这些消息。请求体加密，幂等，单次最多 200 条。顺序上先落库再 ack——反过来的话账已经销了而落库半途失败，消息就补不回来了。

`since` / `limit` / `messageIds` 不合法时在本地抛 `TypeError`，不跑一趟必然被服务端拒的网络请求。
