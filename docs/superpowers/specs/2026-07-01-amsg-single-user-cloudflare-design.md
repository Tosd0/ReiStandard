# amsg-server 单用户 · Cloudflare Worker 模式 设计稿

日期：2026-07-01
分支：`feat/amsg-single-user-cloudflare`

## 这是啥

给 `@rei-standard/amsg-server` 加一条「单用户」部署路径：整套服务跑在一个 Cloudflare Worker 上，定时任务（schedule）存进 D1，cron 用 CF 自带的 Cron Trigger 触发。目标是让「只有自己一个人用」的场景不用碰多租户那一套（租户注册表、Blob、租户 token），配几个环境变量就能起。

现状是 amsg-server 只有多租户模式：每个请求都要带租户 token，服务端验 token → 查 Netlify Blob 里的租户记录 → 拿到该租户的数据库连接和 masterKey。单用户模式把这一层换掉，其余照搬。

## 用在什么时候

- 自部署、单人使用，不需要多租户隔离
- 想白嫖 Cloudflare 全家桶（Worker + D1 + Cron Trigger），不想额外挂一个 Postgres 和外部定时器
- 愿意为「D1 落库数据」留一层加密（masterKey 放 env、密文进 D1，两边分家），换取 D1 单独泄漏时 LLM API key / prompt 不外泄

多租户 SaaS 场景继续用现有的 `createReiServer` + Neon/Pg，不受本次改动影响。

---

## 一、核心思路：只换 context 层

现有业务 handler 里，schedule-message / messages / update-message / cancel-message / get-user-key 这 **5 个**都通过 `ctx.tenantManager.resolveTenant(headers)` 拿到 `{ tenantId, db, masterKey }`。只要造一个**接口同构**的单用户版 context，这 5 个一行都不用改。

另外两个要单独处理（Codex review 后修正，原稿误把它们也算进「零改动」）：

- **init-tenant**：现有 `createInitTenantHandler` 不走 `resolveTenant`，它在调 `initializeTenant` 前就先校验 body 里的 `driver`/`databaseUrl`（多租户要连 Pg/Neon）。D1 单用户没这俩参数，没法零改动复用 → 单用户单独写一个「只建表」的 init 路由。
- **send-notifications**：它的批处理内核抽成 `runScheduledTick`（第三节）。单用户的定时**只走 CF Cron Trigger（`scheduled()`）**，**不暴露 HTTP 入口**（避免鉴权绕过，见下）。

### 单用户 context

新文件 `server/src/server/tenant/single-user-context.js`，导出：

```js
createSingleUserContextManager({ db, masterKey, serverToken })
```

暴露和多租户版一模一样的两个方法：

| 方法 | 多租户版（现状） | 单用户版（新） |
|---|---|---|
| `resolveTenant(headers, opts)` | 验 Bearer JWT → 查 Blob → 拿 db/masterKey | 配了 `serverToken` 就用 timing-safe 比对 `X-Client-Token` 头，没配就直接放行；返回固定 `{ ok:true, context:{ tenantId:'single', tokenType:'tenant', db, masterKey } }` |
| `initializeTenant()` | 建租户记录 + 建表 + 发 token | **只调 `db.initSchema()`**，返回 `{ tenantId:'single' }`，不发任何 token |

要点：
- `db` 和 `masterKey` 由上层（Worker 入口）从 env + binding 拿好后直接传进来，context 内部不再查 Blob。
- `serverToken` 没配 = 端点开放；配了 = **所有暴露出去的 HTTP 端点**都要带 `X-Client-Token: <serverToken>`，用**可移植的 constant-time 比较**防时序侧信道。**没有免验的后门**。
  - 注意（验证后修正）：别用 Node 的 `crypto.timingSafeEqual`（Worker 上有返回 undefined 的历史 bug），也别用 CF 的 `crypto.subtle.timingSafeEqual`（Node 没有）。这个文件测试跑在 Node、生产跑在 Worker，两边都要过 → 写一个基于 Web Crypto（`crypto.subtle` 两边都有）的双 HMAC 比较，或手写定长常数时间比较。
- 单用户不暴露 HTTP `send-notifications`，所以不存在「`allowCronToken:true` 要不要放行」这种口子。定时只由 CF `scheduled()` 触发（CF 平台内部直接调，不经过 HTTP，天生外人碰不到）。

### 单用户入口

新文件 `server/src/server/single-user.js`，导出：

```js
createSingleUserServer({ vapid, masterKey, serverToken, db, webpush })
```

和 `createReiServer` 并列。内部组装出和多租户版同形的 `ctx`（把 `tenantManager` 换成单用户 context，`webpush` 换成注入进来的推送实现，见第四节），返回同样的 `{ handlers }`。

---

## 二、D1 adapter

