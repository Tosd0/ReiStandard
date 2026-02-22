import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import webpush from 'web-push';
import {
  createReiServer,
  createAdapter,
  deriveUserEncryptionKey,
  encryptForStorage,
  decryptFromStorage,
  decryptPayload,
  validateScheduleMessagePayload,
  isValidISO8601,
  isValidUrl,
  isValidUUID
} from '../src/server/index.js';
import { processMessagesByUuid } from '../src/server/lib/message-processor.js';
import { createSendNotificationsHandler } from '../src/server/handlers/send-notifications.js';

function encryptClientPayload(payload, userId, masterKey) {
  const userKey = deriveUserEncryptionKey(userId, masterKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(userKey, 'hex'), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    encryptedData: encrypted.toString('base64')
  };
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

    // format: iv:authTag:data
    const parts = encrypted.split(':');
    assert.equal(parts.length, 3);

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

  it('validateScheduleMessagePayload rejects missing contactName', () => {
    const result = validateScheduleMessagePayload({});
    assert.equal(result.valid, false);
    assert.equal(result.errorCode, 'INVALID_PARAMETERS');
  });

  it('validateScheduleMessagePayload rejects invalid messageType', () => {
    const result = validateScheduleMessagePayload({ contactName: 'A', messageType: 'bad' });
    assert.equal(result.valid, false);
    assert.equal(result.errorCode, 'INVALID_MESSAGE_TYPE');
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
});

// ─── Adapter factory tests ─────────────────────────────────────

describe('createAdapter', () => {
  it('throws when no config', async () => {
    await assert.rejects(() => createAdapter(), /driver.*required/i);
  });

  it('throws when driver is missing', async () => {
    await assert.rejects(() => createAdapter({}), /driver.*required/i);
  });

  it('throws when connectionString is missing', async () => {
    await assert.rejects(() => createAdapter({ driver: 'neon' }), /connectionString.*required/i);
  });

  it('throws for unsupported driver', async () => {
    await assert.rejects(() => createAdapter({ driver: 'mysql', connectionString: 'x' }), /Unsupported driver/i);
  });
});

// ─── createReiServer tests ─────────────────────────────────────

describe('createReiServer', () => {
  it('throws without config', async () => {
    await assert.rejects(() => createReiServer(), /config is required/i);
  });

  it('throws without encryptionKey', async () => {
    await assert.rejects(
      () => createReiServer({ db: { driver: 'neon', connectionString: 'postgres://x' } }),
      /encryptionKey.*required/i
    );
  });

  it('returns handlers and adapter when configured with neon', async () => {
    const server = await createReiServer({
      db: { driver: 'neon', connectionString: 'postgres://x' },
      encryptionKey: 'a'.repeat(64)
    });

    assert.ok(server.handlers);
    assert.ok(server.adapter);
    assert.equal(typeof server.handlers.initDatabase.GET, 'function');
    assert.equal(typeof server.handlers.initDatabase.POST, 'function');
    assert.equal(typeof server.handlers.getMasterKey.GET, 'function');
    assert.equal(typeof server.handlers.scheduleMessage.POST, 'function');
    assert.equal(typeof server.handlers.sendNotifications.POST, 'function');
    assert.equal(typeof server.handlers.updateMessage.PUT, 'function');
    assert.equal(typeof server.handlers.cancelMessage.DELETE, 'function');
    assert.equal(typeof server.handlers.messages.GET, 'function');
  });

  it('keeps existing mailto: prefix when configuring VAPID subject', async () => {
    const vapidKeys = webpush.generateVAPIDKeys();
    const originalSetVapidDetails = webpush.setVapidDetails;
    let capturedSubject = '';

    webpush.setVapidDetails = (subject) => {
      capturedSubject = subject;
    };

    try {
      await createReiServer({
        db: { driver: 'neon', connectionString: 'postgres://x' },
        encryptionKey: 'a'.repeat(64),
        vapid: {
          email: 'mailto:test@example.com',
          publicKey: vapidKeys.publicKey,
          privateKey: vapidKeys.privateKey
        }
      });

      assert.equal(capturedSubject, 'mailto:test@example.com');
    } finally {
      webpush.setVapidDetails = originalSetVapidDetails;
    }
  });

  it('adds mailto: prefix when VAPID email has no scheme', async () => {
    const vapidKeys = webpush.generateVAPIDKeys();
    const originalSetVapidDetails = webpush.setVapidDetails;
    let capturedSubject = '';

    webpush.setVapidDetails = (subject) => {
      capturedSubject = subject;
    };

    try {
      await createReiServer({
        db: { driver: 'neon', connectionString: 'postgres://x' },
        encryptionKey: 'a'.repeat(64),
        vapid: {
          email: 'test@example.com',
          publicKey: vapidKeys.publicKey,
          privateKey: vapidKeys.privateKey
        }
      });

      assert.equal(capturedSubject, 'mailto:test@example.com');
    } finally {
      webpush.setVapidDetails = originalSetVapidDetails;
    }
  });
});

// ─── Handler unit tests (no real DB) ───────────────────────────

describe('getMasterKey handler', () => {
  let server;

  beforeEach(async () => {
    server = await createReiServer({
      db: { driver: 'neon', connectionString: 'postgres://x' },
      encryptionKey: 'b'.repeat(64)
    });
  });

  it('returns 400 when X-User-Id is missing', async () => {
    const result = await server.handlers.getMasterKey.GET({});
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'USER_ID_REQUIRED');
  });

  it('returns masterKey when userId is present', async () => {
    const result = await server.handlers.getMasterKey.GET({ 'x-user-id': 'u1' });
    assert.equal(result.status, 200);
    assert.equal(result.body.data.masterKey, 'b'.repeat(64));
    assert.equal(result.body.data.version, 1);
  });
});

