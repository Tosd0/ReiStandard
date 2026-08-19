import test from 'node:test';
import assert from 'node:assert/strict';
import { dataUrlToBlob, blobToDataUrl } from '../src/dataurl.js';

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 128, 7]);

// CI 跑在 Node 上，没有原生 fromBase64/toBase64/FileReader，快路径和 FileReader
// 分支平时测不到。下面几个测试用这个小工具临时打桩宿主 API，逼出分支覆盖——
// 打桩钉的是「有没有被调用、调用参数长什么样」这类接线/调用约定，不是原生实现的语义本身。
async function withPatch(obj, prop, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(obj, prop);
  const original = obj[prop];
  obj[prop] = value;
  try {
    return await fn();
  } finally {
    if (had) obj[prop] = original;
    else delete obj[prop];
  }
}

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
  assert.throws(() => dataUrlToBlob(null), { name: 'TypeError', message: /Invalid data URL/ });
});

test('裸 mime 的 base64 data URL 落到 application/octet-stream（FileReader 给无 type Blob 产出的正是这个形状）', async () => {
  const blob = dataUrlToBlob('data:;base64,YWJj');
  assert.equal(blob.type, 'application/octet-stream');
  assert.equal(await blob.text(), 'abc');
});

test('utf8 data URL 宽容解码：合法 %XX 段照常解码，坏转义段原样保留', async () => {
  const encoded = dataUrlToBlob('data:image/svg+xml,<svg width="100%25"/>');
  assert.equal(await encoded.text(), '<svg width="100%"/>');

  // 浏览器渲染这种 URL 完全正常：SVG 里字面的 100% 不是合法 %XX 转义，
  // percent-decode 应当原样保留，而不是抛 URIError。
  const malformed = dataUrlToBlob('data:image/svg+xml,<svg width="100%"/>');
  assert.equal(await malformed.text(), '<svg width="100%"/>');
});

test('dataUrlToBlob 的 fromBase64 快路径与 atob 回退路径解出同样的字节', async () => {
  const dataUrl = await blobToDataUrl(new Blob([PNG_BYTES], { type: 'image/png' }));

  let calls = 0;
  const fastBytes = await withPatch(
    Uint8Array,
    'fromBase64',
    (s) => {
      calls++;
      return new Uint8Array(Buffer.from(s, 'base64'));
    },
    async () => new Uint8Array(await dataUrlToBlob(dataUrl).arrayBuffer()),
  );
  assert.equal(calls, 1);

  const fallbackBytes = await withPatch(
    Uint8Array,
    'fromBase64',
    undefined,
    async () => new Uint8Array(await dataUrlToBlob(dataUrl).arrayBuffer()),
  );

  assert.deepEqual(fastBytes, fallbackBytes);
});

test('blobToDataUrl 的 toBase64 快路径无参调用，且与 btoa 回退结果一致', async () => {
  const blob = new Blob([PNG_BYTES], { type: 'image/png' });

  // 手编路径只在没有 FileReader 时才会跑到；显式打掉 FileReader，别指望
  // 当前跑测试的环境（Node）恰好没有它——未来的 Node / jsdom 可能会有。
  await withPatch(globalThis, 'FileReader', undefined, async () => {
    let argsLength = -1;
    const fastUrl = await withPatch(
      Uint8Array.prototype,
      'toBase64',
      function toBase64Stub(...args) {
        argsLength = args.length;
        return Buffer.from(this).toString('base64');
      },
      () => blobToDataUrl(blob),
    );
    assert.equal(argsLength, 0);

    const fallbackUrl = await withPatch(Uint8Array.prototype, 'toBase64', undefined, () => blobToDataUrl(blob));

    assert.equal(fastUrl, fallbackUrl);
  });
});

test('btoa 回退路径在 0x8000 分块边界上下都不丢字节', async () => {
  const lengths = [0, 1, 0x8000 - 1, 0x8000, 0x8000 + 1];
  // 同上：显式打掉 FileReader，逼进手编路径，不依赖环境恰好没有它。
  await withPatch(globalThis, 'FileReader', undefined, () =>
    withPatch(Uint8Array.prototype, 'toBase64', undefined, async () => {
      for (const len of lengths) {
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) bytes[i] = i % 256;
        const dataUrl = await blobToDataUrl(new Blob([bytes], { type: 'application/octet-stream' }));
        const back = dataUrlToBlob(dataUrl);
        assert.deepEqual(new Uint8Array(await back.arrayBuffer()), bytes, `length=${len}`);
      }
    }),
  );
});

test('blobToDataUrl 有 type 的 Blob 走 FileReader、无 type 的 Blob 走手工编码', async () => {
  let instances = 0;
  class FakeFileReader {
    constructor() {
      instances++;
    }
    readAsDataURL(blob) {
      queueMicrotask(() => {
        this.result = `data:fake;from=filereader;type=${blob.type}`;
        if (typeof this.onload === 'function') this.onload();
      });
    }
  }

  await withPatch(globalThis, 'FileReader', FakeFileReader, async () => {
    const typedResult = await blobToDataUrl(new Blob([PNG_BYTES], { type: 'image/png' }));
    assert.equal(instances, 1);
    assert.equal(typedResult, 'data:fake;from=filereader;type=image/png');

    const untypedResult = await blobToDataUrl(new Blob([PNG_BYTES]));
    assert.equal(instances, 1); // 没有新增实例，说明无 type 时没有走 FileReader
    assert.match(untypedResult, /^data:application\/octet-stream;base64,/);
  });
});

test('blobToDataUrl 在 FileReader 出错时 reject', async () => {
  class FailingFileReader {
    readAsDataURL() {
      queueMicrotask(() => {
        this.error = new Error('boom');
        if (typeof this.onerror === 'function') this.onerror();
      });
    }
  }

  await withPatch(globalThis, 'FileReader', FailingFileReader, async () => {
    await assert.rejects(() => blobToDataUrl(new Blob([PNG_BYTES], { type: 'image/png' })), /boom/);
  });
});
