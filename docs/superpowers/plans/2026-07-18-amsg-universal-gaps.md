# amsg 满血后台消息实测后的通用缺口补齐 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ① `client_state` 大值透明分块 + 整批局部失败；② fire 级 scratch 容器进 hook ctx；③ `GET /capabilities` 特性探测端点 + 客户端 `getCapabilities()`。任务 4（scheduled 推送溢出封套）评估后本批暂缓（见文末评估）。

**Architecture:**
① 分块放在**服务端**（不是下游参考实现的客户端切块）：client SDK 零改动即可传大 value，handler 收到 >200KB 的值后用 `chunkReasoningByUtf8Bytes`（shared 现成的字节安全切片器）切片，切片逐片 `encryptForStorage` 后存进保留 namespace（`\u001famsg-chunks\u001f<ns>`），原 (ns, key) 行的 value 写成纯文本 marker（`\u001famsg-chunked\u001fv1\u001f<count>`——`encryptForStorage` 输出是 `hex:hex:hex`，永远不会以控制字符开头，两种行值不会混淆）。`GET` 与 hook 的 `readState` 共用 `resolveClientStateEntries` 拼回原值；完整性判定 = 块齐全 且 每块 `updated_at` 与根行一致，不一致该 key 视为不存在。清尾块用「每条 accepted 条目先跑一条条件 DELETE（LIKE 前缀 + `updated_at <=`）再 upsert，全在同一 batch」的统一规则，无需先读旧状态。
② scratch 是 `runAgenticFire` 每次调用新建的普通对象，挂进 fireCtx 与每轮 sessionCtx（shared 的 `buildSessionContext` 加可选参数，不传字段缺席 → instant 行为不变）。
③ capabilities 的 `serverVersion` 由 tsup `define` 构建期注入（`__AMSG_SERVER_VERSION__`，src 直跑时 typeof 守卫落 `0.0.0-dev`），features 是静态数组（表达「这份代码支持什么」，不反映部署配置）。

**Tech Stack:** Node 20 `node:test` + better-sqlite3 D1 shim；tsup；changesets（pre 模式 `next` tag）；纯 Web Crypto（红线：运行时代码禁 `node:` 内置——tsup.config.js 属构建脚本不受限）。

**红线自查项（每个 task 收尾过一遍）：** 新代码无 `node:` import / Buffer（tsup.config.js 除外）；无下游业务词；hook ctx / scratch 无 apiKey/pushSubscription/vapid/masterKey；老客户端可见行为：全成功响应形状不变、≤200KB 单值存储路径不变。

**兼容性注记（有意的行为变化，changeset 里写明）：**
- 批内有非法/超限条目：以前整批 400/413，现在 200 + `data.rejected` 逐条拒绝（交接 prompt 点名要求）。
- namespace / key 含 C0 控制字符（\u0000-\u001f）：以前接受，现在逐条拒绝（库内部保留；SQLite 的 LIKE 在 NUL 处截断 pattern，故内部分隔符选 \u001f 且必须挡住用户写入保留区）。
- `DELETE /client-state` 返回的 `deleted` 计数含内部切片行。
- adapter `upsertClientState` 返回值新增 `outcomes`（既有测试的 deepEqual 需同步）。

---

## File Structure

| 包 | 文件 | 动作 | 职责 |
|---|---|---|---|
| shared | `shared/src/index.js` | 修改 | `buildSessionContext` 加可选 `scratch` 透传 + SessionContext typedef |
| shared | `shared/test/agentic-contract.test.mjs` | 修改（追加） | scratch 透传/缺席测试 |
| server | `server/src/server/lib/state-chunks.js` | 新建 | 分块纯函数：marker 构造/解析、切片、保留 ns/key 命名、`resolveClientStateEntries` |
| server | `server/test/state-chunks.test.mjs` | 新建 | 纯函数单测（中文大包、emoji 代理对、缺块、ts 不一致） |
| server | `server/src/server/adapters/d1.js` | 修改 | `upsertClientState(userId, entries, cleanups)` + 返回 `outcomes`；LIKE 转义 |
| server | `server/src/server/adapters/interface.js` | 修改 | typedef 同步 |
| server | `server/src/server/handlers/client-state.js` | 修改 | 逐条校验（accepted/rejected）、分块展开物理行、逻辑计数、GET 拼回 |
| server | `server/test/client-state.test.mjs` | 修改 | 老 413 测试改写 + 分块往返/缩块清尾/LWW/局部失败/配置上限测试；adapter 段 deepEqual 加 outcomes + cleanups 测试 |
| server | `server/src/server/lib/agentic-fire.js` | 修改 | readState 走 `resolveClientStateEntries`；scratch 创建与挂载 |
| server | `server/test/agentic-fire.test.mjs` | 修改（追加） | readState 分块拼回；scratch 同引用/跨 fire 隔离/抛错隔离 |
| server | `server/src/server/lib/version.js` | 新建 | `SERVER_VERSION`（define 注入 + dev 兜底） |
| server | `server/src/server/handlers/capabilities.js` | 新建 | `SERVER_FEATURES` + GET handler |
| server | `server/src/server/single-user.js` | 修改 | 挂 capabilities handler；ctx 透传 `maxStateValueBytes`；config JSDoc |
| server | `server/src/server/cloudflare/single-user-worker.js` | 修改 | `GET /capabilities` 路由 + 头部路由表注释 |
| server | `server/tsup.config.js` | 修改 | `define: { __AMSG_SERVER_VERSION__ }` |
| server | `server/test/capabilities.test.mjs` | 新建 | 200 形状 / features 名单 / serverToken 401 |
| client | `client/src/index.js` | 修改 | `getCapabilities()`；`putClientState` JSDoc（大值 + rejected 响应） |
| client | `client/test/capabilities.test.mjs` | 新建 | 成功 / 404→null / 非 JSON→null / 失败抛错 / token 头 |
| server | `server/examples/cloudflare-single-user/README.md` | 修改 | 端点表 + 大值/局部失败一句话说明 |
| root | `.changeset/amsg-client-state-chunking.md`、`.changeset/amsg-agentic-scratch.md`、`.changeset/amsg-capabilities.md` | 新建 | server minor ×3 合并；shared minor；client minor |

分支：`feat/amsg-universal-gaps`（从 main 拉）。提交按 task 粒度，Conventional Commit。

---

### Task 1: shared — buildSessionContext 可选 scratch

**Files:**
- Modify: `packages/rei-standard-amsg/shared/src/index.js`（`SessionContext` typedef + `buildSessionContext`）
- Test: `packages/rei-standard-amsg/shared/test/agentic-contract.test.mjs`（文件末尾追加）

- [ ] **Step 1.1: 追加失败测试**（agentic-contract.test.mjs 末尾）

```js
describe('buildSessionContext scratch', () => {
  test('scratch 原样透传同一引用；ctx 冻结但 scratch 本体可变', () => {
    const scratch = { a: 1 };
    const ctx = buildSessionContext({
      sessionId: 's', messages: [], llmResponse: null, iteration: 0, contactName: 'C', scratch,
    });
    assert.equal(ctx.scratch, scratch);
    ctx.scratch.b = 2;
    assert.equal(scratch.b, 2);
  });

  test('不传 scratch → 字段缺席（instant 现有形状不变）', () => {
    const ctx = buildSessionContext({
      sessionId: 's', messages: [], llmResponse: null, iteration: 0, contactName: 'C',
    });
    assert.ok(!('scratch' in ctx));
  });
});
```

（该文件顶部应已 import `buildSessionContext`；若无则加进现有 import。）

- [ ] **Step 1.2: 跑测试确认失败**

Run: `node --test packages/rei-standard-amsg/shared/test/agentic-contract.test.mjs`
Expected: FAIL（`ctx.scratch` undefined ≠ scratch）

- [ ] **Step 1.3: 实现** — `shared/src/index.js`：

SessionContext typedef 追加一行属性：

```js
 * @property {Record<string, unknown>}  [scratch]      - Per-fire host scratch object. Producers that run several hooks within one fire (amsg-server's fire-time loop) pass the same mutable object to every hook of that fire, so hooks can hand context to each other without a module-level Map. The library never reads, writes, logs, or persists it, and never shares it across fires. Absent when the producer does not supply one (amsg-instant).
```

`buildSessionContext` 解构加 `scratch`，冻结前条件挂载：

```js
export function buildSessionContext({
  sessionId,
  messages,
  llmResponse,
  iteration,
  contactName,
  avatarUrl,
  charId,
  metadata,
  scratch,
}) {
  const llmOutputText = readLlmOutputText(llmResponse);
  const ctx = {
    sessionId,
    charId,
    messages,
    llmResponse,
    llmOutputText,
    iteration,
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
    contactName,
    avatarUrl: avatarUrl || undefined,
  };
  if (scratch !== undefined) ctx.scratch = scratch;
  return Object.freeze(ctx);
}
```

