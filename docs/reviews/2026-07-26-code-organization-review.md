# ReiStandard 代码组织审查报告

日期：2026-07-26 · 基线：`main` @ 6edd522 · 方法：全仓四路并行深度审查（server 包 / client+sw / instant+shared / 根级设施），关键结论全部经过第二轮独立验证（diff / grep / 实际构建 / 实际运行测试）。

## 基线状态

- `npm run ci`（check:esm → check:pm → build → test）全绿，sw 56/56 等各包测试全部通过。
- 注意：`npm test` 不能单独在新克隆上运行——各包测试通过 workspace 链接引用 `amsg-shared` 的 **dist 产物**，必须先 `npm run build`，否则报 `ERR_MODULE_NOT_FOUND`（见 C 类问题）。

## 总体判断

代码质量本身不差：分层意图清晰（shared 为零依赖底层）、测试量可观（35+ 测试文件）、changesets 管理版本、agentic 决策契约已经正确地收敛进 shared——这个先例说明团队知道正确做法。但存在三类**系统性**问题：

1. **复制-粘贴 + "keep in sync" 注释代替单一事实来源**：instant↔server 约 650 行近似重复（含 Web Push 加密栈整个文件），且已产生 4 处实锤行为漂移；SQL 适配器、SW 内部 IDB 管道、协议常量同病。
2. **文档/元数据与代码大面积脱节**：4/5 包发布损坏的 .d.ts（实测）、5 处手写版本号全部错误、权威规范缺失 next 线全部新能力、许可证声明自相矛盾。
3. **双轨演化失控**：多租户 vs 单用户、examples vs SDK——新功能只落一侧，另一侧无人宣判死亡也无人同步。

---

## A. 高严重度问题

### A1. 4/5 包发布的 `.d.ts` 是 JS 源码原文（实测验证）
- `client/dist/index.d.ts` 实测为 70KB / 1655 行的 JS 源码原样拷贝，含 `const TEXT_ENCODER = new TextEncoder()`、`this._baseUrl = ...` 等运行时语句，零 `declare`；server 的 "d.ts" 甚至含 `import ... from 'crypto'`。TS 消费者 import 这四个包会直接报声明文件语法错误。
- 根因在 `shared/tsup.config.js:6-11` 自己写明白了：tsup 的 dts 插件不会从 .js 入口提取 JSDoc `@typedef`，只有 shared 用 `tsc -p tsconfig.json --emitDeclarationOnly` 两步构建规避（`shared/package.json:30`）；instant/server/client/sw 全部 `dts: true` 踩坑。
- 修复：把 shared 的 tsconfig + 两步构建复制到其余 4 包（instant 需为 adapters/blob 多入口分别产出声明）。

### A2. instant ↔ server 约 650 行复制实现，且已产生 4 处行为漂移
- **Web Push 加密栈整文件复制**：`instant/src/webpush.js`（355 行）与 `server/src/server/lib/webpush-webcrypto.js` 除 1 行 import 路径与 34 行 server 专属附录（`SCHEDULED_DEFAULT_TTL` + `createWebCryptoWebPush`）外**逐字节相同**（diff 实测仅 39 行）。这是 RFC 8291/8292 安全敏感加密代码，两处维护、两套测试（instant 侧解密验证 160 行，server 侧仅断言 header 70 行）。
- **LLM 调用器平行实现且已漂移**（`server/.../lib/llm.js` vs `instant/src/message-processor.js:184-309`，各约 120 行）：
  1. `stream: false` 只在 instant 侧固定（message-processor.js:233），server 侧缺失；
  2. messages 模式检测 instant 用真值判断、server 用 `Array.isArray && length>0`——`messages: []` 时两侧行为完全不同；
  3. 超时：server 可配 `timeoutMs`，instant 硬编码 300000；
  4. content trim 位置不同。
  `llm.js:121-126` 注释声称"各持一份是为避免架构依赖"——但两包都已依赖 shared，理由不成立。
