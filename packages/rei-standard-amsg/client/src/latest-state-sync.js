import { chunkReasoningByUtf8Bytes } from '@rei-standard/amsg-shared';

/**
 * @typedef {Object} StateSyncEntry
 * @property {string} namespace
 * @property {string} key
 * @property {string|null} value
 * @property {number} updatedAt
 * @property {number} [version]
 * @property {{ type: string, id: string }} [owner]
 * @property {string} [kind]
 * @property {number} [ownerGeneration]
 */
/** @typedef {{ entry: StateSyncEntry, status: 'applied'|'conflict'|'rejected'|'unknown'|'failed', error?: Object }} StateWriteOutcome */
/** @typedef {{ outcomes: StateWriteOutcome[], pending: StateSyncEntry[], revision: number }} StateSyncReport */
const identity = (entry) => JSON.stringify([entry.namespace, entry.key]);
const copy = (value) => JSON.parse(JSON.stringify(value));
const encoder = new TextEncoder();
// Match the default server limits without importing its Node-capable entry.
const DEFAULT_REQUEST_BYTES = 32 * 1024 * 1024;
const DEFAULT_STATE_BYTES = 5 * 1024 * 1024;
// Multi-entry batches stop here so a Free-plan Worker can decrypt and write one
// request within its CPU budget; a single entry may still use the full request limit.
const BATCH_TARGET_BYTES = 1024 * 1024;
const STATE_CHUNK_BYTES = 200 * 1024;
const ENVELOPE_BYTES = JSON.stringify({ iv: 'x'.repeat(16), authTag: 'x'.repeat(24), encryptedData: '' }).length;
const encryptedBodyBytes = (plainBytes) => ENVELOPE_BYTES + 4 * Math.ceil(plainBytes / 3);

/** A successful HTTP request is not proof that every entry was written. Unknown
 * or incomplete receipts never authorize clearing a pending value.
 * @param {StateSyncEntry[]} entries
 * @param {Object} response
 * @returns {StateWriteOutcome[]}
 */
export function classifyClientStateWrite(entries, response) {
  if (response?.success !== true) {
    return entries.map((entry) => ({ entry, status: 'failed', error: response?.error }));
  }
  const data = response.data || {};
  const rejected = Array.isArray(data.rejected) ? data.rejected : [];
  const skipped = Array.isArray(data.skippedEntries) ? data.skippedEntries : [];
  const matchedRejected = entries.map((entry, index) => rejected.find((item) => item.index === index
    && (item.namespace === undefined || item.namespace === entry.namespace)
    && (item.key === undefined || item.key === entry.key)));
  const matchedSkipped = entries.map((entry) => skipped.some((item) => item.namespace === entry.namespace && item.key === entry.key));
  const validCounts = (data.unknown === undefined || data.unknown === 0)
    && Number.isInteger(data.upserted) && data.upserted >= 0
    && Number.isInteger(data.skipped) && data.skipped >= 0
    && Number.isInteger(data.deleted ?? 0) && (data.deleted ?? 0) >= 0
    && matchedRejected.filter(Boolean).length === rejected.length
    && matchedSkipped.filter(Boolean).length === data.skipped;
  const completeLogical = validCounts
    && data.upserted + (data.deleted ?? 0) + data.skipped + rejected.length === entries.length;
  // Older servers may return physical row totals. Only an exact, all-written
  // receipt proves success; partial counts cannot identify the affected roots.
  let completePhysical = false;
  if (!completeLogical && validCounts && data.skipped === 0 && skipped.length === 0) {
    const accepted = entries.filter((_, index) => !matchedRejected[index]);
    const physicalRows = accepted.reduce((count, entry) => count + (entry.value === null ? 0
      : encoder.encode(entry.value).length <= STATE_CHUNK_BYTES ? 1
        : 1 + chunkReasoningByUtf8Bytes(entry.value, STATE_CHUNK_BYTES).length), 0);
    completePhysical = data.upserted === physicalRows
      && (data.deleted ?? 0) === accepted.filter(entry => entry.value === null).length;
  }
  const complete = completeLogical || completePhysical;
  return entries.map((entry, index) => {
    if (matchedRejected[index]) return { entry, status: 'rejected', error: matchedRejected[index] };
    if (matchedSkipped[index]) return { entry, status: 'conflict' };
    return { entry, status: complete ? 'applied' : 'unknown' };
  });
}

/**
 * Coalesce pending state by namespace/key and drain newer saves after an active
 * upload. Each version is attempted once per flush; failure/conflict stays
 * pending. The host controls backoff and conflict policy, and must not blindly
 * increase timestamps to overwrite another device.
 *
 * Persistence commits before sending and before forgetting an accepted value.
 * Optional load/save adapters make the queue survive restart. Use one instance
 * per user/store; cross-tab coordination belongs to the storage adapter.
 * @param {{ send: (entries: StateSyncEntry[]) => Promise<Object>|Object, loadPending?: () => Promise<StateSyncEntry[]>|StateSyncEntry[], savePending?: (entries: StateSyncEntry[]) => Promise<void>|void, maxRequestBodyBytes?: number, maxStateValueBytes?: number }} options
 */
