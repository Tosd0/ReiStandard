---
"@rei-standard/amsg-server": minor
---

任务正文加大小上限，超了在建任务时就回 400，并导出预算用的常量

一条任务的正文（`messages` / `completePrompt` / `metadata` 等）整个加密成一个字符串落在 `scheduled_messages.encrypted_payload` 这一列上。原来这条链路上没有任何大小检查，正文多大都照单收下；写到 Cloudflare D1 时才撞上它 2,000,000 字节的单行上限，调用方拿到的是一个 500，错误体里只有一句 `D1_ERROR: string or blob too big`——既不知道是哪份数据太大，也不知道上限是多少。本地测试跑的是 SQLite、生产用 Postgres 的部署也碰不到这条线，所以问题只在 D1 上、且只在运行时才暴露。

现在 `POST /schedule-message` 与 `PUT /update-message` 在加密落库前先量一次正文，超限直接回 400：

```json
{
  "success": false,
  "error": {
    "code": "TASK_PAYLOAD_TOO_LARGE",
    "message": "任务内容 1048576 字节，超过 995871 字节上限",
    "details": { "bytes": 1048576, "maxBytes": 995871 }
  }
}
```

判断读 `details.bytes` / `details.maxBytes` 就够，不用去解析 message 那句话。`PUT /update-message` 量的是合并之后的正文：patch 本身很小、叠到存量正文上顶穿上限的情况同样会被拦下。

上限是 **995,871 字节**（明文的 UTF-8 字节数，不是字符数——一段全中文的正文，字节数是字符数的三倍），从 D1 的 2,000,000 字节反推：密文按十六进制存，字节数正好翻倍，再给行里其他列、以及投递失败时补写 `lastError` 留出余量。这个数从包根导出成 `MAX_TASK_PAYLOAD_BYTES`，客户端想在提交前自己预算就读这一份，别手抄第二个数。

上限对所有适配器一视同仁（D1 / Postgres / Neon）：同一份任务在不同库之间搬家时契约不该跟着变。正常大小的任务不受影响——一条塞满 messages 的对话离这个量级还差得远；真要放大段内容，走 `client_state` 旁路存，任务里只留引用键。

**`PUT /update-message` 只拦「这次改动把它变大了」**

大小闸门量的是合并之后的正文，不是这次的 patch——patch 本身可能很小，叠到存量正文上却顶穿上限。但上限是后加的，比它更早建出来的大任务本来跑得好好的：一律按合并后的大小拒的话，那条任务连把 `nextSendAt` 往后挪一小时都做不到，只能删掉重建。所以合并后超限、且比改动前更大才回 `400`；改小或大小没变的改动照常放行。
