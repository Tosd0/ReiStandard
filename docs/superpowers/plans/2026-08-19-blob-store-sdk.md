# @rei-standard/blob-store 包实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现并发布 `@rei-standard/blob-store` 首个 next 版——令牌式 Blob 存储 core + 孤儿 GC + `/react` 子路径。

**Architecture:** 单包多模块：`token.js`（id/令牌/提取）→ `dataurl.js`（互转）→ `store.js`（createBlobStore，经适配器读写）→ `gc.js`（mark-and-sweep）→ `idb-adapter.js`（独立 DB 默认适配器）→ `react.js`（objectURL hook，独立入口）。core 零运行时依赖，完全不直接碰 IndexedDB。

**Tech Stack:** JS 源码 + JSDoc 类型（仓库惯例，d.ts 由 `tsc --allowJs --emitDeclarationOnly` 生成）、tsup 双格式、`node --test`、fake-indexeddb（仅测试）、changesets pre 模式发 `next`。

**设计依据:** `docs/superpowers/specs/2026-08-19-blob-store-design.md`。行为语义（错误哲学、GC 三道安全阀、备份互操作）以 spec 为准。

**工作分支:** `feat/blob-store`（已从 origin/main 建出）。所有命令在仓库根目录执行。

---

## 文件结构

```
packages/rei-standard-blob-store/
├── package.json          # 双入口 exports（. 和 ./react），react 是 optional peerDep
├── tsconfig.json         # allowJs + emitDeclarationOnly，include src/**/*.js
├── tsup.config.js        # entry: index + react，external: ['react']
├── LICENSE               # 从 amsg/shared 复制
├── README.md             # 最小接入示例 + 宿主义务（GC 引用面清单）
├── src/
│   ├── index.js          # 公共出口：createBlobStore、createIdbAdapter、工具函数
│   ├── token.js          # genId / parseIdTimestamp / extractRefs / DEFAULT_PREFIX
│   ├── dataurl.js        # dataUrlToBlob / blobToDataUrl（fromBase64 快路径 + 回退）
│   ├── store.js          # createBlobStore：put/get/delete/isRef/resolve*/migrate/gc
│   ├── gc.js             # runGc：mark-and-sweep + 三道安全阀
│   ├── idb-adapter.js    # createIdbAdapter：独立 DB 开箱即用
│   └── react.js          # useBlobUrl（./react 独立入口，不进 index.js）
└── test/
    ├── helpers.mjs       # memoryAdapter（Map 内存假适配器）
    ├── token.test.mjs
    ├── dataurl.test.mjs
    ├── store.test.mjs
    ├── gc.test.mjs
    ├── idb-adapter.test.mjs
    └── exports.test.mjs  # 公共 API 表面守卫（照 amsg-client 的惯例）
```

另改根目录：`package.json`（workspaces 加一行）、`package-lock.json`（npm install 生成）、`standards/blob-storage.md`（新增规范文档）。

---

### Task 1: 包脚手架 + workspace 注册

**Files:**
- Modify: `package.json`（仓库根）
- Create: `packages/rei-standard-blob-store/package.json`
- Create: `packages/rei-standard-blob-store/tsconfig.json`
- Create: `packages/rei-standard-blob-store/tsup.config.js`
- Create: `packages/rei-standard-blob-store/LICENSE`（复制）
- Create: `packages/rei-standard-blob-store/src/index.js`（暂时只有一行注释导出）

- [ ] **Step 1: 根 package.json 的 workspaces 加入新包**

`package.json` 的 `"workspaces"` 数组改为：

```json
  "workspaces": [
    "packages/rei-standard-amsg/*",
    "packages/rei-standard-blob-store",
    "examples"
  ],
```

- [ ] **Step 2: 建包目录与 package.json**

```bash
mkdir -p packages/rei-standard-blob-store/src packages/rei-standard-blob-store/test
cp packages/rei-standard-amsg/shared/LICENSE packages/rei-standard-blob-store/LICENSE
```

`packages/rei-standard-blob-store/package.json`：

```json
{
  "name": "@rei-standard/blob-store",
  "version": "0.0.0",
  "description": "ReiStandard token-based Blob storage — binary in IndexedDB, a short blobref: token in your data fields; orphan GC included",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/Tosd0/ReiStandard.git",
    "directory": "packages/rei-standard-blob-store"
  },
  "license": "MIT",
  "type": "module",
  "sideEffects": false,
  "publishConfig": {
    "access": "public"
  },
  "main": "./dist/index.cjs",
  "module": "./dist/index.mjs",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.mjs",
      "require": "./dist/index.cjs"
    },
    "./react": {
      "types": "./dist/react.d.ts",
      "import": "./dist/react.mjs",
      "require": "./dist/react.cjs"
    }
  },
  "files": [
    "dist"
  ],
  "scripts": {
    "build": "tsup && tsc -p tsconfig.json && node -e \"const fs=require('fs');for(const f of fs.readdirSync('dist'))if(f.endsWith('.d.ts'))fs.copyFileSync('dist/'+f,'dist/'+f.slice(0,-5)+'.d.cts')\"",
    "test": "node --test test/*.test.mjs"
  },
  "engines": {
    "node": ">=20"
  },
  "peerDependencies": {
    "react": ">=17"
  },
  "peerDependenciesMeta": {
    "react": {
      "optional": true
    }
  },
  "devDependencies": {
    "@types/react": "^18.0.0",
    "fake-indexeddb": "^6.0.0",
    "react": "^18.0.0",
    "tsup": "^8.0.0",
    "typescript": "^5.0.0"
  }
}
```

- [ ] **Step 3: tsconfig.json**（照 amsg/shared，include 放宽到全部 src）

`packages/rei-standard-blob-store/tsconfig.json`：

```json
{
  "compilerOptions": {
    "allowJs": true,
    "checkJs": false,
    "declaration": true,
    "emitDeclarationOnly": true,
    "outDir": "dist",
    "rootDir": "src",
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "node",
    "strict": false,
    "skipLibCheck": true,
    "esModuleInterop": true
  },
  "include": ["src/**/*.js"]
}
```

