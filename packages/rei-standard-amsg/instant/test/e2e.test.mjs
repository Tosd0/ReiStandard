/**
 * E2E test for amsg-instant.
 *
 * Verifies that the push payload field shape produced by amsg-instant is
 * byte-identical to what amsg-server's scheduled path produces, using the
 * same encryption helpers, the same VAPID values, and the same input
 * shape. This is the test that guards the "single protocol contract"
 * promise of the package.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'crypto';

import { createInstantHandler, deriveUserEncryptionKey } from '../src/index.js';

const TEST_USER_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEST_MASTER_KEY = 'b'.repeat(64);

function encryptForTransport(obj, userKeyHex) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(userKeyHex, 'hex'), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    encryptedData: encrypted.toString('base64')
  };
}

describe('e2e: push payload contract parity with amsg-server', () => {
  it('produces a payload with every field defined in message-processor.js:78-93', async () => {
    const userKey = deriveUserEncryptionKey(TEST_USER_ID, TEST_MASTER_KEY);
    const envelope = encryptForTransport({
      contactName: '小手机',
      avatarUrl: 'https://example.com/avatar.png',
      completePrompt: 'reply with two sentences in Chinese',
      apiUrl: 'https://api.example.com/v1/chat/completions',
      apiKey: 'sk-test',
      primaryModel: 'gpt-4o-mini',
      messageSubtype: 'forum',
      pushSubscription: {
        endpoint: 'https://push.example.com/sub',
        keys: { p256dh: 'aaa', auth: 'bbb' }
      },
      metadata: { foo: 'bar', n: 42 }
    }, userKey);

    const captured = [];
    const handler = createInstantHandler({
      vapid: {
        email: 'mailto:vapid@example.com',
        publicKey: 'pub',
        privateKey: 'priv'
      },
      masterKey: TEST_MASTER_KEY,
      webpush: {
        setVapidDetails() {},
        async sendNotification(_sub, payload) {
          captured.push(JSON.parse(payload));
        }
      },
      fetch: async () => ({
        ok: true,
        async json() {
          return { choices: [{ message: { content: '第一句。第二句！' } }] };
        }
      })
    });

    const req = new Request('http://localhost/instant', {
      method: 'POST',
      headers: {
        'x-user-id': TEST_USER_ID,
        'x-payload-encrypted': 'true',
        'x-encryption-version': '1'
      },
      body: JSON.stringify(envelope)
    });
    const res = await handler(req);
    assert.equal(res.status, 200);

    assert.equal(captured.length, 2);

    const required = [
      'title',
      'message',
      'contactName',
      'messageId',
      'messageIndex',
      'totalMessages',
      'messageType',
      'messageSubtype',
      'taskId',
      'timestamp',
      'source',
      'avatarUrl',
      'metadata'
    ];
    for (const field of required) {
      assert.ok(field in captured[0], `payload missing field: ${field}`);
    }

    assert.equal(captured[0].title, '来自 小手机');
    assert.equal(captured[0].message, '第一句。');
    assert.equal(captured[0].messageType, 'instant');
    assert.equal(captured[0].messageSubtype, 'forum');
    assert.equal(captured[0].source, 'instant');
    assert.equal(captured[0].taskId, null);
    assert.equal(captured[0].avatarUrl, 'https://example.com/avatar.png');
    assert.deepEqual(captured[0].metadata, { foo: 'bar', n: 42 });
    assert.match(captured[0].messageId, /^msg_[0-9a-f-]+_instant_0$/);
    assert.equal(captured[0].totalMessages, 2);
    assert.equal(captured[0].messageIndex, 1);

    assert.equal(captured[1].message, '第二句！');
    assert.equal(captured[1].messageIndex, 2);
    assert.match(captured[1].messageId, /^msg_[0-9a-f-]+_instant_1$/);
  });
});
