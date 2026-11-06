/**
 * 加解密底层：base64 分块编码与旧实现逐字节一致；AES 密钥只 importKey 一次，
 * init() 换 key 后失效。
 */

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ReiClient } from '../src/index.js';

const USER = '550e8400-e29b-41d4-a716-446655440000';

async function initWithKey(client, hex) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ success: true, data: { userKey: hex } });
  try { await client.init(); } finally { globalThis.fetch = original; }
}

// 最朴素的参考实现，当对照用。
const referenceBase64 = (uint8) => btoa(Array.from(uint8, (b) => String.fromCharCode(b)).join(''));

test('_toBase64 大数组 / subarray / 非块边界长度 与参考实现输出一致', () => {
  const client = new ReiClient({ baseUrl: 'https://w.dev', userId: USER });
  const big = new Uint8Array(200 * 1024 + 13);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff;
  for (const input of [big, big.subarray(5, 0x8000 + 3), big.subarray(100, 101), new Uint8Array(0)]) {
    assert.equal(client._toBase64(input), referenceBase64(input));
  }
});

test('_encrypt / _decrypt 复用同一把 CryptoKey，init() 换 key 后重新导入', async () => {
  const client = new ReiClient({ baseUrl: 'https://w.dev', userId: USER });
  await initWithKey(client, 'ab'.repeat(32));
  const importKey = mock.method(crypto.subtle, 'importKey');
  try {
    const first = await client._encrypt('{"a":1}');
    const second = await client._encrypt('{"a":2}');
    assert.deepEqual(await client._decrypt(first), { a: 1 });
    assert.deepEqual(await client._decrypt(second), { a: 2 });
    assert.equal(importKey.mock.callCount(), 1);

    await initWithKey(client, 'cd'.repeat(32));
    await client._encrypt('{"a":3}');
    assert.equal(importKey.mock.callCount(), 2);
    await assert.rejects(() => client._decrypt(first), 'old-key ciphertext must not decrypt under the new key');
  } finally {
    importKey.mock.restore();
  }
});