- [ ] **Step 4: tsup.config.js**（双入口，react 走 external）

`packages/rei-standard-blob-store/tsup.config.js`：

```js
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.js', react: 'src/react.js' },
  format: ['cjs', 'esm'],
  // d.ts 由 build 脚本里单独的 tsc --allowJs --emitDeclarationOnly 生成，
  // 原因同 amsg/shared：tsup 的 dts 插件不认 .js 入口里的 JSDoc @typedef。
  dts: false,
  outDir: 'dist',
  outExtension({ format }) {
    return { js: format === 'esm' ? '.mjs' : '.cjs' };
  },
  platform: 'neutral',
  target: 'es2020',
  splitting: false,
  clean: true,
  external: ['react']
});
```

- [ ] **Step 5: 占位入口**

`src/index.js`（Task 2 起逐步填充）：

```js
// @rei-standard/blob-store 公共出口。
export {};
```

`src/react.js`（Task 8 实现，先占位以免 tsup 入口缺文件报错）：

```js
// ./react 子路径入口。
export {};
```

- [ ] **Step 6: 安装依赖并验证构建**

```bash
npm install
npm run build -w @rei-standard/blob-store
```

Expected: install 无报错、lockfile 更新；build 产出 `dist/index.mjs`、`dist/react.mjs`、`dist/index.d.ts` 等，退出码 0。

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json packages/rei-standard-blob-store
git commit -m "feat(blob-store): 包脚手架与 workspace 注册"
```

---

### Task 2: token.js — id 生成、时间反解、令牌提取

**Files:**
- Create: `packages/rei-standard-blob-store/src/token.js`
- Create: `packages/rei-standard-blob-store/test/token.test.mjs`
- Modify: `packages/rei-standard-blob-store/src/index.js`

- [ ] **Step 1: 写失败测试**

`test/token.test.mjs`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PREFIX, genId, parseIdTimestamp, extractRefs } from '../src/token.js';

test('genId 形如 b_<ts36>_<seq36>_<rand>，且互不相同', () => {
  const a = genId();
  const b = genId();
  assert.match(a, /^b_[0-9a-z]+_[0-9a-z]+_[0-9a-z]{6}$/);
  assert.notEqual(a, b);
});

test('parseIdTimestamp 反解出的时间贴近当前', () => {
  const before = Date.now();
  const ts = parseIdTimestamp(genId());
  assert.ok(ts !== null && ts >= before - 1000 && ts <= Date.now() + 1000);
});

test('parseIdTimestamp 对非本格式 id 返回 null', () => {
  assert.equal(parseIdTimestamp('img_abc_0_xyz123'), null); // 宿主存量格式
  assert.equal(parseIdTimestamp('随便什么'), null);
  assert.equal(parseIdTimestamp(''), null);
});

test('extractRefs 从 JSON 串里提取令牌并在引号处截断', () => {
  const id = genId();
  const json = JSON.stringify({ wallpaper: DEFAULT_PREFIX + id, note: 'no ref here' });
  assert.deepEqual(extractRefs(json), [DEFAULT_PREFIX + id]);
});

test('extractRefs 提取多个令牌、支持自定义前缀、裸前缀不算', () => {
  const s = `x blobref:b_1_2_aaaaaa,blobref:img_old blobref: end`;
  assert.deepEqual(extractRefs(s), ['blobref:b_1_2_aaaaaa', 'blobref:img_old']);
  assert.deepEqual(extractRefs('pic:abc_1', 'pic:'), ['pic:abc_1']);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npm test -w @rei-standard/blob-store
```

Expected: FAIL（模块不存在 / 导出缺失）。

- [ ] **Step 3: 实现 token.js**