describe('initDatabase handler', () => {
  it('returns 500 when initSecret is not configured', async () => {
    const server = await createReiServer({
      db: { driver: 'neon', connectionString: 'postgres://x' },
      encryptionKey: 'a'.repeat(64)
    });

    const result = await server.handlers.initDatabase.GET({});
    assert.equal(result.status, 500);
    assert.equal(result.body.error.code, 'INIT_SECRET_MISSING');
  });

  it('returns 500 on POST when initSecret is not configured', async () => {
    const server = await createReiServer({
      db: { driver: 'neon', connectionString: 'postgres://x' },
      encryptionKey: 'a'.repeat(64)
    });

    const result = await server.handlers.initDatabase.POST({}, '{}');
    assert.equal(result.status, 500);
    assert.equal(result.body.error.code, 'INIT_SECRET_MISSING');
  });

  it('returns 401 when authorization header is wrong', async () => {
    const server = await createReiServer({
      db: { driver: 'neon', connectionString: 'postgres://x' },
      encryptionKey: 'a'.repeat(64),
      initSecret: 'my-secret'
    });

    const result = await server.handlers.initDatabase.GET({ authorization: 'Bearer wrong' });
    assert.equal(result.status, 401);
    assert.equal(result.body.error.code, 'UNAUTHORIZED');
  });

  it('returns 400 on POST when body is malformed JSON', async () => {
    const server = await createReiServer({
      db: { driver: 'neon', connectionString: 'postgres://x' },
      encryptionKey: 'a'.repeat(64),
      initSecret: 'my-secret'
    });

    const result = await server.handlers.initDatabase.POST(
      { authorization: 'Bearer my-secret' },
      '{not valid json}'
    );
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'INVALID_JSON');
  });

  it('returns 400 on POST when body is not an object', async () => {
    const server = await createReiServer({
      db: { driver: 'neon', connectionString: 'postgres://x' },
      encryptionKey: 'a'.repeat(64),
      initSecret: 'my-secret'
    });

    const result = await server.handlers.initDatabase.POST(
      { authorization: 'Bearer my-secret' },
      null
    );
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'INVALID_REQUEST_BODY');
  });
});

describe('messages handler validation', () => {
  let server;

  beforeEach(async () => {
    server = await createReiServer({
      db: { driver: 'neon', connectionString: 'postgres://x' },
      encryptionKey: 'a'.repeat(64)
    });
  });

  it('returns 400 for invalid limit', async () => {
    const result = await server.handlers.messages.GET(
      '/messages?limit=abc',
      { 'x-user-id': 'u1' }
    );
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'INVALID_PARAMETERS');
  });

  it('returns 400 for negative offset', async () => {
    const result = await server.handlers.messages.GET(
      '/messages?offset=-5',
      { 'x-user-id': 'u1' }
    );
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'INVALID_PARAMETERS');
  });

  it('returns 400 for zero limit', async () => {
    const result = await server.handlers.messages.GET(
      '/messages?limit=0',
      { 'x-user-id': 'u1' }
    );
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'INVALID_PARAMETERS');
  });

  it('returns encrypted payload for successful list query', async () => {
    const userKey = deriveUserEncryptionKey('u1', 'a'.repeat(64));
    const encryptedPayload = encryptForStorage(
      JSON.stringify({
        contactName: 'Alice',
        messageSubtype: 'chat',
        recurrenceType: 'none'
      }),
      userKey
    );

    server.adapter.listTasks = async () => ({
      tasks: [
        {
          id: 1,
          uuid: '550e8400-e29b-41d4-a716-446655440000',
          encrypted_payload: encryptedPayload,
          message_type: 'fixed',
          next_send_at: '2030-01-01T00:00:00.000Z',
          status: 'pending',
          retry_count: 0,
          created_at: '2030-01-01T00:00:00.000Z',
          updated_at: '2030-01-01T00:00:00.000Z'
        }
      ],
      total: 1
    });

    const result = await server.handlers.messages.GET('/messages', { 'x-user-id': 'u1' });
    assert.equal(result.status, 200);
    assert.equal(result.body.success, true);
    assert.equal(result.body.encrypted, true);
    assert.equal(result.body.version, 1);

    const decrypted = decryptPayload(result.body.data, userKey);
    assert.equal(Array.isArray(decrypted.tasks), true);
    assert.equal(decrypted.tasks.length, 1);
    assert.equal(decrypted.tasks[0].contactName, 'Alice');
    assert.equal(decrypted.pagination.total, 1);
  });
});

