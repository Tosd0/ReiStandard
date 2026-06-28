import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isValidUrl,
  AVATAR_URL_MAX_LENGTH,
  validateAvatarUrl,
  normalizeVapidSubject,
  readReasoningContent,
  stripReasoningTags,
} from '../src/index.js';

// ─── validateAvatarUrl ──────────────────────────────────────────────────

test('validateAvatarUrl: absent value is OK (null)', () => {
  assert.equal(validateAvatarUrl(undefined), null);
  assert.equal(validateAvatarUrl(null), null);
});

test('validateAvatarUrl: a normal https URL passes', () => {
  assert.equal(validateAvatarUrl('https://cdn.example.com/a.png'), null);
});

test('validateAvatarUrl: non-string rejected', () => {
  assert.match(validateAvatarUrl(123), /必须是字符串/);
});

test('validateAvatarUrl: data: URI rejected', () => {
  assert.match(validateAvatarUrl('data:image/png;base64,AAAA'), /data:/);
});

test('validateAvatarUrl: over-length rejected', () => {
  const long = 'https://e.com/' + 'a'.repeat(AVATAR_URL_MAX_LENGTH);
  assert.match(validateAvatarUrl(long), /超过/);
});

test('validateAvatarUrl: malformed non-data URL rejected (the client-alignment case)', () => {
  // `new URL('foo.com/a.png')` throws (no scheme) — server/instant always
  // rejected this; client now does too via the shared validator.
  assert.match(validateAvatarUrl('foo.com/a.png'), /不是合法 URL/);
  assert.match(validateAvatarUrl('not a url'), /不是合法 URL/);
});

test('isValidUrl: absolute URL true, scheme-less false', () => {
  assert.equal(isValidUrl('https://e.com'), true);
  assert.equal(isValidUrl('e.com/x'), false);
  assert.equal(isValidUrl(123), false);
});

// ─── normalizeVapidSubject ──────────────────────────────────────────────

test('normalizeVapidSubject: bare email gets mailto: prefix', () => {
  assert.equal(normalizeVapidSubject('you@example.com'), 'mailto:you@example.com');
});

test('normalizeVapidSubject: existing mailto: kept', () => {
  assert.equal(normalizeVapidSubject('mailto:you@example.com'), 'mailto:you@example.com');
});

test('normalizeVapidSubject: https: subject kept as-is (regression guard)', () => {
  // RFC 8292 allows an https: subject. The previous server-only copy only
  // matched /^mailto:/ and would mangle this into `mailto:https://...`.
  assert.equal(
    normalizeVapidSubject('https://example.com/contact'),
    'https://example.com/contact',
  );
  assert.equal(normalizeVapidSubject('http://example.com/c'), 'http://example.com/c');
});

test('normalizeVapidSubject: blank → empty string', () => {
  assert.equal(normalizeVapidSubject(''), '');
  assert.equal(normalizeVapidSubject('   '), '');
  assert.equal(normalizeVapidSubject(undefined), '');
});

// ─── readReasoningContent / stripReasoningTags ──────────────────────────

test('readReasoningContent: reads reasoning_content', () => {
  const r = readReasoningContent({ choices: [{ message: { reasoning_content: '  思考中  ' } }] });
  assert.equal(r, '思考中');
});

test('readReasoningContent: empty reasoning_content → null', () => {
  assert.equal(readReasoningContent({ choices: [{ message: { reasoning_content: '   ' } }] }), null);
  assert.equal(readReasoningContent({}), null);
  assert.equal(readReasoningContent(null), null);
});

test('readReasoningContent: falls back to <think> span in content', () => {
  const r = readReasoningContent({ choices: [{ message: { content: '<think>盘算一下</think>你好' } }] });
  assert.equal(r, '盘算一下');
});

test('stripReasoningTags: removes <think> span (privacy regression guard)', () => {
  // Private chain-of-thought must never ride along inside the user-facing text.
  assert.equal(stripReasoningTags('<think>secret plan</think>你好'), '你好');
  assert.equal(stripReasoningTags('a<THINKING>x</THINKING>b'), 'ab');
  assert.equal(stripReasoningTags('<thought>m</thought>n<think>o</think>'), 'n');
});

test('stripReasoningTags: content without tags is untouched', () => {
  assert.equal(stripReasoningTags('plain text'), 'plain text');
  assert.equal(stripReasoningTags('no angle brackets here'), 'no angle brackets here');
});
