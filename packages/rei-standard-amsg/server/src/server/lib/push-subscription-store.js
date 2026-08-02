/**
 * 用户级 Web Push 订阅。
 *
 * 一个用户一份订阅，独立于任务行存放；任务本身不带订阅，到点投递时现读。
 * 用户清站点数据、重装 PWA、或者推送服务轮换了 endpoint 之后，客户端
 * `PUT /push-subscription` 覆盖这一份就够了——不用把每条任务翻出来逐行刷。
 * 角色在 fire 里给自己排的任务客户端压根不知道存在，逐行刷这条路本来也走
 * 不通：推不出去 → 状态记不下来 → 客户端不知道有这条任务 → 更刷不到它。
 *
 * 订阅落库前用 per-user key 加密（和任务 payload、client_state 同一套）。
 */

import { decryptFromStorage, encryptForStorage } from './encryption.js';

/** 适配器支不支持用户级订阅存储。 */
export function supportsPushSubscriptionStore(db) {
  return !!db
    && typeof db.getPushSubscription === 'function'
    && typeof db.upsertPushSubscription === 'function'
    && typeof db.deletePushSubscription === 'function';
}

/**
 * 一个对象长得像不像 Web Push 订阅。只看投递必需的部分：没有 endpoint 就
 * 谈不上往哪推。keys 缺失留给推送服务去拒，这里不替它判。
 *
 * @param {unknown} subscription
 * @returns {boolean}
 */
export function isPushSubscriptionShape(subscription) {
  return !!subscription
    && typeof subscription === 'object'
    && !Array.isArray(subscription)
    && typeof (/** @type {{ endpoint?: unknown }} */ (subscription).endpoint) === 'string'
    && /** @type {{ endpoint: string }} */ (subscription).endpoint.trim().length > 0;
}

/**
 * 写入（覆盖）这个用户的订阅。
 *
 * @param {Object} args
 * @param {import('../adapters/interface.js').DbAdapter} args.db
 * @param {string} args.userId
 * @param {string} args.userKey
 * @param {Object} args.subscription - 明文订阅对象
 * @param {number} [args.updatedAt] - epoch 毫秒，默认取当前时刻
 * @returns {Promise<{ updatedAt: number }>}
 */
export async function savePushSubscription({ db, userId, userKey, subscription, updatedAt }) {
  const at = Number.isInteger(updatedAt) && updatedAt > 0 ? updatedAt : Date.now();
  const encrypted = await encryptForStorage(JSON.stringify(subscription), userKey);
  await db.upsertPushSubscription(userId, encrypted, at);
  return { updatedAt: at };
}

/**
 * 读回这个用户的订阅（解密后的明文对象）。没有登记过 → null。
 *
 * @param {Object} args
 * @param {import('../adapters/interface.js').DbAdapter} args.db
 * @param {string} args.userId
 * @param {string} args.userKey
 * @returns {Promise<{ subscription: Object, updatedAt: number|null }|null>}
 */
export async function loadPushSubscription({ db, userId, userKey }) {
  const row = await db.getPushSubscription(userId);
  if (!row || typeof row.subscription !== 'string' || !row.subscription) return null;
  const subscription = JSON.parse(await decryptFromStorage(row.subscription, userKey));
  return { subscription, updatedAt: row.updated_at ?? null };
}

/**
 * 投递前取订阅。取不到就抛——静默不发会让任务「成功」地什么都没做，用户
 * 只看到消息凭空消失。抛出去走既有的重试 / 标记逻辑，原因也会记进 payload
 * 的 lastError，`GET /messages` 上看得见。
 *
 * @param {Object} args
 * @param {import('../adapters/interface.js').DbAdapter} args.db
 * @param {string} args.userId
 * @param {string} args.userKey
 * @returns {Promise<Object>} 明文订阅对象
 */
export async function resolvePushSubscription({ db, userId, userKey }) {
  if (!supportsPushSubscriptionStore(db)) {
    throw new Error('PUSH_SUBSCRIPTION_STORE_UNSUPPORTED: 当前数据库适配器不支持用户级推送订阅存储');
  }
  const stored = await loadPushSubscription({ db, userId, userKey });
  if (!stored) {
    throw new Error('PUSH_SUBSCRIPTION_MISSING: 该用户还没有登记推送订阅（PUT /push-subscription）');
  }
  return stored.subscription;
}
