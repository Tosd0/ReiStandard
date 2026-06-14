/**
 * Minimal, *controllable* in-memory IndexedDB fake for resilience tests.
 *
 * It implements only the slice of the IndexedDB surface that
 * `src/index.js` actually touches:
 *   - indexedDB.open() with onupgradeneeded / onsuccess / onerror
 *   - db.transaction() that THROWS InvalidStateError once the connection
 *     is closed (via db.close()) or force-killed (db._forceDead())
 *   - db.onversionchange / db.onclose hooks
 *   - object stores: add / get / put / delete / count / getAll /
 *     getAllKeys / openCursor + a single `expiresAt` index
 *   - IDBKeyRange.upperBound()
 *
 * Why hand-rolled instead of `fake-indexeddb`: this package ships with
 * zero runtime deps and the tests must be able to *deliberately* put a
 * cached connection into the "closing" state to reproduce the strong-close
 * bug. A real polyfill never lets you do that.
 *
 * Async semantics mirror real IDB: request callbacks fire on a later
 * microtask, so the source's `request.onsuccess = ...` assignment (which
 * happens *after* the call) is always in place before the callback runs.
 */

class FakeDOMException extends Error {
  constructor(message, name) {
    super(message);
    this.name = name;
  }
}

function fire(handler, arg) {
  if (typeof handler === 'function') handler(arg);
}

function schedule(fn) {
  queueMicrotask(fn);
}

function valueAtPath(record, keyPath) {
  if (record == null) return undefined;
  return record[keyPath];
}

function inRange(value, range) {
  if (!range) return true;
  if (range._type === 'upperBound') {
    return range.upperOpen ? value < range.upper : value <= range.upper;
  }
  return true;
}

export const FakeIDBKeyRange = {
  upperBound(upper, upperOpen = false) {
    return { _type: 'upperBound', upper, upperOpen };
  },
};

class FakeRequest {
  constructor() {
    this.onsuccess = null;
    this.onerror = null;
    this.result = undefined;
    this.error = null;
  }
}

class FakeIndex {
  constructor(store, def) {
    this._store = store;
    this._keyPath = def.keyPath;
  }

  _matching(range) {
    const out = [];
    for (const [primaryKey, value] of this._store._data.records.entries()) {
      if (inRange(valueAtPath(value, this._keyPath), range)) {
        out.push({ primaryKey, value });
      }
    }
    return out;
  }

  getAll(range) {
    const req = new FakeRequest();
    const rows = this._matching(range);
    schedule(() => {
      req.result = rows.map((r) => r.value);
      fire(req.onsuccess);
    });
    return req;
  }

  getAllKeys(range) {
    const req = new FakeRequest();
    const rows = this._matching(range);
    schedule(() => {
      req.result = rows.map((r) => r.primaryKey);
      fire(req.onsuccess);
    });
    return req;
  }

  openCursor(range) {
    const req = new FakeRequest();
    const store = this._store;
    const keys = this._matching(range).map((r) => r.primaryKey);
    let i = 0;

    const step = () => {
      schedule(() => {
        if (i >= keys.length) {
          req.result = null;
          fire(req.onsuccess);
          return;
        }
        const primaryKey = keys[i];
        const cursor = {
          delete() {
            const dreq = new FakeRequest();
            schedule(() => {
              store._data.records.delete(primaryKey);
              dreq.result = undefined;
              fire(dreq.onsuccess);
            });
            return dreq;
          },
          continue() {
            i += 1;
            step();
          },
        };
        req.result = cursor;
        fire(req.onsuccess);
      });
    };

    step();
    return req;
  }
}

class FakeObjectStore {
  constructor(transaction, data) {
    this.transaction = transaction;
    this._data = data;
    this.keyPath = data.keyPath;
    this.indexNames = {
      contains: (name) => data.indexes.has(name),
    };
  }

  _key(record) {
    let key = valueAtPath(record, this._data.keyPath);
    if (key === undefined && this._data.autoIncrement) {
      this._data.autoIncrementCounter += 1;
      key = this._data.autoIncrementCounter;
      record[this._data.keyPath] = key;
    }
    return key;
  }

  add(record) {
    const req = new FakeRequest();
    const key = this._key(record);
    schedule(() => {
      if (this._data.records.has(key)) {
        req.error = new FakeDOMException('Key already exists', 'ConstraintError');
        const event = {
          _prevented: false,
          preventDefault() { this._prevented = true; },
        };
        fire(req.onerror, event);
        if (!event._prevented) this.transaction._fail(req.error);
        return;
      }
      this._data.records.set(key, record);
      req.result = key;
      fire(req.onsuccess);
      this.transaction._settleSimple();
    });
    return req;
  }

  put(record) {
    const req = new FakeRequest();
    const key = this._key(record);
    schedule(() => {
      this._data.records.set(key, record);
      req.result = key;
      fire(req.onsuccess);
      this.transaction._settleSimple();
    });
    return req;
  }

  get(key) {
    const req = new FakeRequest();
    schedule(() => {
      req.result = this._data.records.has(key) ? this._data.records.get(key) : undefined;
      fire(req.onsuccess);
      this.transaction._settleSimple();
    });
    return req;
  }

  delete(key) {
    const req = new FakeRequest();
    schedule(() => {
      this._data.records.delete(key);
      req.result = undefined;
      fire(req.onsuccess);
      this.transaction._settleSimple();
    });
    return req;
  }