- **messages 数组校验漂移**：instant 侧支持 assistant `tool_calls`（content 可空）与 `role:'tool'`（`instant/src/validation.js:33-60`）；server 侧（`lib/validation.js:108-130`）完全没有这两个分支——**回放 agentic 会话到 scheduleMessage 会被 400 拒绝**，而 server 文件 101-103 行还声称"kept in lockstep on purpose"。
- **utils 半途而废的迁移**：`instant/src/utils.js`（88 行）是 `server/.../webcrypto-utils.js`（111 行）的严格子集，两者第 15 行都已从 shared import 3 个helper——剩余 8 个没搬完。第三份独立 base64url+HMAC 在 `server/.../tenant/token.js:3-21`。
- **句子切分**：同一正则 + 同一 reduce 惯用法两处实现；server 文件内两条 "lockstep" 注释互相矛盾（161-163 行说要与 instant 保持同步的函数，60-63 行说 instant 0.8.0 已删除）。
- 修复：全部上移 shared（该仓库已用 `assertValidDecision`/`buildSessionContext` 证明这条路可行）。

### A3. 安全加固只做了一侧：D1 有 SQL 列名白名单，pg/neon 没有
- `d1.js:16-19` 定义 `UPDATABLE_COLUMNS` 并在两个 update 方法中拒绝未知键；`pg.js:135-138` / `neon.js:134-137` 直接把 `Object.entries(updates)` 的 key 插值进 `SET ${key} = $n`，无白名单。今天调用方是硬编码的，但同一防线三个适配器只装了一个。

### A4. pg.js 与 neon.js 约 85% 逐字节相同
- 归一化调用管道后 diff 仅剩 ~42 行（构造/懒初始化 + 13 行样板），全部 SQL 字符串（含 25 行中文 `claimTask` 注释）三份拷贝（pg/neon/d1），文档注释已开始漂移（pg.js:224 vs neon.js:225 对 `false` 语义的描述已不同）。`test/pg-neon-adapter.test.mjs:53-56` 已经把两者当同一后端参数化测试——抽象在测试里存在、在源码里不存在。
- 修复：抽 `PostgresBaseAdapter`（抽象 `_query`），两个子类各 ~15 行。

### A5. 权威规范（standards/）与实现双向脱节
- **规范有、实现无**：`active-messaging-api.md:154` 列出的 `POST /api/v1/send-notifications-scheduled` 在全仓 0 个 JS 文件中实现（grep 实测）。
- **实现有、规范无**：`/capabilities`、`/client-state`、`/vapid-public-key`、`X-Client-Token`、`GET /messages` 的 `charId`/`clientTaskId`、单用户模式及其无 `/api/v1` 前缀的路由规则——规范中**零提及**（grep 实测 0 命中），而这些已发布到 npm `next` tag 且 client SDK 已文档化。
- **虚假同构声明**：规范第 20 行称"适用于 `packages/.../server` 与 `examples/` 的同构实现"，但 examples 连 `messageKind` 都没有（见 B5）。
- 对一个自称"技术标准仓库"（根 README 维护原则一节）的项目，这是最伤根基的问题。

### A6. 许可证自相矛盾且无 LICENSE 文件
- 全仓无任何 LICENSE 文件（find 实测）；5 个包 package.json 全部 `"license": "MIT"`；根 README 第 107 行声称 CC BY-NC-SA 4.0。npm 上的包声明 MIT，仓库声明非商业——法律上互相矛盾。需要一次明确决策（常见做法：代码 MIT、规范文本 CC，分别放 LICENSE 与 standards/LICENSE 并在 README 说明）。

### A7. 跨包线协议常量双写
- **multipart 分片协议**：`instant/src/multipart.js:3-9` 导出 `MULTIPART_MESSAGE_KIND = '_multipart'`、`MULTIPART_ENCODING`、ttl/maxChunks/maxTotalBytes 默认值；`sw/src/index.js:68-76` 以**本地未导出常量**原样重写一遍。任一侧改值即静默破坏重组。`_blob` 信封同病（instant 手写 object literal 产出、sw 注释里约定消费）。
- **client↔SW postMessage 协议**：`REI_AMSG_POSTMESSAGE_TYPE` / `REI_SW_EVENT` / `REI_SW_MESSAGE_TYPE` 只在 sw 包定义（sw/src/index.js:88-116）；client 包不定义也不导入，两个 README 都教页面代码硬编码字符串。从 window 侧 import sw 模块取常量还会执行其模块级状态（4 个 Map + DB 缓存）。
- 修复：全部入 shared（或 sw 提供无副作用的 `/protocol` 子路径导出）。

