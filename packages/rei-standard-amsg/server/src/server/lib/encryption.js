/**
 * Encryption utility library (SDK version)
 *
 * Wraps AES-256-GCM operations for request/response and storage encryption.
 * Implemented on `globalThis.crypto.subtle` (Web Crypto) so the module runs
 * on Cloudflare Workers and other edge runtimes without `nodejs_compat`, as
 * well as on Node ≥ 19. All exports are async because SubtleCrypto is.
 *
 * Wire formats are byte-identical to the previous node:crypto implementation
 * (pinned by test/encryption-compat.test.mjs):
 *   - payload:  12-byte IV, base64 `{ iv, authTag, encryptedData }`
 *   - storage:  16-byte IV, hex `iv:authTag:encryptedData`
 * Web Crypto appends the GCM auth tag to the ciphertext, while these formats
 * carry it detached — aesGcmSeal / aesGcmOpen below own that seam.
 */

import {
  utf8,
  utf8Decode,
  randomBytes,
  concatBytes,
  bytesToBase64,
  base64UrlToBytes,
  bytesToHex,
  hexToBytes
} from './webcrypto-utils.js';

// Decoder for the wire formats' base64 fields. base64UrlToBytes normalizes
// the url-safe alphabet and padding first, so it accepts both standard and
// url-safe base64 — same leniency as node's Buffer.from(x, 'base64').
const base64ToBytes = base64UrlToBytes;

const TAG_LENGTH_BYTES = 16; // AES-GCM auth tag emitted on encrypt

function importAesKey(hexKey, usage) {
  return globalThis.crypto.subtle.importKey(
    'raw',
    hexToBytes(hexKey),
    { name: 'AES-GCM' },
    false,
    [usage]
  );
}

/** AES-256-GCM encrypt; returns the ciphertext and the detached 16-byte tag. */
async function aesGcmSeal(hexKey, iv, plaintextBytes) {
  const key = await importAesKey(hexKey, 'encrypt');
  const sealed = new Uint8Array(await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: TAG_LENGTH_BYTES * 8 },
    key,
    plaintextBytes
  ));
  return {
    ciphertext: sealed.slice(0, sealed.length - TAG_LENGTH_BYTES),
    authTag: sealed.slice(sealed.length - TAG_LENGTH_BYTES)
  };
}

/** AES-256-GCM decrypt from detached-tag form; returns plaintext bytes. */
async function aesGcmOpen(hexKey, iv, ciphertext, authTag) {
  const key = await importAesKey(hexKey, 'decrypt');
  // node's decipher accepted GCM tags truncated down to 96 bits; mirror that
  // by sizing tagLength from the provided tag. Anything outside the standard
  // 96–128-bit range keeps 128 and fails authentication, as it did before.
  const tagBits = authTag.length * 8;
  const tagLength = tagBits >= 96 && tagBits <= 128 ? tagBits : 128;
  const plain = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, tagLength },
    key,
    concatBytes(ciphertext, authTag)
  );
  return new Uint8Array(plain);
}

/**
 * Derive a user-specific encryption key from the master key.
 *
 * @param {string} userId    - Unique user identifier.
 * @param {string} masterKey - 64-char hex master key.
 * @returns {Promise<string>} 64-char hex key.
 */
export async function deriveUserEncryptionKey(userId, masterKey) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', utf8(masterKey + userId));
  return bytesToHex(new Uint8Array(digest)).slice(0, 64);
}

/**
 * Decrypt a client-encrypted request body (AES-256-GCM, base64 encoded).
 *
 * @param {{ iv: string, authTag: string, encryptedData: string }} encryptedPayload
 * @param {string} encryptionKey - 64-char hex key.
 * @returns {Promise<Object>} Decrypted JSON object.
 */
export async function decryptPayload(encryptedPayload, encryptionKey) {
  const { iv, authTag, encryptedData } = encryptedPayload;
  const plain = await aesGcmOpen(
    encryptionKey,
    base64ToBytes(iv),
    base64ToBytes(encryptedData),
    base64ToBytes(authTag)
  );
  return JSON.parse(utf8Decode(plain));
}

/**
 * Encrypt a JSON payload for API transfer (AES-256-GCM, base64 encoded).
 *
 * @param {string|Object} payload
 * @param {string} encryptionKey - 64-char hex key.
 * @returns {Promise<{ iv: string, authTag: string, encryptedData: string }>}
 */
export async function encryptPayload(payload, encryptionKey) {
  const plaintext = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const iv = randomBytes(12);
  const { ciphertext, authTag } = await aesGcmSeal(encryptionKey, iv, utf8(plaintext));

  return {
    iv: bytesToBase64(iv),
    authTag: bytesToBase64(authTag),
    encryptedData: bytesToBase64(ciphertext)
  };
}

/**
 * Encrypt data for database storage (hex encoded, colon-separated).
 *
 * @param {string} text          - Plaintext string.
 * @param {string} encryptionKey - 64-char hex key.
 * @returns {Promise<string>} Format: iv:authTag:encryptedData
 */
export async function encryptForStorage(text, encryptionKey) {
  const iv = randomBytes(16);
  const { ciphertext, authTag } = await aesGcmSeal(encryptionKey, iv, utf8(text));
  return `${bytesToHex(iv)}:${bytesToHex(authTag)}:${bytesToHex(ciphertext)}`;
}

/**
 * Decrypt data from database storage format.
 *
 * @param {string} encryptedText - Format: iv:authTag:encryptedData
 * @param {string} encryptionKey - 64-char hex key.
 * @returns {Promise<string>} Plaintext string.
 */
export async function decryptFromStorage(encryptedText, encryptionKey) {
  const [ivHex, authTagHex, encryptedDataHex] = encryptedText.split(':');
  const plain = await aesGcmOpen(
    encryptionKey,
    hexToBytes(ivHex),
    hexToBytes(encryptedDataHex),
    hexToBytes(authTagHex)
  );
  return utf8Decode(plain);
}
