/**
 * Encryption utility library (Web Crypto version)
 * ReiStandard SDK
 *
 * AES-256-GCM for request/response and storage encryption. Built on
 * `globalThis.crypto.subtle` so it runs on any Web Crypto runtime (Cloudflare
 * Workers, Vercel/Netlify Edge, Deno, Bun, Node ≥ 19) with no Node builtins.
 * That lets the single-user / Cloudflare entry bundle without `nodejs_compat`.
 *
 * Wire format is byte-for-byte identical to the previous node:crypto version:
 * payload uses standard base64 with a separate `authTag`; storage uses hex in
 * `iv:authTag:encryptedData`. Web Crypto appends the GCM tag to the ciphertext,
 * so these functions split it off on encrypt and re-join it on decrypt.
 */

import {
  utf8,
  utf8Decode,
  randomBytes,
  concatBytes,
  bytesToHex,
  hexToBytes,
  bytesToBase64,
  base64ToBytes,
} from './webcrypto-utils.js';

const subtle = globalThis.crypto.subtle;
const TAG_LEN = 16; // AES-GCM auth tag length in bytes (tagLength: 128)

/** Import a 64-char hex key as an AES-256-GCM CryptoKey. */
async function importAesKey(hexKey) {
  return subtle.importKey('raw', hexToBytes(hexKey), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/**
 * Derive a user-specific encryption key from the master key.
 *
 * @param {string} userId    - Unique user identifier.
 * @param {string} masterKey - 64-char hex master key.
 * @returns {Promise<string>} 64-char hex key.
 */
export async function deriveUserEncryptionKey(userId, masterKey) {
  const digest = await subtle.digest('SHA-256', utf8(masterKey + userId));
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
  const key = await importAesKey(encryptionKey);
  const sealed = concatBytes(base64ToBytes(encryptedData), base64ToBytes(authTag));
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(iv), tagLength: 128 }, key, sealed);
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
  const key = await importAesKey(encryptionKey);
  const sealed = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, utf8(plaintext)));
  return {
    iv: bytesToBase64(iv),
    authTag: bytesToBase64(sealed.slice(sealed.length - TAG_LEN)),
    encryptedData: bytesToBase64(sealed.slice(0, sealed.length - TAG_LEN)),
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
  const key = await importAesKey(encryptionKey);
  const sealed = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, utf8(text)));
  const data = sealed.slice(0, sealed.length - TAG_LEN);
  const tag = sealed.slice(sealed.length - TAG_LEN);
  return `${bytesToHex(iv)}:${bytesToHex(tag)}:${bytesToHex(data)}`;
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
  const key = await importAesKey(encryptionKey);
  const sealed = concatBytes(hexToBytes(encryptedDataHex), hexToBytes(authTagHex));
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv: hexToBytes(ivHex), tagLength: 128 }, key, sealed);
  return utf8Decode(plain);
}
