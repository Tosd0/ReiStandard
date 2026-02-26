import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createReiServer,
  deriveUserEncryptionKey,
  decryptFromStorage,
  encryptForStorage,
  decryptPayload,
  validateScheduleMessagePayload,
  isValidISO8601,
  isValidUrl,
  isValidUUID,
  isValidUUIDv4
} from '../src/server/index.js';
import { encryptPayload } from '../src/server/lib/encryption.js';

const TEST_USER_ID = '550e8400-e29b-41d4-a716-446655440000';

function createInMemoryBlobStore() {
  const map = new Map();
  return {
    async get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async set(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    }
  };
}

function createFakeAdapter() {
  let idCounter = 1;
  const tasks = [];

  return {
    async initSchema() {
      return {
        columnsCreated: 9,
        indexesCreated: 5,
        indexesFailed: 0,
        columns: [
          { name: 'id' },
          { name: 'user_id' },
          { name: 'uuid' },
          { name: 'encrypted_payload' },
          { name: 'message_type' },
          { name: 'next_send_at' },
          { name: 'status' },
          { name: 'retry_count' },
          { name: 'updated_at' }
        ],
        indexes: []
      };
    },

    async createTask(params) {
      const now = new Date().toISOString();
      const row = {
        id: idCounter++,
        user_id: params.user_id,
        uuid: params.uuid,
        encrypted_payload: params.encrypted_payload,
        message_type: params.message_type,
        next_send_at: params.next_send_at,
        status: 'pending',
        retry_count: 0,
        created_at: now,
        updated_at: now
      };
      tasks.push(row);

      return {
        id: row.id,
        uuid: row.uuid,
        next_send_at: row.next_send_at,
        status: row.status,
        created_at: row.created_at
      };
    },

    async getTaskByUuid(uuid, userId) {
      return tasks.find(task => task.uuid === uuid && task.user_id === userId && task.status === 'pending') || null;
    },

    async getTaskByUuidOnly(uuid) {
      return tasks.find(task => task.uuid === uuid && task.status === 'pending') || null;
    },

    async updateTaskById(taskId, updates) {
      const target = tasks.find(task => task.id === taskId);
      if (!target) return null;
      Object.assign(target, updates, { updated_at: new Date().toISOString() });
      return target;
    },

    async updateTaskByUuid(uuid, userId, encryptedPayload, extraFields) {
      const target = tasks.find(task => task.uuid === uuid && task.user_id === userId && task.status === 'pending');
      if (!target) return null;
      target.encrypted_payload = encryptedPayload;
      if (extraFields) Object.assign(target, extraFields);
      target.updated_at = new Date().toISOString();
      return { uuid: target.uuid, updated_at: target.updated_at };
    },

    async deleteTaskById(taskId) {
      const index = tasks.findIndex(task => task.id === taskId);
      if (index === -1) return false;
      tasks.splice(index, 1);
      return true;
    },

    async deleteTaskByUuid(uuid, userId) {
      const index = tasks.findIndex(task => task.uuid === uuid && task.user_id === userId);
      if (index === -1) return false;
      tasks.splice(index, 1);
      return true;
    },

    async getPendingTasks(limit = 50) {
      const now = Date.now();
      return tasks
        .filter(task => task.status === 'pending' && new Date(task.next_send_at).getTime() <= now)
        .slice(0, limit);
    },

    async listTasks(userId, opts = {}) {
      const status = opts.status || 'all';
      const limit = opts.limit || 20;
      const offset = opts.offset || 0;

      const filtered = tasks.filter(task => {
        if (task.user_id !== userId) return false;
        if (status !== 'all' && task.status !== status) return false;
        return true;
      });

      const paged = filtered.slice(offset, offset + limit);
      return { tasks: paged, total: filtered.length };
    },

    async cleanupOldTasks() {
      return 0;
    },

    async getTaskStatus(uuid, userId) {
      const target = tasks.find(task => task.uuid === uuid && task.user_id === userId);
      return target ? target.status : null;
    }
  };
}

