---
"@rei-standard/amsg-server": minor
---

换过主密钥后读到解不开的旧数据，返回 `409 STORED_DATA_UNDECRYPTABLE`

存储密钥由主密钥派生，重新部署时换了 `AMSG_MASTER_KEY`，之前写进去的数据就解不开了。读到这样的数据时，服务端返回 `409`，`error.code` 是 `STORED_DATA_UNDECRYPTABLE`，`error.message` 说明原因和出路（换回原来的密钥，或清掉云端旧数据）。

- `GET /messages` 照样列出解不开的任务：只带行上的明文字段（`uuid`、`status`、`nextSendAt`、`lastError` 等），外加 `error: { code, message }`，其余任务照常返回，客户端可以按 `uuid` 取消它。fire-time hook 的 `ctx.listTasks()` 同样处理。
- `GET /client-state` 把解不开的 key 列在 `undecryptable: [{ key, updatedAt, code }]` 里，不进 `entries`；全部能解开时不带这个字段。
- `PUT /client-state`、`PUT /llm-credentials` 写入旧密钥写过的 key 时照常成功，旧的归属记录按不存在处理并用新密钥重写。
- `GET /message`、`PUT /update-message` 碰到解不开的任务返回 `409 STORED_DATA_UNDECRYPTABLE`。
- 到点投递解不开的任务时，`lastError.errorCode` 是 `STORED_DATA_UNDECRYPTABLE`。
- 新增导出 `StoredDataUndecryptableError`、`isStoredDataUndecryptableError`、`STORED_DATA_UNDECRYPTABLE_CODE`。
