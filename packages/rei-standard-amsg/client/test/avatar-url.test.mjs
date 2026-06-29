import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ReiClient } from '../src/index.js';

function makeClient() {
  return new ReiClient({ baseUrl: 'https://example.com', instantEncryption: false });
}

// Run a `_sanitizeAvatarUrl` call with console.warn stubbed (keeps the test
// output clean) and report whether a warning fired.
function sanitize(client, target) {
  const original = console.warn;
  let warned = false;
  console.warn = () => { warned = true; };
  try {
    const stripped = client._sanitizeAvatarUrl(target);
    return { stripped, warned };
  } finally {
    console.warn = original;
  }
}

test('_sanitizeAvatarUrl: valid https URL is kept', () => {
  const client = makeClient();
  const target = { avatarUrl: 'https://cdn.example.com/a.png' };
  const { stripped, warned } = sanitize(client, target);
  assert.equal(stripped, false);
  assert.equal(warned, false);
  assert.equal(target.avatarUrl, 'https://cdn.example.com/a.png');
});

test('_sanitizeAvatarUrl: absent avatarUrl is a no-op', () => {
  const client = makeClient();
  const target = { contactName: 'Rei' };
  const { stripped } = sanitize(client, target);
  assert.equal(stripped, false);
  assert.equal('avatarUrl' in target, false);
});

test('_sanitizeAvatarUrl: data: URI is stripped', () => {
  const client = makeClient();
  const target = { avatarUrl: 'data:image/png;base64,AAAA' };
  const { stripped, warned } = sanitize(client, target);
  assert.equal(stripped, true);
  assert.equal(warned, true);
  assert.equal(target.avatarUrl, null);
});

test('_sanitizeAvatarUrl: malformed non-data URL is now stripped (aligned with server/instant)', () => {
  // Behavior change: before the shared-validator alignment, client only checked
  // data: + length, so a scheme-less URL passed through. server/instant always
  // rejected it; client now matches.
  const client = makeClient();
  const target = { avatarUrl: 'foo.com/avatar.png' };
  const { stripped, warned } = sanitize(client, target);
  assert.equal(stripped, true);
  assert.equal(warned, true);
  assert.equal(target.avatarUrl, null);
});
