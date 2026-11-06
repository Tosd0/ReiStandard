---
"@rei-standard/amsg-shared": minor
---

`sendWebPush` 可以超时 / 中止；`verifyVapidJwt` 可以校 aud；builder 与类型守卫校验更严

**1. `sendWebPush` 新增 `signal` 和 `timeoutMs`**

`sendWebPush({ …, signal?, timeoutMs? })`：`timeoutMs` 默认 30000，`signal` 和超时合并，任一触发就停掉请求。失败一律抛 `code: 'PUSH_SEND_FAILED'` 的 `Error`：推送服务回非 2xx 时带 `statusCode`；`fetch` 本身失败、超时或中止时带 `cause`、不带 `statusCode`。响应体最多读 16 KiB，多出来的丢掉。

**2. `verifyVapidJwt(jwt, publicKey, { expectedAudience })`**

第三个参数可选。传了 `expectedAudience` 就比对 `aud`；`exp` 超过当前时间 24 小时的 token 拒绝。

**3. LLM messages 的 `role` 接受 `developer`**

`validateLlmMessagesShape` 的合法集合是 `system / developer / user / assistant / tool`。

**4. 类型守卫同时检查该 kind 的必需字段**

`isContentPush` 要求 `message` 是字符串，`isReasoningPush` 要求 `reasoningContent` 是字符串，`isToolRequestPush` 要求 `toolCalls` 是数组，`isErrorPush` 要求 `code` 和 `message` 是字符串，`isResultPush` 要求 `resultKind` 是字符串。只带 `messageKind` 的对象过不了守卫。

**5. builder 按枚举校验 `messageType` / `source`**

五个 builder 对 `messageType` 只认 `MESSAGE_TYPE` 里的值、`source` 只认 `PUSH_SOURCE` 里的值，枚举外抛 `Error`（message 形如 `[amsg-shared] ContentPush: 'messageType' must be one of 'instant' | 'fixed' | 'prompted' | 'auto'`）。

**6. `concatBytes` 认 `subarray` / `DataView`**

`toUint8` / `concatBytes` 接受任意 `ArrayBufferView`，按各自的 `byteOffset` / `byteLength` 取段，不会把底层整个 buffer 拼进去。

**7. Node 版本要求 ≥ 20.3.0**

`package.json` 的 `engines` 定为 `node >= 20.3.0`（用到 `AbortSignal.any`）。
