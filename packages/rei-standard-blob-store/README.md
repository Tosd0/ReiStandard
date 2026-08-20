# @rei-standard/blob-store

纯前端应用的令牌式 Blob 存储：图片 / 音频 / 模型文件等二进制存 IndexedDB，业务字段里只留一个短令牌 `blobref:<id>`。字段仍是普通 string——JSON 序列化、结构化克隆、备份导出都不受影响；渲染时令牌解析成 objectURL。相比 base64 内嵌省 ~33% 空间，且二进制不再常驻 JS 堆。

```bash
npm install @rei-standard/blob-store@next
```

目前处于预发布期，请装 `@next`（稳定版发布后本句和上面的 `@next` 一起移除）。

## 最小接入

```js
import { createBlobStore, createIdbAdapter } from '@rei-standard/blob-store';

// 没有自己 IndexedDB 的项目：独立数据库开箱即用
const store = createBlobStore({ adapter: createIdbAdapter('my-app-blobs') });

const token = await store.put(file);      // → 'blobref:b_xxx' 存进业务字段
const blob = await store.get(token);      // 渲染时取回
const url = blob ? URL.createObjectURL(blob) : '';   // get 可能返回 null，喂给 <img>/CSS 前判空；用完 URL.revokeObjectURL(url)，否则内存泄漏
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

令牌要**独占一个字段值**才会被还原：对象键位上的令牌、拼进更长字符串中间的令牌都不在 `resolveDeep` 的替换范围（键没有「原地替换」可言，中缀不是令牌值），会原样留进备份文件。业务数据的形态要保证令牌单独占一个值槽。

## 孤儿 GC 与宿主义务

令牌方案下删除是保守的（同一令牌可能被多处引用），孤儿 Blob 靠 GC 收口：

```js
const result = await store.gc({
  refSources: (async function* () {
    for (const row of await myDb.getAllAssets()) yield JSON.stringify(row);
    // localStorage 先同步快照再吐：async generator 每次 yield 都会挂起，
    // 挂起期间并发的 removeItem 会让下标移位、漏扫一个 key
    const localValues = [];
    for (let i = 0; i < localStorage.length; i++) localValues.push(localStorage.getItem(localStorage.key(i)) ?? '');
    yield* localValues;
  })(),
});
// → { deleted, kept, keptBoundary, aborted }
```

**⚠️ 宿主义务（GC 唯一要你自己保证对的部分）：**

- **引用面要全**：`refSources` 必须枚举全部可能含令牌的持久化面。漏掉一个面，那个面独占引用的图会被当孤儿删掉。建议在代码里维护一份引用面清单并随新功能更新。
- **吐出来的必须是令牌逐字可见的明文**：某个面若压缩（如 lz-string）、加密或 URL 编码后才落盘，要先还原成明文再吐。这种情况枚举不报错、安全阀也不触发，但令牌在文本里不可见，等于这个面没扫——照样删活图。
- **一张 blob 表只能对应一个令牌前缀**：多个 store 共用同一个 adapter（同一张表）而前缀不同时，任何一个 store 的 GC 只按自己的前缀 mark、却 sweep 整张表，会把其他前缀引用的活图全部删掉，且不触发任何安全阀。要按资产种类分类，请分开建表（不同 dbName / 不同 adapter），别分前缀。
- **GC 进行期间别做「先删后写」式搬家**：一轮 mark 不是一致性快照。引用在持久化面之间移动（重存、跨表搬家）时若有瞬间从所有面上消失，恰好撞上扫描就会被误判成孤儿（老图没有新鲜豁免可救）。挑没有这类写入的空闲时机跑；多 tab 场景建议用 `navigator.locks` 之类保证 GC 独跑。
- **备份导入期间别并发跑 GC**：`restore` 写回的是备份里的原 id，反解出来的是当年的老时间戳，享受不到新鲜豁免。「restore 已执行、引用面尚未落盘」的窗口里撞上一轮扫描，这些图会被当孤儿删掉。导入请等引用全部落盘后再跑 GC；反过来 GC 进行中也别开始导入。
- **令牌在吐出的文本里要保持边界完整**：提取是按最长 `[A-Za-z0-9_]` 段截 id 的。拿令牌拼复合键（`${token}_thumb`）会让提出来的 id 比真实 id 长；分块吐大文本时把令牌从中间切开会只剩半截——两种情况真实 id 都进不了标记集。拼接请用 `-`、`?` 等字符集外的分隔符；分块请按记录/行切。SDK 在 sweep 侧有兜底（存储 id 与某个在用 id 互为前缀时不删），但它救不了恰好切在前缀边界上的情形，别拿兜底当许可。

安全阀（总原则「宁可留孤儿，绝不删活图」）：任一来源抛错整轮放弃（`aborted: true`）；创建不足 72 小时（`minAgeMs` 可配）的不删，挡住「已 put、引用未落盘」的竞态；超出 `[A-Za-z0-9_]` 字符集的 id（比如存量数据直接拿 UUID 当 id，含 `-`）一律保留不删——这类 id 在文本提取时会被截断、无法安全判定引用，读写不受影响，只是想让它们参与回收得先迁移成本包生成的 id；存储 id 与某个在用 id 互为前缀的也不删——那是令牌边界出过事（复合键拼接、分块切开）的痕迹。这道豁免的命中数在结果里单独计数（`keptBoundary`）：它接近库存量时，多半是某个引用面里混进了一段杂散的令牌前缀文本（比如把 `blobref:b_` 当例子写进了会被扫描的说明文案）——提出来的短 id 是每个 SDK 生成 id 的前缀，GC 从此整轮空转，而 `deleted: 0` 和真没垃圾长得一模一样，看到 `keptBoundary` 暴涨就该去排查引用面而不是当成没垃圾。`refSources` 传错东西（单个字符串、吐非字符串的迭代器、不可迭代对象）会直接抛 `TypeError`——配置错误吵着失败，不会静默清库。

调用频率不用讲究：挑个后台空闲的时候跑一次，或者干脆挂在设置页的「清理缓存」之类的手动按钮上，不需要频繁跑。时机上只有一条要求，就是上面说的——避开搬家式写入正在进行的时刻。反过来，`refSources` 的引用面清单没把握齐全时，先别开 GC——孤儿 Blob 只是多占点空间，删活图才是不可逆的。

## API 一览

### `createBlobStore` 与 store 方法

| 方法 | 签名 | 语义 |
|---|---|---|
| `createBlobStore` | `createBlobStore({ adapter, prefix? }) → store` | 创建 store 实例；`adapter` 必填，`prefix` 默认 `blobref:`，必须是非空字符串（配置错误抛 `TypeError`）。自定义前缀建议以 `:` 这类非 `[A-Za-z0-9_]` 字符收尾——`pic` 这种前缀会把普通字符串（如 `picture.png`）误判成令牌 |
| `store.prefix` | `string`（勿修改） | 当前令牌前缀 |
| `store.isRef(value)` | `(value: unknown) → boolean` | 判断 `value` 是不是本 store 生成的令牌 |
| `store.put(blob)` | `(blob: Blob) → Promise<string>` | 存入 Blob，返回令牌；适配器失败会上抛。入参不是 Blob（如误传 data URL 字符串）抛 `TypeError`——字符串请走 `migrateDataUrl` |
| `store.restore(token, blob)` | `(token: string, blob: Blob) → Promise<void>` | 备份导入用：把 Blob 写回令牌原有的 id 下，业务字段里的旧令牌继续有效。`token` 必须是本 store 前缀的令牌且 id 完整落在 `[A-Za-z0-9_]` 内（字符集外的 id 写进去会成为 GC 永不能回收的存量，直接拒收），`blob` 判定与 `put` 相同——不满足抛 `TypeError`；适配器失败会上抛。同 id 重复 restore 是覆盖：同一份备份导两遍幂等。导入期间别并发跑 GC，见下面「孤儿 GC 与宿主义务」 |
| `store.get(token)` | `(token: unknown) → Promise<Blob \| null>` | 令牌 → Blob；非令牌 / 不存在 / 读失败一律返回 `null` |
| `store.delete(token)` | `(token: unknown) → Promise<void>` | best-effort 删除，失败静默不抛。同一令牌可能被多处引用，删之前先确认没人再用它——误删会让其他引用处变成死链；拿不准就交给上面的 GC，别手动 delete |
| `store.resolveToDataUrl(value)` | `(value: string) → Promise<string>` | 令牌 → data URL；非令牌原样返回；图已丢或编码失败返回空串 |
| `store.migrateDataUrl(dataUrl)` | `(dataUrl: string) → Promise<string>` | data URL → 令牌；失败回退返回原串 |
| `store.resolveDeep(root)` | `(root: object) → Promise<void>` | 深度遍历对象树，令牌原地替换成 data URL；原地修改、无返回值 |
| `store.gc(opts)` | `(opts: GcOptions) → Promise<GcResult>` | 孤儿 GC，详见上面「孤儿 GC 与宿主义务」 |

### 模块导出

| 导出 | 签名 | 语义 |
|---|---|---|
| `createIdbAdapter` | `createIdbAdapter(dbName, { storeName? }) → StorageAdapter` | 独立 IndexedDB 适配器，没有自己数据库的项目开箱即用。一个 dbName 只有首次创建时的 storeName 生效——再配第二个 storeName 会吵着报错，要多个 store 请换 dbName |
| `dataUrlToBlob` | `(dataUrl: string) → Blob` | data URL → Blob；非法输入抛错 |
| `blobToDataUrl` | `(blob: Blob) → Promise<string>` | Blob → data URL |
| `extractRefs` | `(str: string, prefix?: string) → string[]` | 从任意字符串提取全部令牌；自己拼 GC 的 `refSources` 时用得上 |
| `DEFAULT_PREFIX` | `'blobref:'` | 默认令牌前缀常量 |

## 错误哲学

存储层错误不打断业务：读失败返回 null、删失败静默、GC 宁留勿删、迁移失败回退原串。`put` 失败会上抛——调用方必须知道图没存进去。

完整规范见 [`standards/blob-storage.md`](https://github.com/Tosd0/ReiStandard/blob/main/standards/blob-storage.md)（绝对链接是刻意的：npm 包页不会替包内相对路径向仓库上层爬升，相对链接在那儿是死的）。
