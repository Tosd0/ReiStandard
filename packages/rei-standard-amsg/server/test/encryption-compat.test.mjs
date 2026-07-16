/**
 * Cross-implementation compatibility tests for lib/encryption.js.
 *
 * The library's wire formats are consumed by already-deployed clients and
 * already-written database rows, so they must stay byte-compatible across
 * implementation changes. These tests pin the formats against an independent
 * node:crypto reference implementation:
 *
 *   - payload format:  AES-256-GCM, 12-byte IV, base64 fields
 *                      { iv, authTag, encryptedData } with a detached 16-byte tag
 *   - storage format:  AES-256-GCM, 16-byte IV, hex `iv:authTag:data`
 *   - key derivation:  sha256(masterKey + userId) hex, first 64 chars
 *
 * If any of IV length / tag handling / encoding / derivation changes, the
 * cross-decryption tests here fail. All calls `await` the library functions so
 * the suite passes whether the exports are sync or async.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import {
  deriveUserEncryptionKey,
  encryptPayload,
  decryptPayload,
  encryptForStorage,
  decryptFromStorage
} from '../src/server/lib/encryption.js';

const MASTER_KEY = 'a'.repeat(64);
const USER_ID = '123e4567-e89b-42d3-a456-426614174000';

/** node:crypto reference: encrypt in the payload wire format (12-byte IV, base64). */
function referenceEncryptPayload(payload, hexKey) {
  const plaintext = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(hexKey, 'hex'), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    encryptedData: encrypted.toString('base64')
  };
}

/** node:crypto reference: decrypt the payload wire format. */
function referenceDecryptPayload({ iv, authTag, encryptedData }, hexKey) {
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(hexKey, 'hex'), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encryptedData, 'base64')), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

