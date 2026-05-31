# ReiStandard

**主动消息 API 标准**：让纯前端项目（小手机类）也能可靠地推定时 / 即时消息。端到端加密、Serverless 部署、三包接入。一个数据库就能持续跑，全程免费。

## 📦 包

| 包 | 版本 | 用途 |
|---|---|---|
| [`@rei-standard/amsg-shared`](./packages/rei-standard-amsg/shared/README.md) | `0.2.0` | 三轴推送契约（`AmsgPush` 判别联合 + builders + 类型守卫） |
| [`@rei-standard/amsg-instant`](./packages/rei-standard-amsg/instant/README.md) | `0.9.0` | 一次性即时推送（SSE 默认传输、always-on Web Push backup） |
| [`@rei-standard/amsg-server`](./packages/rei-standard-amsg/server/README.md) | `2.5.0` | 定时 / 周期消息，多租户 Blob 配置 + token 鉴权 |
| [`@rei-standard/amsg-client`](./packages/rei-standard-amsg/client/README.md) | `2.4.0` | 浏览器 SDK：加密、请求封装、Push 订阅、SSE consumer |
| [`@rei-standard/amsg-sw`](./packages/rei-standard-amsg/sw/README.md) | `2.2.0` | Service Worker：推送展示、离线队列、delivery dedupe |

`amsg-shared` 是依赖图最底层：其他四个包都依赖它，反过来不行；它本身零运行时依赖。

**怎么挑服务端包**：只发"按钮点了就立刻推一条" → `amsg-instant`；要定时或周期任务 → `amsg-server`；两种都要就都装，共用同一套 VAPID 与 masterKey。

### 协调发布说明：稳定版发布（shared 0.2.0 / instant 0.9.0 / sw 2.2.0 / client 2.4.0 / server 2.5.0）

本轮补上 SSE + Web Push backup 的同 key 去重链路，并将相关包作为稳定版发布。`amsg-server` 没有运行时行为改动，只做 shared 依赖协调发版。

- `@rei-standard/amsg-shared`：`0.1.0` → `0.2.0`
- `@rei-standard/amsg-instant`：`0.8.2` → `0.9.0`
- `@rei-standard/amsg-server`：`2.4.1` → `2.5.0`
- `@rei-standard/amsg-sw`：`2.1.1` → `2.2.0`
- `@rei-standard/amsg-client`：`2.3.0` → `2.4.0`

包间依赖一律使用**精确版本**（不带 `^`），避免 npm 在生态系统里解析出混版本图。本轮重点是：`amsg-instant` 默认 SSE 传输与 always-on Web Push backup、`amsg-client` 的 SSE consumer、`amsg-sw` 的 delivery dedupe / `REI_AMSG_DELIVER` bridge，以及 shared 的 `notification.silent` 类型补齐。

**安装最新版（`latest` dist-tag）**：

```bash
npm install @rei-standard/amsg-shared @rei-standard/amsg-instant @rei-standard/amsg-server @rei-standard/amsg-sw @rei-standard/amsg-client
```

## 三轴推送语义（Three-axis push schema）

每一条推送都由三个**正交**的维度描述。把"用什么方式发出去"（dispatch）、"业务命名空间"（business）、"载荷里装的是什么"（content）拆开，让一个 axis 加值的时候不需要动另外两个 axis。

| 轴 | 字段 | 取值 | 由谁定 |
|---|---|---|---|
| Dispatch | `messageType` | `instant` / `fixed` / `prompted` / `auto` | 包（固定枚举） |
| Business | `messageSubtype` | 任意字符串 | 调用方（自由命名） |
| Content | `messageKind` | `content` / `reasoning` / `tool_request` / `error` | 包（固定枚举） |

外加一个 `source: 'instant' | 'scheduled'` —— 路由来源（`instant` 来自 `amsg-instant`，`scheduled` 来自 `amsg-server` 的任何输出）。

**`messageKind` 四种值**（载荷里到底是什么）：

- `content` —— 最终面向用户的文本片段。携带 `message`、可选 `messageIndex` / `totalMessages`（N 段分句 burst 用）、`title`、`contactName`、`avatarUrl` 等。
- `reasoning` —— LLM 的思考过程（`choices[0].message.reasoning_content`）。携带 `reasoningContent`。**不带** `messageIndex` / `totalMessages`，因为推理是一轮 LLM 一条，不是分句 burst。
- `tool_request` —— Agentic loop 钩子返回的工具调用请求。携带 `toolCalls`（OpenAI `tool_calls` 透传形状），客户端执行后通过 `/continue` 恢复。
- `error` —— 生产端诊断错误（如 `HOOK_THREW` / `LOOP_EXCEEDED`）。携带 `code`、`message`、可选 `iteration`。**取代了 0.7.x 那个 `{ type: 'error', code: '...' }` 旧信封**。

