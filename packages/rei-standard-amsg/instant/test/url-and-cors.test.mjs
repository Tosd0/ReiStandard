/**
 * Tests for the two 0.4.0 additions:
 *   - Smart `apiUrl` normalization (idempotent v1/chat/completions append).
 *   - CORS handling: OPTIONS preflight short-circuit + per-response header merge.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  createInstantHandler,
  normalizeAiApiUrl,
} from '../src/index.js';
import {
  generateTestVapid,
  generateTestSubscription,
  createFetchRouter,
  makeLlmResponse,
} from './helpers.mjs';

let vapid;
let subKit;

before(async () => {
  vapid = await generateTestVapid();
  subKit = await generateTestSubscription();
});

// ─── URL normalization ────────────────────────────────────────────────

describe('normalizeAiApiUrl', () => {
  it('appends /v1/chat/completions for a bare host', () => {
    assert.equal(
      normalizeAiApiUrl('https://api.openai.com'),
      'https://api.openai.com/v1/chat/completions'
    );
  });

  it('appends /v1/chat/completions for a host with just a trailing slash', () => {
    assert.equal(
      normalizeAiApiUrl('https://api.openai.com/'),
      'https://api.openai.com/v1/chat/completions'
    );
  });

  it('appends only /chat/completions when the path already ends in /v1', () => {
    assert.equal(
      normalizeAiApiUrl('https://api.openai.com/v1'),
      'https://api.openai.com/v1/chat/completions'
    );
    assert.equal(
      normalizeAiApiUrl('https://api.openai.com/v1/'),
      'https://api.openai.com/v1/chat/completions'
    );
  });

  it('appends only /chat/completions for non-v1 version segments (e.g. /v2)', () => {
    assert.equal(
      normalizeAiApiUrl('https://my.proxy.com/openai/v2'),
      'https://my.proxy.com/openai/v2/chat/completions'
    );
  });

  it('leaves a full chat/completions URL untouched', () => {
    const full = 'https://api.openai.com/v1/chat/completions';
    assert.equal(normalizeAiApiUrl(full), full);
  });

  it('is idempotent — running it twice is identical to once', () => {
    const inputs = [
      'https://api.openai.com',
      'https://api.openai.com/v1',
      'https://api.openai.com/v1/chat/completions',
      'https://my.proxy.com/openai/v2',
    ];
    for (const input of inputs) {
      assert.equal(normalizeAiApiUrl(normalizeAiApiUrl(input)), normalizeAiApiUrl(input));
    }
  });

  it('preserves the query string', () => {
    assert.equal(
      normalizeAiApiUrl('https://api.openai.com/v1?beta=1'),
      'https://api.openai.com/v1/chat/completions?beta=1'
    );
  });

  it('leaves custom non-OpenAI paths untouched (no `chat/completions`, no `/vN` suffix)', () => {
    // Anthropic-shaped path: /v1/messages — already specifies the endpoint, do not double-suffix.
    assert.equal(
      normalizeAiApiUrl('https://api.anthropic.com/v1/messages'),
      'https://api.anthropic.com/v1/messages'
    );
    // Arbitrary proxy path that the caller intentionally points at — trust it.
    assert.equal(
      normalizeAiApiUrl('https://my.proxy.com/openai/api/chat'),
      'https://my.proxy.com/openai/api/chat'
    );
  });

  it('trims whitespace before parsing', () => {
    assert.equal(
      normalizeAiApiUrl('   https://api.openai.com/v1   '),
      'https://api.openai.com/v1/chat/completions'
    );
  });

  it('rejects empty or invalid input', () => {
    assert.throws(() => normalizeAiApiUrl(''), /required/);
    assert.throws(() => normalizeAiApiUrl('not-a-url'), /Invalid apiUrl/);
  });
});

// ─── CORS handling ────────────────────────────────────────────────────

function makeRequest({ method = 'POST', body, headers = {} } = {}) {
  return new Request('http://localhost/instant', {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

function validPayload() {
  return {
    contactName: 'Rei',
    completePrompt: 'hi',
    apiUrl: 'https://api.example.com/v1/chat/completions',
    apiKey: 'sk-test',
    primaryModel: 'm',
    pushSubscription: subKit.subscription,
  };
}

describe('CORS preflight (OPTIONS)', () => {
  it('short-circuits OPTIONS to 204 with default CORS headers', async () => {
    const handler = createInstantHandler({ vapid });
    const res = await handler(new Request('http://localhost/instant', { method: 'OPTIONS' }));
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.match(res.headers.get('access-control-allow-methods') || '', /POST/);
    assert.match(res.headers.get('access-control-allow-methods') || '', /OPTIONS/);
    assert.match(res.headers.get('access-control-allow-headers') || '', /Content-Type/i);
    assert.match(res.headers.get('access-control-allow-headers') || '', /Authorization/i);
    assert.match(res.headers.get('access-control-allow-headers') || '', /X-Client-Token/i);
    // Must allow the client's opt-in gzip marker, else cross-origin preflight
    // blocks compressed `deliver({ compressRequest })` requests.
    assert.match(res.headers.get('access-control-allow-headers') || '', /X-Amsg-Request-Encoding/i);
    assert.equal(res.headers.get('access-control-max-age'), '86400');
  });

  it('uses options.cors.allowOrigin when configured', async () => {
    const handler = createInstantHandler({
      vapid,
      cors: { allowOrigin: 'https://app.example.com' },
    });
    const res = await handler(new Request('http://localhost/instant', { method: 'OPTIONS' }));
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://app.example.com');
    // Custom origin → must emit Vary: Origin so caches don't leak the policy.
    assert.match(res.headers.get('vary') || '', /Origin/i);
  });

  it('does NOT emit Vary: Origin when allowOrigin is the wildcard', async () => {
    const handler = createInstantHandler({ vapid });
    const res = await handler(new Request('http://localhost/instant', { method: 'OPTIONS' }));
    // null is what undici returns for missing headers on Node.
    assert.equal(res.headers.get('vary'), null);
  });
});

describe('CORS headers on regular responses', () => {
  it('attaches CORS headers to 200 success responses', async () => {
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: async () => makeLlmResponse('hi.'),
    });
    const handler = createInstantHandler({ vapid, fetch: router.fetch });
    const res = await handler(makeRequest({ body: validPayload() }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });

  it('attaches CORS headers to 4xx error responses (e.g. validation failure)', async () => {
    const handler = createInstantHandler({ vapid });
    const res = await handler(makeRequest({ body: 'not json {' }));
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });

  it('attaches CORS headers to 401 auth-failure responses', async () => {
    const handler = createInstantHandler({ vapid, clientToken: 'secret' });
    const res = await handler(makeRequest({ body: validPayload() }));
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });

  it('attaches CORS headers to 405 wrong-method responses', async () => {
    const handler = createInstantHandler({
      vapid,
      cors: { allowOrigin: 'https://app.example.com' },
    });
    const res = await handler(new Request('http://localhost/instant', { method: 'GET' }));
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://app.example.com');
  });
});
