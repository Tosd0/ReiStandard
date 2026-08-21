import test from 'node:test';
import assert from 'node:assert/strict';
import { createBlobStore } from '../src/store.js';
import { hashBlob } from '../src/content-scan.js';
import { memoryAdapter, brokenAdapter } from './helpers.mjs';

const blobOf = (s) => new Blob([s], { type: 'text/plain' });

/** 按指定创建时间造一个 SDK 格式的 id——时间戳字段可反解，组内排序读的就是它。 */
const idAt = (ms, seq = 0) => `b_${ms.toString(36)}_${seq.toString(36)}_aaaaaa`;

/** 直接往适配器里塞，绕开 put 的「现在时间」，好逐条控制创建时间。 */
function seeded(entries, { prefix } = {}) {
  const adapter = memoryAdapter();
  for (const [id, text] of entries) adapter.map.set(id, blobOf(text));
  return { adapter, store: createBlobStore(prefix ? { adapter, prefix } : { adapter }) };
}

test('hashBlob：同内容同哈希、不同内容不同哈希，MIME 不参与计算', async () => {
  // SHA-256('abc') 的已知向量
  assert.equal(
    await hashBlob(new Blob(['abc'])),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  assert.equal(await hashBlob(new Blob(['abc'], { type: 'image/png' })), await hashBlob(new Blob(['abc'])));
  assert.notEqual(await hashBlob(blobOf('abc')), await hashBlob(blobOf('abd')));
});

test('hashBlob：入参不是 Blob 直接抛（返回个假哈希，宿主会拿它去合并引用、破图）', async () => {
  await assert.rejects(() => hashBlob('data:image/png;base64,AAAA'), TypeError);
  await assert.rejects(() => hashBlob(null), TypeError);
});

test('同内容归成一组，wastedBytes 按多存的份数算', async () => {
  const { store } = seeded([
    [idAt(1000), 'dup'],
    [idAt(2000), 'dup'],
    [idAt(3000), 'dup'],
    [idAt(4000), 'solo'],
  ]);
  const result = await store.scanContent();
  assert.equal(result.aborted, false);
  assert.equal(result.scanned, 4);
  assert.equal(result.skipped, 0);
  assert.equal(result.byHash.size, 2); // 两种内容
  assert.equal(result.duplicateGroups.length, 1); // 只有多于一个的才算重复组
  const [group] = result.duplicateGroups;
  assert.equal(group.canonical, `blobref:${idAt(1000)}`);
  assert.deepEqual(group.duplicates, [`blobref:${idAt(2000)}`, `blobref:${idAt(3000)}`]);
  assert.equal(group.size, 3); // 'dup' 三个字节
  assert.equal(group.wastedBytes, 6); // 多存两份
  assert.equal(result.wastedBytes, 6);
  // byHash 里含前缀、组内按创建时间升序，单份内容也在
  assert.deepEqual(result.byHash.get(await hashBlob(blobOf('dup'))), [
    `blobref:${idAt(1000)}`, `blobref:${idAt(2000)}`, `blobref:${idAt(3000)}`,
  ]);
  assert.deepEqual(result.byHash.get(await hashBlob(blobOf('solo'))), [`blobref:${idAt(4000)}`]);
});

test('canonical 取组内最老的，且不随 adapter.keys() 的返回顺序变', async () => {
  const { adapter } = seeded([
    [idAt(9000), 'dup'],
    [idAt(1000), 'dup'],
    [idAt(5000), 'dup'],
  ]);
  const forward = createBlobStore({ adapter });
  const reversed = createBlobStore({
    adapter: { ...adapter, keys: async () => [...adapter.map.keys()].reverse() },
  });
  for (const store of [forward, reversed]) {
    const [group] = (await store.scanContent()).duplicateGroups;
    assert.equal(group.canonical, `blobref:${idAt(1000)}`);
    assert.deepEqual(group.duplicates, [`blobref:${idAt(5000)}`, `blobref:${idAt(9000)}`]);
  }
});

test('反解不出创建时间的 id 排在组内最后，不会被选成 canonical', async () => {
  const { store } = seeded([
    ['img_legacy_a', 'dup'],
    [idAt(7000), 'dup'],
    ['img_legacy_b', 'dup'],
  ]);
  const [group] = (await store.scanContent()).duplicateGroups;
  assert.equal(group.canonical, `blobref:${idAt(7000)}`);
  // 两个反解不出时间的按 id 字面排，顺序确定
  assert.deepEqual(group.duplicates, ['blobref:img_legacy_a', 'blobref:img_legacy_b']);
});

test('超出令牌字符集的 id 整条跳过并计入 skipped（引用提不全，合并它会破图）', async () => {
  const { store } = seeded([
    [idAt(1000), 'dup'],
    [idAt(2000), 'dup'],
    ['3f2b9c-4d1a-uuid', 'dup'], // 带 `-`，字符集外
  ]);
  const result = await store.scanContent();
  assert.equal(result.scanned, 2);
  assert.equal(result.skipped, 1);
  const [group] = result.duplicateGroups;
  assert.deepEqual(group.duplicates, [`blobref:${idAt(2000)}`]);
  assert.equal(group.wastedBytes, 3); // 跳过的那条不算进浪费
  // 整个结果里都不该出现它
  assert.deepEqual([...result.byHash.values()].flat(), [`blobref:${idAt(1000)}`, `blobref:${idAt(2000)}`]);
});

test('keys() 读不出来 → 整轮放弃，结果是空的 aborted，不是「没有重复」', async () => {
  const store = createBlobStore({ adapter: brokenAdapter() });
  const result = await store.scanContent();
  assert.equal(result.aborted, true);
  assert.equal(result.byHash.size, 0);
  assert.deepEqual(result.duplicateGroups, []);
  assert.equal(result.scanned, 0);
  assert.equal(result.skipped, 0);
  assert.equal(result.wastedBytes, 0);
});

test('单条 Blob 读失败只跳过这一条，其余照常成组（不是整轮放弃）', async () => {
  const { adapter } = seeded([
    [idAt(1000), 'dup'],
    [idAt(2000), 'dup'],
    [idAt(3000), 'boom'],
  ]);
  const store = createBlobStore({
    adapter: {
      ...adapter,
      get: async (id) => {
        if (id === idAt(3000)) throw new Error('read failed');
        return adapter.map.get(id) ?? null;
      },
    },
  });
  const result = await store.scanContent();
  assert.equal(result.aborted, false);
  assert.equal(result.scanned, 2);
  assert.equal(result.skipped, 1);
  assert.equal(result.duplicateGroups.length, 1);
});

test('keys() 之后被删掉、get 返回 null 的那条按跳过计', async () => {
  const { adapter } = seeded([[idAt(1000), 'a'], [idAt(2000), 'b']]);
  const store = createBlobStore({ adapter: { ...adapter, get: async () => null } });
  const result = await store.scanContent();
  assert.equal(result.aborted, false);
  assert.equal(result.scanned, 0);
  assert.equal(result.skipped, 2);
  assert.equal(result.byHash.size, 0);
});

test('空库：各计数为 0，但不是 aborted', async () => {
  const { store } = seeded([]);
  const result = await store.scanContent();
  assert.equal(result.aborted, false);
  assert.equal(result.scanned, 0);
  assert.equal(result.skipped, 0);
  assert.equal(result.wastedBytes, 0);
  assert.equal(result.byHash.size, 0);
  assert.deepEqual(result.duplicateGroups, []);
});

test('全都不重复：duplicateGroups 为空，byHash 仍逐份留一条（迁移期当 cache 用）', async () => {
  const { store } = seeded([[idAt(1000), 'a'], [idAt(2000), 'b'], [idAt(3000), 'c']]);
  const result = await store.scanContent();
  assert.deepEqual(result.duplicateGroups, []);
  assert.equal(result.wastedBytes, 0);
  assert.equal(result.scanned, 3);
  assert.equal(result.byHash.size, 3);
  for (const tokens of result.byHash.values()) assert.equal(tokens.length, 1);
});

test('duplicateGroups 按 wastedBytes 从大到小排', async () => {
  const { store } = seeded([
    [idAt(1000), 'xx'], [idAt(2000), 'xx'],                    // 2 字节 × 多 1 份 = 2
    [idAt(3000), 'yyyyyyyy'], [idAt(4000), 'yyyyyyyy'],        // 8 字节 × 多 1 份 = 8
    [idAt(5000), 'zzz'], [idAt(6000), 'zzz'], [idAt(7000), 'zzz'], // 3 字节 × 多 2 份 = 6
  ]);
  const result = await store.scanContent();
  assert.deepEqual(result.duplicateGroups.map((g) => g.wastedBytes), [8, 6, 2]);
  assert.equal(result.wastedBytes, 16);
});

test('onProgress：每条回调一次（跳过的也算），最后一次是 (total, total)', async () => {
  const { store } = seeded([
    [idAt(1000), 'dup'],
    ['uuid-with-dash', 'dup'], // 会被跳过，同样要报进度
    [idAt(2000), 'dup'],
  ]);
  const calls = [];
  await store.scanContent({ onProgress: (done, total) => calls.push([done, total]) });
  assert.deepEqual(calls, [[1, 3], [2, 3], [3, 3]]);
});

test('onProgress 传了但不是函数 → TypeError（编程错误，不静默忽略）', async () => {
  const { store } = seeded([[idAt(1000), 'a']]);
  await assert.rejects(() => store.scanContent({ onProgress: 'tick' }), TypeError);
});

test('扫描是纯只读的：库里一条都不动', async () => {
  const { adapter, store } = seeded([[idAt(1000), 'dup'], [idAt(2000), 'dup']]);
  const before = [...adapter.map.keys()];
  const result = await store.scanContent();
  assert.equal(result.duplicateGroups.length, 1);
  assert.deepEqual([...adapter.map.keys()], before);
  assert.equal(await (await store.get(`blobref:${idAt(2000)}`)).text(), 'dup');
});

test('自定义前缀：byHash 与 canonical 里的令牌都带该前缀', async () => {
  const { store } = seeded([[idAt(1000), 'dup'], [idAt(2000), 'dup']], { prefix: 'pic:' });
  const result = await store.scanContent();
  assert.deepEqual(result.byHash.get(await hashBlob(blobOf('dup'))), [`pic:${idAt(1000)}`, `pic:${idAt(2000)}`]);
  assert.equal(result.duplicateGroups[0].canonical, `pic:${idAt(1000)}`);
});

test('走 put 存进去的两份同内容照样查得出来（真实路径）', async () => {
  const store = createBlobStore({ adapter: memoryAdapter() });
  const first = await store.put(blobOf('same picture'));
  const second = await store.put(blobOf('same picture'));
  const result = await store.scanContent();
  assert.equal(result.duplicateGroups.length, 1);
  assert.equal(result.duplicateGroups[0].canonical, first); // 先存的更老
  assert.deepEqual(result.duplicateGroups[0].duplicates, [second]);
  assert.equal(result.wastedBytes, 'same picture'.length);
});
