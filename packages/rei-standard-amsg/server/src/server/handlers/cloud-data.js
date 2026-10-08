import {
  deriveUserEncryptionKey,
  decryptPayload,
  encryptPayload,
  encryptForStorage,
  decryptFromStorage
} from '../lib/encryption.js';
import {
  getHeader,
  parseEncryptedBody,
  requireUserId
} from '../lib/request.js';
import {
  CLOUD_RESOURCE_TYPES,
  cloudError,
  validCloudOwner,
  cloudInventory,
  makeCleanupPlan,
  startCleanup,
  readCloudRecord,
  publicOperation
} from '../lib/cloud-data-cleanup.js';

function inventorySummary(inventory) {
  const resources = inventory.entries.map(entry => entry.resource);
  return {
    total: resources.length,
    counts: CLOUD_RESOURCE_TYPES.map(type => ({
      type,
      count: resources.filter(resource => resource.type === type).length,
      byteSize: resources.filter(resource => resource.type === type).reduce((sum,resource) => sum + (resource.byteSize || 0),0)
    })),
    complete: inventory.complete,
    gaps: inventory.gaps
  };
}

export function createCloudDataHandler(ctx) {
  async function run(url, headers, body, method) {
    const tenant = await ctx.tenantManager.resolveTenant(headers);
    if (!tenant.ok) return tenant.error;
    const gate = requireUserId(headers);
    if (gate.error) return gate.error;
    const { db, masterKey } = tenant.context;
    const { userId } = gate;
    if (!db.cloudDataManagement)
      return {
        status: 501,
        body: {
          success: false,
          error: {
            code: 'CLOUD_DATA_NOT_SUPPORTED',
            message: '当前适配器不支持完整云端管理'
          }
        }
      };
    const key = await deriveUserEncryptionKey(userId, masterKey);
    try {
      const parsedUrl = new URL(url, 'https://cloud.invalid');
      const path = parsedUrl.pathname;
      const params = parsedUrl.searchParams;
      let input;
      if (method === 'POST') {
        if (
          getHeader(headers, 'x-payload-encrypted') !== 'true' ||
          getHeader(headers, 'x-encryption-version') !== '1'
        )
          throw cloudError('ENCRYPTION_REQUIRED', '请求必须使用版本 1 加密');
        const parsed = parseEncryptedBody(body);
        if (!parsed.ok) throw cloudError('INVALID_PAYLOAD', '请求格式无效');
        try {
          input = await decryptPayload(parsed.data, key);
        } catch {
          throw cloudError('DECRYPTION_FAILED', '请求解密失败');
        }
        if (!input || typeof input !== 'object' || Array.isArray(input))
          throw cloudError('INVALID_PAYLOAD', '请求格式无效');
      }
      let data;
      if (
        method === 'GET' &&
        (path.endsWith('/summary') || path.endsWith('/resources'))
      ) {
        const ownerType = params.get('ownerType'),
          ownerId = params.get('ownerId'),
          type = params.get('type');
        if (
          Boolean(ownerType) !== Boolean(ownerId) ||
          (type && !CLOUD_RESOURCE_TYPES.includes(type))
        )
          throw cloudError('INVALID_CLOUD_FILTER', '资源筛选无效');
        const filter = { ownerType, ownerId, type };
        if (path.endsWith('/summary')) {
          const inventory = await cloudInventory(ctx, db, userId, key);
          data = inventorySummary(inventory);
        } else {
          const limit = Number(params.get('limit') || 50);
          if (!Number.isInteger(limit) || limit < 1 || limit > 200)
            throw cloudError('INVALID_CLOUD_LIMIT', '每页数量必须为 1–200');
          let snapshot,
            offset = 0;
          const cursor = params.get('cursor');
          if (cursor) {
            const match = /^([0-9a-f-]{36}):(\d+)$/.exec(cursor);
            if (!match)
              throw cloudError('INVALID_CLOUD_CURSOR', '分页游标无效');
            snapshot = await readCloudRecord(
              db,
              userId,
              key,
              'inventory',
              match[1]
            );
            offset = Number(match[2]);
            if (
              !Number.isSafeInteger(offset) ||
              offset < 0 ||
              offset > snapshot.resources.length
            )
              throw cloudError('INVALID_CLOUD_CURSOR', '分页游标无效');
            if (
              snapshot.expiresAt < Date.now() ||
              JSON.stringify(snapshot.filter) !== JSON.stringify(filter)
            )
              throw cloudError(
                'CLOUD_CURSOR_EXPIRED',
                '分页已过期或筛选变化',
                409
              );
          } else {
            const inventory = await cloudInventory(ctx, db, userId, key);
            snapshot = {
              id: crypto.randomUUID(),
              filter,
              summary: inventorySummary(inventory),
              expiresAt: Date.now() + 15 * 60 * 1000,
              resources: inventory.entries
                .map((e) => e.resource)
                .filter(
                  (r) =>
                    (!type || r.type === type) &&
                    (!ownerId ||
                      (r.owner?.type === ownerType && r.owner.id === ownerId))
                ),
              complete: inventory.complete,
              gaps: inventory.gaps
            };
            await db.putCloudDataRecord(
              userId,
              'inventory',
              snapshot.id,
              await encryptForStorage(JSON.stringify(snapshot), key)
            );
          }
          data = {
            resources: snapshot.resources.slice(offset, offset + limit),
            ...(snapshot.summary ? { summary: snapshot.summary } : {}),
            nextCursor:
              offset + limit < snapshot.resources.length
                ? `${snapshot.id}:${offset + limit}`
                : null,
            complete: snapshot.complete,
            gaps: snapshot.gaps
          };
        }
      } else if (method === 'POST' && path.endsWith('/cleanup-plans'))
        data = await makeCleanupPlan(ctx, db, userId, key, input);
      else if (method === 'POST' && path.endsWith('/cleanup-operations'))
        data = await startCleanup(ctx, db, userId, key, input);
      else if (method === 'GET' && path.endsWith('/cleanup-operations')) {
        const records = await db.listCloudDataRecords(userId, 'operation');
        const operations = [];
        const gaps = [];
        for (const row of records) {
          try {
            operations.push(
              publicOperation(
                JSON.parse(await decryptFromStorage(row.data, key))
              )
            );
          } catch {
            gaps.push({
              source: 'operation',
              code: 'UNREADABLE_OPERATION',
              message: `无法读取操作 ${row.id}`
            });
          }
        }
        data = {
          operations: operations.sort((a, b) => b.createdAt - a.createdAt),
          complete: gaps.length === 0,
          gaps
        };
      } else if (method === 'GET' && path.includes('/cleanup-operations/'))
        data = publicOperation(
          await readCloudRecord(
            db,
            userId,
            key,
            'operation',
            path.split('/').pop()
          )
        );
      else if (method === 'GET' && path.endsWith('/owners')) {
        const owners = await db.listCloudOwners(userId);
        data = {
          owners: owners.map((state) => ({
            owner: state.owner,
            retired: !state.active,
            generation: state.generation,
            updatedAt: state.updatedAt,
            complete: true,
            gaps: []
          })),
          complete: true,
          gaps: []
        };
      } else if (path.endsWith('/owner')) {
        const owner =
          method === 'POST'
            ? input.owner
            : { type: params.get('ownerType'), id: params.get('ownerId') };
        if (!validCloudOwner(owner))
          throw cloudError('INVALID_CLOUD_OWNER', '归属格式无效');
        if (method === 'POST') {
          const beforeRestore = await db.getCloudOwner(userId, owner);
          if (input.action !== 'restore')
            throw cloudError('INVALID_CLOUD_OWNER_ACTION', '归属操作无效');
          const rows = await db.listCloudDataRecords(userId, 'operation');
          for (const row of rows) {
            const op = JSON.parse(await decryptFromStorage(row.data, key));
            if (
              op.mode === 'retire-owner' &&
              op.owner?.type === owner.type &&
              op.owner?.id === owner.id &&
              ['pending', 'running'].includes(op.status)
            )
              throw cloudError(
                'CLOUD_CLEANUP_IN_PROGRESS',
                '清理完成后才能重新启用',
                409
              );
          }
          if (!beforeRestore.active)
            await db.setCloudOwnerActive(
              userId,
              owner,
              true,
              beforeRestore.generation
            );
        }
        const state = await db.getCloudOwner(userId, owner);
        data = {
          owner,
          retired: !state.active,
          generation: state.generation,
          updatedAt: state.updatedAt ?? null,
          complete: true,
          gaps: []
        };
      } else throw cloudError('NOT_FOUND', '云端管理入口不存在', 404);
      return {
        status: 200,
        body: {
          success: true,
          encrypted: true,
          version: 1,
          data: await encryptPayload(data, key)
        }
      };
    } catch (error) {
      return {
        status: error.status || 500,
        body: {
          success: false,
          error: {
            code: error.code || 'CLOUD_DATA_FAILED',
            message: error.status
              ? error.message
              : '云端管理请求失败；未能确认操作结果。'
          }
        }
      };
    }
  }
  return {
    GET: (url, headers) => run(url, headers, null, 'GET'),
    POST: (url, headers, body) => run(url, headers, body, 'POST')
  };
}
