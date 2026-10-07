import {
  encryptForStorage,
  decryptFromStorage,
  deriveUserEncryptionKey
} from './encryption.js';
import { buildCloudDataInventory } from './cloud-data-inventory.js';

export const CLOUD_RESOURCE_TYPES = [
  'task',
  'state',
  'credential',
  'outbox',
  'subscription'
];
export function cloudError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}
export function validCloudOwner(owner) {
  return (
    owner &&
    typeof owner.type === 'string' &&
    owner.type.length > 0 &&
    owner.type.length <= 100 &&
    typeof owner.id === 'string' &&
    owner.id.length > 0 &&
    owner.id.length <= 300
  );
}
const ownerEquals = (a, b) => a && b && a.type === b.type && a.id === b.id;
export async function cloudInventory(ctx, db, userId, userKey) {
  return buildCloudDataInventory({
    db,
    userId,
    userKey,
    resolveOwner: ctx.cloudData?.resolveOwner
  });
}
async function save(db, userId, key, kind, value, options) {
  return db.putCloudDataRecord(
    userId,
    kind,
    value.id,
    await encryptForStorage(
      JSON.stringify({
        ...value,
        ...(value.entries
          ? { entries: value.entries.map(({ locator, ...entry }) => entry) }
          : {})
      }),
      key
    ),
    options
  );
}
export async function readCloudRecord(db, userId, key, kind, id) {
  const record = await db.getCloudDataRecord(userId, kind, id);
  if (!record)
    throw cloudError('CLOUD_RECORD_NOT_FOUND', '云端管理记录不存在', 404);
  return JSON.parse(await decryptFromStorage(record.data, key));
}
export function publicOperation(operation) {
  const {
    entries,
    cursor,
    attempts,
    nextAttemptAt,
    knownResourceIds,
    knownResourceVersions,
    ...publicValue
  } = operation;
  return publicValue;
}
export async function makeCleanupPlan(ctx, db, userId, key, input) {
  const { mode, owner, resourceIds, types } = input;
  if (!['purge', 'retire-owner'].includes(mode))
    throw cloudError('INVALID_CLEANUP_MODE', '清理模式无效');
  if (owner !== undefined && !validCloudOwner(owner))
    throw cloudError('INVALID_CLOUD_OWNER', '归属格式无效');
  if (mode === 'retire-owner' && !validCloudOwner(owner))
    throw cloudError('INVALID_CLOUD_OWNER', '彻底移除需要明确归属');
  if (
    resourceIds !== undefined &&
    (!Array.isArray(resourceIds) ||
      !resourceIds.length ||
      resourceIds.some((id) => typeof id !== 'string'))
  )
    throw cloudError('INVALID_CLEANUP_SELECTION', '请选择至少一项资源');
  if (
    types !== undefined &&
    (!Array.isArray(types) ||
      !types.length ||
      types.some((type) => !CLOUD_RESOURCE_TYPES.includes(type)))
  )
    throw cloudError('INVALID_CLEANUP_SELECTION', '资源类别无效');
  if (mode === 'purge' && !owner && !resourceIds?.length)
    throw cloudError('INVALID_CLEANUP_SELECTION', '清理需要明确资源或归属');
  if (mode === 'retire-owner' && (resourceIds || types))
    throw cloudError('INVALID_CLEANUP_SELECTION', '彻底移除不能限制资源类别');
  const ownerGeneration =
    mode === 'retire-owner'
      ? (await db.getCloudOwner(userId, owner)).generation
      : null;
  const inventory = await cloudInventory(ctx, db, userId, key);
  if (!inventory.complete)
    throw cloudError(
      'CLOUD_INVENTORY_INCOMPLETE',
      '云端清单不完整，暂不能生成清理计划',
      409
    );
  const entries = inventory.entries.filter(
    (e) =>
      (!owner || ownerEquals(e.resource.owner, owner)) &&
      (!resourceIds || resourceIds.includes(e.resource.id)) &&
      (!types || types.includes(e.resource.type))
  );
  if (resourceIds && new Set(resourceIds).size !== entries.length)
    throw cloudError(
      'CLOUD_RESOURCE_NOT_FOUND',
      '部分选中资源不存在或不属于当前范围',
      409
    );
  const at = Date.now();
  const plan = {
    id: crypto.randomUUID(),
    mode,
    ownerGeneration,
    owner: owner
      ? { type: owner.type, id: owner.id, label: owner.label }
      : null,
    resources: entries.map((e) => e.resource),
    count: entries.length,
    counts: CLOUD_RESOURCE_TYPES.map((type) => ({
      type,
      count: entries.filter((e) => e.resource.type === type).length
    })),
    expiresAt: at + 15 * 60 * 1000,
    impacts:
      mode === 'retire-owner'
        ? [
            '停用此归属，包含执行时新增的全部所属资源。',
            '已交给外部推送服务的通知无法撤回。'
          ]
        : ['仅清理预览中的资源；后续正常写入可以重新创建。'],
    complete: true,
    gaps: [],
    entries
  };
  await save(db, userId, key, 'plan', plan);
  const { entries: privateEntries, ...publicPlan } = plan;
  return publicPlan;
}
export async function startCleanup(ctx, db, userId, key, input) {
  if (
    typeof input.planId !== 'string' ||
    typeof input.idempotencyKey !== 'string' ||
    !input.idempotencyKey.trim() ||
    input.idempotencyKey.length > 200
  )
    throw cloudError('INVALID_CLEANUP_OPERATION', '需要计划编号与幂等键');
  // Idempotency is scoped to this user by the database, never a client-supplied user ID.
  const existing = await db.getCloudDataRecordByIdempotency(
    userId,
    'operation',
    input.idempotencyKey
  );
  if (existing) {
    const op = JSON.parse(await decryptFromStorage(existing.data, key));
    if (op.planId !== input.planId)
      throw cloudError('IDEMPOTENCY_CONFLICT', '此幂等键已用于另一计划', 409);
    const resumed = await advanceCleanup(ctx, db, userId, key, op);
    assertRetirementAcknowledged(resumed);
    return publicOperation(resumed);
  }
  const plan = await readCloudRecord(db, userId, key, 'plan', input.planId);
  if (plan.expiresAt < Date.now())
    throw cloudError('CLOUD_PLAN_EXPIRED', '清理预览已过期，请重新预览', 409);
  if (
    plan.mode === 'retire-owner' &&
    (await db.getCloudOwner(userId, plan.owner)).generation !==
      plan.ownerGeneration
  ) {
    throw cloudError('CLOUD_PLAN_CHANGED', '归属代际已变化，请重新预览', 409);
  }
  if (plan.mode === 'purge') {
    const current = await cloudInventory(ctx, db, userId, key);
    if (!current.complete)
      throw cloudError(
        'CLOUD_INVENTORY_INCOMPLETE',
        '无法确认当前云端数据',
        409
      );
    const versions = new Map(
      current.entries.map((e) => [e.resource.id, e.version])
    );
    if (plan.entries.some((e) => versions.get(e.resource.id) !== e.version))
      throw cloudError(
        'CLOUD_PLAN_CHANGED',
        '预览后数据已变化，请重新预览',
        409
      );
  }
  const at = Date.now();
  const operation = {
    id: crypto.randomUUID(),
    planId: plan.id,
    idempotencyKey: input.idempotencyKey,
    mode: plan.mode,
    owner: plan.owner,
    ownerGeneration: plan.ownerGeneration,
    fencedGeneration: null,
    status: 'pending',
    counts: CLOUD_RESOURCE_TYPES.map((type) => ({
      type,
      deleted: 0,
      remaining: plan.entries.filter((e) => e.resource.type === type).length,
      failed: 0
    })),
    errors: [],
    createdAt: at,
    updatedAt: at,
    entries: plan.entries,
    knownResourceIds: plan.entries.map((entry) => entry.resource.id),
    knownResourceVersions: Object.fromEntries(
      plan.entries.map((entry) => [entry.resource.id, entry.version])
    ),
    cursor: 0,
    attempts: 0,
    nextAttemptAt: 0
  };
  const stored = await save(db, userId, key, 'operation', operation, {
    idempotencyKey: input.idempotencyKey
  });
  const persisted = JSON.parse(await decryptFromStorage(stored.data, key));
  if (persisted.planId !== input.planId)
    throw cloudError('IDEMPOTENCY_CONFLICT', '此幂等键已用于另一计划', 409);
  await db.deleteCloudDataRecord(userId, 'plan', plan.id);
  const advanced = await advanceCleanup(ctx, db, userId, key, persisted);
  assertRetirementAcknowledged(advanced);
  return publicOperation(advanced);
}
function assertRetirementAcknowledged(operation) {
  if (operation.mode === 'retire-owner' && operation.fencedGeneration == null) {
    throw cloudError(
      'CLOUD_RETIREMENT_NOT_CONFIRMED',
      '尚未确认云端停用，请保留本地角色并重试或查看云端操作记录。',
      503
    );
  }
}
export async function advanceCleanup(ctx, db, userId, key, operation) {
  if (
    operation.status === 'completed' ||
    operation.status === 'failed' ||
    operation.nextAttemptAt > Date.now()
  )
    return operation;
  const leaseToken = crypto.randomUUID();
  const leaseMs = 120000;
  if (
    typeof db.claimCloudDataRecord === 'function' &&
    !(await db.claimCloudDataRecord(
      userId,
      'operation',
      operation.id,
      leaseMs,
      leaseToken
    ))
  )
    return operation;
  const renewLease = async () => {
    if (
      !(await db.renewCloudDataRecordLease(
        userId,
        'operation',
        operation.id,
        leaseMs,
        leaseToken
      ))
    ) {
      throw cloudError(
        'CLOUD_LEASE_LOST',
        '清理处理权已交给另一个工作实例',
        409
      );
    }
  };
  try {
    operation = await readCloudRecord(
      db,
      userId,
      key,
      'operation',
      operation.id
    );
    if (operation.status === 'completed' || operation.status === 'failed')
      return operation;
    operation.status = 'running';
    if (operation.mode === 'retire-owner') {
      if (operation.fencedGeneration == null) {
        const state = await db.setCloudOwnerActive(
          userId,
          operation.owner,
          false,
          operation.ownerGeneration
        );
        operation.fencedGeneration = state.generation;
        await save(db, userId, key, 'operation', operation, { leaseToken });
      } else {
        const state = await db.getCloudOwner(userId, operation.owner);
        if (state.active || state.generation !== operation.fencedGeneration) {
          throw cloudError(
            'CLOUD_OWNER_CHANGED',
            '归属已变化，已停止旧清理操作',
            409
          );
        }
      }
      const inventory = await cloudInventory(ctx, db, userId, key);
      if (!inventory.complete)
        throw cloudError(
          'CLOUD_INVENTORY_INCOMPLETE',
          '无法确认待清理资源',
          503
        );
      const known = new Set(operation.knownResourceIds || []);
      operation.knownResourceVersions ||= {};
      operation.entries = inventory.entries.filter((entry) => {
        if (ownerEquals(entry.resource.owner, operation.owner)) return true;
        if (!known.has(entry.resource.id)) return false;
        if (
          entry.resource.owner ||
          operation.knownResourceVersions[entry.resource.id] !== entry.version
        ) {
          throw cloudError(
            'CLOUD_PLAN_CHANGED',
            '已识别资源的归属或内容发生变化，请重新预览',
            409
          );
        }
        return true;
      });
      for (const entry of operation.entries) {
        known.add(entry.resource.id);
        operation.knownResourceVersions[entry.resource.id] = entry.version;
      }
      operation.knownResourceIds = [...known];
      operation.cursor = 0;
      for (const count of operation.counts)
        count.remaining = operation.entries.filter(
          (entry) => entry.resource.type === count.type
        ).length;
      // Save identities before deleting tasks that may be the only owner clue
      // for legacy job inputs and outbox records.
      await save(db, userId, key, 'operation', operation, { leaseToken });
    }
    const beforeBatch = await cloudInventory(ctx, db, userId, key);
    if (!beforeBatch.complete)
      throw cloudError('CLOUD_INVENTORY_INCOMPLETE', '无法确认待清理资源', 503);
    const currentById = new Map(
      beforeBatch.entries.map((entry) => [entry.resource.id, entry])
    );
    const batch = operation.entries.slice(
      operation.cursor,
      operation.cursor + 25
    );
    for (const entry of batch) {
      await renewLease();
      const currentEntry = currentById.get(entry.resource.id);
      if (currentEntry && currentEntry.version !== entry.version) {
        throw cloudError(
          'CLOUD_PLAN_CHANGED',
          '资源在执行前变化，已停止清理',
          409
        );
      }
      const result = currentEntry
        ? await db.deleteCloudResourceRows(userId, [currentEntry.locator], {
            operationId: operation.id,
            leaseToken
          })
        : { changed: 0 };
      if (result.changed)
        throw cloudError(
          'CLOUD_PLAN_CHANGED',
          '资源在执行前变化，已停止清理',
          409
        );
      const count = operation.counts.find(
        (c) => c.type === entry.resource.type
      );
      count.deleted++;
      count.remaining = Math.max(0, count.remaining - 1);
      delete entry.locator;
      operation.cursor++;
      operation.updatedAt = Date.now();
      await save(db, userId, key, 'operation', operation, { leaseToken });
    }
    await renewLease();
    const current = await cloudInventory(ctx, db, userId, key);
    if (!current.complete)
      throw cloudError(
        'CLOUD_INVENTORY_INCOMPLETE',
        '清理后无法确认剩余数据',
        503
      );
    const selected = new Set(operation.entries.map((e) => e.resource.id));
    const remaining = current.entries.filter((e) =>
      operation.mode === 'retire-owner'
        ? ownerEquals(e.resource.owner, operation.owner) ||
          (operation.knownResourceIds || []).includes(e.resource.id)
        : selected.has(e.resource.id)
    );
    for (const count of operation.counts)
      count.remaining = remaining.filter(
        (e) => e.resource.type === count.type
      ).length;
    if (operation.mode === 'purge') {
      const processed = new Set(
        operation.entries
          .slice(0, operation.cursor)
          .map((entry) => entry.resource.id)
      );
      if (remaining.some((entry) => processed.has(entry.resource.id))) {
        throw cloudError(
          'CLOUD_PLAN_CHANGED',
          '已清理资源被重新创建，请重新预览',
          409
        );
      }
    }
    operation.status = remaining.length ? 'pending' : 'completed';
    if (operation.status === 'completed') {
      operation.entries = [];
      operation.knownResourceIds = [];
      operation.knownResourceVersions = {};
    }
    operation.errors = [];
    operation.attempts = 0;
  } catch (error) {
    if (error.code === 'CLOUD_LEASE_LOST') throw error;
    operation.attempts = (operation.attempts || 0) + 1;
    const terminal =
      ['CLOUD_PLAN_CHANGED', 'CLOUD_OWNER_CHANGED'].includes(error.code) ||
      operation.attempts >= 8;
    operation.status = terminal ? 'failed' : 'pending';
    operation.errors = [
      {
        code: error.code || 'CLOUD_CLEANUP_FAILED',
        message:
          error.code === 'CLOUD_PLAN_CHANGED'
            ? error.message
            : '云端清理未完成，将按服务端记录重试。'
      }
    ];
    operation.nextAttemptAt =
      Date.now() + Math.min(3600000, 30000 * 2 ** operation.attempts);
    if (terminal)
      for (const count of operation.counts) count.failed = count.remaining;
  } finally {
    operation.updatedAt = Date.now();
    await save(db, userId, key, 'operation', operation, { leaseToken });
    if (typeof db.releaseCloudDataRecord === 'function')
      await db.releaseCloudDataRecord(
        userId,
        'operation',
        operation.id,
        leaseToken
      );
  }
  return operation;
}
export async function resumeCloudDataCleanups(ctx) {
  const db = ctx.db;
  if (!db?.cloudDataManagement) return;
  const rows = await db.listCloudDataRecordsAcrossUsers('operation');
  await db.cleanupCloudDataRecords('inventory', Date.now() - 3600000);
  await db.cleanupCloudDataRecords('plan', Date.now() - 3600000);
  await db.cleanupCloudResourceMetadata();
  let processed = 0;
  for (const row of rows) {
    try {
      const key = await deriveUserEncryptionKey(row.userId, ctx.masterKey);
      const operation = JSON.parse(await decryptFromStorage(row.data, key));
      if (
        ['completed', 'failed'].includes(operation.status) &&
        operation.updatedAt < Date.now() - 30 * 86400000
      ) {
        await db.deleteCloudDataRecord(row.userId, 'operation', operation.id);
        continue;
      }
      if (['pending', 'running'].includes(operation.status)) {
        await advanceCleanup(ctx, db, row.userId, key, operation);
        if (++processed >= 100) break;
      }
    } catch {
      // Never log encrypted payloads, credentials or user-owned labels.
      console.warn('[amsg] A cloud cleanup operation could not be resumed');
    }
  }
}
