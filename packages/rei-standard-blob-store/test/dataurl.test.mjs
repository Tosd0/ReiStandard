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
