# @rei-standard/blob-store

## 0.1.0-next.2

### Minor Changes

- 6d2cb55: 新增内容查重：`store.scanContent()` 扫全库、按内容哈希分组，找出哪些令牌指着同一份内容；同时导出 `hashBlob(blob)`（Blob 内容的 SHA-256）。同一张图从好几个入口存进来会在库里留下好几份一模一样的 Blob，这条能查出重复了哪些、白占了多少字节。

  扫描是纯只读的（不删、不改、不写），合并引用由宿主在自己的引用面上做，多出来的 Blob 变成孤儿后交给已有的 GC 收。每组保留创建时间最早的令牌（`canonical`）；`byHash` 还能在批量迁移时当 cache 用，新图 `put` 之前先查一下哈希，命中就复用已有令牌、重复不会再生出来。

### Patch Changes

- 65a9f91: CJS 侧的 TypeScript 消费者现在编译得过了：exports 的 require 分支接上 CJS 口味的类型声明

  此前 exports map 里 import / require 两个分支的 `types` 都指向 ESM 口味的 `dist/index.d.ts`（包是 `type: module`），`moduleResolution: node16` 的 TS 项目从 CJS 侧 require 本包会报 TS1479「The specifier only resolves to an ES module」——运行时的 `dist/index.cjs` 一直是好的，卡住的只是类型检查。`./react` 子路径同样。

  现在根路径与 `./react` 的 import 分支 `types` 指 `.d.ts`、require 分支指 `.d.cts`（`types` 都放分支第一位）。`.d.cts` 生成时还会把声明里的相对引用（`./store.js` 等）改写成 `.cjs` 后缀，让整棵声明树都解析成 CJS 口味——此前 `.d.cts` 是 `.d.ts` 的逐字拷贝，相对引用解析回 ESM 口味声明，不开 `skipLibCheck` 的 CJS 消费端照样报错。ESM 侧不受影响。

- 65a9f91: GC 的数字参数传成 NaN/null 会静默关掉新鲜豁免——现在改为直接抛 TypeError

  `minAgeMs` / `now` 现在与 `refSources` 同款待遇：只接受不传（走默认值）或非负有限数字，NaN、null、Infinity、负数、数字字符串一律抛 `TypeError`，GC 不会带着坏配置开跑。

  此前这两个参数没有校验：传成 NaN（宿主用算出来的值最常见，比如 `cfg.hours * 3600000` 而 `cfg.hours` 是 undefined）或 null 时，`now - ts < minAgeMs` 恒为 false，新鲜豁免整道阀静默失效——「已 put、引用还没落到任何持久化面」这个竞态窗口里的活图会被当孤儿删掉，且结果 `aborted: false`、和正常一轮毫无区别。这是防丢数据的修复，用算出来的值配 `minAgeMs` 的宿主升级后第一轮 GC 若见到 `TypeError`，说明此前的豁免一直没生效，去修配置来源即可。

## 0.1.0-next.1

### Minor Changes

- 9a852de: 新增 store.restore(token, blob)：备份导入按原令牌把 Blob 写回原 id，令牌身份不丢。校验令牌前缀与 id 字符集（字符集外拒收，防造出 GC 永不可回收的存量）；同 id 重复 restore 为覆盖，同一份备份导两遍幂等。

## 0.1.0-next.0

### Minor Changes

- 97d7138: 新增 @rei-standard/blob-store：令牌式 Blob 存储。core（适配器模式，不碰宿主 IndexedDB）+ 孤儿 GC（mark-and-sweep，多道安全阀，宁可留孤儿不删活图）+ /react 子路径（useBlobUrl）。