### A8. client README 记载了一个 SW 从不发出的事件形状
- `client/README.md:259` 称 SW 落库后 postMessage `{ type: 'REI_AMSG_PUSH', event: 'DELIVER', payload }`——实际 `event` 取值是 `'rei-amsg-content-received'` 等（`sw/src/index.js:100-107`），`'REI_AMSG_DELIVER'` 是 client→SW 方向的消息类型而非广播事件。示例代码恰好因为忽略 `e.data.event` 而能跑；任何按文档过滤 `event === 'DELIVER'` 的用户将永远收不到回执。这是推荐集成路径上的协议级文档错误。

### A9. 多租户 vs 单用户功能漂移（server 包内）
- 两条装配线共享 handler 是对的，但新功能全部只落单用户线：`capabilities`/`vapidPublicKey`/`clientState` 只在 `single-user.js:73-75` 注册，`createReiServer`（index.js:134-144）不暴露；agentic `hooks` 只在单用户 ctx 接线（single-user.js:58-61），多租户侧 `processSingleMessage` 的 agentic 分支永远不可达；`claimLeaseMs` 多租户 handler 不透传（README 自己承认，server/README.md:134）；pg/neon 缺 `client_state` 三方法、`schema.js` 无 `client_state` 表。
- 伴随不一致：handler key `initTenant` vs `init`；init 返回 201 vs 200；单用户 init 全捕获出 500 JSON、多租户 init 直接向上抛（宿主不包就是裸异常）；CF worker 的 500 分支丢 CORS 头（`single-user-worker.js:99` 的 cors 在 try 内计算，147 行 catch 未带），跨域前端读不到 500 错误体。
- 需要一次产品决策：多租户线 feature-freeze 并写明，或把新能力路由回共享 ctx。

---

## B. 中严重度问题

### B1. 三个巨型单文件
| 文件 | 行数 | 问题 |
|---|---|---|
| `sw/src/index.js` | 1679 | 最乱：每个功能的策略层与存储层相距 400–900 行（dedupe 策略 571-832、其 CRUD 1237-1307、其 DB opener 1550-1588；multipart 同病）；通用 helper（`errorToMessage`/`respondToSender`）藏在不相关的 outbox 段落里被 275/341/348 行远程引用 |
| `client/src/index.js` | 1666 | 相对整齐但：`deliver()` 单方法 238 行（699-936）把 amsg-server CRUD 家族拦腰截断；`normalizeMaxPayloadBytes` 孤悬类后（1645）而兄弟 helper 都在类前；190 行 typedef 把首行可执行代码推到 237 行 |
| `instant/src/index.js` | 981 | god-file：路由 + 鉴权（含完整 HMAC-JWT 验证器 884-947）+ gzip 解码 + CORS + 整个内联 SSE 传输引擎（400-596，藏在 per-request 闭包里无法单测）+ waitUntil + 选项解析 + blob 端点 + 33 行导出桶 |

### B2. SW 内部 IndexedDB 管道三份平行拷贝（~260 行）且已漂移
- 三个事务包装器（`withDatabaseStore`/`withDedupeStore`/`withQueueStore`）形状相同，唯 `withQueueStore` 多了 `transaction.oncomplete → resolve`（1646 行）——两者行为不同是有意还是漂移无人知晓；两个 DB opener、两个缓存失效器、两套 CRUD（`readDedupeRecord` 与 `readStoreRecord` 逐行相同仅 store 选择不同）。
- 另：offline outbox 是唯一没有内存 fallback 的存储家族（`memoryStoreFor` 故意不含 queue store），无 IDB 环境下 `ENQUEUE_REQUEST` 以裸 `ReferenceError` 失败——未文档化的不对称。

### B3. server handlers 四种签名约定、三种响应信封、三种验证位置
- 签名：`POST(headers, body)` / `GET(url, headers)` 严格版 / 带 legacy shim 的 `(headers)||(url,headers)` 双兼容版 / `send-notifications` 的 typeof 嗅探全多态版。`cancel/messages/update` 传给 `resolveTenant` 的 `{ url }` 参数是无效的（context.js:106 仅在 `allowCronToken` 时读取）。
- 信封：标准 `{success,data}` vs `vapid-public-key`/`capabilities` 的顶层字段 vs 加密响应第三种形状；`err()` helper 只有 client-state.js 有，其余 9 个 handler 手写嵌套错误字面量数十处（schedule-message.js 内 12 处）。
- 验证：schedule 用集中式 `validateScheduleMessagePayload`；update 在 handler 内 55 行逐字段重写同样规则；client-state 又一套本地 `validateEntry`。