新文件 `server/src/server/adapters/d1.js`，导出 `createD1Adapter(db)`（`db` 是 CF 的 D1 binding，即 `env.DB`），实现 `DbAdapter` 接口全部 13 个方法。

**不塞进现有 `createAdapter` factory**：factory 硬要求 `connectionString`，而 D1 只有 binding 对象，没有连接串。单用户 context 直接调 `createD1Adapter(env.DB)`。`createD1Adapter` 从 `index.js` 单独导出即可。

### SQLite 方言 schema

现有 schema 是 Postgres 方言，D1 是 SQLite，另存一份 `server/src/server/adapters/schema.sqlite.js`：

```sql
CREATE TABLE IF NOT EXISTS scheduled_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  uuid TEXT,
  encrypted_payload TEXT NOT NULL,
  message_type TEXT NOT NULL CHECK (message_type IN ('fixed','prompted','auto','instant')),
  next_send_at TEXT NOT NULL,                 -- ISO8601 UTC 字符串
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  retry_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,                    -- ISO8601 UTC，adapter 显式写入
  updated_at TEXT NOT NULL
);
```

索引沿用现有那 5 个（含 `uidx_uuid` 唯一约束、几个 partial index）——SQLite 支持 partial index 和 CHECK，SQL 基本能原样搬。

关键差异处理：
- **时间戳存 TEXT（ISO8601 UTC）**。ISO8601 带 `Z` 的定长格式（`YYYY-MM-DDTHH:mm:ss.sssZ`）字典序 = 时间序，所以 `next_send_at <= ?` 这种比较用字符串比就对。
- **时间戳必须归一化**：adapter 在写入 / 比较前一律 `new Date(v).toISOString()`，把带时区偏移（如 `+08:00`）的输入统一成 `Z` 形式。否则 `+08:00` 和 `Z` 混着存会让字典序比较出错。这条用测试钉住（混时区输入仍能正确比较）。
- `NOW()` / `INTERVAL '7 days'` SQLite 没有 → adapter 在 JS 里算好「当前 ISO」「截止 ISO」再 bind 进去。
- `SERIAL` → `INTEGER PRIMARY KEY AUTOINCREMENT`。
- `initSchema`：D1 一次 `prepare` 只能跑一条语句，建表 + 建索引拆成多条，用 `db.batch([...])` 或顺序 `.run()`。
- 建 / 删返回值：D1 `.run()` 返回 `{ success, meta:{ changes, last_row_id } }`。用 `meta.changes` 判断「删了几行」，用 `meta.last_row_id` 或 `RETURNING *` 拿新建行。

### 方法映射

13 个方法的 WHERE / SET 子句语义**逐条对齐现有 `pg.js`**（实现时对着 pg.js 抄，只换方言），返回的 `TaskRow` 形状必须和 Pg/Neon 完全一致：`id` / `retry_count` 是数字，时间戳是 ISO 字符串，其余是字符串。SQLite 原生返回类型正好对上（INTEGER→number，TEXT→string），不用额外转换。

几个重点方法：
- `getPendingTasks(limit)`：`WHERE status='pending' AND next_send_at <= ? ORDER BY next_send_at ASC LIMIT ?`，第一个参数 bind 当前 ISO。cron 内核重度依赖它。
- `createTask(params)`：`INSERT ... RETURNING *`（D1 支持 RETURNING）→ `.first()`。归一化 `next_send_at`，`created_at`/`updated_at` 写当前 ISO。
- `updateTaskById(id, updates)`：按 `updates` 里的键动态拼 SET，每次都带 `updated_at = <当前ISO>`，涉及 `next_send_at` 时归一化。
- `cleanupOldTasks(days)`：`DELETE WHERE status IN ('sent','failed') AND updated_at < ?`，bind「当前 - days」的 ISO，返回 `meta.changes`。

---

## 三、cron：抽出 tick 内核

现状：定时逻辑埋在 `handlers/send-notifications.js` 里——先 `resolveTenant` 验 cron token，再批处理待发任务（取 pending → 逐条处理并发 8 → 成功后按 recurrence 删除或改期 → 失败重试 → 清理旧任务）。

改造：把「验完 token 之后的批处理内核」抽成一个纯函数，放 `server/src/server/lib/run-tick.js`：

```js
runScheduledTick({ db, masterKey, vapid, webpush }) → { totalTasks, successCount, failedCount, ... }
```

- HTTP handler（多租户）：`resolveTenant` 拿到 `{db, masterKey}` 后调 `runScheduledTick`。多租户对外行为不变。
- CF `scheduled(event, env, ctx)`（单用户）：直接构造 `{ db: createD1Adapter(env.DB), masterKey: env.AMSG_MASTER_KEY, ... }` 调 `runScheduledTick`，**不需要 cron token**（CF 运行时直接触发，没有 HTTP 头）。

