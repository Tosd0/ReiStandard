/**
 * Wire-protocol constants — the strings both ends of a transport must
 * agree on, byte-for-byte.
 *
 * 这是全生态唯一一份线协议常量：multipart transport 的 kind / encoding /
 * version 与默认限额（instant 发送端与 sw 重组端共用），以及 SW ↔ 页面
 * postMessage 信封的 type / event 常量（sw 广播端与页面订阅端共用）。
 * 页面侧代码请从本包 import 这些常量，而不要从 `@rei-standard/amsg-sw`
 * import —— sw 包的模块顶层带有 SW 运行时状态，在窗口环境里执行并不合适。
 * 实现在独立模块 — shared 内部按主题拆文件，index 只负责聚合导出。
 */

// ─── Generic multipart transport（`_multipart`）───────────────────────────
// instant 的 buildMultipartPushPayloads 产出、sw 的重组管线消费。两侧
// 必须逐字一致，否则分片会被静默丢弃。

/** Transport-level `messageKind` carried by every multipart chunk. */
export const MULTIPART_MESSAGE_KIND = '_multipart';

/** Chunk body encoding: JSON → UTF-8 bytes → base64url. */
export const MULTIPART_ENCODING = 'json-utf8-base64url';

/**
 * Multipart wire-format version. Producers stamp `multipart.version`
 * with this; the SW drops any chunk whose version doesn't match.
 */
export const MULTIPART_VERSION = 1;

// 默认限额 — instant 发送端与 sw 重组端的同名默认值必须一致，否则
// 发送端按默认切出的分片会被接收端按更紧的默认拒收。
export const DEFAULT_MULTIPART_TTL_MS = 60_000;
export const DEFAULT_MULTIPART_MAX_CHUNKS = 128;
export const DEFAULT_MULTIPART_MAX_TOTAL_BYTES = 256_000;

// ─── SW ↔ 页面 postMessage 信封 ──────────────────────────────────────────

/**
 * Wire-level message type for SW → client postMessage envelopes.
 * Clients filter on `e.data.type === 'REI_AMSG_PUSH'` before reading
 * `e.data.event` (which is one of {@link REI_SW_EVENT}'s values).
 */
export const REI_AMSG_POSTMESSAGE_TYPE = 'REI_AMSG_PUSH';

/**
 * Per-kind event names dispatched to controlled clients. Each push the
 * SW receives is mirrored to every window via
 * `postMessage({ type: 'REI_AMSG_PUSH', event: <one of these>, payload })`.
 *
 * The mapping is keyed by `payload.messageKind`. Legacy payloads (and
 * blob envelopes) without a `messageKind` field dispatch as
 * {@link REI_SW_EVENT.UNKNOWN_RECEIVED} so apps can still handle 2.0.x
 * producers during migration.
 */
export const REI_SW_EVENT = Object.freeze({
  CONTENT_RECEIVED: 'rei-amsg-content-received',
  REASONING_RECEIVED: 'rei-amsg-reasoning-received',
  TOOL_REQUEST_RECEIVED: 'rei-amsg-tool-request-received',
  ERROR_RECEIVED: 'rei-amsg-error-received',
  MULTIPART_EXPIRED: 'rei-amsg-multipart-expired',
  UNKNOWN_RECEIVED: 'rei-amsg-unknown-received'
});

/**
 * 页面 → SW 方向的 message type（离线队列与业务投递管线）。
 */
export const REI_SW_MESSAGE_TYPE = Object.freeze({
  ENQUEUE_REQUEST: 'REI_ENQUEUE_REQUEST',
  DELIVER: 'REI_AMSG_DELIVER',
  FLUSH_QUEUE: 'REI_FLUSH_QUEUE',
  QUEUE_RESULT: 'REI_QUEUE_RESULT'
});

export const REI_AMSG_DELIVER_MESSAGE_TYPE = REI_SW_MESSAGE_TYPE.DELIVER;
