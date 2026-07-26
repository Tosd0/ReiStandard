---
"@rei-standard/amsg-server": minor
---

Web Push payload 加大小护栏，并导出预算用的常量与工具函数

推送服务（FCM / APNs / Mozilla autopush）限的是**加密后** body 的 4096 字节，超了直接 413。之前库里对 payload 长度没有任何检查，超限的消息一路发到推送服务被拒 → 投递失败 → 重试三次 → 任务标 failed，用户完全收不到，只有服务端日志里有痕迹。

现在 `sendWebPush` 在加密前就挡下来，抛出 `err.code === 'PUSH_PAYLOAD_TOO_LARGE'` 的错误，消息里带实际字节数和上限（`err.bytes` / `err.maxBytes` 也可直接读）。

明文额度是 4096 减掉 aes128gcm 的固定开销——header 86（salt 16 + record size 4 + keyid 长度 1 + 应用服务器公钥 65）+ 填充分隔符 1 + GCM auth tag 16 = 103 字节——即 **3993 字节**，按 UTF-8 计。新增导出（包根与 `/cloudflare` 两个入口都有）：

- `MAX_PUSH_PAYLOAD_BYTES` — 3993，一条 push 的明文上限
- `WEB_PUSH_MAX_BODY_BYTES` — 4096，推送服务对密文 body 的上限
- `WEB_PUSH_ENCRYPTION_OVERHEAD_BYTES` — 103，aes128gcm 固定开销
- `measurePushPayload(payload)` — 返回 `{ bytes, maxBytes, remainingBytes, withinLimit }`，组 payload 前量骨架、算还能塞多少

```js
const { remainingBytes } = measurePushPayload(JSON.stringify({ ...basePush, message: '' }));
const message = body.length <= remainingBytes ? body : body.slice(0, remainingBytes);
```

装不下的内容走旁路：正文存进 `client_state`（单用户 Worker 的 hook 用 `ctx.writeState()`），push 里只带引用键，客户端上线后 `GET /client-state` 取回。