```js
// 令牌与 id：`<prefix><id>`。id 形如 b_<毫秒时间戳 base36>_<进程内序号>_<随机 6 位>，
// 时间戳可反解，GC 的新鲜豁免靠它。id 对消费者不透明——宿主存量的其他格式照常读写，
// 只是 parseIdTimestamp 反解不出、GC 按「老」处理（见 gc.js）。

export const DEFAULT_PREFIX = 'blobref:';

let seq = 0;

/** 生成新 blob id。 */
export function genId() {
  return `b_${Date.now().toString(36)}_${(seq++).toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 反解 id 里的创建时间（毫秒时间戳）。只认识本包生成的 `b_` 格式，其余返回 null。
 * @param {string} id
 * @returns {number | null}
 */
export function parseIdTimestamp(id) {
  const m = /^b_([0-9a-z]+)_/.exec(id);
  if (!m) return null;
  const ts = parseInt(m[1], 36);
  return Number.isFinite(ts) ? ts : null;
}

/**
 * 从任意字符串提取全部令牌。prefix 之后取最长的 [A-Za-z0-9_] 段作为 id，
 * 所以 JSON 串里内嵌的令牌（后随引号）也能正确截断。
 * @param {string} str
 * @param {string} [prefix]
 * @returns {string[]}
 */
export function extractRefs(str, prefix = DEFAULT_PREFIX) {
  const refs = [];
  let i = 0;
  while ((i = str.indexOf(prefix, i)) !== -1) {
    let j = i + prefix.length;
    while (j < str.length && /[A-Za-z0-9_]/.test(str[j])) j++;
    if (j > i + prefix.length) refs.push(str.slice(i, j));
    i = j; // 裸前缀（j 停在 prefix 尾）也前进，不会死循环
  }
  return refs;
}
```

`src/index.js` 改为：

```js
// @rei-standard/blob-store 公共出口。
export { DEFAULT_PREFIX, extractRefs } from './token.js';
```

（genId / parseIdTimestamp 是内部件，不进公共面。）

- [ ] **Step 4: 跑测试确认通过**

```bash
npm test -w @rei-standard/blob-store
```

Expected: PASS（5 个测试）。

- [ ] **Step 5: Commit**

```bash
git add packages/rei-standard-blob-store
git commit -m "feat(blob-store): 令牌模块——id 生成、时间反解、extractRefs"
```

---

### Task 3: dataurl.js — data URL ⇄ Blob 互转

**Files:**
- Create: `packages/rei-standard-blob-store/src/dataurl.js`
- Create: `packages/rei-standard-blob-store/test/dataurl.test.mjs`
- Modify: `packages/rei-standard-blob-store/src/index.js`

- [ ] **Step 1: 写失败测试**

`test/dataurl.test.mjs`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { dataUrlToBlob, blobToDataUrl } from '../src/dataurl.js';

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 128, 7]);

test('Blob → data URL → Blob 往返保持字节与 MIME', async () => {
  const blob = new Blob([PNG_BYTES], { type: 'image/png' });
  const dataUrl = await blobToDataUrl(blob);
  assert.match(dataUrl, /^data:image\/png;base64,/);
  const back = dataUrlToBlob(dataUrl);
  assert.equal(back.type, 'image/png');
  assert.deepEqual(new Uint8Array(await back.arrayBuffer()), PNG_BYTES);
});

test('无 MIME 的 Blob 落到 application/octet-stream', async () => {
  const dataUrl = await blobToDataUrl(new Blob([PNG_BYTES]));
  assert.match(dataUrl, /^data:application\/octet-stream;base64,/);
});

test('非 base64 data URL（utf8 svg）按 UTF-8 解码', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
  const blob = dataUrlToBlob(`data:image/svg+xml,${encodeURIComponent(svg)}`);
  assert.equal(blob.type, 'image/svg+xml');
  assert.equal(await blob.text(), svg);
});

test('非 data URL 抛错（明确的编程错误才抛）', () => {
  assert.throws(() => dataUrlToBlob('https://example.com/a.png'));
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npm test -w @rei-standard/blob-store
```

Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 dataurl.js**

```js
// data URL ⇄ Blob。base64 编解码优先走 Uint8Array.fromBase64 / toBase64
//（Safari 18.2+ / Firefox 133+ / Chrome 140+），老环境回退 atob/btoa 手编。
// Blob → data URL 在浏览器主线程优先 FileReader（原生高效、经消费者验证的路径）。

/**
 * `data:<mime>[;base64],<payload>` → Blob。非 data URL 抛错。
 * @param {string} dataUrl
 * @returns {Blob}
 */
export function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:') || comma < 0) throw new Error('Invalid data URL');
  const header = dataUrl.slice(0, comma);
  const mimeMatch = header.match(/^data:([^;,]+)/);
  const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
  if (!/;base64/i.test(header)) {
    // 非 base64（如 utf8 编码的 svg），按 UTF-8 处理。
    return new Blob([decodeURIComponent(dataUrl.slice(comma + 1))], { type: mime });
  }
  const b64 = dataUrl.slice(comma + 1);
  let bytes;
  if (typeof Uint8Array.fromBase64 === 'function') {
    bytes = Uint8Array.fromBase64(b64);
  } else {
    const binary = atob(b64);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

/**
 * Blob → `data:<mime>;base64,xxxx`。
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
export async function blobToDataUrl(blob) {
  if (typeof FileReader !== 'undefined' && blob.type) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(/** @type {string} */ (reader.result));
      reader.onerror = () => reject(reader.error || new Error('blobToDataUrl failed'));
      reader.readAsDataURL(blob);
    });
  }
  // 无 FileReader（Worker / Node）或无 type（FileReader 会丢 MIME 头）时手编。
  const mime = blob.type || 'application/octet-stream';
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let b64;
  if (typeof bytes.toBase64 === 'function') {
    b64 = bytes.toBase64();
  } else {
    let binary = '';
    const CHUNK = 0x8000; // 分块拼串，避开 String.fromCharCode 参数上限
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    b64 = btoa(binary);
  }
  return `data:${mime};base64,${b64}`;
}
```

`src/index.js` 加一行：

```js
export { dataUrlToBlob, blobToDataUrl } from './dataurl.js';
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npm test -w @rei-standard/blob-store
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/rei-standard-blob-store
git commit -m "feat(blob-store): data URL 与 Blob 互转，含 fromBase64 快路径"
```

---

### Task 4: store.js — createBlobStore 核心读写

**Files:**
- Create: `packages/rei-standard-blob-store/src/store.js`
- Create: `packages/rei-standard-blob-store/test/helpers.mjs`
- Create: `packages/rei-standard-blob-store/test/store.test.mjs`
- Modify: `packages/rei-standard-blob-store/src/index.js`

- [ ] **Step 1: 写内存假适配器（测试公用）**

`test/helpers.mjs`：

```js
/** Map 实现的内存适配器；node --test 只收 *.test.mjs，此文件不会被当测试跑。 */
export function memoryAdapter() {
  const map = new Map();
  return {
    map,
    get: async (id) => map.get(id) ?? null,
    put: async (id, blob) => { map.set(id, blob); },
    delete: async (id) => { map.delete(id); },
    keys: async () => [...map.keys()],
  };
}

/** 各方法都抛错的适配器，验证「读失败 null / 删失败吞」。 */
export function brokenAdapter() {
  const boom = async () => { throw new Error('boom'); };
  return { get: boom, put: boom, delete: boom, keys: boom };
}
```

- [ ] **Step 2: 写失败测试**

`test/store.test.mjs`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBlobStore } from '../src/store.js';
import { memoryAdapter, brokenAdapter } from './helpers.mjs';

const blobOf = (s) => new Blob([s], { type: 'text/plain' });

test('put 返回带前缀令牌，get 取回同内容', async () => {
  const store = createBlobStore({ adapter: memoryAdapter() });
  const token = await store.put(blobOf('hello'));
  assert.ok(store.isRef(token));
  assert.match(token, /^blobref:b_/);
  assert.equal(await (await store.get(token)).text(), 'hello');
});

test('get：非令牌 / 不存在 / 适配器抛错 → null，不抛', async () => {
  const store = createBlobStore({ adapter: memoryAdapter() });
  assert.equal(await store.get('data:image/png;base64,AAAA'), null);
  assert.equal(await store.get('blobref:b_missing_0_aaaaaa'), null);
  const broken = createBlobStore({ adapter: brokenAdapter() });
  assert.equal(await broken.get('blobref:b_1_0_aaaaaa'), null);
});