（JSDoc `@param` 列表同步补 `@param {Record<string, unknown>} [args.scratch]`。）

- [ ] **Step 1.4: 跑测试确认通过**

Run: `node --test packages/rei-standard-amsg/shared/test/agentic-contract.test.mjs`（全绿）
再跑 `node --test packages/rei-standard-amsg/instant/test/*.test.mjs` 确认 instant 无回归。

- [ ] **Step 1.5: Commit** `feat(amsg-shared): buildSessionContext 支持可选 scratch 透传`

---

### Task 2: server — lib/state-chunks.js 分块纯函数

**Files:**
- Create: `packages/rei-standard-amsg/server/src/server/lib/state-chunks.js`
- Test: `packages/rei-standard-amsg/server/test/state-chunks.test.mjs`

- [ ] **Step 2.1: 写失败测试** `test/state-chunks.test.mjs`：

```js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATE_CHUNK_SLICE_BYTES,
  chunkNamespaceFor,
  chunkKeyFor,
  buildChunkedRootValue,
  parseChunkedRootCount,
  splitStateValue,
  resolveClientStateEntries,
} from '../src/server/lib/state-chunks.js';

const utf8len = (s) => new TextEncoder().encode(s).length;
const identity = async (v) => v;

describe('state-chunks 纯函数', () => {
  test('marker 往返 + 严格解析（密文/普通文本/坏 marker → null）', () => {
    assert.equal(parseChunkedRootCount(buildChunkedRootValue(3)), 3);
    assert.equal(parseChunkedRootCount('aabb:ccdd:eeff'), null);   // encryptForStorage 形状
    assert.equal(parseChunkedRootCount('plain text'), null);
    assert.equal(parseChunkedRootCount('{"__chunked":1}'), null);
    assert.equal(parseChunkedRootCount('\u001famsg-chunked\u001fv1\u001f0'), null);
    assert.equal(parseChunkedRootCount('\u001famsg-chunked\u001fv1\u001fx'), null);
    assert.equal(parseChunkedRootCount(''), null);
  });

  test('splitStateValue：全中文大包每片 ≤ 200KB，拼回 === 原文', () => {
    const value = '记'.repeat(300_000); // ~900KB utf8
    const slices = splitStateValue(value);
    assert.ok(slices.length > 1);
    for (const s of slices) assert.ok(utf8len(s) <= STATE_CHUNK_SLICE_BYTES);
    assert.equal(slices.join(''), value);
  });

  test('splitStateValue：emoji 代理对不被劈开', () => {
    const value = '😀'.repeat(120_000); // 4B each ≈ 480KB
    const slices = splitStateValue(value);
    assert.ok(slices.length > 1);
    for (const s of slices) {
      const first = s.charCodeAt(0);
      const last = s.charCodeAt(s.length - 1);
      assert.ok(!(first >= 0xdc00 && first <= 0xdfff), '切片开头是孤立低位代理');
      assert.ok(!(last >= 0xd800 && last <= 0xdbff), '切片结尾是孤立高位代理');
    }
    assert.equal(slices.join(''), value);
  });

  test('resolveClientStateEntries：普通行直读，分块行拼回，chunk 查询只发一次', async () => {
    const rows = [
      { namespace: 'n', key: 'small', value: 'v-small', updated_at: 100 },
      { namespace: 'n', key: 'big', value: buildChunkedRootValue(2), updated_at: 200 },
    ];
    const chunkRows = [
      { namespace: chunkNamespaceFor('n'), key: chunkKeyFor('big', 0), value: 'AA', updated_at: 200 },
      { namespace: chunkNamespaceFor('n'), key: chunkKeyFor('big', 1), value: 'BB', updated_at: 200 },
    ];
    let fetches = 0;
    const entries = await resolveClientStateEntries(rows, async () => { fetches++; return chunkRows; }, identity);
    assert.deepEqual(entries, [
      { namespace: 'n', key: 'small', value: 'v-small', updatedAt: 100 },
      { namespace: 'n', key: 'big', value: 'AABB', updatedAt: 200 },
    ]);
    assert.equal(fetches, 1);
  });

  test('缺块 / updated_at 与根行不一致 → 该 key 视为不存在，其余照常', async () => {
    const rows = [
      { namespace: 'n', key: 'missing', value: buildChunkedRootValue(2), updated_at: 100 },
      { namespace: 'n', key: 'torn', value: buildChunkedRootValue(1), updated_at: 300 },
      { namespace: 'n', key: 'ok', value: 'fine', updated_at: 50 },
    ];
    const chunkRows = [
      { namespace: chunkNamespaceFor('n'), key: chunkKeyFor('missing', 0), value: 'AA', updated_at: 100 },
      { namespace: chunkNamespaceFor('n'), key: chunkKeyFor('torn', 0), value: 'OLD', updated_at: 200 },
    ];
    const entries = await resolveClientStateEntries(rows, async () => chunkRows, identity);
    assert.deepEqual(entries, [{ namespace: 'n', key: 'ok', value: 'fine', updatedAt: 50 }]);
  });

  test('没有分块根行时完全不触发 chunk 查询', async () => {
    const rows = [{ namespace: 'n', key: 'k', value: 'v', updated_at: 1 }];
    const entries = await resolveClientStateEntries(
      rows,
      async () => { throw new Error('should not fetch'); },
      identity
    );
    assert.deepEqual(entries, [{ namespace: 'n', key: 'k', value: 'v', updatedAt: 1 }]);
  });
});
```

- [ ] **Step 2.2: 跑测试确认失败**（模块不存在）

Run: `node --test packages/rei-standard-amsg/server/test/state-chunks.test.mjs`
Expected: FAIL（ERR_MODULE_NOT_FOUND）

- [ ] **Step 2.3: 实现** `src/server/lib/state-chunks.js`：

```js
/**
 * client_state 大值透明分块（单用户/D1 专用；handlers/client-state.js 与
 * lib/agentic-fire.js 的 readState 共用）。
 *
 * 存储格式（库内部实现细节，不进公开契约）：
 *   - 单条 value ≤ STATE_CHUNK_SLICE_BYTES（200KB）→ 历史单行路径，存储字节级不变。
 *   - 超过 → 服务端切片跨行：原 (namespace, key) 行的 value 写成纯文本 marker
 *     （`\u001famsg-chunked\u001fv1\u001f<块数>`），切片本体逐片 encryptForStorage
 *     后存进保留 namespace（`\u001famsg-chunks\u001f<原ns>`），key 为
 *     `<原key>\u001f<序号>`。写入方与读取方（客户端 / hook 作者）完全无感。
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
 * 把一个 namespace 的存储行解析成逻辑条目（GET /client-state 与 readState 共用）。
 * 普通行解密直读；分块根行按 marker 拼回。切片行查询是惰性的：整个 namespace
 * 没有分块根行时一次都不发。
 *
 * @param {Array<{ namespace: string, key: string, value: string, updated_at: number }>} rows
 *   用户 namespace 的存储行（getClientState 返回值）。
 * @param {() => Promise<Array<{ key: string, value: string, updated_at: number }>>} fetchChunkRows
 *   取该 namespace 对应保留 namespace 全部切片行（最多调用一次）。
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
```

- [ ] **Step 2.4: 跑测试确认通过**

Run: `node --test packages/rei-standard-amsg/server/test/state-chunks.test.mjs`
Expected: PASS

- [ ] **Step 2.5: Commit** `feat(amsg-server): client_state 分块纯函数（marker/切片/拼回）`

---

### Task 3: server — D1 adapter cleanups + outcomes

**Files:**
- Modify: `packages/rei-standard-amsg/server/src/server/adapters/d1.js`（upsertClientState）
- Modify: `packages/rei-standard-amsg/server/src/server/adapters/interface.js`（typedef）
- Test: `packages/rei-standard-amsg/server/test/client-state.test.mjs`（「D1 adapter client_state」describe 段）

- [ ] **Step 3.1: 更新既有断言 + 追加失败测试**

既有三处 `assert.deepEqual(r…, { upserted: …, skipped: … })` 补上 `outcomes`：
- `{ upserted: 2, skipped: 0 }` → `{ upserted: 2, skipped: 0, outcomes: [true, true] }`
- `{ upserted: 1, skipped: 1 }`（LWW 段）→ `{ upserted: 1, skipped: 1, outcomes: [false, true] }`（k1 旧→skip、k2 新→upsert）
- batch/fallback 段 `{ upserted: 2, skipped: 1 }` → `{ upserted: 2, skipped: 1, outcomes: [true, true, false] }`；`{ upserted: 1, skipped: 1 }` → `{ upserted: 1, skipped: 1, outcomes: [true, false] }`