function buildServer() {
  const fakeAdapter = createFakeAdapter();

  return createReiServer({
    vapid: {
      email: 'vapid@example.com',
      publicKey: 'BDhAMffLOGHAGMeiU10WAui8vJ75OLtytejvWSTY26CtUd0L4QBlg7zC_EBD-w-xEPSdWxf2WCdBVGySkINp-7c',
      privateKey: '3Es187YegZBYEbLax2xJsIL_mhIRutxMeRab3OMOHII'
    },
    tenant: {
      blobNamespace: 'test-namespace',
      kek: 'kek-secret',
      tokenSigningKey: 'tenant-signing-secret',
      initSecret: 'init-secret',
      publicBaseUrl: 'https://example.com',
      adapterFactory: async () => fakeAdapter
    }
  });
}

// ─── Encryption tests ──────────────────────────────────────────

describe('encryption utilities', () => {
  const masterKey = 'a'.repeat(64);
  const userId = 'test-user';

  it('deriveUserEncryptionKey returns a 64-char hex string', () => {
    const key = deriveUserEncryptionKey(userId, masterKey);
    assert.equal(key.length, 64);
    assert.match(key, /^[0-9a-f]{64}$/);
  });

  it('encryptForStorage / decryptFromStorage round-trips', () => {
    const key = deriveUserEncryptionKey(userId, masterKey);
    const original = JSON.stringify({ hello: 'world', num: 42 });
    const encrypted = encryptForStorage(original, key);
    const decrypted = decryptFromStorage(encrypted, key);
    assert.equal(decrypted, original);
  });

  it('decryptFromStorage fails with wrong key', () => {
    const key = deriveUserEncryptionKey(userId, masterKey);
    const wrongKey = deriveUserEncryptionKey('other-user', masterKey);
    const encrypted = encryptForStorage('secret', key);
    assert.throws(() => decryptFromStorage(encrypted, wrongKey));
  });
});

// ─── Validation tests ──────────────────────────────────────────

describe('validation utilities', () => {
  it('isValidISO8601 accepts valid dates', () => {
    assert.equal(isValidISO8601('2030-01-01T00:00:00Z'), true);
    assert.equal(isValidISO8601('not a date'), false);
  });

  it('isValidUrl', () => {
    assert.equal(isValidUrl('https://example.com'), true);
    assert.equal(isValidUrl('ftp://x.com'), true);
    assert.equal(isValidUrl('not-a-url'), false);
  });

  it('isValidUUID', () => {
    assert.equal(isValidUUID('550e8400-e29b-41d4-a716-446655440000'), true);
    assert.equal(isValidUUID('not-a-uuid'), false);
  });

  it('isValidUUIDv4', () => {
    assert.equal(isValidUUIDv4(TEST_USER_ID), true);
    assert.equal(isValidUUIDv4('550e8400-e29b-11d4-a716-446655440000'), false);
  });

  it('validateScheduleMessagePayload accepts a valid fixed payload', () => {
    const result = validateScheduleMessagePayload({
      contactName: 'Alice',
      messageType: 'fixed',
      firstSendTime: new Date(Date.now() + 60000).toISOString(),
      pushSubscription: { endpoint: 'https://push.example.com' },
      userMessage: 'Hello!'
    });
    assert.equal(result.valid, true);
  });

  it('validateScheduleMessagePayload accepts optional maxTokens', () => {
    const result = validateScheduleMessagePayload({
      contactName: 'Alice',
      messageType: 'prompted',
      firstSendTime: new Date(Date.now() + 60000).toISOString(),
      pushSubscription: { endpoint: 'https://push.example.com' },
      completePrompt: 'Say hello',
      apiUrl: 'https://api.example.com/v1/chat/completions',
      apiKey: 'secret',
      primaryModel: 'model-x',
      maxTokens: 128
    });
    assert.equal(result.valid, true);
  });

  it('validateScheduleMessagePayload rejects invalid maxTokens', () => {
    const result = validateScheduleMessagePayload({
      contactName: 'Alice',
      messageType: 'prompted',
      firstSendTime: new Date(Date.now() + 60000).toISOString(),
      pushSubscription: { endpoint: 'https://push.example.com' },
      completePrompt: 'Say hello',
      apiUrl: 'https://api.example.com/v1/chat/completions',
      apiKey: 'secret',
      primaryModel: 'model-x',
      maxTokens: 0
    });
    assert.equal(result.valid, false);
    assert.equal(result.errorCode, 'INVALID_PARAMETERS');
    assert.deepEqual(result.details?.invalidFields, ['maxTokens']);
  });
});

