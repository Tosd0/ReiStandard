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
    credId
  }) => {
    const metadataKey = JSON.stringify([type, ...identity]);
    const id = await cloudDataHash(JSON.stringify([userId, metadataKey]));
    let stored = null;
    const encryptedMetadata = metadata.get(metadataKey);
    if (encryptedMetadata) {
      try {
        stored = JSON.parse(
          await decryptFromStorage(encryptedMetadata, userKey)
        );
      } catch {
        unreadable = true;
      }
    }
    let resolved = null;
    if (resolveOwner) {
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
    const byteSize = rows.reduce(
      (sum, row) =>
        sum +
        encoder.encode(
          String(
            row.value ??
              row.encrypted_payload ??
              row.encrypted_value ??
              row.payload ??
              row.subscription ??
              ''
          )
        ).length,
      0
    );
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
    let value,
      unreadable = false;
    try {
      const count = parseChunkedRootCount(row.value);
      if (count === null) value = await decryptFromStorage(row.value, userKey);
      else {
        // Validate counts against physically present slices before allocating/looping.
        if (count > slices.length) throw new Error('Missing state chunks');
        const parts = [];
        for (let i = 0; i < count; i++) {
          const slice = slices.find(
            (candidate) => candidate.key === chunkKeyFor(row.key, i)
          );
          if (!slice || slice.updated_at !== row.updated_at)
            throw new Error('Mismatched state chunks');
          parts.push(await decryptFromStorage(slice.value, userKey));
        }
        value = parts.join('');
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
      status: null
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
    let payload,
      unreadable = false;
    try {
      payload = objectOrText(await decryptFromStorage(row.payload, userKey));
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
          : 'pending'
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
