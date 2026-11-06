import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isValidISO8601, isValidPushEndpoint, validateScheduleMessagePayload } from '../src/server/lib/validation.js';
import { isPushSubscriptionShape } from '../src/server/lib/push-subscription-store.js';

describe('isValidISO8601', () => {
  test('accepts ISO 8601 strings only', () => {
    for (const ok of ['2030-01-01T00:00:00Z', '2030-01-01T00:00:00.123+08:00', '2030-01-01T00:00', '2030-01-01']) {
      assert.equal(isValidISO8601(ok), true, ok);
    }
    for (const bad of [1700000000000, new Date(), null, undefined, 'not a date', '2030-13-01T00:00:00Z', 'Jan 1 2030', '1700000000000']) {
      assert.equal(isValidISO8601(bad), false, String(bad));
    }
  });

  test('schedule payload with a numeric firstSendTime is INVALID_TIMESTAMP instead of reaching the database', () => {
    const result = validateScheduleMessagePayload({ contactName: 'A', messageType: 'fixed', firstSendTime: Date.now() + 60000 });
    assert.equal(result.valid, false);
    assert.equal(result.errorCode, 'INVALID_TIMESTAMP');
  });
});

describe('isValidPushEndpoint', () => {
  test('https to a public hostname without credentials', () => {
    assert.equal(isValidPushEndpoint('https://push.example/sub/abc'), true);
    assert.equal(isValidPushEndpoint('https://fcm.googleapis.com/fcm/send/x'), true);
  });

  test('rejects anything the server must not be sent to', () => {
    for (const bad of [
      'http://push.example/sub',
      'https://localhost/sub',
      'https://push.localhost/sub',
      'https://127.0.0.1/sub',
      'https://0x7f000001/sub',
      'https://[::1]/sub',
      'https://user:pw@push.example/sub',
      'https://user@push.example/sub',
      'ftp://push.example/sub',
      'push.example/sub',
      '',
      42,
      null,
    ]) {
      assert.equal(isValidPushEndpoint(bad), false, String(bad));
    }
  });

  test('isPushSubscriptionShape applies the same endpoint rule', () => {
    assert.equal(isPushSubscriptionShape({ endpoint: 'https://push.example/sub' }), true);
    assert.equal(isPushSubscriptionShape({ endpoint: 'http://push.example/sub' }), false);
    assert.equal(isPushSubscriptionShape({ endpoint: 'https://127.0.0.1/sub' }), false);
  });
});
