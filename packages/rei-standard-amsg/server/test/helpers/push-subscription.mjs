/**
 * 测试用的用户级推送订阅工具。
 *
 * 订阅是用户级的一份（push_subscriptions 表），任务行不携带它，到点投递时
 * 现读。所以任何「真的推出去一条」的测试都得先让这个用户有一份订阅。
 */

import { deriveUserEncryptionKey, encryptForStorage } from '../../src/server/lib/encryption.js';

export const TEST_PUSH_SUBSCRIPTION = {
  endpoint: 'https://push.example.com/sub',
  keys: { p256dh: 'k', auth: 'a' },
};

/** 把订阅加密成落库那份密文。 */
export async function encryptTestSubscription(userId, masterKey, subscription = TEST_PUSH_SUBSCRIPTION) {
  const userKey = await deriveUserEncryptionKey(userId, masterKey);
  return encryptForStorage(JSON.stringify(subscription), userKey);
}

/** 往真适配器里写一份订阅。 */
export async function seedPushSubscription(adapter, userId, masterKey, subscription = TEST_PUSH_SUBSCRIPTION) {
  await adapter.upsertPushSubscription(
    userId,
    await encryptTestSubscription(userId, masterKey, subscription),
    Date.now()
  );
}

/**
 * 内存版的订阅存储（三个适配器方法）。`encrypted` 传 null 表示「这个用户还
 * 没登记过订阅」。
 */
export function pushSubscriptionStore(encrypted) {
  let row = encrypted ? { subscription: encrypted, updated_at: 1 } : null;
  return {
    async getPushSubscription() { return row; },
    async upsertPushSubscription(_userId, subscription, updatedAt) {
      row = { subscription, updated_at: updatedAt };
      return true;
    },
    async deletePushSubscription() {
      const had = !!row;
      row = null;
      return had;
    },
  };
}

/**
 * 给任意 db（`{}`、假适配器、真 D1 适配器都行）挂上内存版订阅存储。
 * 真适配器的同名方法会被这份覆盖，测试因此不必去建表 / 写行。
 */
export function withPushSubscriptionStore(db, encrypted) {
  const overrides = pushSubscriptionStore(encrypted);
  return new Proxy(db || {}, {
    get(target, prop) {
      if (prop in overrides) return overrides[prop];
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
    has(target, prop) {
      return prop in overrides || prop in target;
    },
  });
}
