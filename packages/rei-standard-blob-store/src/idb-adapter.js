// 独立数据库默认适配器：给没有自己 IndexedDB 的项目开箱即用。
// 单 store、值为裸 Blob（out-of-line key）。已有 DB 的宿主不要用这个，
// 直接拿自家 DB 方法包一个 StorageAdapter（连接管理、版本线全部自理）。

/**
 * @param {string} dbName
 * @param {{ storeName?: string }} [options]
 * @returns {import('./store.js').StorageAdapter}
 */
export function createIdbAdapter(dbName, { storeName = 'blobs' } = {}) {
  if (typeof dbName !== 'string' || !dbName) {
    throw new TypeError('createIdbAdapter: dbName must be a non-empty string');
  }

  /** @type {Promise<IDBDatabase> | null} */
  let dbPromise = null;

  const open = () => {
    if (!dbPromise) {
      /** @type {Promise<IDBDatabase>} */
      let pending;
      // 只清掉自己这一版缓存：旧连接的迟到事件不该把后来重开的好连接抹掉
      const dropCache = () => { if (dbPromise === pending) dbPromise = null; };
      pending = new Promise((resolve, reject) => {
        const req = indexedDB.open(dbName, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
        };
        req.onsuccess = () => {
          const db = req.result;
          // upgradeneeded 只在建库那一次触发：同一个 dbName 配第二个 storeName 时
          // store 永远建不出来，所有操作静默变 NotFoundError。这里吵着失败并说清出路。
          if (!db.objectStoreNames.contains(storeName)) {
            db.close();
            reject(new Error(`createIdbAdapter: 库 "${dbName}" 已存在但没有 store "${storeName}"——一个 dbName 只有首次创建时的 storeName 生效，要另一个 store 请换 dbName`));
            return;
          }
          // 版本钉死 1，这个库由适配器独占，没有自己的升级线（也因此 open 不会收到 blocked）。
          // 外部删库 / 浏览器强制关连接时放掉缓存，下次访问重开。
          db.onversionchange = () => { db.close(); dropCache(); };
          db.onclose = dropCache;
          resolve(db);
        };
        req.onerror = () => reject(req.error || new Error('indexedDB open failed'));
      });
      // 开库失败一律不留缓存——包括没有 indexedDB 全局时的同步抛（那种情况 onerror 根本没挂上）
      pending.catch(dropCache);
      dbPromise = pending;
    }
    return dbPromise;
  };

  /**
   * @param {IDBTransactionMode} mode
   * @param {(store: IDBObjectStore) => IDBRequest} fn
   */
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeName, mode);
      const req = fn(t.objectStore(storeName));
      t.oncomplete = () => resolve(req && req.result);
      // 注意：error 事件派发时 t.error 还是 null（规范在 abort 步骤才赋值），
      // 真错在 request 上——别让 QuotaExceededError 变成无用的 'transaction failed'。
      t.onerror = () => reject((req && req.error) || t.error || new Error('transaction failed'));
      t.onabort = () => reject(t.error || (req && req.error) || new Error('transaction aborted'));
    });
  };

  return {
    get: (id) => tx('readonly', (s) => s.get(id)).then((v) => (v instanceof Blob ? v : null)),
    put: (id, blob) => tx('readwrite', (s) => s.put(blob, id)).then(() => undefined),
    delete: (id) => tx('readwrite', (s) => s.delete(id)).then(() => undefined),
    keys: () => tx('readonly', (s) => s.getAllKeys()).then((ks) => ks.map(String)),
  };
}
