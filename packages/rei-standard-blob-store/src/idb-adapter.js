// 独立数据库默认适配器：给没有自己 IndexedDB 的项目开箱即用。
// 单 store、值为裸 Blob（out-of-line key）。已有 DB 的宿主不要用这个，
// 直接拿自家 DB 方法包一个 StorageAdapter（连接管理、版本线全部自理）。

/**
 * @param {string} dbName
 * @param {{ storeName?: string }} [options]
 * @returns {import('./store.js').StorageAdapter}
 */
export function createIdbAdapter(dbName, { storeName = 'blobs' } = {}) {
  /** @type {Promise<IDBDatabase> | null} */
  let dbPromise = null;

  const open = () => {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(dbName, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
        };
        req.onsuccess = () => {
          const db = req.result;
          // 其他标签页升级 / 连接被动关闭时放掉缓存，下次访问重开（基本自愈）。
          db.onversionchange = () => { db.close(); dbPromise = null; };
          db.onclose = () => { dbPromise = null; };
          resolve(db);
        };
        req.onerror = () => {
          dbPromise = null;
          reject(req.error || new Error('indexedDB open failed'));
        };
      });
    }
    return dbPromise;
  };

  /**
   * @param {IDBTransactionMode} mode
   * @param {(store: IDBObjectStore) => IDBRequest | void} fn
   */
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeName, mode);
      const req = fn(t.objectStore(storeName));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error || new Error('transaction failed'));
      t.onabort = () => reject(t.error || new Error('transaction aborted'));
    });
  };

  return {
    get: (id) => tx('readonly', (s) => s.get(id)).then((v) => (v instanceof Blob ? v : null)),
    put: (id, blob) => tx('readwrite', (s) => { s.put(blob, id); }).then(() => undefined),
    delete: (id) => tx('readwrite', (s) => { s.delete(id); }).then(() => undefined),
    keys: () => tx('readonly', (s) => s.getAllKeys()).then((ks) => ks.map(String)),
  };
}
