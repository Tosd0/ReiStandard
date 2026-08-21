// createBlobStore：令牌式 Blob 存储的核心。存储后端经 StorageAdapter 注入，
// 本模块完全不碰 IndexedDB。错误哲学：读失败 null、删失败吞、put 失败上抛
//（调用方必须知道图没存进去）、迁移失败回退原串。

import { DEFAULT_PREFIX, genId } from './token.js';
import { dataUrlToBlob, blobToDataUrl } from './dataurl.js';
import { runGc } from './gc.js';
import { runContentScan } from './content-scan.js';

// 与 extractRefs 的 id 边界字符集保持一致（见 token.js；gc.js 的 ID_CHARSET 同源）。
// restore 按它拒收字符集外的 id：这类 id 一旦写入，extractRefs 在引用面上提不全它、
// GC 只能靠安全阀永久豁免，等于制造永不可回收的存量。
const ID_CHARSET = /^[A-Za-z0-9_]+$/;

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
     * @throws {TypeError} 入参不是 Blob——非 Blob 往往能被适配器存下，但 get 侧会归一成
     *   null，等于静默产出一个永远解析为空的死令牌。编程错误吵着抛；
     *   跨 realm 的 instanceof 不可靠，按能力鸭子判定。
     */
    async put(blob) {
      if (!blob || typeof blob.arrayBuffer !== 'function' || typeof blob.slice !== 'function') {
        throw new TypeError('put: 需要 Blob；data URL 字符串请走 migrateDataUrl');
      }
      const id = genId();
      await adapter.put(id, blob);
      return prefix + id;
    },

    /**
     * 备份导入用：把 Blob 写回令牌原有的 id 下。put 永远生成新 id，而导入要的是
     * 「原令牌继续有效」——业务字段里存的还是旧令牌，Blob 必须回到旧 id 上，令牌身份才不丢。
     * 同一 id 重复 restore 是覆盖，属预期语义（同一份备份导两遍幂等）。
     * 适配器失败会上抛（调用方必须知道没写进去），与 put 同族哲学。
     * @param {string} token 本 store 前缀的令牌，id 段须完整落在 [A-Za-z0-9_] 内
     * @param {Blob} blob
     * @returns {Promise<void>}
     * @throws {TypeError} token 不是本 store 的令牌、id 为空或含字符集外字符——这是编程/
     *   数据错误，吵着抛（字符集外的 id 会成为 GC 永不可回收的存量，见 ID_CHARSET 注释）；
     *   blob 的鸭子判定与 put 相同，拒收非 Blob。
     */
    async restore(token, blob) {
      if (!isRef(token)) {
        throw new TypeError(`restore: 需要本 store 前缀的令牌（形如 ${prefix}<id>）`);
      }
      if (!ID_CHARSET.test(idOf(token))) {
        throw new TypeError('restore: 令牌 id 须非空且完整落在 [A-Za-z0-9_] 内——字符集外的 id 引用提取不全、GC 永不能回收');
      }
      if (!blob || typeof blob.arrayBuffer !== 'function' || typeof blob.slice !== 'function') {
        throw new TypeError('restore: 需要 Blob');
      }
      await adapter.put(idOf(token), blob);
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
     * 内容查重：扫全库、按内容哈希分组，找出哪些令牌指着同一份内容。纯只读，语义见 content-scan.js。
     * 合并引用由宿主自己做（引用面长什么样只有宿主知道），合并完多出来的 Blob 交给 GC 收。
     * @param {import('./content-scan.js').ContentScanOptions} [opts]
     * @returns {Promise<import('./content-scan.js').ContentScanResult>}
     */
    async scanContent(opts) {
      return runContentScan({ adapter, prefix }, opts);
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
 * 只遍历普通对象与数组（JSON 能表达的部分），Map/Set 内容不遍历，二进制视图
 * （TypedArray/DataView）整块跳过；副本须可写
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
    // 二进制视图整块跳过：元素只能是数字、结构上不含令牌，而 Object.keys 会把每个
    // 下标物化成字符串键——几十 MB 的波形/纹理够把备份导出拖垮甚至 OOM。
    // structuredClone 不保留视图上的 expando（数组会保留、视图不会），
    // 按「传独立副本」的契约跳过零损失。
    if (ArrayBuffer.isView(node)) continue;
    // Object.keys 对数组同时覆盖下标键与 expando 属性（structuredClone 会保留后者）；
    // 稀疏数组的洞没有自有键、直接跳过，同样不会中断遍历
    const keys = Object.keys(node);
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
