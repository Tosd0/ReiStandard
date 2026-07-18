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
    assert.equal(parseChunkedRootCount('aabb:ccdd:eeff'), null); // encryptForStorage 形状
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
    const value = '😀'.repeat(120_000); // 每个 4 字节 ≈ 480KB
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
      // missing 的第 1 片不存在
      { namespace: chunkNamespaceFor('n'), key: chunkKeyFor('torn', 0), value: 'OLD', updated_at: 200 }, // ts 对不上根行
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