### B4. client 错误处理三种构造风格、方法间成败语义不一致
- `makeLocalError`（带 code，全文件只用了 1 次）/ 前缀 `new Error` / 前缀 `TypeError` / 无前缀传输错误并存；`init`/`getVapidPublicKey` 失败**抛**，`scheduleMessage` 等五个方法失败**原样返回信封**，`listMessages`/`getClientState` 混合（信封返回但解密错抛出），`getCapabilities` 再混一种（404 返 null）。调用方学不到统一契约。
- SW 侧对称路径策略也不一致：dedupe 清理失败记 error、multipart 清理静默吞；重复通知的 `showNotification` 拒绝会打爆 waitUntil 链而首投路径有 catch；超预算 multipart 静默丢弃而 TTL 过期有广播事件。

### B5. examples/ 是 3000 行线协议已不兼容的死代码，0 CI 覆盖
- `examples/lib/message-processor.js` 中 `messageKind` 出现 0 次（grep 实测）——早于三轴 `AmsgPush` schema，产出的推送现行 `amsg-sw` 无法路由；错误信封还是已废弃的 `{type:'error'}` 时代。
- 五个 lib 文件与 server 包对应文件已 70–100% 重写分道（diff 实测），只剩 tenant-token 三分之二相同。
- 在 npm workspaces 里但无任何 scripts，`check-esm-syntax` 只走 `type:module` 包也跳过它——3000 行连 `node --check` 都没有。
- 三处"会同步更新"的承诺（examples/README.md:5,14 等）全部失守，连"落后于 v2.3"的过期声明本身都过期了 3 个 minor。

### B6. 手写版本号 5 处全部错误；README 导出清单大面积过期
| 位置 | 声称 | 实际 |
|---|---|---|
| `packages/rei-standard-amsg/README.md` 版本表 | shared 0.2.0 / instant 0.9.0 / server 2.5.0 / client 2.4.0 / sw 2.2.0 | 0.4.0-next.1 / 0.10.1-next.0 / 2.6.0-next.6 / 2.9.0-next.4 / 2.3.3-next.0（client 差 4 个稳定 minor） |
| `standards/active-messaging-api.md:7` 对齐声明 | server 2.5.2 / client 2.7.0 | 同上 |
| `RELEASING.md:25` | shared 用 `^0.2.0` | 实际 `^0.4.0-next.0/1`（且两种 range 并存） |
| 10 个 server 源文件头 | "SDK v2.0.1" | 2.6.0-next.6（而 tsup 里专门做了 `__AMSG_SERVER_VERSION__` 防漂移——防了运行时、没防注释） |
- README 导出缺口：client README 完全未记载 `getVapidPublicKey`/`getCapabilities`/`putClientState`/`getClientState`/`clearClientState` 五个公开方法；server README 只记载 21 个根导出中的 13 个、`./cloudflare` 子路径全文未提；shared README 与代码直接矛盾（称 ReasoningPush 无 `messageIndex`"类型层面刻意不存在"而 typedef 与 builder 都有；`pushPayload` 单数示例自 0.8.0 起是硬错误）且整个后半文件（567-1059 行的 14 个导出）无文档；instant README 漏 6 个 `./blob/*` 子路径、CORS 表漏 `X-Amsg-Request-Encoding`、`onEvent` 表列 4 种事件实际发 ~25 种。

### B7. 测试盲区分布
- SW offline outbox（`ENQUEUE_REQUEST`/`FLUSH_QUEUE`/重试策略约 190 行）**零测试**；dispatch.test.mjs 的 mock 无 `indexedDB`，50+ 个 dedupe/multipart 测试全部跑在内存 fallback 上，真实 IDB 分支仅 6 个测试覆盖。
- instant：4 个平台 adapter 只测了 cloudflare；6 个 blob store 只测了 memory。
- server：`tenant/token.js`（过期/类型/签名篡改分支）、`blob-store.js`、`factory.js`、`lib/request.js` 无直接测试。
- client：`scheduleMessage`/`updateMessage`/`listMessages`/`subscribePush`/`_encrypt` 线格式无直接测试（`deliver()` 覆盖很好，53 个测试）。

