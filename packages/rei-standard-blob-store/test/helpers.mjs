/** Map 实现的内存适配器；node --test 只收 *.test.mjs，此文件不会被当测试跑。 */
export function memoryAdapter() {
  const map = new Map();
  return {
    map,
    get: async (id) => map.get(id) ?? null,
    put: async (id, blob) => { map.set(id, blob); },
    delete: async (id) => { map.delete(id); },
    keys: async () => [...map.keys()],
  };
}

/** 各方法都抛错的适配器，验证「读失败 null / 删失败吞」。 */
export function brokenAdapter() {
  const boom = async () => { throw new Error('boom'); };
  return { get: boom, put: boom, delete: boom, keys: boom };
}
