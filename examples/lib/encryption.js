/**
 * 加密工具函数库
 * ReiStandard v1.2.2
 */

const { createCipheriv, createDecipheriv, createHash, randomBytes } = require('crypto');

/**
 * 派生用户专属加密密钥
 * @param {string} userId - 用户唯一标识符
 * @param {string} masterKey - 64字符十六进制系统密钥
 * @returns {string} 64字符十六进制密钥
 */
function deriveUserEncryptionKey(userId, masterKey) {
  if (typeof masterKey !== 'string' || !/^[0-9a-f]{64}$/i.test(masterKey)) {
    throw new Error('Invalid master key format');
  }

  return createHash('sha256')
    .update(masterKey + userId)
    .digest('hex')
    .slice(0, 64); // 32字节 = 64位hex
}

/**
 * 解密请求体（AES-256-GCM）
 * @param {Object} encryptedPayload - { iv, authTag, encryptedData }
 * @param {string} encryptionKey - 64字符十六进制密钥
 * @returns {Object} 解密后的原始数据
 */
function decryptPayload(encryptedPayload, encryptionKey) {
  const { iv, authTag, encryptedData } = encryptedPayload;

  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(encryptionKey, 'hex'),
    Buffer.from(iv, 'base64')
  );

  decipher.setAuthTag(Buffer.from(authTag, 'base64'));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedData, 'base64')),
    decipher.final() // authTag 验证失败会抛出错误
  ]);

  return JSON.parse(decrypted.toString('utf8'));
}

/**
 * 加密数据用于数据库存储（十六进制编码，节省空间）
 * @param {string} text - 明文数据
 * @param {string} encryptionKey - 64字符十六进制密钥
 * @returns {string} 格式：iv:authTag:encryptedData
 */
function encryptForStorage(text, encryptionKey) {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(encryptionKey, 'hex'), iv);
  const encrypted = cipher.update(text, 'utf8', 'hex') + cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * 从数据库存储格式解密
 * @param {string} encryptedText - 格式：iv:authTag:encryptedData
 * @param {string} encryptionKey - 64字符十六进制密钥
 * @returns {string} 明文数据
 */
function decryptFromStorage(encryptedText, encryptionKey) {
  const [ivHex, authTagHex, encryptedDataHex] = encryptedText.split(':');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(encryptionKey, 'hex'),
    Buffer.from(ivHex, 'hex')
  );
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  return decipher.update(encryptedDataHex, 'hex', 'utf8') + decipher.final('utf8');
}

module.exports = {
  deriveUserEncryptionKey,
  decryptPayload,
  encryptForStorage,
  decryptFromStorage
};
