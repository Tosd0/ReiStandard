# @rei-standard/blob-store

纯前端应用的令牌式 Blob 存储：图片 / 音频 / 模型文件等二进制存 IndexedDB，业务字段里只留一个短令牌 `blobref:<id>`。字段仍是普通 string——JSON 序列化、结构化克隆、备份导出都不受影响；渲染时令牌解析成 objectURL。相比 base64 内嵌省 ~33% 空间，且二进制不再常驻 JS 堆。

```bash
npm install @rei-standard/blob-store
```

目前处于预发布期，请装 `@rei-standard/blob-store@next`（稳定版发布后本句移除）。

## 最小接入

```js
import { createBlobStore, createIdbAdapter } from '@rei-standard/blob-store';

// 没有自己 IndexedDB 的项目：独立数据库开箱即用
const store = createBlobStore({ adapter: createIdbAdapter('my-app-blobs') });

const token = await store.put(file);      // → 'blobref:b_xxx' 存进业务字段
const blob = await store.get(token);      // 渲染时取回
const url = URL.createObjectURL(blob);    // 喂给 <img>/CSS；用完 URL.revokeObjectURL(url)，否则内存泄漏
```

React 项目直接用下面的 `useBlobUrl`，revoke 交给 hook 代管，不用自己写这几行。

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

`resolveDeep` 会**原地修改**传入对象，导出前先做独立副本（如 `structuredClone`）再传进来。它没有返回值——用的是改完的原对象，别写成 `const out = await store.resolveDeep(backupObject)`。解析不到的令牌会置成空串：图已丢时备份里对应字段就是空的，这是预期行为，不是 bug。

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

调用时机不用讲究：挑个后台空闲的时候跑一次，或者干脆挂在设置页的「清理缓存」之类的手动按钮上，不需要频繁跑。反过来，`refSources` 的引用面清单没把握齐全时，先别开 GC——孤儿 Blob 只是多占点空间，删活图才是不可逆的。

## API 一览

### `createBlobStore` 与 store 方法

| 方法 | 签名 | 语义 |
|---|---|---|
| `createBlobStore` | `createBlobStore({ adapter, prefix? }) → store` | 创建 store 实例；`adapter` 必填，`prefix` 默认 `blobref:`，必须是非空字符串（配置错误抛 `TypeError`） |
| `store.prefix` | `string`（只读） | 当前令牌前缀 |
| `store.isRef(value)` | `(value: unknown) → boolean` | 判断 `value` 是不是本 store 生成的令牌 |
| `store.put(blob)` | `(blob: Blob) → Promise<string>` | 存入 Blob，返回令牌；适配器失败会上抛 |
| `store.get(token)` | `(token: unknown) → Promise<Blob \| null>` | 令牌 → Blob；非令牌 / 不存在 / 读失败一律返回 `null` |
| `store.delete(token)` | `(token: unknown) → Promise<void>` | best-effort 删除，失败静默不抛。同一令牌可能被多处引用，删之前先确认没人再用它——误删会让其他引用处变成死链；拿不准就交给上面的 GC，别手动 delete |
| `store.resolveToDataUrl(value)` | `(value: string) → Promise<string>` | 令牌 → data URL；非令牌原样返回；图已丢或编码失败返回空串 |
| `store.migrateDataUrl(dataUrl)` | `(dataUrl: string) → Promise<string>` | data URL → 令牌；失败回退返回原串 |
| `store.resolveDeep(root)` | `(root: object) → Promise<void>` | 深度遍历对象树，令牌原地替换成 data URL；原地修改、无返回值 |
| `store.gc(opts)` | `(opts: GcOptions) → Promise<GcResult>` | 孤儿 GC，详见上面「孤儿 GC 与宿主义务」 |

### 模块导出

| 导出 | 签名 | 语义 |
|---|---|---|
| `createIdbAdapter` | `createIdbAdapter(dbName, { storeName? }) → StorageAdapter` | 独立 IndexedDB 适配器，没有自己数据库的项目开箱即用 |
| `dataUrlToBlob` | `(dataUrl: string) → Blob` | data URL → Blob；非法输入抛错 |
| `blobToDataUrl` | `(blob: Blob) → Promise<string>` | Blob → data URL |
| `extractRefs` | `(str: string, prefix?: string) → string[]` | 从任意字符串提取全部令牌；自己拼 GC 的 `refSources` 时用得上 |
| `DEFAULT_PREFIX` | `'blobref:'` | 默认令牌前缀常量 |

## 错误哲学

存储层错误不打断业务：读失败返回 null、删失败静默、GC 宁留勿删、迁移失败回退原串。`put` 失败会上抛——调用方必须知道图没存进去。

完整规范见 [`standards/blob-storage.md`](../../standards/blob-storage.md)。
