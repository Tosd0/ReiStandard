/**
 * 把一个适配器包成「没有收件箱」的样子——`appendOutboxMessages` 那组方法读不
 * 到，与内置 pg / neon 适配器现在的形态一致。
 *
 * 用在哪：思考过程这类到了客户端不弹通知的 payload，有收件箱时只落行、不推送
 * （见 lib/push-policy.js）。要验「推送这条路上出了什么事」的用例，得先站在没
 * 有收件箱的部署上——那时推送是这条内容唯一的腿，库会照旧发。
 *
 * 用 Proxy 而不是浅拷贝：内置适配器是 class 实例，方法挂在原型上，`{...adapter}`
 * 一个都拷不到。
 *
 * @param {Object} adapter
 * @returns {Object} 同一个适配器，outbox 那组方法读成 undefined
 */
export function withoutOutbox(adapter) {
  const hidden = new Set([
    'appendOutboxMessages',
    'markOutboxDelivered',
    'discardOutboxMessages',
    'listUnackedOutbox',
    'ackOutboxMessages',
    'cleanupOutbox',
  ]);
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      if (hidden.has(prop)) return undefined;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    has(target, prop) {
      return hidden.has(prop) ? false : Reflect.has(target, prop);
    },
  });
}