describe 段末尾追加：

```js
  test('cleanups：LIKE 前缀删除只删自己 key 的切片、尊重 LWW、% 通配符被转义', async () => {
    const adapter = createD1Adapter(createTestD1());
    await adapter.initSchema();
    const chunkNs = '\u001famsg-chunks\u001fn';
    await adapter.upsertClientState(USER, [
      { namespace: chunkNs, key: 'a\u001f0', value: 'c0', updatedAt: 100 },
      { namespace: chunkNs, key: 'a\u001f1', value: 'c1', updatedAt: 100 },
      { namespace: chunkNs, key: 'ab\u001f0', value: 'other-key', updatedAt: 100 },
      { namespace: chunkNs, key: 'a%b\u001f0', value: 'pct-key', updatedAt: 100 },
    ]);

    // 清 key 'a' 的切片：'ab' / 'a%b' 的不受影响（\u001f 分隔符挡住前缀误伤）
    await adapter.upsertClientState(USER, [], [
      { namespace: chunkNs, keyPrefix: 'a\u001f', updatedAt: 150 },
    ]);
    let keys = (await adapter.getClientState(USER, chunkNs)).map((r) => r.key).sort();
    assert.deepEqual(keys, ['a%b\u001f0', 'ab\u001f0']);

    // 清 'a%b' 的切片：% 不能当通配符把 'ab' 的也带走
    await adapter.upsertClientState(USER, [], [
      { namespace: chunkNs, keyPrefix: 'a%b\u001f', updatedAt: 150 },
    ]);
    keys = (await adapter.getClientState(USER, chunkNs)).map((r) => r.key);
    assert.deepEqual(keys, ['ab\u001f0']);

    // 陈旧批次（updatedAt 更老）的 cleanup 删不动更新的行
    await adapter.upsertClientState(USER, [], [
      { namespace: chunkNs, keyPrefix: 'ab\u001f', updatedAt: 50 },
    ]);
    assert.equal((await adapter.getClientState(USER, chunkNs)).length, 1);

    // cleanup + upsert 同批：先删后写，同一 key 的新切片完整落库
    const r = await adapter.upsertClientState(USER, [
      { namespace: chunkNs, key: 'ab\u001f0', value: 'new0', updatedAt: 200 },
      { namespace: chunkNs, key: 'ab\u001f1', value: 'new1', updatedAt: 200 },
    ], [
      { namespace: chunkNs, keyPrefix: 'ab\u001f', updatedAt: 200 },
    ]);
    assert.deepEqual(r, { upserted: 2, skipped: 0, outcomes: [true, true] });
    assert.deepEqual(
      (await adapter.getClientState(USER, chunkNs)).map((x) => [x.key, x.value]),
      [['ab\u001f0', 'new0'], ['ab\u001f1', 'new1']]
    );
  });
```

- [ ] **Step 3.2: 跑测试确认失败**

Run: `node --test packages/rei-standard-amsg/server/test/client-state.test.mjs`
Expected: FAIL（outcomes 缺失 / cleanups 参数无效果）

- [ ] **Step 3.3: 实现** — d1.js 的 `upsertClientState` 整体替换为：