**`messageType` 四种值**（怎么发出来的）：

- `instant` —— 一次性即时推送（`amsg-instant` 一发即走，无 DB、无 cron）。总是配 `source: 'instant'`。
- `fixed` —— 固定文本的定时任务（`amsg-server`，无 LLM）。
- `prompted` —— LLM 生成 + 定时调度（`amsg-server` 的 prompted 路径）。
- `auto` —— LLM 生成 + 自动周期（`amsg-server` 的 auto 路径）。

后三种 `messageType` 总是配 `source: 'scheduled'`。

**`messageSubtype`** 是调用方自有命名空间，框架不解读、不强约束格式（producers 默认填 `'chat'`）。业务侧爱怎么切就怎么切。

**`sessionId` 不变性**：同一个 LLM 轮次内自动发出的 `ReasoningPush` 和后续 `ContentPush` burst 共享同一个 `sessionId`；agentic-loop 路径下，同一个 `/instant` 请求的所有 iteration 也共享一个 `sessionId`。客户端可以靠 `sessionId` 把"思考中"UI 和真正回复拼回到同一条消息上。

字段表、builders（`buildContentPush` / `buildReasoningPush` / `buildToolRequestPush` / `buildErrorPush`）、类型守卫（`isContentPush` / `isReasoningPush` / …）与常量（`MESSAGE_KIND` / `MESSAGE_TYPE` / `PUSH_SOURCE`）的完整说明见 [`packages/rei-standard-amsg/shared/README.md`](./packages/rei-standard-amsg/shared/README.md)。

## 🚀 接入

1. 服务端：按你选的包打开它的 README，里面有环境变量、`createReiServer` / `createInstantHandler` 用法、各平台 (Netlify / Vercel / Cloudflare / Node) 的适配器。
2. 浏览器：装 `amsg-client` 和 `amsg-sw`，按 [Service Worker 规范第 0 章](./standards/service-worker-specification.md#0-快速接入路径推荐使用-sdk-包) 的最小示例接。

```bash
# 服务端选其一（或都装）
npm install @rei-standard/amsg-server
npm install @rei-standard/amsg-instant

# 浏览器
npm install @rei-standard/amsg-client @rei-standard/amsg-sw
```

数据库驱动按 `amsg-server` README 提示二选一（`@neondatabase/serverless` 或 `pg`）。

## 🗂 仓库布局

```text
ReiStandard/
├── standards/                   # 权威规范文本（端点、字段、错误码）
├── packages/rei-standard-amsg/  # 5 个发布到 npm 的 SDK 包
│   ├── shared/                  # 三轴推送契约（最底层，其他包都依赖）
│   ├── server/                  # 定时 / 周期消息（多租户 Blob + token）
│   ├── instant/                 # 一次性即时推送（无 DB / 无 cron）
│   ├── client/                  # 浏览器 SDK（加密、请求封装、Push 订阅）
│   └── sw/                      # Service Worker（推送展示、离线队列）
├── examples/                    # 手动接入示例（不用 SDK 包时的备用路径）
└── docs/                        # 本地测试、生产监控
```

## 📖 文档

- [API 技术规范](./standards/active-messaging-api.md) — 端点、字段、错误码、鉴权
- [Service Worker 规范](./standards/service-worker-specification.md) — SW 行为、消息协议、兼容性
- [手动接入示例](./examples/README.md) — 不用 SDK 包的备用路径（**滞后于最新 SDK 字段**，新接入请用包）
- [本地测试](./docs/TEST_README.md) · [生产监控](./docs/VERCEL_TEST_DEPLOY.md)

## ⚠️ 文档维护原则

本仓库是技术标准仓库。字段名、端点路径、数据结构、错误代码一旦定下来，除非修 bug 或经过评审，不应随意更改。发现问题请提 Issue 或在群里讨论。

## 📄 许可

CC BY-NC-SA 4.0（署名 - 非商业 - 相同方式共享）。

## 👥 致谢

本标准基于 Whale 小手机、糯米机 的主动消息实现经验。特别感谢：汤圆、脆脆机、koko、糯米机、33 小手机、Raven、toufu、菲洛图等老师的小手机项目的积极参与和支持。
