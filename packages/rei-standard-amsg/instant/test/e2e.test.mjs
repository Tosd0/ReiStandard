/**
 * E2E test for amsg-instant 0.8.0.
 *
 * Verifies the push payload field shape produced by amsg-instant
 * matches the three-axis schema from @rei-standard/amsg-shared:
 *   - messageKind: 'content'  (with messageIndex / totalMessages set)
 *   - all 13 legacy 0.7.x fields still present (back-compat for the
 *     downstream SullyOS SW, which already grew handlers for them)
 *   - plus new fields: messageKind, sessionId
 *
 * We intercept the outgoing Web Push HTTP request via `options.fetch`,
 * then decrypt the RFC 8291 ciphertext using the test subscription's
 * private key to read the JSON the SW would actually receive.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

import { createInstantHandler } from '../src/index.js';
import {
  generateTestVapid,
  generateTestSubscription,
  createFetchRouter,
  decryptCapturedPushBody,
  makeLlmResponse,
  consumeSse,
} from './helpers.mjs';

const LLM_URL = 'https://api.example.com/v1/chat/completions';

let vapid;
let subKit;

before(async () => {
  vapid = await generateTestVapid();
  subKit = await generateTestSubscription();
});

describe('e2e: push payload contract parity with amsg-server', () => {
  function buildPayload() {
    return {
      contactName: '小手机',
      avatarUrl: 'https://example.com/avatar.png',
      completePrompt: 'reply with two sentences in Chinese',
      apiUrl: LLM_URL,
      apiKey: 'sk-test',
      primaryModel: 'gpt-4o-mini',
      messageSubtype: 'forum',
      pushSubscription: subKit.subscription,
      metadata: { foo: 'bar', n: 42 },
    };
  }

  it('opt-out (Accept: application/json): produces a ContentPush carrying all 13 legacy fields + messageKind + sessionId', async () => {
    const payload = buildPayload();

    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: async () => makeLlmResponse('第一句。第二句！'),
    });

    const handler = createInstantHandler({ vapid, fetch: router.fetch });
    const req = new Request('http://localhost/instant', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
    });
    const res = await handler(req);
    assert.equal(res.status, 200);

    assert.equal(router.pushCalls.length, 2);

    const captured = [];
    for (const call of router.pushCalls) {
      const json = await decryptCapturedPushBody(call.body, subKit);
      captured.push(JSON.parse(json));
    }

    const required = [
      // legacy 0.7.x fields (still present in 0.8.0 ContentPush)
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
      'metadata',
      // 0.8.0 additions
      'messageKind',
      'sessionId',
    ];
    for (const field of required) {
      assert.ok(field in captured[0], `payload missing field: ${field}`);
    }

    assert.equal(captured[0].messageKind, 'content');
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
    assert.match(captured[0].sessionId, /^sess_/);

    assert.equal(captured[1].messageKind, 'content');
    assert.equal(captured[1].message, '第二句！');
    assert.equal(captured[1].messageIndex, 2);
    assert.match(captured[1].messageId, /^msg_[0-9a-f-]+_instant_1$/);

    // Both pushes share the SAME sessionId — that's the new
    // "one LLM round → one sessionId" invariant from the shared schema.
    assert.equal(captured[0].sessionId, captured[1].sessionId);
  });

  it('SSE (default): streams the same ContentPush field shape over event: payload, no Web Push', async () => {
    const payload = buildPayload();

    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: async () => makeLlmResponse('第一句。第二句！'),
    });

    const handler = createInstantHandler({ vapid, fetch: router.fetch });
    const req = new Request('http://localhost/instant', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const res = await handler(req);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/);

    const { payloads, doneReceived } = await consumeSse(res);
    assert.equal(doneReceived, true);
    assert.equal(payloads.length, 2);
    assert.equal(router.pushCalls.length, 0, 'SSE happy path must not fall back to Web Push');

    const required = [
      'title', 'message', 'contactName', 'messageId', 'messageIndex',
      'totalMessages', 'messageType', 'messageSubtype', 'taskId',
      'timestamp', 'source', 'avatarUrl', 'metadata',
      'messageKind', 'sessionId',
    ];
    for (const field of required) {
      assert.ok(field in payloads[0], `payload missing field: ${field}`);
    }
    assert.equal(payloads[0].messageKind, 'content');
    assert.equal(payloads[0].message, '第一句。');
    assert.equal(payloads[1].message, '第二句！');
    assert.equal(payloads[0].sessionId, payloads[1].sessionId);
  });
});
