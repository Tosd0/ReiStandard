/** Server-only inventory: physical storage is the source of truth, never an owner registry. */
import { decryptFromStorage } from './encryption.js';
import {
  CHUNK_NAMESPACE_PREFIX,
  isChunkNamespace,
  parseChunkedRootCount,
  chunkKeyFor
} from './state-chunks.js';

const encoder = new TextEncoder();
export async function cloudDataHash(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

function timestamp(value) {
  if (value == null) return null;
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeOwner(owner) {
  if (
    !owner ||
    typeof owner.type !== 'string' ||
    !owner.type ||
    typeof owner.id !== 'string' ||
    !owner.id
  )
    return null;
  return {
    type: owner.type,
    id: owner.id,
    ...(typeof owner.label === 'string' ? { label: owner.label } : {})
  };
}

function objectOrText(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function utf8ByteLength(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  return /[^\x00-\x7f]/.test(text) ? encoder.encode(text).length : text.length;
}

function rowByteSize(row) {
  if (typeof row.byte_size === 'number') return row.byte_size;
  return utf8ByteLength(
    String(
      row.value ??
        row.encrypted_payload ??
        row.encrypted_value ??
        row.payload ??
        row.subscription ??
        ''
    )
  );
}

const STORAGE_PREFIX_RE = /^[0-9a-f]{32}:[0-9a-f]{24,32}:[0-9a-f]*$/i;
const HEX_RE = /^[0-9a-f]*$/i;

function isValidStorageCiphertext(fullText, prefix, suffix, byteSize) {
  if (typeof fullText === 'string') {
    if (!STORAGE_PREFIX_RE.test(fullText)) return false;
    const secondColon = fullText.indexOf(':', 33);
    return secondColon > 32 && (fullText.length - secondColon - 1) % 2 === 0;
  }
  if (typeof prefix === 'string' && typeof byteSize === 'number') {
    if (!STORAGE_PREFIX_RE.test(prefix)) return false;
    if (typeof suffix === 'string' && !HEX_RE.test(suffix)) return false;
    const secondColon = prefix.indexOf(':', 33);
    return secondColon > 32 && (byteSize - secondColon - 1) % 2 === 0;
  }
  return false;
}

function hasCompleteStoredMetadata(stored) {
  return Boolean(
    stored &&
      safeOwner(stored.owner) !== null &&
      typeof stored.kind === 'string' &&
      stored.kind.length > 0
  );
}

/**
 * Internal entries retain exact encrypted snapshots for conditional deletion.
 * Only `entry.resource` may cross the API response boundary.
 */
export async function buildCloudDataInventory({
  db,
  userId,
  userKey,
  resolveOwner
}) {
  const raw = await db.listCloudResourceRows(userId);
  const gaps = [...(raw.gaps || [])];
  const entries = [];
  const metadata = new Map(
    (raw.metadata || []).map((row) => [row.resource_key, row.encrypted_value])
  );
  const readStoredMetadata = async (metadataKey) => {
    const encryptedMetadata = metadata.get(metadataKey) || null;
    if (!encryptedMetadata) {
      return { encryptedMetadata: null, stored: null, unreadable: false };
    }
    try {
      const stored = JSON.parse(
        await decryptFromStorage(encryptedMetadata, userKey)
      );
      return { encryptedMetadata, stored, unreadable: false };
    } catch {
      return { encryptedMetadata, stored: null, unreadable: true };
    }
  };
  const taskPayloads = new Map();
  const taskByUuid = new Map();
  for (const row of raw.task || []) {
    try {
      const payload = JSON.parse(
        await decryptFromStorage(row.encrypted_payload, userKey)
      );
      taskPayloads.set(row.id, payload);
      if (row.uuid) taskByUuid.set(row.uuid, payload);
    } catch {
      /* unreadable rows remain in inventory */
    }
  }
  const tasks = (raw.task || [])
    .filter((row) => taskPayloads.has(row.id))
    .map((row) => ({ ...taskPayloads.get(row.id), uuid: row.uuid }));

  const add = async ({
    type,
    identity,
    rows,
    value,
    payload,
    task,
    unreadable = false,
    status = null,
    namespace,
    key,
    credId,
    metadataInfo
  }) => {
    const metadataKey = JSON.stringify([type, ...identity]);
    const id = await cloudDataHash(JSON.stringify([userId, metadataKey]));
    const {
      encryptedMetadata,
      stored,
      unreadable: metadataUnreadable
    } = metadataInfo ?? (await readStoredMetadata(metadataKey));
    if (metadataUnreadable) unreadable = true;
    let resolved = null;
    if (resolveOwner && !hasCompleteStoredMetadata(stored)) {
      try {
        resolved = await resolveOwner({
          type,
          namespace,
          key,
          credId,
          value,
          payload,
          task,
          tasks
        });
      } catch {
        gaps.push({
          source: type,
          code: 'OWNER_RESOLUTION_FAILED',
          message: 'A resource owner could not be resolved'
        });
      }
    }
    const owner =
      safeOwner(stored?.owner) ||
      safeOwner(payload?.__cloudOwnerGuard?.owner) ||
      safeOwner(payload?.metadata?.cloudOwner) ||
      safeOwner(payload?.metadata?.owner) ||
      safeOwner(payload?.owner) ||
      safeOwner(task?.__cloudOwnerGuard?.owner) ||
      safeOwner(task?.metadata?.cloudOwner) ||
      safeOwner(task?.metadata?.owner) ||
      safeOwner(task?.owner) ||
      safeOwner(resolved?.owner);
    const kind =
      stored?.kind ??
      payload?.metadata?.kind ??
      payload?.kind ??
      resolved?.kind ??
      null;
    const times = rows
      .map((row) => timestamp(row.updated_at ?? row.created_at))
      .filter((time) => time !== null);
    const byteSize = rows.reduce((sum, row) => sum + rowByteSize(row), 0);
    const label =
      type === 'state'
        ? `${namespace}/${key}`
        : type === 'credential'
        ? credId
        : type === 'task'
        ? rows[0].uuid || `task row ${rows[0].id}`
        : type === 'outbox'
        ? rows[0].message_id
        : 'Web Push subscription';
    entries.push({
      resource: {
        id,
        type,
        owner,
        kind: typeof kind === 'string' ? kind : null,
        label,
        byteSize,
        updatedAt: times.length ? Math.max(...times) : null,
        status: unreadable ? 'unreadable' : status
      },
      locator: {
        type,
        rows,
        metadataKey,
        encryptedMetadata: encryptedMetadata || null,
        ...(type === 'state' ? { logicalState: { namespace, key } } : {})
      },
      version: await cloudDataHash(
        JSON.stringify({ rows, encryptedMetadata: encryptedMetadata || null })
      )
    });
  };

  for (const row of raw.task || []) {
    const payload = taskPayloads.get(row.id);
    await add({
      type: 'task',
      identity: [row.uuid ?? ['row', row.id]],
      rows: [row],
      payload,
      task: payload,
      unreadable: !payload,
      status: row.status
    });
  }

  const stateRows = raw.state || [];
  const roots = stateRows.filter((row) => !isChunkNamespace(row.namespace));
  const chunks = new Map();
  for (const row of stateRows.filter((row) =>
    isChunkNamespace(row.namespace)
  )) {
    const separator = row.key.lastIndexOf('\u001f');
    const namespace = row.namespace.slice(CHUNK_NAMESPACE_PREFIX.length);
    const key = separator >= 0 ? row.key.slice(0, separator) : row.key;
    const group = JSON.stringify([namespace, key]);
    if (!chunks.has(group)) chunks.set(group, []);
    chunks.get(group).push(row);
  }
  for (const row of roots) {
    const group = JSON.stringify([row.namespace, row.key]);
    const slices = chunks.get(group) || [];
    chunks.delete(group);
    const rows = [row, ...slices.sort((a, b) => a.key.localeCompare(b.key))];
    const metadataKey = JSON.stringify(['state', row.namespace, row.key]);
    const metadataInfo = await readStoredMetadata(metadataKey);
    const skipFullDecrypt =
      !metadataInfo.unreadable &&
      hasCompleteStoredMetadata(metadataInfo.stored);
    let value,
      unreadable = metadataInfo.unreadable;
    try {
      const rootMarker = row.value ?? row.value_prefix ?? '';
      const count = parseChunkedRootCount(rootMarker);
      if (count === null) {
        if (
          typeof row.value === 'string' &&
          (!skipFullDecrypt || row.value.length <= 1024)
        ) {
          value = await decryptFromStorage(row.value, userKey);
        } else if (skipFullDecrypt) {
          if (
            !isValidStorageCiphertext(
              row.value,
              row.value_prefix,
              row.value_suffix,
              row.byte_size
            )
          ) {
            throw new Error('Invalid state ciphertext');
          }
        } else {
          const fetched =
            typeof db.getClientState === 'function'
              ? await db.getClientState(userId, row.namespace, { key: row.key })
              : [];
          const rawValue = fetched?.[0]?.value;
          if (typeof rawValue !== 'string') {
            throw new Error('Missing state value');
          }
          value = await decryptFromStorage(rawValue, userKey);
        }
      } else {
        // Validate counts against physically present slices before allocating/looping.
        if (count > slices.length) throw new Error('Missing state chunks');
        const sliceByKey = new Map(
          slices.map((candidate) => [candidate.key, candidate])
        );
        const orderedSlices = [];
        for (let i = 0; i < count; i++) {
          const slice = sliceByKey.get(chunkKeyFor(row.key, i));
          if (!slice || slice.updated_at !== row.updated_at)
            throw new Error('Mismatched state chunks');
          if (
            !isValidStorageCiphertext(
              slice.value,
              slice.value_prefix,
              slice.value_suffix,
              slice.byte_size
            )
          ) {
            throw new Error('Corrupt state chunk');
          }
          orderedSlices.push(slice);
        }
        if (!skipFullDecrypt) {
          let fetchedByKey = null;
          if (orderedSlices.some((slice) => typeof slice.value !== 'string')) {
            const fetchedSlices =
              typeof db.getClientState === 'function'
                ? await db.getClientState(
                    userId,
                    CHUNK_NAMESPACE_PREFIX + row.namespace,
                    { keyPrefix: `${row.key}\u001f` }
                  )
                : [];
            fetchedByKey = new Map(
              fetchedSlices.map((candidate) => [candidate.key, candidate.value])
            );
          }
          const parts = [];
          for (const slice of orderedSlices) {
            const rawSliceValue =
              typeof slice.value === 'string'
                ? slice.value
                : fetchedByKey?.get(slice.key);
            if (typeof rawSliceValue !== 'string') {
              throw new Error('Missing state chunk value');
            }
            parts.push(await decryptFromStorage(rawSliceValue, userKey));
          }
          value = parts.join('');
        }
      }
    } catch {
      unreadable = true;
    }
    await add({
      type: 'state',
      identity: [row.namespace, row.key],
      namespace: row.namespace,
      key: row.key,
      rows,
      value,
      unreadable,
      status: null,
      metadataInfo
    });
  }
  for (const [group, rows] of chunks) {
    const [namespace, key] = JSON.parse(group);
    await add({
      type: 'state',
      identity: [namespace, key],
      namespace,
      key,
      rows,
      status: 'orphan-chunks'
    });
  }
  for (const row of raw.credential || []) {
    // Credentials need no decryption to enumerate. Never pass secret credential content to a resolver.
    await add({
      type: 'credential',
      identity: [row.cred_id],
      credId: row.cred_id,
      rows: [row],
      status: null
    });
  }
  for (const row of raw.outbox || []) {
    const metadataKey = JSON.stringify(['outbox', row.message_id]);
    const metadataInfo = await readStoredMetadata(metadataKey);
    const skipFullDecrypt =
      !metadataInfo.unreadable &&
      hasCompleteStoredMetadata(metadataInfo.stored);
    let payload,
      unreadable = metadataInfo.unreadable;
    try {
      if (
        typeof row.payload === 'string' &&
        (!skipFullDecrypt || row.payload.length <= 1024)
      ) {
        payload = objectOrText(await decryptFromStorage(row.payload, userKey));
      } else if (skipFullDecrypt) {
        if (
          !isValidStorageCiphertext(
            row.payload,
            row.payload_prefix,
            row.payload_suffix,
            row.byte_size
          )
        ) {
          throw new Error('Invalid outbox ciphertext');
        }
      } else {
        const rawPayload =
          typeof db.getOutboxPayload === 'function'
            ? await db.getOutboxPayload(userId, row.message_id)
            : null;
        if (typeof rawPayload !== 'string') {
          throw new Error('Missing outbox payload');
        }
        payload = objectOrText(await decryptFromStorage(rawPayload, userKey));
      }
    } catch {
      unreadable = true;
    }
    await add({
      type: 'outbox',
      identity: [row.message_id],
      rows: [row],
      payload,
      task: taskByUuid.get(row.task_uuid),
      unreadable,
      status:
        row.acked_at != null
          ? 'acked'
          : row.delivered_at != null
          ? 'delivered'
          : 'pending',
      metadataInfo
    });
  }
  for (const row of raw.subscription || []) {
    await add({
      type: 'subscription',
      identity: [userId],
      rows: [row],
      status: 'registered'
    });
  }
  // Resolve names from all cloud resources before pagination, preserving each
  // explicit historical snapshot and filling only otherwise unknown names.
  const ownerLabels = new Map();
  for (const { resource } of entries) {
    const owner = resource.owner;
    if (!owner?.label?.trim()) continue;
    const identity = JSON.stringify([owner.type, owner.id]);
    const current = ownerLabels.get(identity);
    if (!current || (resource.updatedAt ?? 0) > current.updatedAt) {
      ownerLabels.set(identity, {
        label: owner.label,
        updatedAt: resource.updatedAt ?? 0
      });
    }
  }
  for (const { resource } of entries) {
    const owner = resource.owner;
    if (!owner || owner.label?.trim()) continue;
    const known = ownerLabels.get(JSON.stringify([owner.type, owner.id]));
    if (known) resource.owner = { ...owner, label: known.label };
  }
  entries.sort((a, b) => a.resource.id.localeCompare(b.resource.id));
  return { entries, complete: gaps.length === 0, gaps };
}