```js
  /**
   * Batch upsert. Last-write-wins per (namespace, key): an entry older
   * than the stored row (updatedAt strictly lower) is skipped; equal or
   * newer overwrites. Values arrive pre-encrypted (the handler encrypts).
   *
   * `cleanups` 是分块存储的清理项（见 lib/state-chunks.js）：在同一 batch 里
   * 先于 upsert 执行，按 (namespace, key 前缀) 删掉旧写入留下的切片行；
   * `updated_at <= ?` 条件保证陈旧批次删不动更新写入的行。
   *
   * Uses D1's batch() — one network round trip for the whole set (implicit
   * transaction). The client calls this endpoint inside its few-seconds
   * background window, so N sequential round trips could eat the whole
   * window. Bindings without batch() (e.g. the sqlite test shim, custom
   * adapters) fall back to a sequential loop.
   *
   * @param {string} userId
   * @param {Array<{ namespace: string, key: string, value: string, updatedAt: number }>} entries
   * @param {Array<{ namespace: string, keyPrefix: string, updatedAt: number }>} [cleanups]
   * @returns {Promise<{ upserted: number, skipped: number, outcomes: boolean[] }>}
   *   `outcomes[i]` 对应 entries[i] 是否真的写入（changes > 0）。
   */
  async upsertClientState(userId, entries, cleanups = []) {
    const UPSERT_SQL =
      `INSERT INTO client_state (user_id, namespace, key, value, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, namespace, key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at
       WHERE excluded.updated_at >= client_state.updated_at`;
    const CLEANUP_SQL =
      `DELETE FROM client_state
       WHERE user_id = ? AND namespace = ? AND key LIKE ? ESCAPE '\\' AND updated_at <= ?`;

    const buildStatements = () => [
      ...cleanups.map((c) =>
        this._db.prepare(CLEANUP_SQL).bind(userId, c.namespace, `${escapeLikePrefix(c.keyPrefix)}%`, c.updatedAt)
      ),
      ...entries.map((entry) =>
        this._db.prepare(UPSERT_SQL).bind(userId, entry.namespace, entry.key, entry.value, entry.updatedAt)
      ),
    ];

    let results;
    if (typeof this._db.batch === 'function') {
      results = await this._db.batch(buildStatements());
    } else {
      results = [];
      for (const stmt of buildStatements()) {
        results.push(await stmt.run());
      }
    }

    // cleanup 语句不计数：upserted/skipped/outcomes 只看 entries 对应的语句。
    const outcomes = results.slice(cleanups.length).map((res) => res.meta.changes > 0);
    let upserted = 0;
    let skipped = 0;
    for (const wrote of outcomes) {
      if (wrote) upserted++; else skipped++;
    }
    return { upserted, skipped, outcomes };
  }
```

模块顶部（class 外）加 LIKE 转义辅助：

```js
// LIKE 前缀转义：用户 key 里的 % _ \ 不能变成通配符/转义符。
function escapeLikePrefix(prefix) {
  return prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
```

interface.js 的 upsertClientState typedef 行同步为：

```js
 * @property {(userId: string, entries: Array<{namespace: string, key: string, value: string, updatedAt: number}>, cleanups?: Array<{namespace: string, keyPrefix: string, updatedAt: number}>) => Promise<{upserted: number, skipped: number, outcomes?: boolean[]}>} [upsertClientState]
 *   (optional; single-user/D1 only) Batch upsert, last-write-wins on updatedAt. `cleanups` 先于 upsert 在同一事务里按 key 前缀删旧切片行（分块存储清理；自定义 adapter 可忽略，只损失存储卫生不影响正确性）；`outcomes` 逐条报告是否真的写入（缺席时 handler 按物理行计数兜底）。
```

- [ ] **Step 3.4: 跑测试确认通过**

Run: `node --test packages/rei-standard-amsg/server/test/client-state.test.mjs`
Expected: PASS（handler 段暂未动，仍应全绿）

- [ ] **Step 3.5: Commit** `feat(amsg-server): D1 upsertClientState 支持 cleanups 与逐条 outcomes`

---

### Task 4: server — client-state handler 分块 + 整批局部失败

**Files:**
- Modify: `packages/rei-standard-amsg/server/src/server/handlers/client-state.js`
- Modify: `packages/rei-standard-amsg/server/src/server/single-user.js`（ctx 透传 `maxStateValueBytes` + config JSDoc）
- Test: `packages/rei-standard-amsg/server/test/client-state.test.mjs`（endpoints describe 段）

- [ ] **Step 4.1: 改写/追加端点测试**

删掉既有 `value over 200KB → 413` 测试，替换 + 追加：

```js
  test('刚超 200KB：不再整批 413，分块入库后 GET 读回原值', async () => {
    const d1 = createTestD1();
    const worker = makeWorker(d1);
    const env = { DB: d1 };
    await worker.fetch(new Request('https://w.dev/init-tenant', { method: 'POST' }), env);
    const value = 'x'.repeat(200 * 1024 + 1);
    const res = await putState(worker, env, [{ namespace: 'n', key: 'big', value, updatedAt: 1 }]);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).data, { upserted: 1, skipped: 0 });

    const getRes = await worker.fetch(new Request('https://w.dev/client-state?namespace=n', {
      method: 'GET', headers: { 'X-User-Id': USER },
    }), env);
    const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
    const data = await decryptPayload((await getRes.json()).data, userKey);
    assert.equal(data.entries.length, 1);
    assert.equal(data.entries[0].value, value);
  });

  test('中文大值分块：GET 拼回原值；物理存储 = 根 marker + 保留 ns 里的加密切片', async () => {
    const d1 = createTestD1();
    const worker = makeWorker(d1);
    const env = { DB: d1 };
    await worker.fetch(new Request('https://w.dev/init-tenant', { method: 'POST' }), env);

    const bigValue = JSON.stringify({ v: 1, doc: '记'.repeat(120_000) }); // ~360KB → 2 片
    await putState(worker, env, [
      { namespace: 'notes', key: 'big', value: bigValue, updatedAt: 100 },
      { namespace: 'notes', key: 'small', value: 'tiny', updatedAt: 100 },
    ]);

    const getRes = await worker.fetch(new Request('https://w.dev/client-state?namespace=notes', {
      method: 'GET', headers: { 'X-User-Id': USER },
    }), env);
    const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
    const data = await decryptPayload((await getRes.json()).data, userKey);
    assert.deepEqual(
      data.entries.map((e) => [e.key, e.value === bigValue ? 'intact' : 'CORRUPTED', e.updatedAt]),
      [['big', 'intact', 100], ['small', 'intact' === 'intact' && e0(data), 100]].map((x, i) =>
        i === 1 ? ['small', 'tiny', 100] : x)
    );

    const adapter = createD1Adapter(d1);
    const userRows = await adapter.getClientState(USER, 'notes');
    assert.equal(userRows.length, 2); // 用户 namespace 只有逻辑条目的行
    const rootRow = userRows.find((r) => r.key === 'big');
    assert.ok(rootRow.value.startsWith('\u001f'), '分块根行是 marker');
    const chunkRows = await adapter.getClientState(USER, '\u001famsg-chunks\u001fnotes');
    assert.equal(chunkRows.length, 2);
    for (const row of chunkRows) assert.match(row.value, /^[0-9a-f]+:[0-9a-f]+:/); // 切片是密文
  });

  test('覆盖写变小 / 缩块：旧切片行清干净，读到的始终是最新值', async () => {
    const d1 = createTestD1();
    const worker = makeWorker(d1);
    const env = { DB: d1 };
    await worker.fetch(new Request('https://w.dev/init-tenant', { method: 'POST' }), env);
    const adapter = createD1Adapter(d1);
    const chunkNs = '\u001famsg-chunks\u001fn';
    const readValue = async () => {
      const getRes = await worker.fetch(new Request('https://w.dev/client-state?namespace=n', {
        method: 'GET', headers: { 'X-User-Id': USER },
      }), env);
      const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
      const data = await decryptPayload((await getRes.json()).data, userKey);
      return data.entries.length === 1 ? data.entries[0].value : data.entries;
    };

    // 大(2片) → 小(单行)：切片全清
    await putState(worker, env, [{ namespace: 'n', key: 'k', value: '记'.repeat(120_000), updatedAt: 100 }]);
    await putState(worker, env, [{ namespace: 'n', key: 'k', value: 'small-now', updatedAt: 200 }]);
    assert.deepEqual(await adapter.getClientState(USER, chunkNs), []);
    assert.equal(await readValue(), 'small-now');

    // 大(3片) → 大(2片)：尾片不残留
    await putState(worker, env, [{ namespace: 'n', key: 'k', value: '记'.repeat(200_000), updatedAt: 300 }]);
    assert.equal((await adapter.getClientState(USER, chunkNs)).length, 3);
    const two = '记'.repeat(120_000);
    await putState(worker, env, [{ namespace: 'n', key: 'k', value: two, updatedAt: 400 }]);
    assert.equal((await adapter.getClientState(USER, chunkNs)).length, 2);
    assert.equal(await readValue(), two);
  });

  test('陈旧的分块写入动不了更新的值（LWW 对分块路径成立）', async () => {
    const d1 = createTestD1();
    const worker = makeWorker(d1);
    const env = { DB: d1 };
    await worker.fetch(new Request('https://w.dev/init-tenant', { method: 'POST' }), env);
    await putState(worker, env, [{ namespace: 'n', key: 'k', value: 'fresh', updatedAt: 500 }]);
    const stale = await putState(worker, env, [{ namespace: 'n', key: 'k', value: '记'.repeat(120_000), updatedAt: 100 }]);
    assert.deepEqual((await stale.json()).data, { upserted: 0, skipped: 1 });
    const getRes = await worker.fetch(new Request('https://w.dev/client-state?namespace=n', {
      method: 'GET', headers: { 'X-User-Id': USER },
    }), env);
    const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
    const data = await decryptPayload((await getRes.json()).data, userKey);
    assert.deepEqual(data.entries.map((e) => [e.key, e.value]), [['k', 'fresh']]);
  });

  test('整批局部失败：坏条目逐条拒绝，好条目照常入库；全成功响应不带 rejected', async () => {
    const d1 = createTestD1();
    const worker = makeWorker(d1);
    const env = { DB: d1 };
    await worker.fetch(new Request('https://w.dev/init-tenant', { method: 'POST' }), env);

    const res = await putState(worker, env, [
      { namespace: 'n', key: 'good', value: 'v', updatedAt: 100 },
      { namespace: 'n', key: 'bad-ts', value: 'v', updatedAt: -1 },
      { namespace: 'n', key: 'huge', value: 'x'.repeat(6 * 1024 * 1024), updatedAt: 100 },
      { namespace: 'n\u0000ctl', key: 'k', value: 'v', updatedAt: 100 },
    ]);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.upserted, 1);
    assert.deepEqual(
      body.data.rejected.map((r) => [r.index, r.code]),
      [[1, 'INVALID_STATE_UPDATED_AT'], [2, 'STATE_VALUE_TOO_LARGE'], [3, 'INVALID_STATE_NAMESPACE']]
    );
    const oversized = body.data.rejected.find((r) => r.code === 'STATE_VALUE_TOO_LARGE');
    assert.equal(oversized.maxBytes, 5 * 1024 * 1024);
    assert.equal(oversized.key, 'huge');

    const getRes = await worker.fetch(new Request('https://w.dev/client-state?namespace=n', {
      method: 'GET', headers: { 'X-User-Id': USER },
    }), env);
    const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
    const data = await decryptPayload((await getRes.json()).data, userKey);
    assert.deepEqual(data.entries.map((e) => e.key), ['good']);

    // 全成功响应形状不变（老客户端无感）
    const okRes = await putState(worker, env, [{ namespace: 'n', key: 'k2', value: 'v', updatedAt: 1 }]);
    assert.deepEqual(Object.keys((await okRes.json()).data).sort(), ['skipped', 'upserted']);
  });

  test('工厂配置 maxStateValueBytes 调总上限；GET 保留 namespace → 400', async () => {
    const d1 = createTestD1();
    const worker = makeWorker(d1, { maxStateValueBytes: 1024 });
    const env = { DB: d1 };
    await worker.fetch(new Request('https://w.dev/init-tenant', { method: 'POST' }), env);

    const res = await putState(worker, env, [
      { namespace: 'n', key: 'over', value: 'x'.repeat(2000), updatedAt: 1 },
      { namespace: 'n', key: 'under', value: 'x'.repeat(500), updatedAt: 1 },
    ]);
    const body = await res.json();
    assert.equal(body.data.upserted, 1);
    assert.deepEqual(body.data.rejected.map((r) => [r.key, r.code, r.maxBytes]),
      [['over', 'STATE_VALUE_TOO_LARGE', 1024]]);

    const badNs = await worker.fetch(new Request('https://w.dev/client-state?namespace=%1Famsg-chunks%1Fn', {
      method: 'GET', headers: { 'X-User-Id': USER },
    }), env);
    assert.equal(badNs.status, 400);
    assert.equal((await badNs.json()).error.code, 'INVALID_STATE_NAMESPACE');
  });
```

（注：第二个测试里 `e0(data)` 是笔误示意，落地时直接写成两行独立断言：`assert.equal(data.entries[0].value, bigValue)`、`assert.deepEqual(data.entries[1], { namespace: 'notes', key: 'small', value: 'tiny', updatedAt: 100 })`，不要照抄示意里的 map 花活。）

- [ ] **Step 4.2: 跑测试确认失败**

Run: `node --test packages/rei-standard-amsg/server/test/client-state.test.mjs`
Expected: 新增测试 FAIL（大值仍 413、无 rejected 等）

- [ ] **Step 4.3: 实现 handler** — client-state.js：

顶部 import 追加：

```js
import {
  STATE_CHUNK_SLICE_BYTES,
  DEFAULT_MAX_STATE_VALUE_BYTES,
  INTERNAL_STATE_CHAR_RE,
  chunkNamespaceFor,
  chunkKeyFor,
  chunkKeyPrefixFor,
  buildChunkedRootValue,
  splitStateValue,
  resolveClientStateEntries,
} from '../lib/state-chunks.js';
```

常量段改为（保留 export 兼容既有 import）：

```js
// 单个存储行的 plaintext 上限 = 分块切片大小：≤ 此值的 value 走历史单行路径
// （存储字节级不变），超过的由服务端透明分块（见 lib/state-chunks.js）。
// 单条 value 的总上限默认 5MB，工厂配置 maxStateValueBytes 可调。
export const MAX_STATE_VALUE_BYTES = STATE_CHUNK_SLICE_BYTES;
```

`validateEntry` 改为返回「拒绝对象或 null」；新增 `rejectEntry`：

```js
function rejectEntry(entry, index, code, message, extra) {
  const rejection = { index, code, message, ...(extra || {}) };
  if (entry && typeof entry === 'object') {
    if (typeof entry.namespace === 'string') rejection.namespace = entry.namespace;
    if (typeof entry.key === 'string') rejection.key = entry.key;
  }
  return rejection;
}

function validateEntry(entry, index, maxValueBytes) {
  if (!isPlainObject(entry)) {
    return rejectEntry(entry, index, 'INVALID_STATE_ENTRY', `entries[${index}] 必须是对象`);
  }
  if (typeof entry.namespace !== 'string' || !entry.namespace.trim() || entry.namespace.length > MAX_NAMESPACE_CHARS) {
    return rejectEntry(entry, index, 'INVALID_STATE_NAMESPACE', `entries[${index}].namespace 必须是 1-${MAX_NAMESPACE_CHARS} 字符的字符串`);
  }
  if (INTERNAL_STATE_CHAR_RE.test(entry.namespace)) {
    return rejectEntry(entry, index, 'INVALID_STATE_NAMESPACE', `entries[${index}].namespace 不能包含控制字符（\\u0000-\\u001f 为库内部保留）`);
  }
  if (typeof entry.key !== 'string' || !entry.key.trim() || entry.key.length > MAX_KEY_CHARS) {
    return rejectEntry(entry, index, 'INVALID_STATE_KEY', `entries[${index}].key 必须是 1-${MAX_KEY_CHARS} 字符的字符串`);
  }
  if (INTERNAL_STATE_CHAR_RE.test(entry.key)) {
    return rejectEntry(entry, index, 'INVALID_STATE_KEY', `entries[${index}].key 不能包含控制字符（\\u0000-\\u001f 为库内部保留）`);
  }
  if (typeof entry.value !== 'string') {
    return rejectEntry(entry, index, 'INVALID_STATE_VALUE', `entries[${index}].value 必须是字符串（宿主自行序列化）`);
  }
  const bytes = utf8.encode(entry.value).length;
  if (bytes > maxValueBytes) {
    return rejectEntry(entry, index, 'STATE_VALUE_TOO_LARGE', `entries[${index}].value 超过单条总上限`, { bytes, maxBytes: maxValueBytes });
  }
  if (!Number.isInteger(entry.updatedAt) || entry.updatedAt <= 0) {
    return rejectEntry(entry, index, 'INVALID_STATE_UPDATED_AT', `entries[${index}].updatedAt 必须是正整数（epoch 毫秒）`);
  }
  return null;
}
```

PUT 的「逐条校验 + upsert + 响应」段（从原 `for … validateEntry` 到 `return { status: 200 … }`）替换为：

```js
    const maxValueBytes = Number.isInteger(ctx.maxStateValueBytes) && ctx.maxStateValueBytes > 0
      ? ctx.maxStateValueBytes
      : DEFAULT_MAX_STATE_VALUE_BYTES;

    // 逐条校验：坏条目只拒它自己（响应 data.rejected 逐条给原因），好条目照常入库。
    const accepted = [];
    const rejected = [];
    for (let i = 0; i < entries.length; i++) {
      const rejection = validateEntry(entries[i], i, maxValueBytes);
      if (rejection) rejected.push(rejection); else accepted.push(entries[i]);
    }

    if (typeof db.upsertClientState !== 'function') {
      return err(501, 'CLIENT_STATE_NOT_SUPPORTED', '当前数据库适配器不支持 client_state');
    }

    // 展开成物理行：小值 1 行（历史路径，字节级不变），大值 = 根 marker 行 +
    // 保留 namespace 里的 N 个加密切片行。每条 accepted 条目都配一条 cleanup
    // （同一 batch 里先删后写），把这个 key 旧写入留下的切片清干净 —— 覆盖写
    // 变小 / 缩块都不留尾巴，陈旧批次的 cleanup 因 updated_at 条件删不动新行。
    const physicalRows = [];
    const cleanups = [];
    const rootRowIndexes = [];
    for (const entry of accepted) {
      cleanups.push({
        namespace: chunkNamespaceFor(entry.namespace),
        keyPrefix: chunkKeyPrefixFor(entry.key),
        updatedAt: entry.updatedAt,
      });
      rootRowIndexes.push(physicalRows.length);
      if (utf8.encode(entry.value).length <= STATE_CHUNK_SLICE_BYTES) {
        physicalRows.push({
          namespace: entry.namespace,
          key: entry.key,
          value: await encryptForStorage(entry.value, userKey),
          updatedAt: entry.updatedAt,
        });
      } else {
        const slices = splitStateValue(entry.value);
        physicalRows.push({
          namespace: entry.namespace,
          key: entry.key,
          value: buildChunkedRootValue(slices.length),
          updatedAt: entry.updatedAt,
        });
        const encryptedSlices = await Promise.all(slices.map((slice) => encryptForStorage(slice, userKey)));
        for (let c = 0; c < encryptedSlices.length; c++) {
          physicalRows.push({
            namespace: chunkNamespaceFor(entry.namespace),
            key: chunkKeyFor(entry.key, c),
            value: encryptedSlices[c],
            updatedAt: entry.updatedAt,
          });
        }
      }
    }

    let upserted = 0;
    let skipped = 0;
    if (physicalRows.length > 0) {
      const result = await db.upsertClientState(userId, physicalRows, cleanups);
      if (Array.isArray(result.outcomes) && result.outcomes.length === physicalRows.length) {
        // 逻辑计数：一条 entry 的 upserted/skipped 看它的根行（切片行不计数）。
        for (const rootIndex of rootRowIndexes) {
          if (result.outcomes[rootIndex]) upserted++; else skipped++;
        }
      } else {
        // 自定义 adapter 只回老形状时按物理行计数兜底。
        upserted = result.upserted;
        skipped = result.skipped;
      }
    }

    const data = { upserted, skipped };
    if (rejected.length > 0) data.rejected = rejected;
    return { status: 200, body: { success: true, data } };
```

GET 的 namespace 校验后追加保留区拦截，行解析改走 `resolveClientStateEntries`：

```js
    const namespace = new URL(url, 'https://dummy').searchParams.get('namespace') || '';
    if (!namespace.trim()) return err(400, 'NAMESPACE_REQUIRED', '必须提供 namespace 查询参数');
    if (INTERNAL_STATE_CHAR_RE.test(namespace)) {
      return err(400, 'INVALID_STATE_NAMESPACE', 'namespace 不能包含控制字符（\\u0000-\\u001f 为库内部保留）');
    }
```

```js
    const userKey = await deriveUserEncryptionKey(userId, masterKey);
    const rows = await db.getClientState(userId, namespace);
    const decrypted = await resolveClientStateEntries(
      rows,
      () => db.getClientState(userId, chunkNamespaceFor(namespace)),
      (value) => decryptFromStorage(value, userKey)
    );
```

文件头注释补两句（平铺直叙）：单条 value 超过 200KB 时服务端切片跨行存、读取拼回原值，客户端无感；批内坏条目逐条拒绝，响应在有拒绝时带 `data.rejected`。

single-user.js：ctx 增加一行 `maxStateValueBytes: config.maxStateValueBytes,`（放在 `totalTimeoutMs` 之后），config JSDoc 增加：

```js
 * @param {number} [config.maxStateValueBytes] - client_state 单条 value 的总上限（默认 5MB）。超过 200KB 的值由服务端透明分块存储。
```

- [ ] **Step 4.4: 跑测试确认通过**

Run: `node --test packages/rei-standard-amsg/server/test/client-state.test.mjs`
Expected: PASS（含既有测试——单值路径、密文落库、401 矩阵全部不变）

- [ ] **Step 4.5: Commit** `feat(amsg-server): client_state 大值透明分块 + 整批局部失败`

---

### Task 5: server — agentic-fire readState 分块拼回 + scratch

**Files:**
- Modify: `packages/rei-standard-amsg/server/src/server/lib/agentic-fire.js`
- Test: `packages/rei-standard-amsg/server/test/agentic-fire.test.mjs`（追加）

- [ ] **Step 5.1: 追加失败测试**

```js
describe('readState 分块拼回', () => {
  test('分块的 client_state 值拼回原文；写到一半断掉的 key 不出现', async () => {
    const d1 = createTestD1();
    const adapter = createD1Adapter(d1);
    await adapter.initSchema();
    const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
    const { buildChunkedRootValue, chunkNamespaceFor, chunkKeyFor } =
      await import('../src/server/lib/state-chunks.js');
    await adapter.upsertClientState(USER, [
      { namespace: 'ns', key: 'big', value: buildChunkedRootValue(2), updatedAt: 100 },
      { namespace: chunkNamespaceFor('ns'), key: chunkKeyFor('big', 0), value: await encryptForStorage('前半', userKey), updatedAt: 100 },
      { namespace: chunkNamespaceFor('ns'), key: chunkKeyFor('big', 1), value: await encryptForStorage('后半', userKey), updatedAt: 100 },
      { namespace: 'ns', key: 'torn', value: buildChunkedRootValue(2), updatedAt: 200 },
      { namespace: chunkNamespaceFor('ns'), key: chunkKeyFor('torn', 0), value: await encryptForStorage('半截', userKey), updatedAt: 200 },
    ]);

    const { task } = await makeTask();
    let seen;
    const hooks = {
      onBeforeFire: async (fireCtx) => {
        seen = await fireCtx.readState('ns');
        return [{ role: 'user', content: 'U' }];
      },
      onLLMOutput: async () => ({ decision: 'skip-push' }),
    };
    const llm = stubLlm([finishRound]);
    try {
      const result = await processSingleMessage(task, makeCtx({ hooks, db: adapter }));
      assert.equal(result.success, true);
      assert.deepEqual(seen, [{ namespace: 'ns', key: 'big', value: '前半后半', updatedAt: 100 }]);
    } finally {
      llm.restore();
    }
  });
});

describe('fire 级 scratch', () => {
  test('同一次 fire 的 onBeforeFire / onLLMOutput / executeToolCalls 拿到同一引用；跨 fire 隔离', async () => {
    const { task } = await makeTask();
    const seen = [];
    let llmOutputCalls = 0;
    const decisions = [
      { decision: 'tool-request', toolCalls: [TOOL_CALL] },
      { decision: 'finish', pushPayloads: [{ messageKind: 'content', message: 'ok' }] },
    ];
    const hooks = {
      onBeforeFire: async (fireCtx) => {
        fireCtx.scratch.token = (fireCtx.scratch.token || 0) + 1;
        seen.push(fireCtx.scratch);
        return [{ role: 'user', content: 'U' }];
      },
      onLLMOutput: async (sessionCtx) => { seen.push(sessionCtx.scratch); return decisions[llmOutputCalls++]; },
      executeToolCalls: async (_toolCalls, sessionCtx) => {
        seen.push(sessionCtx.scratch);
        return [{ tool_call_id: 'call_1', role: 'tool', content: 'ok' }];
      },
    };
    const llm = stubLlm([toolRound, finishRound]);
    try {
      await processSingleMessage(task, makeCtx({ hooks }));
      // before / llm轮1 / tools / llm轮2 —— 4 次全同一引用，且 token 只加了一次
      assert.equal(seen.length, 4);
      for (const s of seen) assert.equal(s, seen[0]);
      assert.equal(seen[0].token, 1);

      // 第二次 fire（重试语义）：新对象，token 重新从 1 开始
      llmOutputCalls = 0;
      seen.length = 0;
      await processSingleMessage(task, makeCtx({ hooks }));
      assert.equal(seen[0].token, 1);
    } finally {
      llm.restore();
    }
  });

  test('fire 抛错后 scratch 不带到下一次 fire', async () => {
    const { task } = await makeTask();
    const scratches = [];
    const hooks = {
      onBeforeFire: async (fireCtx) => {
        scratches.push(fireCtx.scratch);
        fireCtx.scratch.poisoned = true;
        return [{ role: 'user', content: 'U' }];
      },
      onLLMOutput: async () => { throw new Error('boom'); },
    };
    const llm = stubLlm([finishRound]);
    try {
      const r1 = await processSingleMessage(task, makeCtx({ hooks }));
      const r2 = await processSingleMessage(task, makeCtx({ hooks }));
      assert.equal(r1.success, false);
      assert.equal(r2.success, false);
      assert.equal(scratches.length, 2);
      assert.notEqual(scratches[0], scratches[1]);
      assert.equal(scratches[1].poisoned, true); // 本次 hook 自己写的
    } finally {
      llm.restore();
    }
  });
});
```

（`deriveUserEncryptionKey` / `encryptForStorage` 该文件已 import。）

- [ ] **Step 5.2: 跑测试确认失败**

Run: `node --test packages/rei-standard-amsg/server/test/agentic-fire.test.mjs`
Expected: 新增测试 FAIL（scratch undefined；readState 返回 marker 原文）

- [ ] **Step 5.3: 实现** — agentic-fire.js：

import 区追加：

```js
import { chunkNamespaceFor, resolveClientStateEntries } from './state-chunks.js';
```

`readState` 主体改为：

```js
  const readState = async (namespace) => {
    if (typeof namespace !== 'string' || !namespace.trim()) {
      throw new TypeError('readState(namespace) requires a non-empty string');
    }
    if (!ctx.db || typeof ctx.db.getClientState !== 'function') return [];
    const rows = await ctx.db.getClientState(task.user_id, namespace);
    // 分块存储的值在这里拼回原文（见 lib/state-chunks.js）；块不齐全的 key
    // 视为不存在，hook 作者拿到的与客户端写入的一致。
    return resolveClientStateEntries(
      rows,
      () => ctx.db.getClientState(task.user_id, chunkNamespaceFor(namespace)),
      (value) => decryptFromStorage(value, userKey)
    );
  };
```

`fireCtx` 之前创建 scratch 并挂载；每轮 `buildSessionContext` 传入：

```js
  // 单次 fire 的宿主便签：onBeforeFire 的 fireCtx 和同一次 fire 每轮的
  // sessionCtx（onLLMOutput / executeToolCalls）拿到同一个对象引用，fire 结束
  // （finish / skip-push / 抛错 / 轮数超限）随调用栈丢弃。库自己不读不写、
  // 不落库、不打日志、不跨 fire 共享 —— 重试产生的新 fire 拿到的是新对象。
  const scratch = {};

  const fireCtx = Object.freeze({
    task: buildHookTask(task, decryptedPayload),
    userId: task.user_id,
    readState,
    now: new Date(nowFn()),
    scratch,
  });
```

```js
    const sessionCtx = buildSessionContext({
      sessionId,
      messages,
      llmResponse,
      iteration,
      contactName: decryptedPayload.contactName,
      avatarUrl: decryptedPayload.avatarUrl || undefined,
      charId: decryptedPayload.charId,
      metadata: decryptedPayload.metadata,
      scratch,
    });
```

文件头注释的 Credential hiding 段后补一句 scratch 生命周期说明（同上注释要点）。

- [ ] **Step 5.4: 跑测试确认通过**

Run: `node --test packages/rei-standard-amsg/server/test/agentic-fire.test.mjs`
Expected: PASS（既有循环测试不受影响）

- [ ] **Step 5.5: Commit** `feat(amsg-server): fire 级 scratch 进 hook ctx；readState 拼回分块值`

---

### Task 6: server — GET /capabilities + 版本注入

**Files:**
- Create: `packages/rei-standard-amsg/server/src/server/lib/version.js`
- Create: `packages/rei-standard-amsg/server/src/server/handlers/capabilities.js`
- Modify: `packages/rei-standard-amsg/server/src/server/single-user.js`（挂 handler）
- Modify: `packages/rei-standard-amsg/server/src/server/cloudflare/single-user-worker.js`（路由 + 头注释）
- Modify: `packages/rei-standard-amsg/server/tsup.config.js`（define）
- Test: `packages/rei-standard-amsg/server/test/capabilities.test.mjs`

- [ ] **Step 6.1: 写失败测试** `test/capabilities.test.mjs`：

```js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createTestD1 } from './helpers/sqlite-d1.mjs';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { createSingleUserCloudflareWorker } from '../src/server/cloudflare/single-user-worker.js';

const MASTER_KEY = 'a'.repeat(64);

function makeWorker(d1, extra = {}) {
  return createSingleUserCloudflareWorker((env) => ({
    db: createD1Adapter(env.DB),
    masterKey: MASTER_KEY,
    vapid: { email: 'mailto:x@example.com', publicKey: 'pub', privateKey: 'priv' },
    webpush: { async sendNotification() {} },
    ...extra,
  }));
}

describe('GET /capabilities', () => {
  test('返回 serverVersion + 静态 features 名单', async () => {
    const d1 = createTestD1();
    const worker = makeWorker(d1);
    const res = await worker.fetch(new Request('https://w.dev/capabilities', { method: 'GET' }), { DB: d1 });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(typeof body.serverVersion, 'string');
    assert.ok(body.serverVersion.length > 0);
    for (const f of [
      'client-state',
      'client-state-chunking',
      'client-state-partial-failure',
      'agentic-hooks',
      'agentic-scratch',
      'vapid-public-key',
    ]) {
      assert.ok(body.features.includes(f), `features 应包含 ${f}`);
    }
  });

  test('serverToken 配置后：无 X-Client-Token → 401，带上 → 200', async () => {
    const d1 = createTestD1();
    const worker = makeWorker(d1, { serverToken: 's3cret' });
    const env = { DB: d1 };
    const no = await worker.fetch(new Request('https://w.dev/capabilities', { method: 'GET' }), env);
    assert.equal(no.status, 401);
    const ok = await worker.fetch(new Request('https://w.dev/capabilities', {
      method: 'GET', headers: { 'X-Client-Token': 's3cret' },
    }), env);
    assert.equal(ok.status, 200);
  });
});
```

- [ ] **Step 6.2: 跑测试确认失败**

Run: `node --test packages/rei-standard-amsg/server/test/capabilities.test.mjs`
Expected: FAIL（404 NOT_FOUND）

- [ ] **Step 6.3: 实现**

`src/server/lib/version.js`：

```js
/**
 * 构建期注入的包版本。tsup 用 define 把 __AMSG_SERVER_VERSION__ 替换成
 * package.json 的 version（见 tsup.config.js），发布产物里是真实版本号；
 * 直接跑 src（node --test / 本地调试）没有这个替换，typeof 守卫落到
 * '0.0.0-dev'。
 */
/* global __AMSG_SERVER_VERSION__ */
export const SERVER_VERSION =
  typeof __AMSG_SERVER_VERSION__ !== 'undefined' ? __AMSG_SERVER_VERSION__ : '0.0.0-dev';
```

`src/server/handlers/capabilities.js`：

```js
/**
 * Handler: capabilities
 *
 * GET /capabilities → { success, serverVersion, features }。前端用它做特性
 * 探测：worker 部署版本落后时，新链路只是「探测不到」（而不是静默失效），
 * 设置页可以据此提示重新部署 worker。老部署没有这个路由 → 404，客户端 SDK
 * 的 getCapabilities() 把 404 归一成 null。
 *
 * features 表达「这份代码支持什么」，随版本静态演进追加；不反映部署配置——
 * 例如 'agentic-hooks' 表示该版本认识 fire-time hooks，宿主配没配 hooks 不
 * 影响它出现。
 *
 * 鉴权与 /vapid-public-key 同待遇：走 resolveTenant，配置 serverToken 后同样
 * 要求 X-Client-Token。
 */

import { SERVER_VERSION } from '../lib/version.js';

export const SERVER_FEATURES = Object.freeze([
  'client-state',
  'client-state-chunking',
  'client-state-partial-failure',
  'agentic-hooks',
  'agentic-scratch',
  'vapid-public-key',
]);

export function createCapabilitiesHandler(ctx) {
  async function GET(url, headers) {
    const effectiveHeaders = headers || url || {};
    const tenantResult = await ctx.tenantManager.resolveTenant(effectiveHeaders);
    if (!tenantResult.ok) {
      return tenantResult.error;
    }
    return {
      status: 200,
      body: { success: true, serverVersion: SERVER_VERSION, features: [...SERVER_FEATURES] },
    };
  }
  return { GET };
}
```

single-user.js：import + handlers 挂载 `capabilities: createCapabilitiesHandler(ctx)`。

single-user-worker.js：路由表注释加一行 `GET  /capabilities      → { serverVersion, features }（特性探测；老部署无此路由 → 404）`；vapid 路由分支后加：

```js
      } else if (method === 'GET' && pathname.endsWith('/capabilities')) {
        result = await server.handlers.capabilities.GET(url, headers);
```

tsup.config.js：

```js
import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  // Two entries: the root (multi-tenant, Node) and a Cloudflare/D1-only entry
  // that omits the pg/neon/web-push graph so Worker bundles resolve on a
  // D1-only install. See src/server/cloudflare.js.
  entry: {
    index: 'src/server/index.js',
    cloudflare: 'src/server/cloudflare.js'
  },
  format: ['cjs', 'esm'],
  dts: true,
  outDir: 'dist',
  outExtension({ format }) {
    return { js: format === 'esm' ? '.mjs' : '.cjs' };
  },
  platform: 'node',
  target: 'node20',
  splitting: true,
  clean: true,
  // GET /capabilities 的 serverVersion：构建期把版本号焊进产物，
  // 避免手工维护一个会漂移的常量。
  define: {
    __AMSG_SERVER_VERSION__: JSON.stringify(pkg.version)
  }
});
```

- [ ] **Step 6.4: 跑测试确认通过**

Run: `node --test packages/rei-standard-amsg/server/test/capabilities.test.mjs`
Expected: PASS（src 直跑 serverVersion = '0.0.0-dev'，非空即可）

- [ ] **Step 6.5: Commit** `feat(amsg-server): GET /capabilities 特性探测端点`

---

### Task 7: client — getCapabilities()

**Files:**
- Modify: `packages/rei-standard-amsg/client/src/index.js`（`getVapidPublicKey` 之后加方法；`putClientState` JSDoc 更新）
- Test: `packages/rei-standard-amsg/client/test/capabilities.test.mjs`

- [ ] **Step 7.1: 写失败测试** `client/test/capabilities.test.mjs`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReiClient } from '../src/index.js';

