// multipart transport 的线协议常量（kind / encoding / version 与接收端限额
// 默认值）与发送端切片构造，单一来源都在 @rei-standard/amsg-shared —— sw 的
// 重组端、amsg-server 的发送端认的是同一份。
// 这里 re-export 保持本包既有导出名不变。
export {
  MULTIPART_MESSAGE_KIND,
  DEFAULT_MULTIPART_TTL_MS,
  DEFAULT_MULTIPART_MAX_CHUNKS,
  DEFAULT_MULTIPART_MAX_TOTAL_BYTES,
  DEFAULT_MULTIPART_CHUNK_BYTES,
  buildMultipartPushPayloads,
} from '@rei-standard/amsg-shared';

import { buildMultipartPushPayloads } from '@rei-standard/amsg-shared';

// ─── maxChunkBytes 的上限校验 ──────────────────────────────────────────
//
// 推送服务（FCM / APNs / Mozilla autopush）限的是 POST 上去的**密文** body，
// 上限 4096 字节。明文能塞多少要把 aes128gcm 的固定开销减掉：
//
//   密文 body = header(86) + 明文 + 填充分隔符(1) + GCM auth tag(16)
//   header    = salt(16) + record size(4) + keyid 长度(1) + keyid(65)
//
// 开销固定 103 字节，明文上限 4096 - 103 = 3993 字节（UTF-8 计）。这份推导
// 在 amsg-server 的 webpush-webcrypto.js 有对称的一份——两个包刻意不互相
// import，小常量各自复制。

/** 推送服务对加密后 body 的上限（字节）。 */
const WEB_PUSH_MAX_BODY_BYTES = 4096;
/** aes128gcm 固定开销：header 86 + 填充分隔符 1 + GCM tag 16。 */
const WEB_PUSH_ENCRYPTION_OVERHEAD_BYTES = 16 + 4 + 1 + 65 + 1 + 16;
/** 一条 push 的明文（JSON 字符串）上限，UTF-8 字节数。 */
const MAX_PUSH_PAYLOAD_BYTES = WEB_PUSH_MAX_BODY_BYTES - WEB_PUSH_ENCRYPTION_OVERHEAD_BYTES;

const PROBE_BYTE_ENCODER = new TextEncoder();

/**
 * n 字节编成 base64url（不带 padding）后的字符数。
 *
 * @param {number} n
 * @returns {number}
 */
function base64UrlLength(n) {
  return Math.ceil(n * 4 / 3);
}

/**
 * maxChunkBytes 的上限校验：满载一片的**信封**（chunk 经 base64url 膨胀 4/3，
 * 再套上分片元数据的 JSON）必须仍装得进单条 push 的明文上限。
 *
 * 这个旋钮只用来把切片**收窄**到跟接收端对齐；配得比上限大的话，每一片都在
 * 发送时被推送服务拒收——每次触发都失败，报的还是一条跟配置对不上号的推送错
 * 误。配置错误就该在配置这一层吵着失败（createInstantHandler 当场抛），不留
 * 到每次投递才炸。
 *
 * 上限不写死成常量，而是现算：拿真实的 buildMultipartPushPayloads 造一片最小
 * 探针量出信封开销（id / createdAt 等定宽字段取的就是真实值），再把 index /
 * total 的位数按 maxChunks 补足到最坏情况——shared 那边信封格式变了，这里跟着
 * 变，不会留下一个过时的魔数。
 *
 * @param {{ maxChunkBytes: number, maxChunks: number, ttlMs: number }} resolved
 */
export function assertChunkBytesFitPushLimit({ maxChunkBytes, maxChunks, ttlMs }) {
  // 最小探针：3 字节原文 → base64url 后恰好 4 字符，信封开销 = 总长 - 4。
  const PROBE_CHUNK_BYTES = 3;
  const [probe] = buildMultipartPushPayloads(
    { messageKind: 'reasoning' },
    { serializedPayload: 'x'.repeat(PROBE_CHUNK_BYTES), maxChunkBytes: PROBE_CHUNK_BYTES, ttlMs }
  );
  // index / total 在真实批次里最多到 maxChunks（探针里各只有 1 位）。
  const digitHeadroom = 2 * (String(maxChunks).length - 1);
  const envelopeOverhead = PROBE_BYTE_ENCODER.encode(JSON.stringify(probe)).byteLength
    - base64UrlLength(PROBE_CHUNK_BYTES) + digitHeadroom;

  const worstEnvelopeBytes = envelopeOverhead + base64UrlLength(maxChunkBytes);
  if (worstEnvelopeBytes <= MAX_PUSH_PAYLOAD_BYTES) return;

  let maxAllowed = Math.floor((MAX_PUSH_PAYLOAD_BYTES - envelopeOverhead) * 3 / 4);
  while (maxAllowed > 0 && envelopeOverhead + base64UrlLength(maxAllowed) > MAX_PUSH_PAYLOAD_BYTES) {
    maxAllowed--;
  }
  throw new TypeError(
    `[amsg-instant] multipart.maxChunkBytes = ${maxChunkBytes} 切出的分片`
    + `信封最坏 ${worstEnvelopeBytes} 字节，超过单条 push 明文上限 ${MAX_PUSH_PAYLOAD_BYTES} 字节，`
    + `每一片都会被推送服务拒收。这个旋钮只用于收窄，当前配置下最大 ${maxAllowed}`
  );
}
