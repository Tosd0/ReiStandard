import {
  deriveUserEncryptionKey,
  decryptFromStorage,
  encryptForStorage
} from './encryption.js';
import {
  CHUNK_NAMESPACE_PREFIX,
  isChunkNamespace,
  parseChunkedRootCount
} from './state-chunks.js';

const RAW_CLOUD_ADAPTER = Symbol('cloud-data-adapter');

function guardError(code, message) {
  return Object.assign(new Error(message), { code, status: 409 });
}

function validOwner(owner) {
  return (
    owner &&
    typeof owner.type === 'string' &&
    owner.type.trim().length > 0 &&
    owner.type.length <= 100 &&
    typeof owner.id === 'string' &&
    owner.id.trim().length > 0 &&
    owner.id.length <= 300
  );
}

function validateGuard(guard) {
  if (!validOwner(guard?.owner))
    throw guardError('INVALID_CLOUD_OWNER', 'Cloud owner is invalid');
  if (!Number.isSafeInteger(guard.generation) || guard.generation < 0) {
    throw guardError(
      'INVALID_CLOUD_OWNER_GENERATION',
      'Cloud owner generation must be a non-negative integer'
    );
  }
  return { owner: guard.owner, generation: guard.generation };
}

/** Check at task start and immediately before external delivery. Writes must
 * also use the adapter's transactional guard; this read is not a write lock. */
export async function assertCloudGuard(db, userId, guard) {
  if (!guard) return;
  validateGuard(guard);
  if (typeof db.isCloudOwnerGuardValid !== 'function') {
    throw guardError(
      'CLOUD_GUARD_UNSUPPORTED',
      'Adapter cannot validate cloud owner guards'
    );
  }
  if (!(await db.isCloudOwnerGuardValid(userId, guard))) {
    throw guardError(
      'CLOUD_OWNER_RETIRED',
      'Cloud owner is retired or its generation changed'
    );
  }
}

async function resolveMetadata(resolveOwner, input, explicit) {
  const resolved =
    typeof resolveOwner === 'function' ? await resolveOwner(input) : null;
  const owner =
    explicit?.owner ??
    explicit?.metadata?.cloudOwner ??
    resolved?.owner ??
    (validOwner(resolved) ? resolved : null);
  if (owner !== null && !validOwner(owner))
    throw guardError('INVALID_CLOUD_OWNER', 'Cloud owner is invalid');
  return { owner, kind: explicit?.kind ?? resolved?.kind ?? null };
}

/** Capture persisted task identity once. Missing generations deliberately mean
 * zero, never the current generation: restoring must not revive old requests. */
export async function captureCloudTaskGuard(
  db,
  userId,
  payload,
  resolveOwner,
  task
) {
  if (!db.cloudDataManagement) return null;
  if (payload?.__cloudOwnerGuard) {
    const guard = validateGuard(payload.__cloudOwnerGuard);
    await assertCloudGuard(db, userId, guard);
    return guard;
  }
  const { owner } = await resolveMetadata(
    resolveOwner,
    { type: 'task', payload, task },
    payload
  );
  if (!owner) return null;
  const guard = validateGuard({
    owner,
    generation: payload?.ownerGeneration ?? 0
  });
  await assertCloudGuard(db, userId, guard);
  return guard;
}

/** Add ownership and transactional guard arguments at the storage boundary.
 * A task-scoped inherited guard always wins over caller-provided output fields. */
