/**
 * Encryption utility library (SDK version)
 * ReiStandard SDK v1.1.0
 *
 * Wraps AES-256-GCM operations for request/response and storage encryption.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

/**
 * Derive a user-specific encryption key from the master key.
 *
 * @param {string} userId    - Unique user identifier.
 * @param {string} masterKey - 64-char hex master key.
 * @returns {string} 64-char hex key.
 */
export function deriveUserEncryptionKey(userId, masterKey) {
  return createHash('sha256')
    .update(masterKey + userId)
    .digest('hex')
    .slice(0, 64);
}

/**
 * Decrypt a client-encrypted request body (AES-256-GCM, base64 encoded).
 *
 * @param {{ iv: string, authTag: string, encryptedData: string }} encryptedPayload
 * @param {string} encryptionKey - 64-char hex key.
 * @returns {Object} Decrypted JSON object.
 */
export function decryptPayload(encryptedPayload, encryptionKey) {
  const { iv, authTag, encryptedData } = encryptedPayload;

  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(encryptionKey, 'hex'),
    Buffer.from(iv, 'base64')
  );

  decipher.setAuthTag(Buffer.from(authTag, 'base64'));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedData, 'base64')),
    decipher.final()
  ]);

  return JSON.parse(decrypted.toString('utf8'));
}

/**
 * Encrypt a JSON payload for API transfer (AES-256-GCM, base64 encoded).
 *
 * @param {string|Object} payload
 * @param {string} encryptionKey - 64-char hex key.
 * @returns {{ iv: string, authTag: string, encryptedData: string }}
 */
export function encryptPayload(payload, encryptionKey) {
  const plaintext = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(encryptionKey, 'hex'), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    encryptedData: encrypted.toString('base64')
  };
}

/**
 * Encrypt data for database storage (hex encoded, colon-separated).
 *
 * @param {string} text          - Plaintext string.
 * @param {string} encryptionKey - 64-char hex key.
 * @returns {string} Format: iv:authTag:encryptedData
 */
export function encryptForStorage(text, encryptionKey) {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(encryptionKey, 'hex'), iv);
  const encrypted = cipher.update(text, 'utf8', 'hex') + cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt data from database storage format.
 *
 * @param {string} encryptedText - Format: iv:authTag:encryptedData
 * @param {string} encryptionKey - 64-char hex key.
 * @returns {string} Plaintext string.
 */
export function decryptFromStorage(encryptedText, encryptionKey) {
  const [ivHex, authTagHex, encryptedDataHex] = encryptedText.split(':');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(encryptionKey, 'hex'),
    Buffer.from(ivHex, 'hex')
  );
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  return decipher.update(encryptedDataHex, 'hex', 'utf8') + decipher.final('utf8');
}