describe('scheduleMessage handler', () => {
  const masterKey = 'c'.repeat(64);

  it('returns 400 when encrypted body is missing', async () => {
    const server = await createReiServer({
      db: { driver: 'neon', connectionString: 'postgres://x' },
      encryptionKey: masterKey
    });

    const result = await server.handlers.scheduleMessage.POST(
      {
        'x-user-id': 'u1',
        'x-payload-encrypted': 'true',
        'x-encryption-version': '1'
      },
      undefined
    );

    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'INVALID_ENCRYPTED_PAYLOAD');
  });

  it('returns 409 when uuid already exists', async () => {
    const server = await createReiServer({
      db: { driver: 'neon', connectionString: 'postgres://x' },
      encryptionKey: masterKey
    });

    server.adapter.createTask = async () => {
      const duplicateError = new Error('duplicate key value violates unique constraint "uidx_uuid"');
      duplicateError.code = '23505';
      throw duplicateError;
    };

    const encryptedBody = encryptClientPayload(
      {
        uuid: '550e8400-e29b-41d4-a716-446655440000',
        contactName: 'Alice',
        messageType: 'fixed',
        firstSendTime: new Date(Date.now() + 60_000).toISOString(),
        pushSubscription: { endpoint: 'https://push.example.com' },
        userMessage: 'hello'
      },
      'u1',
      masterKey
    );

    const result = await server.handlers.scheduleMessage.POST(
      {
        'x-user-id': 'u1',
        'x-payload-encrypted': 'true',
        'x-encryption-version': '1'
      },
      encryptedBody
    );

    assert.equal(result.status, 409);
    assert.equal(result.body.error.code, 'TASK_UUID_CONFLICT');
  });
});

describe('updateMessage handler', () => {
  let server;

  beforeEach(async () => {
    server = await createReiServer({
      db: { driver: 'neon', connectionString: 'postgres://x' },
      encryptionKey: 'a'.repeat(64)
    });
  });

  it('returns 400 when encryption header is missing', async () => {
    const result = await server.handlers.updateMessage.PUT(
      '/update-message?id=550e8400-e29b-41d4-a716-446655440000',
      { 'x-user-id': 'u1' },
      '{}'
    );
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'ENCRYPTION_REQUIRED');
  });

  it('returns 400 for malformed encrypted payload JSON', async () => {
    const result = await server.handlers.updateMessage.PUT(
      '/update-message?id=550e8400-e29b-41d4-a716-446655440000',
      {
        'x-user-id': 'u1',
        'x-payload-encrypted': 'true',
        'x-encryption-version': '1'
      },
      '{not valid json}'
    );
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'INVALID_ENCRYPTED_PAYLOAD');
  });

  it('returns 400 for missing request body', async () => {
    const result = await server.handlers.updateMessage.PUT(
      '/update-message?id=550e8400-e29b-41d4-a716-446655440000',
      {
        'x-user-id': 'u1',
        'x-payload-encrypted': 'true',
        'x-encryption-version': '1'
      },
      undefined
    );
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'INVALID_ENCRYPTED_PAYLOAD');
  });
});

describe('cancelMessage handler', () => {
  let server;

  beforeEach(async () => {
    server = await createReiServer({
      db: { driver: 'neon', connectionString: 'postgres://x' },
      encryptionKey: 'a'.repeat(64)
    });
  });

  it('returns 404 when target task does not exist', async () => {
    server.adapter.deleteTaskByUuid = async () => false;

    const result = await server.handlers.cancelMessage.DELETE(
      '/cancel-message?id=550e8400-e29b-41d4-a716-446655440000',
      { 'x-user-id': 'u1' }
    );

    assert.equal(result.status, 404);
    assert.equal(result.body.error.code, 'TASK_NOT_FOUND');
  });

  it('returns 200 when task is deleted', async () => {
    server.adapter.deleteTaskByUuid = async () => true;

    const result = await server.handlers.cancelMessage.DELETE(
      '/cancel-message?id=550e8400-e29b-41d4-a716-446655440000',
      { 'x-user-id': 'u1' }
    );

    assert.equal(result.status, 200);
    assert.equal(result.body.success, true);
  });
});

