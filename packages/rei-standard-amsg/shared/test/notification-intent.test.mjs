/**
 * `notificationIntent(payload)` —— 「这条到了客户端会不会弹通知」的单一判定。
 *
 * SW 拿它决定要不要 `showNotification`，发送端拿它决定这条值不值得占用推送通
 * 道。两端读同一份，所以这里的每一条都是跨包契约：判定一旦漂移，要么用户看不
 * 到该看到的消息，要么服务端推出一批不会显示的 push 去换掉订阅。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { notificationIntent } from '../src/index.js';

describe('notificationIntent', () => {
  test('没表态时按 kind 走默认：正文和结果弹，其余不弹', () => {
    assert.equal(notificationIntent({ messageKind: 'content' }), 'always');
    assert.equal(notificationIntent({ messageKind: 'result' }), 'always');
    assert.equal(notificationIntent({ messageKind: 'reasoning' }), 'never');
    assert.equal(notificationIntent({ messageKind: 'tool_request' }), 'never');
    assert.equal(notificationIntent({ messageKind: 'error' }), 'never');
  });

  test('缺 messageKind 的 2.0.x 老 payload 照旧弹', () => {
    assert.equal(notificationIntent({ message: 'hi' }), 'always');
    assert.equal(notificationIntent({ messageKind: null }), 'always');
  });

  test('notification.show 说了算，压过 kind 的默认', () => {
    assert.equal(notificationIntent({ messageKind: 'reasoning', notification: { show: 'always' } }), 'always');
    assert.equal(notificationIntent({ messageKind: 'content', notification: { show: false } }), 'never');
    assert.equal(
      notificationIntent({ messageKind: 'reasoning', notification: { show: 'when-hidden' } }),
      'when-hidden'
    );
  });

  test('show: auto 等于没表态', () => {
    assert.equal(notificationIntent({ messageKind: 'content', notification: { show: 'auto' } }), 'always');
    assert.equal(notificationIntent({ messageKind: 'reasoning', notification: { show: 'auto' } }), 'never');
  });

  test('不是对象的 payload 不弹', () => {
    assert.equal(notificationIntent(null), 'never');
    assert.equal(notificationIntent(undefined), 'never');
    assert.equal(notificationIntent('hi'), 'never');
  });

  test('notification 不是对象时当没写，退回 kind 的默认', () => {
    assert.equal(notificationIntent({ messageKind: 'content', notification: 'always' }), 'always');
    assert.equal(notificationIntent({ messageKind: 'reasoning', notification: 'always' }), 'never');
  });

  test('silent 只管响不响，不影响弹不弹的判定', () => {
    // 发送端拿这个判定决定「这条值不值得占用推送通道」。silent 无论取哪档都
    // 不该动它——不然 `silent: 'when-visible'` 的消息会被当成不弹的那类，
    // 只落收件箱、推送根本不发。
    for (const silent of [true, false, 'when-visible']) {
      assert.equal(
        notificationIntent({ messageKind: 'content', notification: { silent } }),
        'always',
        `silent: ${JSON.stringify(silent)} 不该把 content 变成不弹`,
      );
      assert.equal(
        notificationIntent({ messageKind: 'reasoning', notification: { silent } }),
        'never',
        `silent: ${JSON.stringify(silent)} 不该把 reasoning 变成弹`,
      );
    }
  });
});