export function createLatestStateSync({ send, loadPending, savePending, maxRequestBodyBytes = DEFAULT_REQUEST_BYTES, maxStateValueBytes = DEFAULT_STATE_BYTES } = {}) {
  if (typeof send !== 'function') throw new TypeError('createLatestStateSync requires send(entries)');
  for (const limit of [maxRequestBodyBytes, maxStateValueBytes]) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError('State sync byte limits must be positive integers');
  }
  let pending = new Map();
  let revision = 0;
  let running = null;
  const normalize = (entries) => {
    if (!Array.isArray(entries)) throw new TypeError('Pending state must be an array');
    return entries.map((entry) => {
      if (!entry || typeof entry.namespace !== 'string' || !entry.namespace
        || typeof entry.key !== 'string' || !entry.key
        || (typeof entry.value !== 'string' && entry.value !== null)
        || !Number.isSafeInteger(entry.updatedAt) || entry.updatedAt <= 0) {
        throw new TypeError('Pending state entries require namespace, key, serialized value, and updatedAt');
      }
      return copy(entry);
    });
  };
  const restored = Promise.resolve().then(async () => {
    for (const entry of normalize(loadPending ? await loadPending() : [])) pending.set(identity(entry), entry);
  });
  // Observe immediately even if the host never calls an API. Keep the original
  // rejected promise so every API still reports restoration failure.
  void restored.catch(() => {});
  let stateQueue = restored;

  // Serialize storage mutations. Failed persistence leaves the previous durable
  // state in memory too, so a later retry cannot incorrectly observe an empty queue.
  const commit = (change) => {
    const operation = stateQueue.then(async () => {
      await restored;
      const next = new Map(pending);
      change(next);
      if (savePending) await savePending(copy([...next.values()]));
      pending = next;
      revision++;
    });
    stateQueue = operation.catch(() => {});
    return operation;
  };

  /** @returns {Promise<StateSyncReport>} */
  const run = async () => {
    const attempted = new Set();
    const outcomes = [];
    let processedRevision = revision;
    for (;;) {
      await stateQueue;
      processedRevision = revision;
      const batch = [];
      let plainBytes = encoder.encode('{"entries":[]}').length;
      for (const entry of pending.values()) {
        if (attempted.has(entry)) continue;
        const valueBytes = entry.value === null ? 0 : encoder.encode(entry.value).length;
        const entryBytes = encoder.encode(JSON.stringify(entry)).length;
        const singleBodyBytes = encryptedBodyBytes(encoder.encode('{"entries":[]}').length + entryBytes);
        const rejection = valueBytes > maxStateValueBytes
          ? { code: 'STATE_VALUE_TOO_LARGE', bytes: valueBytes, maxBytes: maxStateValueBytes }
          : singleBodyBytes > maxRequestBodyBytes
            ? { code: 'STATE_REQUEST_TOO_LARGE', bytes: singleBodyBytes, maxBytes: maxRequestBodyBytes }
            : null;
        if (rejection) {
          attempted.add(entry);
          outcomes.push({ entry, status: 'rejected', error: rejection });
          continue;
        }
        const nextBytes = plainBytes + entryBytes + (batch.length ? 1 : 0);
        const batchLimit = batch.length ? Math.min(BATCH_TARGET_BYTES, maxRequestBodyBytes) : maxRequestBodyBytes;
        if (batch.length >= 200 || encryptedBodyBytes(nextBytes) > batchLimit) break;
        attempted.add(entry);
        batch.push(entry);
        plainBytes = nextBytes;
      }
      if (!batch.length) break;
      let response;
      try { response = await send(copy(batch)); }
      catch (error) { response = { success: false, error: { code: error?.code || 'STATE_SYNC_FAILED', message: error?.message || String(error) } }; }
      const receipts = classifyClientStateWrite(batch, response);
      outcomes.push(...receipts);
      const applied = receipts.filter((outcome) => outcome.status === 'applied');
      if (applied.length) {
        await commit((next) => {
          for (const { entry } of applied) {
            if (next.get(identity(entry)) === entry) next.delete(identity(entry));
          }
        });
      }
    }
    return { outcomes: copy(outcomes), pending: copy([...pending.values()]), revision: processedRevision };
  };

  /** @returns {Promise<StateSyncReport>} */
  const flush = async () => {
    await restored;
    await stateQueue;
    const requestedRevision = revision;
    for (;;) {
      if (!running) running = run().finally(() => { running = null; });
      const report = await running;
      if (report.revision >= requestedRevision) return report;
    }
  };
  return {
    /** Persist and start/continue uploading the latest value for each key.
     * @param {StateSyncEntry[]} entries @returns {Promise<StateSyncReport>} */
    async enqueue(entries) {
      const normalized = normalize(entries);
      await commit((next) => { for (const entry of normalized) next.set(identity(entry), entry); });
      return flush();
    },
    /** Drop only still-matching snapshots from a previous report. Bare keys are
     * insufficient: a newer value must survive a delayed conflict decision.
     * @param {StateSyncEntry[]} entries @returns {Promise<StateSyncEntry[]>} */
    async discard(entries) {
      const snapshots = normalize(entries);
      await commit((next) => {
        for (const snapshot of snapshots) {
          const id = identity(snapshot);
          if (JSON.stringify(next.get(id)) === JSON.stringify(snapshot)) next.delete(id);
        }
      });
      return copy([...pending.values()]);
    },
    /** One bounded retry of pending versions; call after reconnect/backoff. */
    flush,
    /** @returns {Promise<StateSyncEntry[]>} */
    async getPending() { await restored; await stateQueue; return copy([...pending.values()]); },
  };
}