const USER = '550e8400-e29b-41d4-a716-446655440000';

function withFetch(impl, run) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return run().finally(() => { globalThis.fetch = original; });
}

test('getCapabilities() GET /capabilities，带 X-Client-Token，返回 { serverVersion, features }', async () => {
  const captured = [];
  await withFetch(async (url, init) => {
    captured.push({ url: String(url), method: init && init.method, headers: (init && init.headers) || {} });
    return new Response(JSON.stringify({
      success: true, serverVersion: '2.7.0', features: ['client-state', 'client-state-chunking'],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }, async () => {
    const client = new ReiClient({ baseUrl: 'https://w.dev', userId: USER, serverToken: 's3cret' });
    const caps = await client.getCapabilities();
    assert.deepEqual(caps, { serverVersion: '2.7.0', features: ['client-state', 'client-state-chunking'] });
  });
  assert.equal(captured[0].url, 'https://w.dev/capabilities');
  assert.equal(captured[0].method, 'GET');
  assert.equal(captured[0].headers['X-Client-Token'], 's3cret');
});

test('老 worker 404（JSON 或非 JSON）→ null 不抛错', async () => {
  await withFetch(async () => new Response(
    JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: 'Unknown route' } }),
    { status: 404, headers: { 'Content-Type': 'application/json' } }
  ), async () => {
    const client = new ReiClient({ baseUrl: 'https://w.dev', userId: USER });
    assert.equal(await client.getCapabilities(), null);
  });
  await withFetch(async () => new Response('<html>Not Found</html>', { status: 404 }), async () => {
    const client = new ReiClient({ baseUrl: 'https://w.dev', userId: USER });
    assert.equal(await client.getCapabilities(), null);
  });
});