// ─── Server tests ──────────────────────────────────────────────

describe('createReiServer v2.0.1 flow', () => {
  let server;

  beforeEach(async () => {
    globalThis.__REI_BLOB_STORE__ = createInMemoryBlobStore();
    server = await buildServer();
  });

  it('returns v2.0.1 handlers', async () => {
    assert.equal(typeof server.handlers.initTenant.POST, 'function');
    assert.equal(typeof server.handlers.getUserKey.GET, 'function');
    assert.equal(typeof server.handlers.scheduleMessage.POST, 'function');
    assert.equal(typeof server.handlers.sendNotifications.POST, 'function');
    assert.equal(typeof server.handlers.updateMessage.PUT, 'function');
    assert.equal(typeof server.handlers.cancelMessage.DELETE, 'function');
    assert.equal(typeof server.handlers.messages.GET, 'function');
  });

  it('initTenant allows requests without init secret when initSecret is not configured', async () => {
    const noSecretServer = await createReiServer({
      vapid: {
        email: 'vapid@example.com',
        publicKey: 'BDhAMffLOGHAGMeiU10WAui8vJ75OLtytejvWSTY26CtUd0L4QBlg7zC_EBD-w-xEPSdWxf2WCdBVGySkINp-7c',
        privateKey: '3Es187YegZBYEbLax2xJsIL_mhIRutxMeRab3OMOHII'
      },
      tenant: {
        blobNamespace: 'test-namespace-optional-init-secret',
        kek: 'kek-secret',
        tokenSigningKey: 'tenant-signing-secret',
        adapterFactory: async () => createFakeAdapter()
      }
    });

    const result = await noSecretServer.handlers.initTenant.POST(
      {},
      { driver: 'neon', databaseUrl: 'postgres://tenant-db' }
    );

    assert.equal(result.status, 201);
    assert.equal(result.body.success, true);
  });

  it('initTenant rejects invalid init auth when initSecret is configured', async () => {
    const result = await server.handlers.initTenant.POST(
      { 'x-init-secret': 'wrong' },
      { driver: 'neon', databaseUrl: 'postgres://tenant-db' }
    );

    assert.equal(result.status, 401);
    assert.equal(result.body.error.code, 'INVALID_INIT_AUTH');
  });

  it('initTenant creates tenant and issues tokens', async () => {
    const result = await server.handlers.initTenant.POST(
      { 'x-init-secret': 'init-secret' },
      { driver: 'neon', databaseUrl: 'postgres://tenant-db' }
    );

    assert.equal(result.status, 201);
    assert.equal(result.body.success, true);
    assert.equal(typeof result.body.data.tenantToken, 'string');
    assert.equal(typeof result.body.data.cronToken, 'string');
    assert.equal(typeof result.body.data.masterKeyFingerprint, 'string');
    assert.ok(result.body.data.cronWebhookUrl.includes('/api/v1/send-notifications?token='));
  });

  it('initTenant returns conflict for duplicated tenantId', async () => {
    const tenantId = '7f1d9cc2-cd93-4466-9533-3fcf42374af4';

    const first = await server.handlers.initTenant.POST(
      { 'x-init-secret': 'init-secret' },
      { tenantId, driver: 'neon', databaseUrl: 'postgres://tenant-db' }
    );
    assert.equal(first.status, 201);

    const duplicated = await server.handlers.initTenant.POST(
      { 'x-init-secret': 'init-secret' },
      { tenantId, driver: 'neon', databaseUrl: 'postgres://tenant-db' }
    );
    assert.equal(duplicated.status, 409);
    assert.equal(duplicated.body.error.code, 'TENANT_ALREADY_INITIALIZED');
  });

  it('protected endpoint rejects missing tenant token', async () => {
    const result = await server.handlers.getUserKey.GET('/api/v1/get-user-key', {
      'x-user-id': TEST_USER_ID
    });

    assert.equal(result.status, 401);
    assert.equal(result.body.error.code, 'INVALID_TENANT_AUTH');
  });

  it('getUserKey returns key with valid tenant token', async () => {
    const initResult = await server.handlers.initTenant.POST(
      { 'x-init-secret': 'init-secret' },
      { driver: 'neon', databaseUrl: 'postgres://tenant-db' }
    );

    const tenantToken = initResult.body.data.tenantToken;

    const result = await server.handlers.getUserKey.GET('/api/v1/get-user-key', {
      authorization: `Bearer ${tenantToken}`,
      'x-user-id': TEST_USER_ID
    });

    assert.equal(result.status, 200);
    assert.equal(typeof result.body.data.userKey, 'string');
    assert.match(result.body.data.userKey, /^[0-9a-f]{64}$/);
  });

  it('scheduleMessage creates task with tenant token', async () => {
    const initResult = await server.handlers.initTenant.POST(
      { 'x-init-secret': 'init-secret' },
      { driver: 'neon', databaseUrl: 'postgres://tenant-db' }
    );

    const tenantToken = initResult.body.data.tenantToken;

    const keyResult = await server.handlers.getUserKey.GET('/api/v1/get-user-key', {
      authorization: `Bearer ${tenantToken}`,
      'x-user-id': TEST_USER_ID
    });

    const encryptedBody = encryptPayload(
      {
        contactName: 'Alice',
        messageType: 'fixed',
        firstSendTime: new Date(Date.now() + 60000).toISOString(),
        pushSubscription: { endpoint: 'https://push.example.com' },
        userMessage: 'hello'
      },
      keyResult.body.data.userKey
    );

    const result = await server.handlers.scheduleMessage.POST(
      {
        authorization: `Bearer ${tenantToken}`,
        'x-user-id': TEST_USER_ID,
        'x-payload-encrypted': 'true',
        'x-encryption-version': '1'
      },
      encryptedBody
    );

    assert.equal(result.status, 201);
    assert.equal(result.body.success, true);
    assert.equal(typeof result.body.data.uuid, 'string');
  });

  it('sendNotifications accepts cron token from query', async () => {
    const initResult = await server.handlers.initTenant.POST(
      { 'x-init-secret': 'init-secret' },
      { driver: 'neon', databaseUrl: 'postgres://tenant-db' }
    );

    const cronToken = initResult.body.data.cronToken;
    const result = await server.handlers.sendNotifications.POST(
      `https://example.com/api/v1/send-notifications?token=${cronToken}`,
      {}
    );

    assert.equal(result.status, 200);
    assert.equal(result.body.success, true);
  });

  it('tenant token cannot call sendNotifications', async () => {
    const initResult = await server.handlers.initTenant.POST(
      { 'x-init-secret': 'init-secret' },
      { driver: 'neon', databaseUrl: 'postgres://tenant-db' }
    );

    const tenantToken = initResult.body.data.tenantToken;
    const result = await server.handlers.sendNotifications.POST('https://example.com/api/v1/send-notifications', {
      authorization: `Bearer ${tenantToken}`
    });

    assert.equal(result.status, 401);
    assert.equal(result.body.error.code, 'INVALID_TENANT_AUTH');
  });

  it('cron token cannot call tenant-only endpoint', async () => {
    const initResult = await server.handlers.initTenant.POST(
      { 'x-init-secret': 'init-secret' },
      { driver: 'neon', databaseUrl: 'postgres://tenant-db' }
    );

    const cronToken = initResult.body.data.cronToken;
    const result = await server.handlers.getUserKey.GET('/api/v1/get-user-key', {
      authorization: `Bearer ${cronToken}`,
      'x-user-id': TEST_USER_ID
    });

    assert.equal(result.status, 401);
    assert.equal(result.body.error.code, 'INVALID_TENANT_AUTH');
  });
});