### B8. 根 tests/ 是 v2.0.1 时代的手动 E2E，未接任何 CI
- 打真实部署 URL、只测 5 个老端点、`run-test.sh` 含交互式 `read -p`，root package.json 与 CI 均无引用。`.env.test.example` 记载的 `TEST_API_URL`/`TEST_API_KEY`/`TEST_MODEL` 三个变量脚本从不读取。

### B9. 运维文档过期 / 发布流程文档缺口
- `docs/VERCEL_TEST_DEPLOY.md:72,78` 使用 Vercel 已下线多年的 `vercel secrets add` + `@secret` 语法，今日无法照做。
- 仓库自 2026-07-01 进入 changesets pre（next）模式，`RELEASING.md` 对 pre 模式零提及——无人知道如何 `changeset pre exit` 切稳定版；根 README 还在教用户装 `latest` tag（装到的是 pre 模式之前的旧稳定线）。
- `docs/superpowers/` 5 份内部 AI 规划文档（含 "For agentic workers: REQUIRED SUB-SKILL..." 指令）无任何引用，但单用户设计 rationale 只存在于此。

### B10. instant 包内部重复
- `validateContinuePayload` 重写 `validateInstantPayload` 约 90 行公共字段校验（validation.js:361-433 vs 124-296）。
- multipart 选项解析双实现且严格性相反：handler 路径抛 TypeError、导出的 `processInstantMessage` 路径静默用默认值——同一配置两种行为。
- `runLegacyInstant` 内容循环重写 `sendPushesSequentially`（含相同的错误包装与 1500ms 间隔）。

---

## C. 低严重度（卫生类）

1. **`server/src/server/` 双重嵌套**独此一家（其余 4 包都是 `src/` 直下），发布物只有 dist，可机械扁平化；`cloudflare.js`（入口文件）与 `cloudflare/`（实现目录）同名不同职；单用户变体散落 4 个目录。
2. **死代码清单**：`schema.js` 的 `REQUIRED_COLUMNS`（0 引用）、`webcrypto-utils.js` 的 `timingSafeEqualBytes`（0 引用）、三适配器各自实现的 `dropSchema`（0 调用）与 `getTaskByUuidOnly`（生产不可达）、`schedule-message.js:60-65` 两分支返回完全相同的死条件、同文件 108-123 与 177-192 十六行注释逐字节重复、sw `createNotificationFromPayload` 永不返回假值导致两处死守卫、`dispatchPushToClients` JSDoc 漏第 4 参。
3. **engines/依赖 range 不一致**：instant `node>=18`（tsup target 却是 node20）vs 其余 `>=20`；shared 依赖 `^0.4.0-next.0` 与 `-next.1` 两种并存。
4. **无任何 lint/format/editorconfig**（find 实测 0 配置文件）；风格一致性纯靠自觉——B3/B4 的漂移即其结果。
5. **`.gitignore`**：首行孤立 `ref` 无对应物；`packages/*/dist/` 模式匹配不到任何东西（实际层级是 `packages/*/*/dist/`，后者已存在）。
6. **文件放置**：`examples/vercel.json.example` 实为 tests/ 健康检查项目的部署配置（server/README.md:199 却引它作 server 部署参考，且用已下线的 `@secret` 语法）；`examples/.env.test.example` 只被 tests/ 消费；根 README 仓库布局树漏 `tests/` 与 `scripts/`。
7. **注释/报错语言混用**：62 个源文件中 34 个含中文（多为注释），报错信息中英随机（sw 同文件内两种语言的 throw）。建议定一条规则即可（如：注释随意、面向用户的报错统一一种语言）。
8. **命名**：无租户的单用户线满身 "tenant" 术语（`tenantManager`、`tenantId:'single'`、路由字面量 `POST /init-tenant`）；client_state 适配器 API 入参 `updatedAt` 出参 `updated_at` 迫使两处翻译层；sw 内 `REI_SW_*` 与 `REI_AMSG_*` 两个前缀家族并存。
9. **测试 helper 包内重复**：server 5 个文件各自重写"造加密任务行"fixture；client 5 个测试文件各自重写 fetch mock；sw 两个测试文件各自手搓 SW mock；server 的 webpush 测试 helper 是 instant 侧的弱化版（不解密）。
10. **`instant/docs/migration-0.8.0-next.4.md`**：全仓唯一的包内 docs/ 目录，记载已被superseded的 pre 版本，且内容已与代码不符（messageId 自动填充格式）。