test('非 404 但响应不是 JSON（代理错误页）→ null', async () => {
  await withFetch(async () => new Response('<html>Bad Gateway</html>', { status: 200 }), async () => {
    const client = new ReiClient({ baseUrl: 'https://w.dev', userId: USER });
    assert.equal(await client.getCapabilities(), null);
  });
});

test('success:false（如 token 错 401）→ 抛错带服务端 message', async () => {
  await withFetch(async () => new Response(
    JSON.stringify({ success: false, error: { code: 'UNAUTHORIZED', message: '缺少或错误的 X-Client-Token' } }),
    { status: 401, headers: { 'Content-Type': 'application/json' } }
  ), async () => {
    const client = new ReiClient({ baseUrl: 'https://w.dev', userId: USER, serverToken: 'wrong' });
    await assert.rejects(() => client.getCapabilities(), /X-Client-Token/);
  });
});
```

- [ ] **Step 7.2: 跑测试确认失败**

Run: `node --test packages/rei-standard-amsg/client/test/capabilities.test.mjs`
Expected: FAIL（getCapabilities is not a function）

- [ ] **Step 7.3: 实现** — `getVapidPublicKey` 方法之后追加：

```js
  /**
   * Fetch the worker's capability manifest (single-user amsg-server 2.7.0+,
   * `GET /capabilities`).
   *
   * Feature detection for deploy drift: an outdated worker lacks newer
   * endpoints/behaviors silently, so the frontend can call this once and
   * show a "worker needs a redeploy" hint instead of leaving new features
   * dead. Feature names are library-defined strings (e.g. `client-state`,
   * `client-state-chunking`, `agentic-hooks`) that grow over time.
   *
   * Sends `X-Client-Token` when a `serverToken` is configured.
   *
   * @returns {Promise<{ serverVersion: string, features: string[] } | null>}
   *   `null` when the worker predates the endpoint (HTTP 404) or the
   *   response is not JSON (e.g. a proxy error page). Other failures
   *   (wrong token, 5xx with a JSON envelope) throw.
   */
  async getCapabilities() {
    const res = await fetch(`${this._baseUrl}/capabilities`, {
      method: 'GET',
      headers: this._withServerToken({})
    });
    if (res.status === 404) return null;

    let json;
    try {
      json = await res.json();
    } catch {
      return null;
    }
    if (!json?.success) throw new Error(json?.error?.message || 'Failed to fetch capabilities');
    return {
      serverVersion: typeof json.serverVersion === 'string' ? json.serverVersion : '',
      features: Array.isArray(json.features) ? json.features : []
    };
  }
