---
"@rei-standard/amsg-shared": minor
"@rei-standard/amsg-instant": patch
"@rei-standard/amsg-sw": patch
---

线协议常量收敛到 shared：新模块 `shared/src/protocol.js` 承载 multipart transport 与 SW ↔ 页面 postMessage 的全部线协议常量，从包根导出

此前 multipart 的 kind / encoding / 默认限额在 instant（`src/multipart.js`，导出）与 sw（`src/index.js`，本地重写、未导出）各写一份，`version: 1` 字面量也两侧各写；SW ↔ 页面 postMessage 常量只定义在 sw 包里，README 教页面侧硬编码字符串。现在单一来源在 shared：

- multipart：`MULTIPART_MESSAGE_KIND` / `MULTIPART_ENCODING` / `MULTIPART_VERSION`（新增，替代两侧的 `version: 1` 字面量）/ `DEFAULT_MULTIPART_TTL_MS` / `DEFAULT_MULTIPART_MAX_CHUNKS` / `DEFAULT_MULTIPART_MAX_TOTAL_BYTES`
- postMessage 信封：`REI_AMSG_POSTMESSAGE_TYPE` / `REI_SW_EVENT` / `REI_SW_MESSAGE_TYPE` / `REI_AMSG_DELIVER_MESSAGE_TYPE`

instant 的 `src/multipart.js` 与 sw 的 `src/index.js` 改为 import shared 并按原导出名 re-export，两个包的公开导出面与 wire format 不变（`DEFAULT_MULTIPART_CHUNK_BYTES` 是发送端独有的切片默认值，留在 instant）。页面侧代码现在可以从 `@rei-standard/amsg-shared` import 这些常量，不必硬编码字符串，也不必从 sw 包 import（那会执行 SW 模块的顶层状态）；client / sw 的 README 示例已相应更新。
