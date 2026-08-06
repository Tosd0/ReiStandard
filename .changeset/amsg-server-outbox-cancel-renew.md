---
"@rei-standard/amsg-server": minor
---

服务端原生消息收件箱（message_outbox + ack）；fire ctx 新增 `cancelTask` / `renewTask`

**message_outbox**：之前没有收件箱表，「补收」只能靠客户端拿「messageId 在不在本地近 N 条里」猜哪些推送丢了——猜错的每种方式都出过场（删掉的回复复活、多段丢失没人补、与进行中会话竞态重复上屏、重试轮重复生成）。现在：

- 服务端发出的每条 push（老链路与 agentic 链路都算）在发送前先落一行 `message_outbox`（payload 是整条 push JSON 的 per-user 密文；`(user_id, message_id)` 唯一，重试同一 occurrence 不产生第二行、不复活已 ack 的行）；Web Push 发出后标 `delivered_at`，半途失败只标已发出的段；
- 客户端两个端点：`GET /outbox?since=<cursor>[&limit=]` 拉未 ack 的行（id 升序游标翻页，响应走加密信封，逐条带解密后的完整 push + taskUuid/sessionId/messageIndex 等），`POST /outbox/ack { messageIds }` 确认收到（幂等）——「补收」变成「拉未 ack」，不存在猜；
- tick 顺手清理：已 ack 的留 7 天，未 ack 的留 28 天（Web Push TTL 上限四周）；
- outbox 全程 best-effort：落行失败不影响投递本身。适配器接口新增五个可选方法（`appendOutboxMessages` / `markOutboxDelivered` / `listUnackedOutbox` / `ackOutboxMessages` / `cleanupOutbox`），内置只有 D1 实现（与 client_state 同待遇），没实现的适配器发送链路静默跳过、端点回 501。

**表结构**：新增 `message_outbox` 表（`initSchema()` / `POST /init-tenant` 会建，幂等）。

**cancelTask / renewTask**：fire ctx 之前只有 `scheduleTask`，云端轮的角色「看得见任务、动不了」——用户说「取消那个提醒」，角色口头答应，任务照旧触发。现在 `fireCtx` 和每轮 `sessionCtx` 上新增 `ctx.cancelTask(uuid)`（语义同 `DELETE /cancel-message`）与 `ctx.renewTask(uuid, nextSendAt)`（语义同 `PUT /update-message` 只改排期：payload 的 firstSendTime 跟着改、重试计数清零、退避放掉；新时刻至少比现在晚 60 秒）。两者都不许操作当前正在 fire 的这条（收尾归 run-tick 管）。

特性位：`message-outbox`、`agentic-cancel-renew-task`。