---

## 优化计划

### Phase 0 — 止血（约 1 人日，全部无 API 变化，可立即做）

1. **修类型产物**（A1）：复制 shared 的 tsconfig + 两步构建到其余 4 包；验收 = 四包 `dist/index.d.ts` 含 `declare` 且无运行时语句。
2. **许可证决策**（A6）：加 LICENSE 文件，统一 README 与 package.json 声明（建议代码 MIT、规范文本 CC，分文件声明）。
3. **pg/neon 补列名白名单**（A3）：把 `UPDATABLE_COLUMNS` 挪到 schema 常量旁，三适配器共用（~20 行）。
4. **删 5 处手写版本号**（B6）：README 版本表改 npm 徽章或删列；文件头版本号全部去掉；RELEASING.md 的 `^0.2.0` 改为不含具体号的表述。
5. **修 client README 协议错误**（A8）+ sw README 导出清单（漏 `DELIVER` 与别名导出）。
6. **死代码清扫**（C2 全清单）。
7. **杂项**：`.gitignore` 清理、`.env.test.example`/`vercel.json.example` 归位 tests/、instant engines 对齐 `>=20`、shared 依赖 range 统一。

### Phase 1 — 收敛重复：shared 扩容（约 3–4 人日，发 shared minor + 各包跟进）

1. shared 源码先内部拆分：`schema.js` / `builders.js` / `guards.js` / `bytes.js` / `validate.js` / `agentic.js` + barrel `index.js`（发布面不变，tsup 照常打包）。
2. **webpush 整栈入 shared**（或新 leaf 包 `amsg-webpush`）：instant/server 各删 355 行，server 保留 34 行 `createWebCryptoWebPush` 薄包装；测试采用 instant 侧的强套件（含 RFC 8291 解密验证）。
3. **bytes/crypto utils 补全入 shared**：`bytesToBase64Url`/`bytesToBase64`/`hexToBytes`/`bytesToHex`/`hmacSha256` 等；删除 `instant/src/utils.js`、`server/.../webcrypto-utils.js` 本地副本、client 三个私有编解码方法、`tenant/token.js` 与 `blob-store.js` 的本地 base64url。
4. **LLM 调用器入 shared**：`normalizeAiApiUrl` + `buildAiRequestBody` + 参数化 `callLlm({ requireContent, timeoutMs, fetchImpl })`；一次性消除 4 处漂移（`stream:false`、`messages:[]`、timeout、trim）。
5. **messages 数组校验入 shared**：以 instant 超集版本为准（含 tool_calls / role:tool），server 侧立即获得 agentic 会话回放能力。
6. **线协议常量入 shared**：`MULTIPART_*` 全家、`_blob` 信封 builder/guard、`REI_AMSG_POSTMESSAGE_TYPE`/`REI_SW_EVENT`/`REI_SW_MESSAGE_TYPE`；sw/client/instant 全部改 import。
7. 默认句子切分器入 shared；`SLEEP_BETWEEN_MESSAGES_MS`（现有 3 份）随迁。
- 验收：`grep -r "keep in sync\|lockstep" packages` 归零；instant↔server 无 100 行以上相似文件。

### Phase 2 — 结构重组（约 4–6 人日，行为保持重构，测试不动仍绿）

1. **拆 `sw/src/index.js`**：`constants` / `install` / `notify` / `dedupe` / `multipart` / `outbox` / `idb` / `util` 八模块；IDB 管道参数化合一（`openDatabase({name,version,upgrade,cache})` + `withStore` + 单套 CRUD），并显式决策 `oncomplete→resolve` 行为要不要全体采用。
2. **拆 `client/src/index.js`**：`types` / `sse` / `compress` / `crypto` / `delivery` / `transport` / `server-api` + 薄 index；`consumeInstantStream` 改走 `_runInstantTransport`（消除 err.status 漂移）；提取 `_encryptedHeaders()` / `_decryptEnvelope()`（现有 8 处头部三件套与 2 处 10 行解包重复）。
3. **拆 `instant/src/index.js`**：`handler` / `sse-transport`（SSE 引擎出闭包，可单测）/ `auth` / `http` / `options` / `blob-endpoint`；multipart 选项解析只留抛错版；`validateContinuePayload` 与 `validateInstantPayload` 抽公共字段校验。
4. **server 包**：`src/server/` 扁平化为 `src/`；单用户文件归拢 `src/single-user/`；pg/neon 抽 `PostgresBaseAdapter`；handler 统一为 `handler({ url, headers, body })` + `ok()/err()` helper（`err` 已在 client-state.js 存在，提级即可）；update-message 的 55 行内联验证收敛进 `lib/validation.js`。
- 验收：单文件 ≤ 500 行；全测试绿。