describe('processMessagesByUuid delivery safety', () => {
  it('does not retry delivery when cleanup fails after successful send', async () => {
    const masterKey = 'd'.repeat(64);
    const userId = 'u1';
    const task = {
      id: 1,
      user_id: userId,
      uuid: '550e8400-e29b-41d4-a716-446655440000',
      encrypted_payload: '',
      message_type: 'fixed',
      next_send_at: new Date(Date.now() + 60_000).toISOString(),
      status: 'pending',
      retry_count: 0
    };

    const userKey = deriveUserEncryptionKey(userId, masterKey);
    task.encrypted_payload = encryptForStorage(
      JSON.stringify({
        contactName: 'Alice',
        messageType: 'fixed',
        userMessage: 'hello',
        pushSubscription: { endpoint: 'https://push.example.com' },
        messageSubtype: 'chat',
        metadata: {}
      }),
      userKey
    );

    let sendCount = 0;
    const updateCalls = [];

    const ctx = {
      encryptionKey: masterKey,
      vapid: {
        email: 'vapid@example.com',
        publicKey: 'public-key',
        privateKey: 'private-key'
      },
      webpush: {
        sendNotification: async () => {
          sendCount++;
        }
      },
      db: {
        getTaskByUuid: async () => task,
        getTaskByUuidOnly: async () => task,
        deleteTaskById: async () => {
          throw new Error('delete failed');
        },
        updateTaskById: async (_taskId, updates) => {
          updateCalls.push(updates);
          return { id: task.id, ...updates };
        }
      }
    };

    const result = await processMessagesByUuid(task.uuid, ctx, 2, userId);

    assert.equal(result.success, false);
    assert.equal(result.error.code, 'POST_SEND_CLEANUP_FAILED');
    assert.equal(sendCount, 1);
    assert.equal(updateCalls.length, 1);
    assert.deepEqual(updateCalls[0], { status: 'sent', retry_count: 0 });
  });
});

describe('sendNotifications post-send persistence safety', () => {
  it('marks sent and avoids retry scheduling when cleanup fails', async () => {
    const masterKey = 'e'.repeat(64);
    const userId = 'u1';
    const userKey = deriveUserEncryptionKey(userId, masterKey);
    const task = {
      id: 42,
      user_id: userId,
      uuid: '550e8400-e29b-41d4-a716-446655440000',
      encrypted_payload: encryptForStorage(
        JSON.stringify({
          contactName: 'Alice',
          messageType: 'fixed',
          userMessage: 'hello',
          pushSubscription: { endpoint: 'https://push.example.com' },
          recurrenceType: 'none',
          messageSubtype: 'chat',
          metadata: {}
        }),
        userKey
      ),
      message_type: 'fixed',
      next_send_at: new Date(Date.now() - 60_000).toISOString(),
      status: 'pending',
      retry_count: 0
    };

    let sendCount = 0;
    const updateCalls = [];
    const handler = createSendNotificationsHandler({
      encryptionKey: masterKey,
      cronSecret: 'cron-secret',
      vapid: {
        email: 'vapid@example.com',
        publicKey: 'public-key',
        privateKey: 'private-key'
      },
      webpush: {
        sendNotification: async () => {
          sendCount++;
        }
      },
      db: {
        getPendingTasks: async () => [task],
        deleteTaskById: async () => {
          throw new Error('delete failed');
        },
        updateTaskById: async (_taskId, updates) => {
          updateCalls.push(updates);
          return { id: task.id, ...updates };
        },
        cleanupOldTasks: async () => 0
      }
    });

    const result = await handler.POST({ authorization: 'Bearer cron-secret' });

    assert.equal(result.status, 200);
    assert.equal(sendCount, 1);
    assert.equal(result.body.success, true);
    assert.equal(result.body.data.failedCount, 1);
    assert.equal(result.body.data.details.failedTasks.length, 1);
    assert.equal(result.body.data.details.failedTasks[0].status, 'post_send_cleanup_failed_marked_sent');
    assert.equal(updateCalls.length, 1);
    assert.deepEqual(updateCalls[0], { status: 'sent', retry_count: 0 });
  });
});
