import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  deriveUserEncryptionKey,
  encryptPayload,
  decryptPayload,
  encryptForStorage,
  decryptFromStorage,
} from '../src/server/lib/encryption.js';

// These tests pin the wire format of the Web Crypto encryption library so a
// future change to the algorithm, IV length, encoding, or auth-tag handling
// can't silently break interop with data written by the previous node:crypto
// implementation. They run on Node, which has BOTH node:crypto and Web Crypto,
// so the node:crypto helpers below stand in for the old implementation and the
// tests prove the two produce/consume the exact same bytes.

const MASTER_KEY = 'a'.repeat(64);
const USER_ID = '550e8400-e29b-41d4-a716-446655440000';

// ─── node:crypto reference implementation (the old encryption.js, verbatim) ───

/** sha256(masterKey + userId) hex, first 64 chars. */
function nodeDeriveKey(userId, masterKey) {
  return crypto.createHash('sha256').update(masterKey + userId).digest('hex').slice(0, 64);
}

/** Old payload format: 12-byte IV, separate authTag, standard base64. */
function nodeEncryptPayload(payload, keyHex) {
  const plaintext = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    encryptedData: encrypted.toString('base64'),
  };
}

function nodeDecryptPayload({ iv, authTag, encryptedData }, keyHex) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encryptedData, 'base64')), decipher.final()]);
  return decrypted.toString('utf8');
}

/** Old storage format: 16-byte IV, hex, colon-separated iv:authTag:data. */
function nodeEncryptForStorage(text, keyHex) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const encrypted = cipher.update(text, 'utf8', 'hex') + cipher.final('hex');
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted}`;
}

function nodeDecryptFromStorage(text, keyHex) {
  const [ivHex, tagHex, dataHex] = text.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return decipher.update(dataHex, 'hex', 'utf8') + decipher.final('utf8');
}

const SAMPLES = ['hello world', '楪同学的中文消息', 'emoji 🎉🔒✨ mixed 中英', ''];

// ─── 1. Derived key equivalence ──────────────────────────────────────────────

test('deriveUserEncryptionKey matches the node:crypto sha256 derivation', async () => {
  for (const userId of [USER_ID, 'other-user', '']) {
    const web = await deriveUserEncryptionKey(userId, MASTER_KEY);
    const node = nodeDeriveKey(userId, MASTER_KEY);
    assert.equal(web, node, `derived key must match for userId=${JSON.stringify(userId)}`);
    assert.match(web, /^[0-9a-f]{64}$/);
  }
});

// ─── 2. Cross-implementation interop (pins the wire format) ───────────────────

test('payload: node:crypto ciphertext decrypts with the Web Crypto decryptPayload', async () => {
  const key = await deriveUserEncryptionKey(USER_ID, MASTER_KEY);
  const obj = { contactName: '楪', messageType: 'fixed', n: 42 };
  const nodeCiphertext = nodeEncryptPayload(obj, key);
  const decrypted = await decryptPayload(nodeCiphertext, key);
  assert.deepEqual(decrypted, obj);
});

test('payload: Web Crypto encryptPayload output decrypts with node:crypto', async () => {
  const key = await deriveUserEncryptionKey(USER_ID, MASTER_KEY);
  const obj = { hello: 'world 🎉', arr: [1, 2, 3] };
  const webCiphertext = await encryptPayload(obj, key);
  // Shape must be exactly what the old format promised.
  assert.deepEqual(Object.keys(webCiphertext).sort(), ['authTag', 'encryptedData', 'iv']);
  assert.equal(Buffer.from(webCiphertext.iv, 'base64').length, 12, 'payload IV stays 12 bytes');
  assert.equal(Buffer.from(webCiphertext.authTag, 'base64').length, 16, 'auth tag is 16 bytes');
  assert.deepEqual(JSON.parse(nodeDecryptPayload(webCiphertext, key)), obj);
});

test('storage: node:crypto ciphertext decrypts with the Web Crypto decryptFromStorage', async () => {
  const key = await deriveUserEncryptionKey(USER_ID, MASTER_KEY);
  for (const text of SAMPLES) {
    const nodeCiphertext = nodeEncryptForStorage(text, key);
    assert.equal(await decryptFromStorage(nodeCiphertext, key), text);
  }
});

test('storage: Web Crypto encryptForStorage output decrypts with node:crypto', async () => {
  const key = await deriveUserEncryptionKey(USER_ID, MASTER_KEY);
  for (const text of SAMPLES) {
    const webCiphertext = await encryptForStorage(text, key);
    const [ivHex, tagHex] = webCiphertext.split(':');
    assert.equal(Buffer.from(ivHex, 'hex').length, 16, 'storage IV stays 16 bytes');
    assert.equal(Buffer.from(tagHex, 'hex').length, 16, 'auth tag is 16 bytes');
    assert.equal(nodeDecryptFromStorage(webCiphertext, key), text);
  }
});

// ─── 3. Round-trips (incl. Chinese, emoji, empty-string edge) ─────────────────

test('encryptPayload → decryptPayload round-trips JSON objects', async () => {
  const key = await deriveUserEncryptionKey(USER_ID, MASTER_KEY);
  for (const value of [{ a: 1, msg: '楪同学' }, { text: 'emoji 🔒✨', arr: [1, 2] }, { empty: '' }]) {
    const round = await decryptPayload(await encryptPayload(value, key), key);
    assert.deepEqual(round, value);
  }
});

test('encryptForStorage → decryptFromStorage round-trips all samples', async () => {
  const key = await deriveUserEncryptionKey(USER_ID, MASTER_KEY);
  for (const text of SAMPLES) {
    assert.equal(await decryptFromStorage(await encryptForStorage(text, key), key), text);
  }
});

// ─── 4. Tampering is rejected (GCM integrity holds) ───────────────────────────

test('decryptPayload rejects a tampered auth tag', async () => {
  const key = await deriveUserEncryptionKey(USER_ID, MASTER_KEY);
  const sealed = await encryptPayload({ secret: 'value' }, key);
  const tag = Buffer.from(sealed.authTag, 'base64');
  tag[0] ^= 0xff;
  await assert.rejects(decryptPayload({ ...sealed, authTag: tag.toString('base64') }, key));
});

test('decryptFromStorage rejects a tampered ciphertext byte', async () => {
  const key = await deriveUserEncryptionKey(USER_ID, MASTER_KEY);
  const sealed = await encryptForStorage('sensitive data', key);
  const [ivHex, tagHex, dataHex] = sealed.split(':');
  const data = Buffer.from(dataHex, 'hex');
  data[0] ^= 0xff;
  const tampered = `${ivHex}:${tagHex}:${data.toString('hex')}`;
  await assert.rejects(decryptFromStorage(tampered, key));
});

test('decryptFromStorage rejects the wrong key', async () => {
  const key = await deriveUserEncryptionKey(USER_ID, MASTER_KEY);
  const wrongKey = await deriveUserEncryptionKey('someone-else', MASTER_KEY);
  const sealed = await encryptForStorage('secret', key);
  await assert.rejects(decryptFromStorage(sealed, wrongKey));
});
