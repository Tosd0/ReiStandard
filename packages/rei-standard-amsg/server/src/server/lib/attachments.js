import { randomUUID } from './webcrypto-utils.js';

// A dedicated namespace lets the regular cron reclaim abandoned/retried writes.
export const ATTACHMENT_NAMESPACE = 'amsg:attachments';
export const ATTACHMENT_RETENTION_DAYS = 30;
export const MAX_ATTACHMENT_TTL_MS = ATTACHMENT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/**
 * @typedef {Object} AttachmentRef
 * @property {1} version
 * @property {string} namespace
 * @property {string} key
 * @property {string} taskUuid
 * @property {number} occurrenceMs
 * @property {number} expiresAt
 */

/** Each write gets an independent immutable identity. Reads never delete: an
 * outbox retry or another device can still resolve the same reference. Shorter
 * TTLs expire logically; cron reclaims all rows after the retention ceiling.
 * @param {{ task: Object, occurrenceMs: number|null, writeState: Function, now: () => number }} args
 */
export function createAttachmentStore({ task, occurrenceMs, writeState, now }) {
  /** @param {string} value @param {{ ttlMs?: number, owner?: { type: string, id: string }, kind?: string, ownerGeneration?: number }} [options] @returns {Promise<AttachmentRef>} */
  return async function storeAttachment(value, { ttlMs = MAX_ATTACHMENT_TTL_MS, owner, kind = 'attachment', ownerGeneration } = {}) {
    if (typeof value !== 'string') throw new TypeError('storeAttachment value must be a serialized string');
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_ATTACHMENT_TTL_MS) {
      throw new RangeError('storeAttachment ttlMs must be between 1 millisecond and 30 days');
    }
    if (typeof task.uuid !== 'string' || !task.uuid || !Number.isFinite(occurrenceMs)) {
      throw new TypeError('storeAttachment requires a task UUID and a valid occurrence');
    }
    const at = now();
    const ref = { version: /** @type {1} */ (1), namespace: ATTACHMENT_NAMESPACE, key: randomUUID(), taskUuid: task.uuid, occurrenceMs, expiresAt: at + ttlMs };
    const result = await writeState(ATTACHMENT_NAMESPACE, [{ key: ref.key, value: JSON.stringify({ ...ref, owner, kind, ownerGeneration, value }), updatedAt: at, owner, kind, ownerGeneration }]);
    if (result.upserted !== 1 || result.skipped !== 0) {
      throw new Error('ATTACHMENT_WRITE_INCOMPLETE: attachment was not stored');
    }
    return ref;
  };
}
