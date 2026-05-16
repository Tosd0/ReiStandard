/**
 * Encryption utility (instant variant)
 * ReiStandard amsg-instant
 *
 * IMPORTANT: This file is a deliberate COPY of the transport-layer helpers
 * in @rei-standard/amsg-server (`server/src/server/lib/encryption.js`).
 * The protocol contract — sha256-derived user key + AES-256-GCM with
 * base64-encoded (iv | authTag | encryptedData) envelope — must stay
 * bit-identical so the same `@rei-standard/amsg-client` build can talk to
 * both endpoints without any branching on the client side.
 *
 * If you change anything here, change the matching code in amsg-server and
 * cut a new version on BOTH packages. The whole point of amsg-instant is
 * that the protocol contract is locked behind ONE version number, not
 * silently drifted across server-patch releases.
 */

import { createDecipheriv, createHash } from 'crypto';

/**
 * Derive a user-specific encryption key from the tenant master key.
 *
 * Matches amsg-server v2.0.1:
 *   sha256(masterKey + userId).hex().slice(0, 64)
 *
 * @param {string} userId    - UUID v4.
 * @param {string} masterKey - 64-char hex master key (32 bytes of entropy).
 * @returns {string} 64-char hex key.
 */
export function deriveUserEncryptionKey(userId, masterKey) {
  return createHash('sha256')
    .update(masterKey + userId)
    .digest('hex')
    .slice(0, 64);
}

/**
 * Decrypt a client-encrypted request body (AES-256-GCM).
 *
 * Envelope shape (matches amsg-client `_encrypt` output):
 *   { iv: base64(12 bytes), authTag: base64(16 bytes), encryptedData: base64(...) }
 *
 * @param {{ iv: string, authTag: string, encryptedData: string }} encryptedPayload
 * @param {string} encryptionKey - 64-char hex key from deriveUserEncryptionKey().
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
