// createBlobStore：令牌式 Blob 存储的核心。存储后端经 StorageAdapter 注入，
// 本模块完全不碰 IndexedDB。错误哲学：读失败 null、删失败吞、put 失败上抛
//（调用方必须知道图没存进去）、迁移失败回退原串。

import { DEFAULT_PREFIX, genId } from './token.js';
import { dataUrlToBlob, blobToDataUrl } from './dataurl.js';
import { runGc } from './gc.js';

/**
 * @typedef {Object} StorageAdapter
 * @property {(id: string) => Promise<Blob | null>} get
 * @property {(id: string, blob: Blob) => Promise<void>} put
 * @property {(id: string) => Promise<void>} delete
 * @property {() => Promise<string[]>} keys GC 扫描用；blob 表行数是千级，全量返回没有压力
 */

/**
 * @param {{ adapter: StorageAdapter, prefix?: string }} options
 */
export function createBlobStore(options) {
  const { adapter, prefix = DEFAULT_PREFIX } = options || {};
  if (!adapter) throw new TypeError('createBlobStore: adapter is required');
  // 空前缀是配置错误——不拦会让 isRef 匹配一切字符串，resolveToDataUrl 把真实 data URL 都清空。
  if (typeof prefix !== 'string' || !prefix) throw new TypeError('createBlobStore: prefix must be a non-empty string');

  /** @param {unknown} v @returns {v is string} */
  const isRef = (v) => typeof v === 'string' && v.startsWith(prefix);
  /** @param {string} ref */
  const idOf = (ref) => ref.slice(prefix.length);

  const store = {
    prefix,
    isRef,

    /**
     * 存入 Blob，返回令牌。适配器失败会上抛。
     * @param {Blob} blob
     * @returns {Promise<string>}
     */
    async put(blob) {
      const id = genId();
      await adapter.put(id, blob);
      return prefix + id;
    },

    /**
     * 令牌 → Blob。非令牌 / 不存在 / 读失败一律 null。
     * @param {unknown} token
     * @returns {Promise<Blob | null>}
     */
    async get(token) {
      if (!isRef(token)) return null;
      try {
        return (await adapter.get(idOf(token))) ?? null;
      } catch {
        return null;
      }
    },

    /**
     * best-effort 删除；非令牌不动，失败静默。
     * @param {unknown} token
     * @returns {Promise<void>}
     */
    async delete(token) {
      if (!isRef(token)) return;
      try {
        await adapter.delete(idOf(token));
      } catch { /* best-effort */ }
    },

    /**
     * 令牌 → data URL；非令牌透传；Blob 已丢、或读到的 Blob 编码失败同样返回空串（别把死令牌当 src 用）。
     * @param {string} value
     * @returns {Promise<string>}
     */
    async resolveToDataUrl(value) {
      if (!isRef(value)) return value;
      const blob = await store.get(value);
      if (!blob) return '';
      try {
        return await blobToDataUrl(blob);
      } catch {
        return '';
      }
    },

    /**
     * data URL → 令牌；失败回退原串，调用方永远拿到可渲染的值。
     * @param {string} dataUrl
     * @returns {Promise<string>}
     */
    async migrateDataUrl(dataUrl) {
      try {
        return await store.put(dataUrlToBlob(dataUrl));
      } catch {
        return dataUrl;
      }
    },

    /** 深度遍历对象树，令牌原地替换成 data URL（备份导出前调用）。 */
    async resolveDeep(root) {
      return resolveDeep(store, root);
    },

    /**
     * 孤儿 GC，语义见 gc.js。
     * @param {import('./gc.js').GcOptions} opts
     * @returns {Promise<import('./gc.js').GcResult>}
     */
    async gc(opts) {
      return runGc({ adapter, prefix }, opts);
    },
  };
  return store;
}

/**
 * 深度遍历对象树，把所有令牌字符串原地替换成 data URL。原地修改传入对象，
 * 调用方须传独立副本。解析不到的令牌置空串（图已丢，别导出恢复端认不得的死令牌）。
 * 迭代遍历 + WeakSet 防循环；同一令牌只读一次。
 * 只遍历普通对象与数组（JSON 能表达的部分），Map/Set 内容不遍历；副本须可写
 * （frozen 节点会抛）；根是字符串等非对象时为 no-op（原地修改改不了原始值，
 * 单个令牌请用 resolveToDataUrl）。
 */
async function resolveDeep(store, root) {
  if (root === null || typeof root !== 'object') return;
  /** @type {Array<{ container: any, key: string | number, ref: string }>} */
  const hits = [];
  const seen = new WeakSet();
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (seen.has(node)) continue;
    seen.add(node);
    // 数组走 keys()：洞也会产出下标，读出来是 undefined，不会中断遍历
    const keys = Array.isArray(node) ? node.keys() : Object.keys(node);
    for (const key of keys) {
      const v = node[key];
      if (store.isRef(v)) {
        hits.push({ container: node, key, ref: v });
      } else if (v !== null && typeof v === 'object') {
        stack.push(v);
      }
    }
  }
  if (!hits.length) return;
  const cache = new Map();
  // 串行 await 是刻意的——循环是 O(唯一令牌数)，瓶颈在编码不在延迟；
  // 并行会同时压满 IDB/FileReader、峰值内存起飞。
  for (const { container, key, ref } of hits) {
    let dataUrl = cache.get(ref);
    if (dataUrl === undefined) {
      dataUrl = await store.resolveToDataUrl(ref);
      cache.set(ref, dataUrl);
    }
    container[key] = dataUrl;
  }
}