```

`putClientState` JSDoc 补两点（平铺直叙）：value 超过 200KB 时由 worker（amsg-server 2.7.0+ 单用户）透明分块存储，客户端无需自行切分，总上限默认 5MB（worker 工厂配置可调）；批内有坏条目时响应为 `{ success: true, data: { upserted, skipped, rejected: [{ index, namespace, key, code, message }] } }`，全部成功时 `rejected` 缺席。

- [ ] **Step 7.4: 跑测试确认通过**

Run: `node --test packages/rei-standard-amsg/client/test/*.test.mjs`
Expected: PASS（全部客户端测试）

- [ ] **Step 7.5: Commit** `feat(amsg-client): getCapabilities() 特性探测`

---

### Task 8: 文档 + changesets

**Files:**
- Modify: `packages/rei-standard-amsg/server/examples/cloudflare-single-user/README.md`
- Create: `.changeset/amsg-client-state-chunking.md`、`.changeset/amsg-agentic-scratch.md`、`.changeset/amsg-capabilities.md`

- [ ] **Step 8.1: README** — 端点表加 `GET /capabilities` 一行；client_state 段补两句：单条 value 超过 200KB 由 worker 分块存储、读取拼回（客户端无感，总上限默认 5MB 可配）；批量上传里坏条目只拒它自己，响应 `data.rejected` 给原因。语气平铺直叙，不踩旧版本。

- [ ] **Step 8.2: changesets**

`.changeset/amsg-client-state-chunking.md`：

```md
---
"@rei-standard/amsg-server": minor
---

client_state 大值透明分块 + 整批局部失败（单用户 worker）

- `PUT /client-state` 单条 value 不再受 200KB 整批 413 的限制：超过 200KB 的值由服务端切片跨行存储，`GET /client-state` 与 hook 的 `ctx.readState()` 返回拼好的原值，客户端和 hook 作者无感。单条总上限默认 5MB，工厂配置 `maxStateValueBytes` 可调。切片在码点边界（中文 / emoji 不会被劈开）；覆盖写变小不残留旧切片；块不齐全（写到一半断了）时该 key 视为不存在，读方走自己的兜底。
- 整批局部失败：批里某条超限 / 非法只拒它自己，其余照常入库。有拒绝时响应带 `data.rejected: [{ index, namespace, key, code, message }]`；全部成功时响应形状与之前完全一致。
- namespace / key 里的控制字符（\u0000-\u001f）为库内部保留，逐条拒绝。
- adapter 的 `upsertClientState` 新增可选第三参 `cleanups` 与返回值 `outcomes`；自定义 adapter 不实现也能工作（只损失存储卫生，不影响正确性）。
```

`.changeset/amsg-agentic-scratch.md`：

```md
---
"@rei-standard/amsg-shared": minor
"@rei-standard/amsg-server": minor
---

fire 级 scratch：hook 之间传上下文不再自己维护 Map

单次 fire 开始时库创建一个空对象，`onBeforeFire` 的 fireCtx 和同一次 fire 里每轮 `onLLMOutput` / `executeToolCalls` 的 sessionCtx 都拿到同一个 `scratch` 引用；fire 结束（finish / skip-push / 抛错 / 轮数超限）后随之丢弃。不落库、不进日志、不跨 fire 共享。amsg-shared 的 `buildSessionContext` 新增可选 `scratch` 参数（不传则字段缺席，amsg-instant 行为不变）。
```

`.changeset/amsg-capabilities.md`：

```md
---
"@rei-standard/amsg-server": minor
"@rei-standard/amsg-client": minor
---

`GET /capabilities` 特性探测端点 + 客户端 `getCapabilities()`

worker 部署版本落后时，新功能只是「探测不到」而不是静默失效。单用户 worker 新增 `GET /capabilities`，返回 `{ serverVersion, features }`（feature 名如 `client-state` / `client-state-chunking` / `agentic-hooks`，随版本演进追加；表达代码能力，不反映部署配置）；鉴权与 `/vapid-public-key` 一致。客户端 SDK 新增 `getCapabilities()`：打到没有该路由的老 worker（404）返回 `null` 不抛错，前端可据此在设置里提示「worker 需要重新部署」。
```

- [ ] **Step 8.3: Commit** `docs(amsg): 单用户 README 补 capabilities 与大值说明；三个 changeset`

---

### Task 9: 全量验证 + 打包红线

- [ ] **Step 9.1:** 四包全量测试：

```bash
node --test packages/rei-standard-amsg/shared/test/*.test.mjs
node --test packages/rei-standard-amsg/server/test/*.test.mjs
node --test packages/rei-standard-amsg/client/test/*.test.mjs
node --test packages/rei-standard-amsg/instant/test/*.test.mjs
```

Expected: 全绿。

- [ ] **Step 9.2:** server 构建 + 产物红线：

```bash
cd packages/rei-standard-amsg/server && npm run build
grep -n "__AMSG_SERVER_VERSION__" dist/cloudflare.mjs || echo "define 已替换（应无输出）"
grep -nE "from ['\"]node:|require\(['\"]node:" dist/cloudflare.mjs && echo "红线violation" || echo "cloudflare 产物无 node 内置"
```

Expected: `dist/cloudflare.mjs` 无 `__AMSG_SERVER_VERSION__` 残留、无 `node:` 导入。

- [ ] **Step 9.3:** 红线 grep（本批新增/修改文件里无下游业务标识）：

```bash
git diff main --name-only | xargs grep -ln "SullyOS\|fire_pack\|tool_pack\|世界书\|角色卡" 2>/dev/null
```

Expected: 无输出（本 plan 文件除外——它引用了交接背景）。

- [ ] **Step 9.4:** 提 PR（base: main），PR 描述按「改了什么 / 改后怎样」组织，附验收清单勾选。

---

## 任务 4（scheduled 推送溢出封套）评估结论：本批暂缓

调研结果（供下一批决策）：

- amsg-instant 的溢出处理有两条路：`_blob` 封套（需要 blobStore adapter + `/blob/:key` 回取路由 + TTL 清理）和 `_multipart` 多推分片（无存储，SW 端重组）。
- amsg-server 的 scheduled 路径要复用 `_blob`，除了把封套逻辑抽进 shared，还需要：单用户 worker 新增 blob 存储表 + 回取路由 + cron 里的 TTL 清理 + 公网 URL 配置（scheduled 路径没有 requestUrl 可推导）。改动横跨 server/shared/sw 三包，且给单用户 worker 引入一张新表（涉及既有部署的建表补充）。
- 复用 `_multipart` 成本更低（无存储、无新路由），但 instant 的发送器是自带 fetch 的 `sendWebPush`，amsg-server 用的是 `ctx.webpush.sendNotification`，抽公共层需要先抽象「发送函数」接口，动 instant 的既有发送路径。
- 两条路都值得做，但与本批任务 1-3 合在一起会把改动面扩到全部五个包。建议：本批发版后，下游先用任务 1 的大值 client_state + `readState` 兜底（fire 时从状态表取大件，push 里只带引用 key），若实测仍需要真封套，再单开一批做 `_multipart` 下沉方案（推荐，成本低于 `_blob` 方案）。
