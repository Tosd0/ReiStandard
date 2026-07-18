/**
 * client_state 大值透明分块（单用户/D1 专用；handlers/client-state.js 与
 * lib/agentic-fire.js 的 readState 共用）。
 *
 * 存储格式（库内部实现细节，不进公开契约）：
 *   - 单条 value ≤ STATE_CHUNK_SLICE_BYTES（200KB）→ 历史单行路径，存储字节级不变。
 *   - 超过 → 服务端切片跨行：原 (namespace, key) 行的 value 写成纯文本 marker
 *     （`\u001famsg-chunked\u001fv1\u001f<块数>`），切片本体逐片
 *     encryptForStorage 后存进保留 namespace（`\u001famsg-chunks\u001f<原ns>`），
 *     key 为 `<原key>\u001f<序号>`。写入方与读取方（客户端 / hook 作者）完全无感。
 *   - marker 以 \u001f (Unit Separator) 开头；encryptForStorage 输出是
 *     `hex:hex:hex`，永远不以控制字符开头，两种行值不会混淆。
 *
 * 读取完整性：块必须齐全，且每块 updated_at 与根行一致（同一次写入的印记）。
 * 不满足（写到一半断了 / 新旧写交错）→ 该 key 视为不存在，读方走自己的兜底，
 * 不抛错、不吐半截数据。
 *
 * 保留字符：namespace / key 里的 C0 控制字符（\u0000-\u001f）为库内部保留，
 * handler 对用户输入逐条拒绝。内部分隔符选 \u001f 而不是 NUL，因为 SQLite 的
 * LIKE 在 \u0000 处截断 pattern，前缀清理会失效。
 */

import { chunkReasoningByUtf8Bytes } from '@rei-standard/amsg-shared';

// 每个切片行的 plaintext 上限 = 历史单条上限，沿用已验证的行大小。
export const STATE_CHUNK_SLICE_BYTES = 200 * 1024;
// 单条 value 总上限的默认值（工厂配置 maxStateValueBytes 可调）。
export const DEFAULT_MAX_STATE_VALUE_BYTES = 5 * 1024 * 1024;
// 用户输入里的保留字符（namespace / key 逐条拒绝）。
export const INTERNAL_STATE_CHAR_RE = /[\u0000-\u001f]/;

const SEP = '\u001f';
const CHUNK_NS_PREFIX = `${SEP}amsg-chunks${SEP}`;
const ROOT_MARKER_PREFIX = `${SEP}amsg-chunked${SEP}v1${SEP}`;

/** 某个用户 namespace 的切片行所在的保留 namespace。 */
export function chunkNamespaceFor(namespace) {
  return CHUNK_NS_PREFIX + namespace;
}

/** 第 index 片的存储 key。 */
export function chunkKeyFor(key, index) {
  return `${key}${SEP}${index}`;
}

/** 清理某 key 全部切片行用的 key 前缀。 */
export function chunkKeyPrefixFor(key) {
  return `${key}${SEP}`;
}

/** 分块根行的 value（纯文本 marker，不加密——不含用户数据）。 */
export function buildChunkedRootValue(chunkCount) {
  return `${ROOT_MARKER_PREFIX}${chunkCount}`;
}

/**
 * 严格解析根行 marker。不是 marker（普通密文 / 任意文本 / 计数非正整数）
 * → null，调用方按普通单行处理。
 *
 * @param {unknown} value
 * @returns {number | null}
 */
export function parseChunkedRootCount(value) {
  if (typeof value !== 'string' || !value.startsWith(ROOT_MARKER_PREFIX)) return null;
  const raw = value.slice(ROOT_MARKER_PREFIX.length);
  if (!/^[1-9][0-9]*$/.test(raw)) return null;
  return Number(raw);
}

/**
 * 把超限 value 切成 ≤ STATE_CHUNK_SLICE_BYTES 的切片。切点在码点边界
 * （chunkReasoningByUtf8Bytes 保证多字节字符 / emoji 代理对不被劈开，
 * join('') === 原文）。
 *
 * @param {string} value
 * @returns {string[]}
 */
export function splitStateValue(value) {
  return chunkReasoningByUtf8Bytes(value, STATE_CHUNK_SLICE_BYTES);
}

/**
 * 把一个 namespace 的存储行解析成逻辑条目（GET /client-state 与 readState
 * 共用）。普通行解密直读；分块根行按 marker 拼回。切片行查询是惰性的：
 * 整个 namespace 没有分块根行时一次都不发。
 *
 * @param {Array<{ namespace: string, key: string, value: string, updated_at: number }>} rows
 *   用户 namespace 的存储行（getClientState 返回值）。
 * @param {() => Promise<Array<{ key: string, value: string, updated_at: number }>>} fetchChunkRows
 *   取该 namespace 对应保留 namespace 的全部切片行（最多调用一次）。
 * @param {(value: string) => Promise<string>} decryptValue
 * @returns {Promise<Array<{ namespace: string, key: string, value: string, updatedAt: number }>>}
 */
export async function resolveClientStateEntries(rows, fetchChunkRows, decryptValue) {
  let chunkMap = null;
  const loadChunks = async () => {
    if (chunkMap === null) {
      const chunkRows = await fetchChunkRows();
      chunkMap = new Map(chunkRows.map((row) => [row.key, row]));
    }
    return chunkMap;
  };

  const entries = [];
  for (const row of rows) {
    const count = parseChunkedRootCount(row.value);
    if (count === null) {
      entries.push({
        namespace: row.namespace,
        key: row.key,
        value: await decryptValue(row.value),
        updatedAt: row.updated_at,
      });
      continue;
    }

    const map = await loadChunks();
    const chunkRows = [];
    let intact = true;
    for (let i = 0; i < count; i++) {
      const chunk = map.get(chunkKeyFor(row.key, i));
      if (!chunk || chunk.updated_at !== row.updated_at) {
        intact = false;
        break;
      }
      chunkRows.push(chunk);
    }
    if (!intact) continue; // 写到一半断了 → 该 key 视为不存在

    const parts = await Promise.all(chunkRows.map((chunk) => decryptValue(chunk.value)));
    entries.push({
      namespace: row.namespace,
      key: row.key,
      value: parts.join(''),
      updatedAt: row.updated_at,
    });
  }
  return entries;
}
