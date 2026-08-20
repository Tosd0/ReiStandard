---
"@rei-standard/amsg-instant": patch
---

`multipart.maxChunkBytes` 加上限校验，配错在 `createInstantHandler` 当场失败

每片原文经 base64url 膨胀 4/3、再套上分片信封后，必须仍装得进单条 push 的明文上限（约 3993 字节）。`maxChunkBytes` 配超过约 2800 字节时，切出的每一片都会被推送服务拒收——原来的下场是每次触发时 reasoning / 长内容静默丢失，只留一条跟配置对不上号的推送错误，而这个旋钮此前只校验「正整数」，没人拦着调大。

现在 `createInstantHandler` 解析 `multipart` 配置时校验这个上限（上限按分片信封的实际开销现算，不是写死的数），配超了当场抛 `TypeError`，错误信息带当前配置下允许的最大值；deprecated 别名 `reasoningChunkBytes` 走同一道校验。绕过 handler、自己攒 ctx 直接调 `processInstantMessage` / `sendPushWithMaybeBlob` 的，同一道校验在切片前拦下。这个旋钮的用途不变：只用来把切片收窄到跟接收端那份对齐，默认值与合法收窄值不受影响。