单用户**不提供** HTTP `/send-notifications`。原因：那条 HTTP 入口在多租户里靠 cron token 保护，单用户没这套 token，留着就等于一个免验的公开端点——谁都能打进来触发发消息、烧 LLM API key（Codex review 的 P1）。有 CF Cron Trigger 就够了，直接砍掉。

抽取前后多租户行为一致，用回归测试锁住（见第七节）。

---

## 四、CF 上的 Web Push（已知风险 + 方案）

**风险**：`web-push` npm 包在 CF Worker 上大概率跑不起来——它底层用 Node 的 `https.request`，而 CF Worker 出站只认 `fetch`，`nodejs_compat` 也不保证补齐 `https.request`。

**为什么现有代码能救**：server 的消息处理没有直接 `import 'web-push'`，而是把它当依赖注入——`ctx.webpush.sendNotification(subscription, payload)`。只要注入一个「行为兼容」的实现，消息处理逻辑一行不用改。

**方案**：在 server 里加一个自带的 Web Crypto 版推送模块 `server/src/server/lib/webpush-webcrypto.js`（照搬 instant `src/webpush.js` 那套 RFC 8291/8292 实现，纯 Web Crypto，能在 CF 跑）。它对外暴露和 `web-push` 兼容的接口：

- `setVapidDetails(subject, publicKey, privateKey)`
- `sendNotification(subscription, payload)`：成功正常返回；失败抛出带 `.statusCode` 的错误（现有失败处理会看 statusCode 判断 410 之类，得对齐）。

单用户 Worker 入口把这个模块当 `webpush` 注入给 `createSingleUserServer`；多租户路径继续用 `web-push` npm，不受影响。

**取舍**：和 instant 有一份重复实现，换来 server 不新增对 instant 的包依赖。后续若嫌重复，可把这套推送下沉到 `shared`，两边共用——本次不做（YAGNI）。

**实现时先验证**：搭个最小 Worker 实测 `web-push` npm 是否真的挂；若某些路径能用则相应简化。方案以「自带 Web Crypto 实现」为准，验证只为确认，不阻塞。

---

## 五、CF Worker 模板（对标 instant 的 sfworker）

新目录 `server/examples/cloudflare-single-user/`，和 instant 把 worker 当 example 放包内的结构对齐：

### `worker.js`

```js
export default {
  async fetch(request, env, ctx) { /* 小路由，分发到 handlers */ },
  async scheduled(event, env, ctx) { /* 直接 runScheduledTick */ },
}
```

- `fetch`：一个小路由，按 `METHOD + path` 把 CF `Request` 分发到 `createSingleUserServer(...).handlers` 对应的方法。每请求构造：`db = createD1Adapter(env.DB)`，`masterKey = env.AMSG_MASTER_KEY`，`serverToken = env.AMSG_SERVER_TOKEN`，`vapid` 从 env，`webpush = createWebCryptoWebPush()`。构造开销可忽略（对标 instant `createCloudflareWorker((env)=>config)` 每请求建 config 的做法）。
- 路由覆盖：`POST /init-tenant`（单用户专用建表路由，只跑 `initSchema`，幂等；配了 `serverToken` 也要带 `X-Client-Token`）、`POST /schedule-message`、`GET /messages`、`PUT /update-message`、`DELETE /cancel-message`、`GET /user-key`。**不含 HTTP `/send-notifications`**——定时只走 `scheduled()`。
- `scheduled`：直接 `runScheduledTick({ db: createD1Adapter(env.DB), masterKey: env.AMSG_MASTER_KEY, vapid, webpush })`，无需 token。

路由把 CF `Request` 适配成现有 handler 期望的入参——实现时对齐现有 handler 的调用约定（参考 `examples/api` 里 handler 是怎么被调的）。

### `wrangler.toml`

```toml
name = "amsg-single-user"
main = "worker.js"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "DB"
database_name = "amsg"
database_id = "<填你的>"

[triggers]
crons = ["* * * * *"]   # 按需，最小 1 分钟一跳
```

VAPID / masterKey / serverToken 走 `wrangler secret put`，不写进 toml。

### `schema.sql`

建表脚本，给愿意用命令行的人 `wrangler d1 execute amsg --file schema.sql` 用。内容 = 第二节的 SQLite 建表 + 5 个索引。

### 建表的两条路（都给）

1. **命令行**：`wrangler d1 execute amsg --file schema.sql`（主路径，一步到位）。
2. **HTTP 兜底**：部署后调一次 `POST /init-tenant`（内部只跑 `db.initSchema()`，`CREATE TABLE IF NOT EXISTS`，幂等可重复调）。给没有命令行环境的人用。若配了 `serverToken`，这个端点也要带 `X-Client-Token`。

### `README.md`

