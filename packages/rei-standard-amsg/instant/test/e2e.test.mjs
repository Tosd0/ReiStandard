/**
 * E2E test for amsg-instant.
 *
 * Verifies the push payload field shape produced by amsg-instant remains
 * byte-identical to amsg-server's scheduled path, so the shared SW
 * (`@rei-standard/amsg-sw`) keeps working unchanged. Body is now plain JSON
 * (amsg-instant 0.2.0 dropped the envelope encryption).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createInstantHandler } from '../src/index.js';

describe('e2e: push payload contract parity with amsg-server', () => {
  it('produces a payload with every field defined in message-processor.js:78-93', async () => {
    const payload = {
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
    };

    const captured = [];
    const handler = createInstantHandler({
      vapid: {
        email: 'mailto:vapid@example.com',
        publicKey: 'pub',
        privateKey: 'priv'
      },
      webpush: {
        setVapidDetails() {},
        async sendNotification(_sub, body) {
          captured.push(JSON.parse(body));
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
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
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