export function createCloudGuardedAdapter(
  db,
  {
    masterKey,
    resolveOwner,
    guard: inheritedGuard = null,
    userId: scopedUserId
  } = {}
) {
  db = db[RAW_CLOUD_ADAPTER] ?? db;
  if (!db.cloudDataManagement) return db;
  const methods = new Map();
  const keyFor = (userId) => deriveUserEncryptionKey(userId, masterKey);
  const metadataFor = async (userId, input, explicit, userKey) => {
    const resolved = await resolveMetadata(resolveOwner, input, explicit);
    const resourceKey =
      input.type === 'state'
        ? ['state', input.namespace, input.key]
        : input.type === 'credential'
        ? ['credential', input.credId]
        : null;
    let expectedCloudMetadata;
    if (resourceKey && typeof db.getCloudResourceMetadata === 'function') {
      const stored = await db.getCloudResourceMetadata(
        userId,
        JSON.stringify(resourceKey)
      );
      expectedCloudMetadata = stored;
      if (stored) {
        const previous = JSON.parse(await decryptFromStorage(stored, userKey));
        if (previous.owner) {
          if (
            resolved.owner &&
            (previous.owner.type !== resolved.owner.type ||
              previous.owner.id !== resolved.owner.id)
          ) {
            throw guardError(
              'CLOUD_OWNER_IMMUTABLE',
              'Existing cloud resource ownership cannot be changed by ordinary writes'
            );
          }
          resolved.owner ??= previous.owner;
          resolved.kind ??= previous.kind;
        }
      }
    }
    const inheritsOwner = input.type === 'task' || input.type === 'outbox';
    let guard;
    if (inheritedGuard && inheritsOwner) {
      guard = inheritedGuard;
    } else if (resolved.owner) {
      if (
        inheritedGuard &&
        (resolved.owner.type !== inheritedGuard.owner.type ||
          resolved.owner.id !== inheritedGuard.owner.id)
      ) {
        throw guardError(
          'CLOUD_CROSS_OWNER_WRITE',
          "A task cannot write another cloud owner's resources"
        );
      }
      guard =
        inheritedGuard ||
        validateGuard({
          owner: resolved.owner,
          generation: explicit?.ownerGeneration ?? 0
        });
    } else {
      guard = null;
    }
    await assertCloudGuard(db, userId, inheritedGuard);
    await assertCloudGuard(db, userId, guard);
    // Global/shared state stays global while its mutation is still gated by
    // the originating task. Only task/outbox descendants inherit ownership.
    const metadata = {
      owner: guard?.owner ?? resolved.owner,
      kind: resolved.kind,
      generation: guard?.generation ?? 0
    };
    return {
      cloudGuard: guard,
      encryptedCloudMetadata: await encryptForStorage(
        JSON.stringify(metadata),
        userKey
      ),
      ...(expectedCloudMetadata !== undefined ? { expectedCloudMetadata } : {})
    };
  };
  const stateIdentity = (row) => {
    const chunk = isChunkNamespace(row.namespace);
    const namespace =
      row.cloudNamespace ??
      (chunk
        ? row.namespace.slice(CHUNK_NAMESPACE_PREFIX.length)
        : row.namespace);
    let key = row.cloudKey ?? row.key ?? row.keyPrefix;
    if (chunk && row.cloudKey === undefined && typeof key === 'string')
      key = key.slice(0, key.lastIndexOf('\u001f'));
    return { namespace, key };
  };
  const wrap = (name, fn) => {
    if (typeof db[name] === 'function') methods.set(name, fn);
  };

  for (const method of ['createTask', 'createTaskSuperseding']) {
    wrap(method, async (params, supersedesUuid) => {
      const key = await keyFor(params.user_id);
      const payload = JSON.parse(
        await decryptFromStorage(params.encrypted_payload, key)
      );
      // A client must not forge the internal identity of a newly scheduled task.
      delete payload.__cloudOwnerGuard;
      const metadata = await metadataFor(
        params.user_id,
        { type: 'task', payload, task: params },
        payload,
        key
      );
      if (metadata.cloudGuard) payload.__cloudOwnerGuard = metadata.cloudGuard;
      const next = {
        ...params,
        ...metadata,
        encrypted_payload: await encryptForStorage(JSON.stringify(payload), key)
      };
      return method === 'createTaskSuperseding'
        ? db[method](next, supersedesUuid, metadata.cloudGuard)
        : db[method](next, metadata.cloudGuard);
    });
  }

  wrap(
    'upsertClientState',
    async (userId, entries, cleanups = [], now = Date.now()) => {
      const key = await keyFor(userId);
      const roots = new Map();
      const rows = [];
      for (const entry of entries) {
        const identity = stateIdentity(entry);
        const token = JSON.stringify([identity.namespace, identity.key]);
        let metadata = roots.get(token);
        if (!metadata) {
          let value = entry.cloudValue;
          if (
            value === undefined &&
            entry.value &&
            !isChunkNamespace(entry.namespace) &&
            !parseChunkedRootCount(entry.value)
          ) {
            value = await decryptFromStorage(entry.value, key);
          }
          metadata = await metadataFor(
            userId,
            { type: 'state', ...identity, value, row: entry },
            entry,
            key
          );
          roots.set(token, metadata);
        }
        rows.push(
          isChunkNamespace(entry.namespace)
            ? { ...entry, cloudGuard: metadata.cloudGuard }
            : { ...entry, ...metadata }
        );
      }
      const guardedCleanups = [];
      for (const cleanup of cleanups) {
        const identity = stateIdentity(cleanup);
        const token = JSON.stringify([identity.namespace, identity.key]);
        const metadata =
          roots.get(token) ??
          (await metadataFor(
            userId,
            {
              type: 'state',
              ...identity,
              value: cleanup.cloudValue,
              row: cleanup
            },
            cleanup,
            key
          ));
        guardedCleanups.push({
          ...cleanup,
          cloudGuard: metadata.cloudGuard,
          cloudMetadataKey: JSON.stringify([
            'state',
            identity.namespace,
            identity.key
          ]),
          ...(metadata.expectedCloudMetadata !== undefined
            ? { expectedCloudMetadata: metadata.expectedCloudMetadata }
            : {})
        });
      }
      return db.upsertClientState(
        userId,
        rows,
        guardedCleanups,
        now,
        inheritedGuard
      );
    }
  );

  wrap('upsertLlmCredentials', async (userId, entries) => {
    const key = await keyFor(userId);
    const rows = [];
    for (const entry of entries) {
      const value = JSON.parse(
        await decryptFromStorage(entry.encryptedValue, key)
      );
      const metadata = await metadataFor(
        userId,
        { type: 'credential', credId: entry.credId, value, row: entry },
        entry,
        key
      );
      rows.push({ ...entry, ...metadata });
    }
    return db.upsertLlmCredentials(userId, rows, inheritedGuard);
  });

  wrap('appendOutboxMessages', async (userId, entries) => {
    const key = await keyFor(userId);
    const rows = [];
    for (const entry of entries) {
      const payload = JSON.parse(await decryptFromStorage(entry.payload, key));
      const metadata = await metadataFor(
        userId,
        { type: 'outbox', payload, row: entry },
        payload,
        key
      );
      rows.push({ ...entry, ...metadata });
    }
    return db.appendOutboxMessages(userId, rows, inheritedGuard);
  });

  if (inheritedGuard) {
    wrap('updateTaskById', async (id, updates) => {
      if (scopedUserId)
        await assertCloudGuard(db, scopedUserId, inheritedGuard);
      return db.updateTaskById(id, updates, inheritedGuard);
    });
  }

  wrap(
    'updateTaskByUuid',
    async (uuid, userId, encryptedPayload, extraFields) => {
      const existing = await db.getTaskByUuid(uuid, userId);
      if (!existing) return null;
      const key = await keyFor(userId);
      const originalPayload = JSON.parse(
        await decryptFromStorage(existing.encrypted_payload, key)
      );
      const originalGuard = await captureCloudTaskGuard(
        db,
        userId,
        originalPayload,
        resolveOwner,
        existing
      );
      if (
        inheritedGuard &&
        originalGuard &&
        (originalGuard.owner.type !== inheritedGuard.owner.type ||
          originalGuard.owner.id !== inheritedGuard.owner.id)
      ) {
        throw guardError(
          'CLOUD_CROSS_OWNER_WRITE',
          'A task cannot update another cloud owner'
        );
      }
      const guard = inheritedGuard || originalGuard;
      await assertCloudGuard(db, userId, guard);
      const payload = JSON.parse(
        await decryptFromStorage(encryptedPayload, key)
      );
      delete payload.__cloudOwnerGuard;
      if (guard) payload.__cloudOwnerGuard = guard;
      // Scheduling identity is fixed for this task. Ordinary updates cannot
      // relabel it or replace the generation captured at creation.
      for (const field of ['owner', 'ownerGeneration']) {
        if (originalPayload[field] !== undefined)
          payload[field] = originalPayload[field];
        else delete payload[field];
      }
      if (payload.metadata && typeof payload.metadata === 'object') {
        if (originalPayload.metadata?.cloudOwner !== undefined)
          payload.metadata.cloudOwner = originalPayload.metadata.cloudOwner;
        else delete payload.metadata.cloudOwner;
      }
      return db.updateTaskByUuid(
        uuid,
        userId,
        await encryptForStorage(JSON.stringify(payload), key),
        extraFields,
        guard
      );
    }
  );

  return new Proxy(db, {
    get(target, property) {
      if (property === RAW_CLOUD_ADAPTER) return target;
      if (methods.has(property)) return methods.get(property);
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}
