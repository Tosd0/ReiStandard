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
 * `MULTIPART_EXPIRED` 事件上带的 `reason`：这条 multipart id 是怎么废的。
 * 页面靠它区分「等到 TTL 也没收齐」和「当场就判废了」——两种都别再等，但后
 * 者通常意味着发送端或链路有问题，值得报上去。
 */
export const MULTIPART_FAILURE_REASON = Object.freeze({
  /** TTL 到期仍未收齐，或收到的分片本身已经过期。 */
  TTL_EXPIRED: 'ttl-expired',
  /** 分片信封不合规：version / encoding 对不上、index 越界、chunk 不是合法 base64url。 */
  INVALID_CHUNK: 'invalid-chunk',
  /** 同一个 id 的分片报了不一样的 total / encoding，已收的部分拼不回去。 */
  CHUNK_CONFLICT: 'chunk-conflict',
  /** 累计字节数超过 maxTotalBytes。 */
  SIZE_LIMIT_EXCEEDED: 'size-limit-exceeded',
  /** 收齐了但拼不回原 payload（缺片、超限、JSON 解不开）。 */
  RESTORE_FAILED: 'restore-failed',
  /** 分片仓库（IndexedDB）读写失败。 */
  STORAGE_FAILED: 'storage-failed',
  /** 接收端把 multipart 关了（`multipart.enabled === false`），分片没法重组。 */
  DISABLED: 'disabled'
});

/**
 * 页面 → SW 方向的 message type（离线队列与业务投递管线）。
 */
export const REI_SW_MESSAGE_TYPE = Object.freeze({
  ENQUEUE_REQUEST: 'REI_ENQUEUE_REQUEST',
  DELIVER: 'REI_AMSG_DELIVER',
  FLUSH_QUEUE: 'REI_FLUSH_QUEUE',
  /**
   * 入队的点对点回执：谁发的 ENQUEUE_REQUEST 就回给谁一条，一次一条。
   * 没转 MessagePort 过来时会落到全局的 `navigator.serviceWorker` message
   * 监听器上。
   */
  QUEUE_RESULT: 'REI_QUEUE_RESULT',
  /**
   * 队列请求被永久拒绝、即将从队列里删掉时广播给所有窗口的一条。
   *
   * 跟 QUEUE_RESULT 分开是因为两者的收信人不是一回事：这条是广播，可能来自后台
   * `sync` 冲刷、说的也可能是另一条八竿子打不着的旧请求。共用一个 type 的话，
   * 页面等自己那条入队回执时会先收到这一条、当成自己的结果处理。
   */
  QUEUE_DROPPED: 'REI_QUEUE_DROPPED'
});

export const REI_AMSG_DELIVER_MESSAGE_TYPE = REI_SW_MESSAGE_TYPE.DELIVER;