  count(key) {
    const req = new FakeRequest();
    schedule(() => {
      req.result = key === undefined
        ? this._data.records.size
        : (this._data.records.has(key) ? 1 : 0);
      fire(req.onsuccess);
      this.transaction._settleSimple();
    });
    return req;
  }

  getAll() {
    const req = new FakeRequest();
    schedule(() => {
      req.result = Array.from(this._data.records.values());
      fire(req.onsuccess);
      this.transaction._settleSimple();
    });
    return req;
  }

  createIndex(name, keyPath, options = {}) {
    this._data.indexes.set(name, { keyPath, unique: Boolean(options.unique) });
    return new FakeIndex(this, this._data.indexes.get(name));
  }

  index(name) {
    const def = this._data.indexes.get(name);
    if (!def) throw new FakeDOMException(`No index ${name}`, 'NotFoundError');
    return new FakeIndex(this, def);
  }
}

class FakeTransaction {
  constructor(db, storeNames, mode) {
    this.db = db;
    this.mode = mode;
    this.error = null;
    this.onerror = null;
    this.oncomplete = null;
    this.onabort = null;
    this._storeNames = Array.isArray(storeNames) ? storeNames : [storeNames];
    this._completed = false;
    this._failed = false;
  }

  objectStore(name) {
    const data = this.db._meta.stores.get(name);
    if (!data) throw new FakeDOMException(`No object store ${name}`, 'NotFoundError');
    return new FakeObjectStore(this, data);
  }

  // Fire oncomplete once the simple (non-cursor) request that drove this
  // transaction has resolved. Good enough for the single-op transactions
  // the queue store relies on (`withQueueStore`).
  _settleSimple() {
    if (this._completed || this._failed) return;
    this._completed = true;
    schedule(() => fire(this.oncomplete));
  }

  _fail(error) {
    if (this._failed || this._completed) return;
    this._failed = true;
    this.error = error;
    schedule(() => fire(this.onerror));
  }

  abort() {
    this._fail(new FakeDOMException('aborted', 'AbortError'));
  }
}

class FakeDatabase {
  constructor(fake, meta) {
    this._fake = fake;
    this._meta = meta;
    this._closed = false;
    this._dead = false;
    this.onversionchange = null;
    this.onclose = null;
    this.objectStoreNames = {
      contains: (name) => this._meta.stores.has(name),
    };
  }

  transaction(storeNames, mode = 'readonly') {
    if (this._closed || this._dead) {
      throw new FakeDOMException(
        "Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.",
        'InvalidStateError',
      );
    }
    return new FakeTransaction(this, storeNames, mode);
  }

  createObjectStore(name, options = {}) {
    const data = {
      name,
      keyPath: options.keyPath,
      autoIncrement: Boolean(options.autoIncrement),
      autoIncrementCounter: 0,
      records: new Map(),
      indexes: new Map(),
    };
    this._meta.stores.set(name, data);
    const upgradeTx = new FakeTransaction(this, [name], 'versionchange');
    return new FakeObjectStore(upgradeTx, data);
  }

  close() {
    this._closed = true;
  }

  /** Test hook: simulate the browser force-closing this connection. */
  _forceDead() {
    this._dead = true;
  }

  /** Test hook: dispatch the `close` event the way the browser would. */
  _emitClose() {
    fire(this.onclose);
  }
}

export class FakeIndexedDB {
  constructor() {
    this._databases = new Map(); // name -> { version, stores: Map }
    this._connections = new Map(); // name -> last opened FakeDatabase
    this.openCount = 0;
  }

  open(name, version = 1) {
    this.openCount += 1;
    const req = new FakeRequest();
    req.transaction = null;

    let meta = this._databases.get(name);
    const isNew = !meta;
    if (isNew) {
      meta = { version: 0, stores: new Map() };
      this._databases.set(name, meta);
    }
    const needsUpgrade = version > meta.version;

    const db = new FakeDatabase(this, meta);
    req.result = db;

    schedule(() => {
      if (needsUpgrade) {
        const upgradeTx = new FakeTransaction(db, [], 'versionchange');
        upgradeTx.objectStore = (storeName) => {
          const data = meta.stores.get(storeName);
          if (!data) throw new FakeDOMException(`No object store ${storeName}`, 'NotFoundError');
          return new FakeObjectStore(upgradeTx, data);
        };
        req.transaction = upgradeTx;
        meta.version = version;
        fire(req.onupgradeneeded, { oldVersion: 0, newVersion: version });
        req.transaction = null;
      }
      this._connections.set(name, db);
      fire(req.onsuccess);
    });

    return req;
  }

  /** Most recently opened (and therefore cached) connection for a db name. */
  lastConnection(name) {
    return this._connections.get(name);
  }

  deleteDatabase(name) {
    const req = new FakeRequest();
    this._databases.delete(name);
    this._connections.delete(name);
    schedule(() => fire(req.onsuccess));
    return req;
  }
}

/**
 * Install a fresh fake IndexedDB onto globalThis and return it. Call once
 * at module scope of a test file; `node --test` isolates each file in its
 * own process so this never leaks into the memory-fallback suites.
 */
export function installFakeIndexedDB() {
  const fake = new FakeIndexedDB();
  globalThis.indexedDB = fake;
  globalThis.IDBKeyRange = FakeIDBKeyRange;
  return fake;
}