一页跑通：建 D1 → 建表 → 配 secrets（VAPID / masterKey / 可选 serverToken）→ `wrangler deploy` → 验证。

---

## 六、client 单用户档

现状：client 自己不带租户 token（假定有代理 / 拦截器注入 `Authorization: Bearer`）；加密路径要先 `init()` 拉 userKey。可选的弱密钥 `instantClientToken`（`X-Client-Token`）现在**只**加在 instant 明文路径上。

单用户服务端不验租户 token → client 加密路径本来就能原样跑。唯一要加的能力：**把共享密钥也带到 schedule / messages 这些路径**。

改法：`ReiClientConfig` 新增一个字段 `serverToken`（语义清楚、不动老的 `instantClientToken`）。配了 `serverToken` 就给 **amsg-server 自己的端点**（schedule / messages / update / cancel / user-key / init）加上 `X-Client-Token: <serverToken>` 头。加密、`userId`、`init()` 这些都不动。

**serverToken 不加到 instant 路径**（Codex review 的 P2）：instant 可能指向另一个 worker（`customBaseUrls.instant`）、用它自己的 `instantClientToken`，两者都落在同一个 `X-Client-Token` 头上，混用会打架（server 的 token 会顶掉 instant 的，或让 instant 收到错的密钥）。所以 serverToken 只管 amsg-server 端点，instant 路径继续用 `instantClientToken`，井水不犯河水。

---

## 七、测试（当回归守卫）

- **D1 adapter**：跑 13 方法的 CRUD；重点覆盖 `getPendingTasks` 的时间比较（含混时区输入归一化后仍正确）、`cleanupOldTasks` 的截止时间、`uidx_uuid` 唯一约束冲突。用 better-sqlite3 或 miniflare 的本地 D1 当测试后端。
- **`runScheduledTick` 抽取**：一个测试锁住多租户 `send-notifications` 抽取前后行为一致（能在抽取破坏行为时挂、抽对时过）。
- **单用户 context**：配了 `serverToken` → 缺头 / 错头拦截、对头放行；没配 → 直接放行；`initializeTenant` 只建表、不发 token。
- **鉴权无后门（P1 回归守卫）**：配了 `serverToken` 时，暴露的每个 HTTP 端点都要求带对的 `X-Client-Token`——用一个测试钉住「没有任何端点能免验触发」，防止将来又冒出个 `allowCronToken` 式的口子。
- **单用户 init 路由**：无参 `POST` 只建表、幂等可重复调；配了 `serverToken` 时缺 / 错 `X-Client-Token` 被拦。
- **Web Crypto 推送 shim**：接口和失败错误形状（`.statusCode`）与 `web-push` 对齐。
- **client**：`serverToken` 配了，**amsg-server 端点**的请求带 `X-Client-Token`，**instant 路径不带**（instant 仍用自己的 `instantClientToken`）；没配 serverToken 则 server 端点都不带。

---

## 八、文件清单（全在 amsg-server 包内，不新增包）

**新增**
- `server/src/server/tenant/single-user-context.js`
- `server/src/server/single-user.js`
- `server/src/server/handlers/single-user-init.js`（只跑 `initSchema` 的建表路由，不复用 `createInitTenantHandler`）
- `server/src/server/adapters/d1.js`
- `server/src/server/adapters/schema.sqlite.js`
- `server/src/server/lib/run-tick.js`
- `server/src/server/lib/webpush-webcrypto.js`
- `server/examples/cloudflare-single-user/{worker.js, wrangler.toml, schema.sql, README.md}`
- 对应测试文件

**改动**
- `server/src/server/handlers/send-notifications.js`：改成调 `runScheduledTick`
- `server/src/server/index.js`：导出 `createSingleUserServer`、`createD1Adapter`
- `client/src/index.js`：新增 `serverToken` 配置

---

## 九、环境变量 / 配置清单（单用户 Worker）

| 名字 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `DB` | D1 binding | 是 | D1 数据库绑定 |
| `AMSG_MASTER_KEY` | secret | 是 | 加密用主密钥，随机 32 字节 hex，生成后粘贴一次 |
| `VAPID_EMAIL` / `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | secret | 是 | Web Push VAPID |
| `AMSG_SERVER_TOKEN` | secret | 否 | 配了就校验 `X-Client-Token`，不配端点开放 |
| `[triggers] crons` | wrangler 配置 | 是 | cron 触发频率 |

---

## 十、非目标（YAGNI）

- 不做多用户 / 租户隔离（那是现有多租户模式的活）
- 不把 Web Crypto 推送下沉到 shared（先在 server 内自带，重复可接受）
- 不动多租户模式的对外行为
- 不做 D1 之外的单用户存储后端（KV / DO 等）
- 单用户模式下不引入租户 token / cron token 体系