### Phase 3 — 双轨对齐与文档（约 2–3 人日，含一次产品决策）

1. **多租户/单用户契约决策**（A9）：要么 README 声明多租户线 feature-frozen，要么把 `capabilities`/`vapid-public-key`/`client-state`/`hooks`/`claimLeaseMs` 提升进 `createReiServer`；同时统一 init 状态码与 handler key、引入 `withErrorBoundary` 统一错误边界、修 CF worker 500 丢 CORS。
2. **规范升级**（A5）：起草 spec v2.5——补 6 项已发布能力 + 单用户路由前缀规则；`send-notifications-scheduled` 脚注为"实现方自备胶水"或补实现；撤销 examples 同构声明；`/instant`、`/continue` 从"见 instant README"升为规范正文。**必须在 `changeset pre exit`（切稳定版）之前完成**，让规范与稳定版同落。
3. **examples/ 处置**（B5）：建议删除、README 留一段"用 SDK"指针（git 历史可查）；次选改为 import `createReiServer` 的薄包装使其无法再漂移。tests/ 同步处置（改名 e2e-smoke 并声明非 CI，或随 examples 一起删）。
4. **文档修复**：VERCEL_TEST_DEPLOY 的 secrets 语法更新；RELEASING.md 补 pre 模式章节（进入/发布到 next tag/退出流程）；shared README 三处与代码矛盾修正 + 后半文件 14 个导出补文档；client README 补 5 方法；server README 补 `./cloudflare` 子路径与导出全集；docs/superpowers 的设计 rationale 移入 `docs/design/` 后删除原始规划文件。

### Phase 4 — 防回归基础设施（约 2 人日 + 持续）

1. **上 lint/format**（ESLint + Prettier 或 Biome）接入 `npm run ci`；CI matrix `node: [20, 22]`（当前 CI 用 20、发布用 22.22.3，测试的不是发布的工具链）。
2. **契约测试**：schema.js 与 schema.sqlite.js 列名/索引名集合相等断言；各包公开导出面 pin 测试（`Object.keys` deep-equal）；multipart/postMessage 常量一旦入 shared 自动免疫。
3. **测试补齐**（按 B7 优先级）：SW outbox 测试文件；dispatch.test.mjs 参数化跑 fake-indexeddb（helper 已存在）；instant blob store 契约测试（put/read/TTL 打一遍 6 个实现）+ node adapter 往返测试；`tenant/token.js` 过期/篡改直测。
4. **流程规则**：版本号只允许存在于 package.json 与 CHANGELOG（可在 check 脚本加 grep guard）；examples 若保留则给它至少 `node --check`。

### 顺序依赖

- Phase 0 与其他阶段无耦合，随时可做。
- Phase 1（常量/函数上移）必须先于 Phase 2 的文件拆分（否则同一批行改两遍）。
- Phase 3.2（规范补齐）是 `changeset pre exit` 的前置门槛。
- Phase 4.2 的导出面 pin 测试应在 Phase 2 拆分完成后落地（拆分期间导出面会动）。

---

## 根因回顾（防止问题再生）

1. **"keep in sync" 注释是本仓库最大的谎言来源**——4 处此类注释全部已失效或自相矛盾。规则：凡两个包需要同一段代码，它就属于 shared；不允许注释级同步。
2. **手写的版本号/导出清单必然腐烂**——5 处手写版本全部错误。规则：版本号只活在 package.json/CHANGELOG；导出清单用 pin 测试锁。
3. **双轨演化需要显式契约**——多租户 vs 单用户、examples vs SDK 都是"新功能只落一侧"的受害者。规则：每条轨道要么有 capability 对齐检查，要么明文宣布冻结。
4. **零工具链靠自觉**——B3/B4 的四种签名、三种信封正是没有 lint/评审基线的自然结果。
