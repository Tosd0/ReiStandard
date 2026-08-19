# @rei-standard/blob-store 设计

日期：2026-08-19
状态：设计定稿，待实现

## 这是什么

ReiStandard 的第二个垂直：纯前端应用的二进制存储 SDK。把「图片/音频/模型二进制存 IndexedDB Blob，业务字段里只留一个短令牌」这套在小手机类项目里验证过的方案，抽成可以 `npm install` 的包。

核心思路一句话：二进制进 Blob 表，字段里存 `blobref:<id>` 令牌。字段仍是普通 string，JSON 序列化、结构化克隆、备份导出都不受影响；渲染时令牌解析成 objectURL 喂给 `<img>`/CSS。

方案有两个先行实现：

- Whale-LLT 的双表引用计数方案（fileStorage + fileReferences，语义化业务 API 层）
- SullyOS 的令牌方案（单表 + 令牌内嵌业务字段，`utils/blobRef.ts`）

本包标准化的是令牌方案。两者的取舍：

| | 双表引用计数 | 令牌方案（本包） |
|---|---|---|
| 引用关系 | 独立引用表，需与业务键保持一致 | 令牌就在业务字段里，无需同步 |
| 存储层与业务耦合 | referenceId 由业务键拼出，存储前必须先知道业务键 | id 不透明随机，业务无感 |
| 删除 | 引用计数 + 清理孤儿 | mark-and-sweep GC（见下文） |
| 接入面 | 每类业务一组语义方法 | put/get/delete 三个通用方法 |

## 首版范围

装进去的：

- **core**：令牌生成与解析、经适配器的 Blob 读写、data URL ⇄ Blob 互转、deep-resolve（备份导出用）、惰性迁移辅助
- **孤儿 GC**：mark-and-sweep，引用来源由宿主注入
- **`/react` 子路径**：objectURL 生命周期 hook

不装的（都有明确理由，不是忘了）：

- **存储用量统计 / persist 申请**：和 blob 存储是两个关注点，将来可单独成包
- **内容寻址去重（SHA-256 当 id）**：id 本来就不透明，以后想加可以零破坏地加
- **OPFS 后端**：IDB Blob 没有暴露出问题，多一个后端多一份维护
- **语义化业务层**（storeAvatar 这类）：业务命名归宿主，SDK 只管字节

## 包结构

`packages/rei-standard-blob-store/` 单包，跟随仓库既有约定：tsup 双格式（ESM + CJS）、MIT、changesets 独立版本、pre 模式先发 `next` tag（首版 `0.1.0-next.0`）。

两个入口：

- `.` —— core，零运行时依赖
- `./react` —— 只有一个 hook；react 是 optional peerDependency，不装 react 的消费者完全无感

## core API

```ts
import { createBlobStore, createIdbAdapter, dataUrlToBlob, blobToDataUrl, extractRefs } from '@rei-standard/blob-store';

const store = createBlobStore({ adapter, prefix = 'blobref:' });

await store.put(blob);              // → 'blobref:<id>'
await store.get(token);             // → Blob | null（非令牌 / 不存在 / 读失败都是 null，不抛）
await store.delete(token);          // best-effort，失败静默
store.isRef(v);                     // 类型守卫，正分支收窄成品牌 string 子类型
await store.resolveToDataUrl(v);    // 令牌 → data URL；非令牌透传；Blob 已丢返回空串
await store.resolveDeep(root);      // 深度遍历对象树，令牌原地替换成 data URL（备份导出前调用）
await store.migrateDataUrl(url);    // data URL → 令牌；失败回退返回原串，调用方永远拿到可渲染的值
```

### id 与令牌格式

- 令牌 = `<prefix><id>`，prefix 默认 `blobref:`，可配。
- SDK 生成的 id 格式：`b_<毫秒时间戳 base36>_<进程内序号 base36>_<随机 6 位 base36>`。时间戳可反解，GC 的新鲜豁免依赖它。
- id 对消费者不透明：宿主存量数据里的其他 id 格式（如 SullyOS 的 `img_` 前缀）照读不误，新老混存没有问题。SDK 只反解自己认识的格式，反解不了的一律按「老」处理（见 GC 一节）。

### 工具函数（模块级导出）

- `dataUrlToBlob(dataUrl)` / `blobToDataUrl(blob)`：优先走 `Uint8Array.fromBase64` / `toBase64`（Safari 18.2+ / Firefox 133+ / Chrome 140+），不支持的环境回退 `atob` 循环 / FileReader。非 base64 data URL（utf8 svg 等）按 UTF-8 处理。
- `extractRefs(str, prefix = 'blobref:')`：从任意字符串提取全部令牌。规则：找到 prefix 后取其后最长的 `[A-Za-z0-9_]` 段作为 id，因此 JSON 串里内嵌的令牌（后随引号）也能正确截断提出。GC 内部调用时自动带上 store 配置的 prefix；宿主自定义了 prefix 又直接调模块级函数时需自行传入。

## 适配器契约

core 完全不直接碰 IndexedDB。存储后端由宿主注入：

```ts
interface StorageAdapter {
    get(id: string): Promise<Blob | null>;
    put(id: string, blob: Blob): Promise<void>;
    delete(id: string): Promise<void>;
    keys(): Promise<string[]>;          // GC 扫描用；blob 表行数是千级，全量返回没有压力
}
```