/** node:crypto reference: encrypt in the storage wire format (16-byte IV, hex `iv:tag:data`). */
function referenceEncryptForStorage(text, hexKey) {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(hexKey, 'hex'), iv);
  const encrypted = cipher.update(text, 'utf8', 'hex') + cipher.final('hex');
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted}`;
}

/** node:crypto reference: decrypt the storage wire format. */
function referenceDecryptFromStorage(encryptedText, hexKey) {
  const [ivHex, tagHex, dataHex] = encryptedText.split(':');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(hexKey, 'hex'), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return decipher.update(dataHex, 'hex', 'utf8') + decipher.final('utf8');
}

describe('deriveUserEncryptionKey', () => {
  it('matches sha256(masterKey + userId) hex truncated to 64 chars', async () => {
    const expected = createHash('sha256').update(MASTER_KEY + USER_ID).digest('hex').slice(0, 64);
    assert.strictEqual(await deriveUserEncryptionKey(USER_ID, MASTER_KEY), expected);
  });
});

describe('payload format cross-compatibility', () => {
  it('decryptPayload reads node:crypto-produced ciphertext', async () => {
    const key = await deriveUserEncryptionKey(USER_ID, MASTER_KEY);
    const original = { contactName: '小 明', note: 'emoji 🎉 と日本語', n: 42 };
    const sealed = referenceEncryptPayload(original, key);
    assert.deepStrictEqual(await decryptPayload(sealed, key), original);
  });

  it('node:crypto reads encryptPayload-produced ciphertext', async () => {
    const key = await deriveUserEncryptionKey(USER_ID, MASTER_KEY);
    const original = { tasks: [{ uuid: 'x', text: '中文句子。' }], ok: true };
    const sealed = await encryptPayload(original, key);
    assert.deepStrictEqual(referenceDecryptPayload(sealed, key), original);
  });

  it('keeps the 12-byte IV and detached 16-byte authTag', async () => {
    const key = await deriveUserEncryptionKey(USER_ID, MASTER_KEY);
    const sealed = await encryptPayload({ a: 1 }, key);
    assert.strictEqual(Buffer.from(sealed.iv, 'base64').length, 12);
    assert.strictEqual(Buffer.from(sealed.authTag, 'base64').length, 16);
  });

  it('accepts a pre-serialized JSON string payload', async () => {
    const key = await deriveUserEncryptionKey(USER_ID, MASTER_KEY);
    const sealed = await encryptPayload(JSON.stringify({ s: 'str' }), key);
    assert.deepStrictEqual(referenceDecryptPayload(sealed, key), { s: 'str' });
  });
});

describe('storage format cross-compatibility', () => {
  it('decryptFromStorage reads node:crypto-produced ciphertext', async () => {
    const key = await deriveUserEncryptionKey(USER_ID, MASTER_KEY);
    const original = JSON.stringify({ userMessage: '你好！🌸', recurrenceType: 'daily' });
    const stored = referenceEncryptForStorage(original, key);
    assert.strictEqual(await decryptFromStorage(stored, key), original);
  });

  it('node:crypto reads encryptForStorage-produced ciphertext', async () => {
    const key = await deriveUserEncryptionKey(USER_ID, MASTER_KEY);
    const original = '混合 content：emoji 🚀、換行\n、空格  ';
    const stored = await encryptForStorage(original, key);
    assert.strictEqual(referenceDecryptFromStorage(stored, key), original);
  });

  it('keeps the hex iv:authTag:data layout with a 16-byte IV', async () => {
    const key = await deriveUserEncryptionKey(USER_ID, MASTER_KEY);
    const stored = await encryptForStorage('abc', key);
    const [ivHex, tagHex, dataHex] = stored.split(':');
    assert.match(ivHex, /^[0-9a-f]{32}$/);
    assert.match(tagHex, /^[0-9a-f]{32}$/);
    assert.match(dataHex, /^[0-9a-f]*$/);
  });

  it('round-trips the empty string', async () => {
    const key = await deriveUserEncryptionKey(USER_ID, MASTER_KEY);
    const stored = await encryptForStorage('', key);
    assert.strictEqual(await decryptFromStorage(stored, key), '');
  });
});

describe('lenient decode compatibility (node Buffer.from parity)', () => {
  it('decryptPayload accepts base64url-encoded fields, like Buffer.from(x, "base64") did', async () => {
    const key = await deriveUserEncryptionKey(USER_ID, MASTER_KEY);
    const original = { compat: 'base64url ✓' };
    const sealed = referenceEncryptPayload(original, key);
    const toUrlSafe = (b64) => b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    const urlSafe = {
      iv: toUrlSafe(sealed.iv),
      authTag: toUrlSafe(sealed.authTag),
      encryptedData: toUrlSafe(sealed.encryptedData)
    };
    assert.deepStrictEqual(await decryptPayload(urlSafe, key), original);
  });

  it('accepts GCM auth tags truncated to 96 bits, like node decipher did', async () => {
    const key = await deriveUserEncryptionKey(USER_ID, MASTER_KEY);
    const original = { compat: 'truncated tag' };
    const sealed = referenceEncryptPayload(original, key);
    const tag12 = Buffer.from(sealed.authTag, 'base64').subarray(0, 12).toString('base64');
    assert.deepStrictEqual(await decryptPayload({ ...sealed, authTag: tag12 }, key), original);

    const stored = referenceEncryptForStorage('truncated tag storage', key);
    const [ivHex, tagHex, dataHex] = stored.split(':');
    assert.strictEqual(
      await decryptFromStorage(`${ivHex}:${tagHex.slice(0, 24)}:${dataHex}`, key),
      'truncated tag storage'
    );
  });

  it('rejects tags shorter than 96 bits', async () => {
    const key = await deriveUserEncryptionKey(USER_ID, MASTER_KEY);
    const sealed = referenceEncryptPayload({ a: 1 }, key);
    const tag8 = Buffer.from(sealed.authTag, 'base64').subarray(0, 8).toString('base64');
    await assert.rejects(async () => decryptPayload({ ...sealed, authTag: tag8 }, key));
  });
});

describe('tamper detection', () => {
  it('decryptPayload rejects a flipped ciphertext byte', async () => {
    const key = await deriveUserEncryptionKey(USER_ID, MASTER_KEY);
    const sealed = await encryptPayload({ secret: 'data' }, key);
    const bytes = Buffer.from(sealed.encryptedData, 'base64');
    bytes[0] ^= 0xff;
    const tampered = { ...sealed, encryptedData: bytes.toString('base64') };
    await assert.rejects(async () => decryptPayload(tampered, key));
  });

  it('decryptPayload rejects a flipped authTag byte', async () => {
    const key = await deriveUserEncryptionKey(USER_ID, MASTER_KEY);
    const sealed = await encryptPayload({ secret: 'data' }, key);
    const tag = Buffer.from(sealed.authTag, 'base64');
    tag[0] ^= 0xff;
    const tampered = { ...sealed, authTag: tag.toString('base64') };
    await assert.rejects(async () => decryptPayload(tampered, key));
  });

  it('decryptFromStorage rejects a flipped ciphertext byte', async () => {
    const key = await deriveUserEncryptionKey(USER_ID, MASTER_KEY);
    const stored = await encryptForStorage('secret data', key);
    const [ivHex, tagHex, dataHex] = stored.split(':');
    const flipped = (parseInt(dataHex.slice(0, 2), 16) ^ 0xff).toString(16).padStart(2, '0');
    const tampered = `${ivHex}:${tagHex}:${flipped}${dataHex.slice(2)}`;
    await assert.rejects(async () => decryptFromStorage(tampered, key));
  });

  it('decryptPayload rejects ciphertext sealed with a different key', async () => {
    const keyA = await deriveUserEncryptionKey(USER_ID, MASTER_KEY);
    const keyB = await deriveUserEncryptionKey(USER_ID, 'b'.repeat(64));
    const sealed = await encryptPayload({ secret: 'data' }, keyA);
    await assert.rejects(async () => decryptPayload(sealed, keyB));
  });
});
