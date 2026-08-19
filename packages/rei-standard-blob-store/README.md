# @rei-standard/blob-store

纯前端应用的令牌式 Blob 存储：图片 / 音频 / 模型二进制存 IndexedDB，业务字段里只留一个短令牌 `blobref:<id>`。字段仍是普通 string——JSON 序列化、结构化克隆、备份导出都不受影响；渲染时令牌解析成 objectURL。相比 base64 内嵌省 ~33% 空间，且二进制不再常驻 JS 堆。

```bash
npm install @rei-standard/blob-store
```

## 最小接入

```js
import { createBlobStore, createIdbAdapter } from '@rei-standard/blob-store';

// 没有自己 IndexedDB 的项目：独立数据库开箱即用
const store = createBlobStore({ adapter: createIdbAdapter('my-app-blobs') });

const token = await store.put(file);      // → 'blobref:b_xxx' 存进业务字段
const blob = await store.get(token);      // 渲染时取回
```

已有自己 IndexedDB 的项目（多数情况）：拿现成的 DB 方法包一个适配器，连接管理、版本升级全部自理，本包不碰你的库：

```js
const store = createBlobStore({
  adapter: {
    get: (id) => myDb.getBlobAsset(id),
    put: (id, blob) => myDb.putBlobAsset(id, blob),
    delete: (id) => myDb.deleteBlobAsset(id),
    keys: () => myDb.listBlobAssetIds(),   // GC 扫描用
  },
});
```

## React 渲染

```jsx
import { createBlobStore, createIdbAdapter } from '@rei-standard/blob-store';
import { useBlobUrl } from '@rei-standard/blob-store/react';

// store 须身份稳定：模块级建一次（或 useMemo 持有），别在组件体/父组件里现场 create
const store = createBlobStore({ adapter: createIdbAdapter('my-app-blobs') });

function Wallpaper({ value }) {
  const url = useBlobUrl(store, value);   // 令牌→objectURL（自动 revoke），非令牌透传
  return url ? <img src={url} /> : null;
}
```

react 是可选 peerDependency，不用 React 的项目零负担。

## 备份互操作

令牌只在本机数据库里有意义。导出备份前调用 `store.resolveDeep(backupObject)`，对象树里的全部令牌原地变回 data URL——备份文件里永远没有令牌，格式与是否用本包解耦。导入侧可用 `store.migrateDataUrl(dataUrl)` 惰性转回令牌。

`resolveDeep` 会**原地修改**传入对象，导出前先做独立副本（如 `structuredClone`）再传进来。

## 孤儿 GC 与宿主义务

令牌方案下删除是保守的（同一令牌可能被多处引用），孤儿 Blob 靠 GC 收口：

```js
const result = await store.gc({
  refSources: (async function* () {
    for (const row of await myDb.getAllAssets()) yield JSON.stringify(row);
    for (let i = 0; i < localStorage.length; i++) yield localStorage.getItem(localStorage.key(i)) ?? '';
  })(),
});
// → { deleted, kept, aborted }
```

**⚠️ 宿主义务：`refSources` 必须枚举全部可能含令牌的持久化面。漏掉一个面，那个面独占引用的图会被当孤儿删掉。** 建议在代码里维护一份引用面清单并随新功能更新。

安全阀（总原则「宁可留孤儿，绝不删活图」）：任一来源抛错整轮放弃（`aborted: true`）；创建不足 72 小时（`minAgeMs` 可配）的不删，挡住「已 put、引用未落盘」的竞态。`refSources` 传错东西（单个字符串、吐非字符串的迭代器、不可迭代对象）会直接抛 `TypeError`——配置错误吵着失败，不会静默清库。

## 错误哲学

存储层错误不打断业务：读失败返回 null、删失败静默、GC 宁留勿删、迁移失败回退原串。`put` 失败会上抛——调用方必须知道图没存进去。

完整规范见 [`standards/blob-storage.md`](../../standards/blob-storage.md)。