- 已有自己 IndexedDB 的宿主（多数情况）：拿现成的 DB 方法包一层即可，连接管理、版本升级、自愈逻辑全部自理，SDK 不参与。
- 没有 DB 的项目：`createIdbAdapter(dbName)` 提供开箱即用的独立数据库适配器（单 store，含 versionchange/blocked 的基本处理，保持简单）。

## 孤儿 GC

背景：令牌方案下删除是保守的——同一令牌可能被多处引用，消费方通常不主动删，孤儿 Blob 会随时间累积。GC 用 mark-and-sweep 收口：

```ts
await store.gc({ refSources, minAgeMs = 72 * 3600 * 1000 });
// → { deleted: number, kept: number, aborted: boolean }（aborted=true 即安全阀触发、整轮放弃）
```

- **mark**：`refSources` 是宿主提供的、吐字符串的 async iterable（例如：资产表每行的 JSON 串、localStorage 全量值）。SDK 对每段字符串跑 `extractRefs`，汇总出「在用令牌」集合。
- **sweep**：`adapter.keys()` 里不在集合中的 id 删除。

三道安全阀，总原则「宁可留孤儿，绝不删活图」：

1. 任何一个 refSource 迭代中抛错 → 整轮放弃，一个都不删。
2. 新鲜豁免：id 反解出的创建时间距今不足 `minAgeMs` 的不删。这挡住一个竞态：`put` 返回令牌到宿主把令牌写进业务字段并持久化之间有窗口，此时扫描看不到引用。
3. 反解不出时间的 id（宿主存量数据）按「老」处理，正常参与判定——老数据早该被引用了，扫不到引用即真孤儿。

**宿主的义务（README 显眼处必须写）**：`refSources` 必须枚举全部可能含令牌的持久化面。漏掉一个面，那个面独占引用的图会被当孤儿删掉。接入方应在代码里维护一份引用面清单并随新功能更新。

## `/react` 子路径

```ts
import { useBlobUrl } from '@rei-standard/blob-store/react';

const url = useBlobUrl(store, value);
```

- 令牌 → 读 Blob 建 objectURL，组件卸载 / value 变化时 revoke，不泄漏。
- 非令牌（data: / http(s) / 渐变串 / undefined）原样返回。
- 令牌解析完成前返回 undefined（首帧无图，读出后再渲染，属预期）。
- store 显式作参数传入，不做 context、不做全局单例；宿主想要默认 store 的便捷 hook 自己包一层，宿主特有的取值逻辑（如内置素材 URL 解析）也叠在那层薄壳里。

## 备份互操作

令牌只在本机数据库里有意义，跨设备备份必须还原成自包含格式。约定：导出前对备份对象树调用 `resolveDeep`，全部令牌变回 data URL；导入侧按普通 data URL 处理，可选地用 `migrateDataUrl` 惰性转回令牌。解析不到的令牌置空串，避免导出恢复端认不得的死令牌。

这个约定让备份格式与「是否使用本包」完全解耦：备份文件里永远没有令牌。

## 错误处理哲学

全线一个取向——存储层错误不打断业务：

- 读失败返回 null，不抛
- 删失败静默吞掉
- GC 宁留勿删（任何不确定 → 不删）
- 迁移失败回退原串，调用方永远拿到可渲染的值

抛错只发生在明确的编程错误上（如给 `dataUrlToBlob` 传非 data URL）。

## 测试策略

- **core**：`node --test` + 内存假适配器（Map 实现），不需要任何 IDB 环境。令牌生成/解析、resolveDeep、extractRefs、GC 三道安全阀（含新鲜豁免的时间边界）都在这层钉住。
- **createIdbAdapter**：devDependency 引入 fake-indexeddb 单独测。
- **react hook**：逻辑极薄，行为守卫依托首个消费者（SullyOS）侧的既有测试，随薄壳继续运行。

## 首个消费者接入（SullyOS，独立的第二步）

1. 本包发出 `next` 版后，SullyOS 直接安装正式依赖，不走 `link:`（避免污染 pnpm-lock，提交前 grep 自查）。
2. `utils/blobRef.ts` 变薄壳：re-export SDK，保留 SullyOS 特有的三样——内置样板房素材解析、`deleteBlobRefIfUnreferenced` 的引用扫描、外观预设导入迁移。
3. `db.ts` 新增 `listBlobAssetIds`（适配器 `keys()` 用）。
4. 验收：既有 blobRef 测试全绿；GC 接入后新增守卫测试——孤儿被清、新鲜的和被引用的不动。
5. GC 触发点首版只挂开发调试面板手动触发；产品化入口（如设置页存储统计区的「清理未使用文件」）留给后续。
6. SullyOS 落地 PR 必须附引用面清单（至少：assets 表、localStorage；实现时全量盘点 blobRef 消费者确认有无遗漏）。

## 规范文档与发布

- `standards/blob-storage.md`：令牌格式、适配器契约、GC 语义、备份互操作的规范化描述（面向想自己实现而不是装包的读者）。
- 包 README 按 amsg 各包风格：最小接入示例 + 宿主义务。
- changesets 走既有发布流程：写 changeset → 合 main → Version Packages PR → 发 `next`。

## 后续方向（不承诺）

- 内容寻址去重：put 时算 SHA-256 当 id，同图多处只存一份；对既有 API 零破坏。
- 存储用量统计 / persist 申请单独成包。
- 双表方案迁移器：给存量项目一条从引用计数方案迁入的路径。