test('put 失败向上抛（调用方必须知道图没存进去）', async () => {
  const store = createBlobStore({ adapter: brokenAdapter() });
  await assert.rejects(() => store.put(blobOf('x')));
});

test('delete best-effort：非令牌不动、适配器抛错吞掉', async () => {
  const adapter = memoryAdapter();
  const store = createBlobStore({ adapter });
  const token = await store.put(blobOf('bye'));
  await store.delete('data:xxx'); // 不抛
  await store.delete(token);
  assert.equal(adapter.map.size, 0);
  await createBlobStore({ adapter: brokenAdapter() }).delete('blobref:b_1_0_aaaaaa'); // 不抛
});

test('resolveToDataUrl：令牌→data URL、非令牌透传、丢图→空串', async () => {
  const store = createBlobStore({ adapter: memoryAdapter() });
  const token = await store.put(blobOf('pic'));
  assert.match(await store.resolveToDataUrl(token), /^data:text\/plain;base64,/);
  assert.equal(await store.resolveToDataUrl('https://a/b.png'), 'https://a/b.png');
  assert.equal(await store.resolveToDataUrl('blobref:b_gone_0_aaaaaa'), '');
});

test('migrateDataUrl：成功返回令牌，坏输入回退原串', async () => {
  const store = createBlobStore({ adapter: memoryAdapter() });
  const token = await store.migrateDataUrl('data:text/plain;base64,aGk=');
  assert.ok(store.isRef(token));
  assert.equal(await store.migrateDataUrl('not-a-data-url'), 'not-a-data-url');
});

test('自定义前缀贯穿 put/isRef/get', async () => {
  const store = createBlobStore({ adapter: memoryAdapter(), prefix: 'pic:' });
  const token = await store.put(blobOf('p'));
  assert.match(token, /^pic:b_/);
  assert.ok(store.isRef(token));
  assert.ok(!store.isRef('blobref:b_1_0_aaaaaa'));
  assert.equal(await (await store.get(token)).text(), 'p');
});

test('缺 adapter 直接抛（编程错误）', () => {
  assert.throws(() => createBlobStore({}));
});
```

- [ ] **Step 3: 跑测试确认失败**

```bash
npm test -w @rei-standard/blob-store
```

Expected: FAIL（store.js 不存在）。

- [ ] **Step 4: 实现 store.js**

```js
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
  if (!adapter) throw new Error('createBlobStore: adapter is required');

  /** @param {unknown} v @returns {boolean} */
  const isRef = (v) => typeof v === 'string' && v.startsWith(prefix);
  /** @param {string} ref */
  const idOf = (ref) => ref.slice(prefix.length);

  const store = {
    prefix,
    isRef,

    /** 存入 Blob，返回令牌。适配器失败会上抛。 */
    async put(blob) {
      const id = genId();
      await adapter.put(id, blob);
      return prefix + id;
    },

    /** 令牌 → Blob。非令牌 / 不存在 / 读失败一律 null。 */
    async get(token) {
      if (!isRef(token)) return null;
      try {
        return (await adapter.get(idOf(token))) ?? null;
      } catch {
        return null;
      }
    },

    /** best-effort 删除；非令牌不动，失败静默。 */
    async delete(token) {
      if (!isRef(token)) return;
      try {
        await adapter.delete(idOf(token));
      } catch { /* best-effort */ }
    },

    /** 令牌 → data URL；非令牌透传；Blob 已丢返回空串（别把死令牌当 src 用）。 */
    async resolveToDataUrl(value) {
      if (!isRef(value)) return value;
      const blob = await store.get(value);
      return blob ? blobToDataUrl(blob) : '';
    },

    /** data URL → 令牌；失败回退原串，调用方永远拿到可渲染的值。 */
    async migrateDataUrl(dataUrl) {
      try {
        return await store.put(dataUrlToBlob(dataUrl));
      } catch {
        return dataUrl;
      }
    },

    /** 深度遍历对象树，令牌原地替换成 data URL（备份导出前调用）。见 Task 5。 */
    async resolveDeep(root) {
      return resolveDeep(store, root);
    },

    /** 孤儿 GC，语义见 gc.js。 */
    async gc(opts) {
      return runGc({ adapter, prefix }, opts);
    },
  };
  return store;
}

/* resolveDeep 在 Task 5 实现；本 Task 先放一个抛错占位，Task 5 的测试会替换它。 */
async function resolveDeep(_store, _root) {
  throw new Error('not implemented yet');
}
```

注意：`gc.js` 此时还不存在，先建一个最小占位 `src/gc.js`（Task 6 实现）：

```js
export async function runGc(_ctx, _opts) {
  throw new Error('not implemented yet');
}
```

`src/index.js` 加一行：

```js
export { createBlobStore } from './store.js';
```

- [ ] **Step 5: 跑测试确认通过**

```bash
npm test -w @rei-standard/blob-store
```

Expected: PASS（store.test.mjs 8 个全绿，此前测试不回归）。

- [ ] **Step 6: Commit**

```bash
git add packages/rei-standard-blob-store
git commit -m "feat(blob-store): createBlobStore 核心读写与迁移辅助"
```

---

### Task 5: resolveDeep — 备份导出前的深度还原

**Files:**
- Modify: `packages/rei-standard-blob-store/src/store.js`
- Modify: `packages/rei-standard-blob-store/test/store.test.mjs`

- [ ] **Step 1: 追加失败测试**

`test/store.test.mjs` 末尾追加：

```js
test('resolveDeep：嵌套对象/数组里的令牌原地变 data URL，丢图置空串', async () => {
  const store = createBlobStore({ adapter: memoryAdapter() });
  const token = await store.put(blobOf('deep'));
  const root = {
    theme: { wallpaper: token, color: '#fff' },
    icons: [token, 'https://a/b.png'],
    dead: 'blobref:b_gone_0_aaaaaa',
  };
  await store.resolveDeep(root);
  assert.match(root.theme.wallpaper, /^data:text\/plain;base64,/);
  assert.equal(root.icons[0], root.theme.wallpaper);
  assert.equal(root.icons[1], 'https://a/b.png');
  assert.equal(root.dead, '');
});

test('resolveDeep：同一令牌只读一次适配器', async () => {
  const adapter = memoryAdapter();
  let reads = 0;
  const counting = { ...adapter, get: async (id) => { reads++; return adapter.get(id); } };
  const store = createBlobStore({ adapter: counting });
  const token = await store.put(blobOf('once'));
  await store.resolveDeep({ a: token, b: { c: token }, d: [token] });
  assert.equal(reads, 1);
});

test('resolveDeep：循环引用不挂', async () => {
  const store = createBlobStore({ adapter: memoryAdapter() });
  const a = { name: 'a' };
  a.self = a;
  await store.resolveDeep(a); // 不超时、不抛即通过
  assert.equal(a.name, 'a');
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npm test -w @rei-standard/blob-store
```

Expected: FAIL（`not implemented yet`）。

- [ ] **Step 3: 把 store.js 里的占位替换成实现**

将 Task 4 里 `resolveDeep` 占位函数整体替换为：

```js
/**
 * 深度遍历对象树，把所有令牌字符串原地替换成 data URL。原地修改传入对象，
 * 调用方须传独立副本。解析不到的令牌置空串（图已丢，别导出恢复端认不得的死令牌）。
 * 迭代遍历 + WeakSet 防循环；同一令牌只读一次。
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
    const entries = Array.isArray(node)
      ? node.map((v, i) => [i, v])
      : Object.keys(node).map((k) => [k, node[k]]);
    for (const [key, v] of entries) {
      if (store.isRef(v)) {
        hits.push({ container: node, key, ref: v });
      } else if (v !== null && typeof v === 'object') {
        stack.push(v);
      }
    }
  }
  if (!hits.length) return;
  const cache = new Map();
  for (const { container, key, ref } of hits) {
    let dataUrl = cache.get(ref);
    if (dataUrl === undefined) {
      dataUrl = await store.resolveToDataUrl(ref);
      cache.set(ref, dataUrl);
    }
    container[key] = dataUrl;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npm test -w @rei-standard/blob-store
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/rei-standard-blob-store
git commit -m "feat(blob-store): resolveDeep 深度还原，备份导出用"
```

---

### Task 6: gc.js — mark-and-sweep 与三道安全阀

**Files:**
- Modify: `packages/rei-standard-blob-store/src/gc.js`（替换占位）
- Create: `packages/rei-standard-blob-store/test/gc.test.mjs`

- [ ] **Step 1: 写失败测试**

`test/gc.test.mjs`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBlobStore } from '../src/store.js';
import { memoryAdapter } from './helpers.mjs';

const blobOf = (s) => new Blob([s], { type: 'text/plain' });
const DAY = 24 * 3600 * 1000;

/** 建一个 store，塞 n 个 blob，返回 { store, adapter, tokens }。 */
async function seed(n) {
  const adapter = memoryAdapter();
  const store = createBlobStore({ adapter });
  const tokens = [];
  for (let i = 0; i < n; i++) tokens.push(await store.put(blobOf('b' + i)));
  return { store, adapter, tokens };
}

test('老孤儿被删，被引用的保留', async () => {
  const { store, adapter, tokens } = await seed(2);
  const [used, orphan] = tokens;
  const result = await store.gc({
    refSources: [JSON.stringify({ wallpaper: used })],
    minAgeMs: 0, // 全部视为老，聚焦引用判定
  });
  assert.deepEqual(result, { deleted: 1, kept: 1, aborted: false });
  assert.ok(await store.get(used));
  assert.equal(await store.get(orphan), null);
});

test('新鲜豁免：距创建不足 minAgeMs 的孤儿不删', async () => {
  const { store, adapter } = await seed(1);
  const result = await store.gc({ refSources: [], minAgeMs: 3 * DAY });
  assert.deepEqual(result, { deleted: 0, kept: 1, aborted: false });
  assert.equal(adapter.map.size, 1);
});

test('反解不出时间的存量 id 按「老」处理，孤儿即删', async () => {
  const { store, adapter } = await seed(0);
  adapter.map.set('img_legacy_0_xyz', blobOf('old'));
  const result = await store.gc({ refSources: [], minAgeMs: 3 * DAY });
  assert.deepEqual(result, { deleted: 1, kept: 0, aborted: false });
});

test('任一 refSource 抛错 → 整轮放弃，一个都不删', async () => {
  const { store, adapter } = await seed(2);
  async function* poison() {
    yield 'something';
    throw new Error('source broke');
  }
  const result = await store.gc({ refSources: poison(), minAgeMs: 0 });
  assert.equal(result.aborted, true);
  assert.equal(result.deleted, 0);
  assert.equal(adapter.map.size, 2);
});

test('refSources 支持 async generator（数组形态首个测试已覆盖）', async () => {
  const { store, tokens } = await seed(1);
  async function* gen() { yield `x ${tokens[0]} y`; }
  const r1 = await store.gc({ refSources: gen(), minAgeMs: 0 });
  assert.deepEqual(r1, { deleted: 0, kept: 1, aborted: false });
});

test('自定义前缀的 store，GC 按该前缀提取引用', async () => {
  const adapter = memoryAdapter();
  const store = createBlobStore({ adapter, prefix: 'pic:' });
  const used = await store.put(blobOf('u'));
  const orphan = await store.put(blobOf('o'));
  const result = await store.gc({ refSources: [used], minAgeMs: 0 });
  assert.deepEqual(result, { deleted: 1, kept: 1, aborted: false });
  assert.ok(await store.get(used));
  assert.equal(await store.get(orphan), null);
});

test('缺 refSources 直接抛（编程错误，不是静默全删）', async () => {
  const { store } = await seed(1);
  await assert.rejects(() => store.gc({}));
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npm test -w @rei-standard/blob-store
```

Expected: FAIL（`not implemented yet`）。

- [ ] **Step 3: 实现 gc.js（整体替换占位）**

```js
// 孤儿 GC：mark-and-sweep。总原则「宁可留孤儿，绝不删活图」——
//   1) 任一 refSource 迭代抛错 → 整轮放弃；
//   2) 新鲜豁免：id 反解创建时间距今不足 minAgeMs 的不删（挡住 put 之后、
//      引用落盘之前的竞态窗口）；
//   3) 反解不出时间的存量 id 按「老」处理：老数据早该被引用了，扫不到即真孤儿。
// 宿主义务：refSources 必须枚举全部可能含令牌的持久化面，漏一个面就会删活图。

import { extractRefs, parseIdTimestamp } from './token.js';

const DEFAULT_MIN_AGE_MS = 72 * 3600 * 1000;

/**
 * @param {{ adapter: import('./store.js').StorageAdapter, prefix: string }} ctx
 * @param {{ refSources: Iterable<string> | AsyncIterable<string>, minAgeMs?: number, now?: number }} opts
 * @returns {Promise<{ deleted: number, kept: number, aborted: boolean }>}
 */
export async function runGc({ adapter, prefix }, opts) {
  const { refSources, minAgeMs = DEFAULT_MIN_AGE_MS, now = Date.now() } = opts || {};
  if (!refSources) throw new Error('gc: refSources is required');

  // mark：汇总在用 id。任何一个来源出错都放弃整轮。
  const used = new Set();
  try {
    for await (const chunk of refSources) {
      if (typeof chunk !== 'string') continue;
      for (const ref of extractRefs(chunk, prefix)) used.add(ref.slice(prefix.length));
    }
  } catch {
    return { deleted: 0, kept: 0, aborted: true };
  }

  // sweep：不在集合里的删，新鲜的豁免。keys 读不出来也放弃。
  let ids;
  try {
    ids = await adapter.keys();
  } catch {
    return { deleted: 0, kept: 0, aborted: true };
  }

  let deleted = 0;
  let kept = 0;
  for (const id of ids) {
    if (used.has(id)) { kept++; continue; }
    const ts = parseIdTimestamp(id);
    if (ts !== null && now - ts < minAgeMs) { kept++; continue; }
    try {
      await adapter.delete(id);
      deleted++;
    } catch {
      kept++; // 删失败按保留计，下轮再试
    }
  }
  return { deleted, kept, aborted: false };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npm test -w @rei-standard/blob-store
```

Expected: PASS（gc.test.mjs 7 个全绿）。

- [ ] **Step 5: Commit**

```bash
git add packages/rei-standard-blob-store
git commit -m "feat(blob-store): 孤儿 GC——mark-and-sweep 与三道安全阀"
```

---

### Task 7: idb-adapter.js — 独立 DB 默认适配器

**Files:**
- Create: `packages/rei-standard-blob-store/src/idb-adapter.js`
- Create: `packages/rei-standard-blob-store/test/idb-adapter.test.mjs`
- Modify: `packages/rei-standard-blob-store/src/index.js`

- [ ] **Step 1: 写失败测试**

`test/idb-adapter.test.mjs`：

```js
import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdbAdapter } from '../src/idb-adapter.js';
import { createBlobStore } from '../src/store.js';

test('put/get/keys/delete 走真 IDB 语义往返', async () => {
  const adapter = createIdbAdapter('blob-store-test-1');
  const blob = new Blob(['idb'], { type: 'text/plain' });
  await adapter.put('a1', blob);
  const back = await adapter.get('a1');
  assert.equal(await back.text(), 'idb');
  assert.deepEqual(await adapter.keys(), ['a1']);
  await adapter.delete('a1');
  assert.equal(await adapter.get('a1'), null);
  assert.deepEqual(await adapter.keys(), []);
});

test('get 不存在的 id 返回 null（不是 undefined）', async () => {
  const adapter = createIdbAdapter('blob-store-test-2');
  assert.equal(await adapter.get('nope'), null);
});

test('与 createBlobStore 组合成完整闭环', async () => {
  const store = createBlobStore({ adapter: createIdbAdapter('blob-store-test-3') });
  const token = await store.put(new Blob(['e2e'], { type: 'text/plain' }));
  assert.equal(await (await store.get(token)).text(), 'e2e');
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npm test -w @rei-standard/blob-store
```

Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 idb-adapter.js**

```js
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
```

`src/index.js` 加一行：

```js
export { createIdbAdapter } from './idb-adapter.js';
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npm test -w @rei-standard/blob-store
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/rei-standard-blob-store
git commit -m "feat(blob-store): 独立 DB 默认适配器 createIdbAdapter"
```

---

### Task 8: react.js — useBlobUrl hook（./react 子路径）

hook 逻辑极薄，行为守卫依托首个消费者（SullyOS）侧既有测试（见 spec 测试策略节），本仓不写 hook 单测；本 Task 的验证是构建产物与类型声明齐全。

**Files:**
- Modify: `packages/rei-standard-blob-store/src/react.js`（替换占位）

- [ ] **Step 1: 实现 react.js**

```js
// ./react 子路径：令牌 → objectURL 的生命周期 hook。
// store 显式作参数传入——不做 context、不做全局单例；宿主想要绑定默认 store 的
// 便捷 hook 或叠加自有取值逻辑（如内置素材解析），在自己那层薄壳里包。

import { useEffect, useState } from 'react';

/**
 * 把字段值解析成可直接用于 <img src> / CSS url() 的字符串。
 *   · 令牌 → 读 Blob 建 objectURL，卸载 / value 变化时 revoke，不泄漏；
 *   · 非令牌（data: / http(s) / 渐变串 / undefined）→ 原样返回；
 *   · 令牌解析完成前返回 undefined（首帧无图，读出后再渲染，属预期）。
 * @param {{ isRef: (v: unknown) => boolean, get: (token: string) => Promise<Blob | null> }} store
 *   createBlobStore 的返回值（只用到 isRef/get，结构化声明以免 allowJs 声明生成翻车）
 * @param {string | undefined | null} value
 * @returns {string | undefined}
 */
export function useBlobUrl(store, value) {
  const [url, setUrl] = useState(store.isRef(value) ? undefined : value ?? undefined);

  useEffect(() => {
    if (!store.isRef(value)) {
      setUrl(value ?? undefined);
      return;
    }
    let alive = true;
    /** @type {string | undefined} */
    let objUrl;
    store.get(value).then((blob) => {
      if (!alive) return;
      if (blob) {
        objUrl = URL.createObjectURL(blob);
        setUrl(objUrl);
      } else {
        setUrl(undefined);
      }
    });
    return () => {
      alive = false;
      if (objUrl) URL.revokeObjectURL(objUrl);
    };
  }, [store, value]);

  return url;
}
```

- [ ] **Step 2: 构建并验证产物**

```bash
npm run build -w @rei-standard/blob-store
ls packages/rei-standard-blob-store/dist
```

Expected: 退出码 0；dist 里有 `react.mjs`、`react.cjs`、`react.d.ts`、`react.d.cts`，且 react 保持 external 未被打进产物（`grep -E 'from ?"react"' packages/rei-standard-blob-store/dist/react.mjs` 有输出）。

- [ ] **Step 3: 跑全部测试确认不回归**

```bash
npm test -w @rei-standard/blob-store
```

Expected: PASS。

- [ ] **Step 4: Commit**

```bash
git add packages/rei-standard-blob-store
git commit -m "feat(blob-store): ./react 子路径 useBlobUrl hook"
```

---

### Task 9: 公共 API 表面守卫

**Files:**
- Create: `packages/rei-standard-blob-store/test/exports.test.mjs`

- [ ] **Step 1: 写测试（照 amsg-client 的 exports.test.mjs 惯例）**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../src/index.js';

test('公共出口恰好是这些（加导出要有意识地改这里）', () => {
  assert.deepEqual(Object.keys(api).sort(), [
    'DEFAULT_PREFIX',
    'blobToDataUrl',
    'createBlobStore',
    'createIdbAdapter',
    'dataUrlToBlob',
    'extractRefs',
  ]);
});

test('store 实例的方法表面', async () => {
  const store = api.createBlobStore({
    adapter: { get: async () => null, put: async () => {}, delete: async () => {}, keys: async () => [] },
  });
  for (const m of ['put', 'get', 'delete', 'isRef', 'resolveToDataUrl', 'migrateDataUrl', 'resolveDeep', 'gc']) {
    assert.equal(typeof store[m], 'function', m);
  }
  assert.equal(store.prefix, 'blobref:');
});
```

- [ ] **Step 2: 跑测试确认通过**

```bash
npm test -w @rei-standard/blob-store
```

Expected: PASS（若失败说明前面某 Task 的导出和计划不一致，修到一致为止）。

- [ ] **Step 3: Commit**

```bash
git add packages/rei-standard-blob-store
git commit -m "test(blob-store): 公共 API 表面守卫"
```

---

### Task 10: 包 README + standards 规范文档

**Files:**
- Create: `packages/rei-standard-blob-store/README.md`
- Create: `standards/blob-storage.md`

- [ ] **Step 1: 写包 README**

`packages/rei-standard-blob-store/README.md`：

````markdown
# @rei-standard/blob-store

纯前端应用的令牌式 Blob 存储：图片 / 音频 / 模型二进制存 IndexedDB，业务字段里只留一个短令牌 `blobref:<id>`。字段仍是普通 string——JSON 序列化、结构化克隆、备份导出都不受影响；渲染时令牌解析成 objectURL。相比 base64 内嵌省 ~33% 空间，且二进制不再常驻 JS 堆。

```bash
npm install @rei-standard/blob-store
```

## 最小接入

```js
import { createBlobStore, createIdbAdapter } from '@rei-standard/blob-store';

// 没有自己 IndexedDB 的项目：独立数据库开箱即用
const store = createBlobStore({ adapter: createIdbAdapter('my-app-blobs') });

const token = await store.put(file);      // → 'blobref:b_xxx' 存进业务字段
const blob = await store.get(token);      // 渲染时取回
```

已有自己 IndexedDB 的项目（多数情况）：拿现成的 DB 方法包一个适配器，连接管理、版本升级全部自理，本包不碰你的库：

```js
const store = createBlobStore({
  adapter: {
    get: (id) => myDb.getBlobAsset(id),
    put: (id, blob) => myDb.putBlobAsset(id, blob),
    delete: (id) => myDb.deleteBlobAsset(id),
    keys: () => myDb.listBlobAssetIds(),   // GC 扫描用
  },
});
```

## React 渲染

```jsx
import { useBlobUrl } from '@rei-standard/blob-store/react';

function Wallpaper({ store, value }) {
  const url = useBlobUrl(store, value);   // 令牌→objectURL（自动 revoke），非令牌透传
  return url ? <img src={url} /> : null;
}
```

react 是可选 peerDependency，不用 React 的项目零负担。

## 备份互操作

令牌只在本机数据库里有意义。导出备份前调用 `store.resolveDeep(backupObject)`，对象树里的全部令牌原地变回 data URL——备份文件里永远没有令牌，格式与是否用本包解耦。导入侧可用 `store.migrateDataUrl(dataUrl)` 惰性转回令牌。

## 孤儿 GC 与宿主义务

令牌方案下删除是保守的（同一令牌可能被多处引用），孤儿 Blob 靠 GC 收口：

```js
const result = await store.gc({
  refSources: (async function* () {
    for (const row of await myDb.getAllAssets()) yield JSON.stringify(row);
    for (let i = 0; i < localStorage.length; i++) yield localStorage.getItem(localStorage.key(i)) ?? '';
  })(),
});
// → { deleted, kept, aborted }
```

**⚠️ 宿主义务：`refSources` 必须枚举全部可能含令牌的持久化面。漏掉一个面，那个面独占引用的图会被当孤儿删掉。** 建议在代码里维护一份引用面清单并随新功能更新。

安全阀（总原则「宁可留孤儿，绝不删活图」）：任一来源抛错整轮放弃（`aborted: true`）；创建不足 72 小时（`minAgeMs` 可配）的不删，挡住「已 put、引用未落盘」的竞态。

## 错误哲学

存储层错误不打断业务：读失败返回 null、删失败静默、GC 宁留勿删、迁移失败回退原串。`put` 失败会上抛——调用方必须知道图没存进去。

完整规范见 [`standards/blob-storage.md`](../../standards/blob-storage.md)。
````

- [ ] **Step 2: 写规范文档**

`standards/blob-storage.md`：

````markdown
# Blob 存储规范（blob-store）

纯前端应用二进制存储的规范化描述。面向想自己实现（而不是安装 `@rei-standard/blob-store`）的读者；包的行为以本规范为准。

## 1. 模型

- 二进制以 Blob 形式存进 IndexedDB 的一张表；业务数据里不出现二进制，只出现**令牌**。
- 令牌 = `<prefix><id>`，prefix 默认 `blobref:`。令牌是普通 string，可 JSON 序列化、可结构化克隆。
- id 对消费者**不透明**：任何实现不得解析他人生成的 id 语义，只能整串比对。

## 2. id 格式（参考实现）

`b_<毫秒时间戳 base36>_<进程内序号 base36>_<随机 6 位 base36>`

时间戳字段供 GC 的新鲜豁免反解。其他格式的存量 id 合法——读写不受影响，仅 GC 按「老」处理。

## 3. 存储适配器契约

实现方通过四个方法对接任意后端：

| 方法 | 语义 |
|---|---|
| `get(id) → Promise<Blob \| null>` | 不存在返回 null |
| `put(id, blob) → Promise<void>` | 失败必须抛出（调用方要知道没存上） |
| `delete(id) → Promise<void>` | 幂等 |
| `keys() → Promise<string[]>` | 全量 id，GC 扫描用 |

## 4. 错误语义

| 操作 | 失败时 |
|---|---|
| get / resolve | 返回 null / 空串，不抛 |
| delete | 静默 |
| put | 上抛 |
| 迁移（data URL → 令牌） | 回退返回原始输入 |

原则：存储层错误不打断业务；抛错只发生在明确的编程错误上。

## 5. 孤儿 GC

mark-and-sweep：

1. **mark**——宿主枚举全部可能含令牌的持久化面（数据库各表、localStorage 等），对每段字符串按 prefix 提取令牌（prefix 之后取最长 `[A-Za-z0-9_]` 段），汇总在用 id 集合。
2. **sweep**——`keys()` 中不在集合里的 id 删除。

安全要求（必须全部实现）：

- 任一引用来源枚举失败 → 整轮放弃，不删任何东西。
- 新鲜豁免：id 可反解创建时间且距今不足阈值（参考值 72h）的不删——挡住「已 put、引用尚未持久化」的竞态窗口。
- 反解不出时间的 id 按「老」处理。
- 单个删除失败不中断整轮，按保留计。

**宿主义务：引用面清单不全会删活图。这是接入方唯一必须自己保证正确的事。**

## 6. 备份互操作

- 导出前：深度遍历备份对象树，令牌原地替换为 data URL；解析不到的令牌置空串。**备份文件里永远没有令牌**——备份格式与是否采用本方案解耦，跨设备、跨实现可恢复。
- 导入侧：按普通 data URL 处理即可；可选地惰性转回令牌（读到 data: 时顺手 put 并替换）。

## 7. 渲染

令牌经 `URL.createObjectURL` 转 objectURL 喂给 `<img>` / CSS。实现方必须管理生命周期：消费点卸载或值变化时 revoke，防止内存泄漏。
````

- [ ] **Step 3: Commit**

```bash
git add packages/rei-standard-blob-store/README.md standards/blob-storage.md
git commit -m "docs(blob-store): 包 README 与 blob 存储规范"
```

---

### Task 11: changeset、全仓 CI、推送开 PR

**Files:**
- Create: `.changeset/blob-store-initial.md`

- [ ] **Step 1: 写 changeset**

`.changeset/blob-store-initial.md`：

```markdown
---
"@rei-standard/blob-store": minor
---

新增 @rei-standard/blob-store：令牌式 Blob 存储。core（适配器模式，不碰宿主 IndexedDB）+ 孤儿 GC（mark-and-sweep，三道安全阀）+ /react 子路径（useBlobUrl）。
```

（仓库处于 pre(next) 模式，合并后发出的首版是 `0.1.0-next.0`。）

- [ ] **Step 2: 跑全仓 CI 脚本**

```bash
npm run ci
```

Expected: check:esm、check:pm、全 workspace build、全 workspace test 依次通过，退出码 0。若 check 脚本对新包报错，按报错信息修（多半是 ESM 语法或 packageManager 声明检查）。

- [ ] **Step 3: Commit + 推送 + 开 PR**

```bash
git add .changeset/blob-store-initial.md
git commit -m "chore(blob-store): changeset——首版 minor"
git push -u origin feat/blob-store
gh pr create --repo Tosd0/ReiStandard --base main --title "feat: 新增 @rei-standard/blob-store 令牌式 Blob 存储" --body "$(cat <<'EOF'
## 改了什么

新垂直 `@rei-standard/blob-store`：纯前端应用的令牌式 Blob 存储 SDK。

- **core**：二进制存 IndexedDB Blob，业务字段只留 `blobref:<id>` 令牌；存储后端经四方法适配器注入，不碰宿主的库
- **孤儿 GC**：mark-and-sweep，三道安全阀（来源出错整轮放弃 / 72h 新鲜豁免 / 存量 id 按老处理）
- **/react 子路径**：`useBlobUrl`（objectURL 生命周期管理），react 为可选 peerDep
- 规范文档 `standards/blob-storage.md`，设计定稿见 `docs/superpowers/specs/2026-08-19-blob-store-design.md`

## 测试

- core 全部用内存假适配器跑 `node --test`，不依赖 IDB 环境
- `createIdbAdapter` 用 fake-indexeddb 单独覆盖
- 公共 API 表面有守卫测试

https://claude.ai/code/session_01X4GxcrjUKy2iWnSdQmdDbx
EOF
)"
```

Expected: PR 创建成功。合并后 CI 开 Version Packages PR，合并该 PR 发出 `0.1.0-next.0`。

---

## 完成后

发出 `next` 版后，另写 SullyOS 接入计划（薄壳化 blobRef.ts、db.ts 加 `listBlobAssetIds`、GC 挂开发调试面板、引用面清单盘点），按 spec「首个消费者接入」一节执行。
