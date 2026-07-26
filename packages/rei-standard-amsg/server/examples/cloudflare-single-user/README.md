# 单用户 amsg-server · Cloudflare Worker

定时消息存 D1，定时投递用 CF Cron Trigger。适合只有自己一个人用、想全程跑在 Cloudflare 上的场景。

## 跑通步骤

1. 建 D1 数据库，把返回的 id 填进 `wrangler.toml` 的 `database_id`：
   ```bash
   wrangler d1 create amsg
   ```
2. 建表（二选一）：
   - 命令行：`wrangler d1 execute amsg --file schema.sql`
   - 或部署后调一次 `POST /init-tenant`（幂等；配了 serverToken 要带 `X-Client-Token`）
3. 配 secrets：
   ```bash
   wrangler secret put AMSG_MASTER_KEY      # 随机 32 字节 hex，见下
   wrangler secret put VAPID_EMAIL          # 例如 mailto:you@example.com
   wrangler secret put VAPID_PUBLIC_KEY
   wrangler secret put VAPID_PRIVATE_KEY
   wrangler secret put AMSG_SERVER_TOKEN    # 可选：共享密钥，配了才校验 X-Client-Token
   ```
   生成 `AMSG_MASTER_KEY`：
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
4. 部署：`wrangler deploy`

## 端点

`/get-user-key`、`/schedule-message`、`/messages`、`/update-message`、`/cancel-message`、`/init-tenant`、`/vapid-public-key`、`/client-state`、`/capabilities`。
**没有 HTTP `/send-notifications`**——定时投递由 CF Cron Trigger 直接触发 `scheduled()`。

`GET /vapid-public-key` 返回本 Worker 的 `VAPID_PUBLIC_KEY`，供前端创建 Web Push 订阅时作 `applicationServerKey`；未配置 VAPID 时返回 503。跟其它端点一样受 CORS 和 `serverToken` 约束。

`GET /capabilities` 返回 `{ serverVersion, features }`，给前端做特性探测：worker 部署版本落后时新功能只是探测不到，前端（`client.getCapabilities()`，打到老 worker 时返回 `null`）可以据此在设置页提示重新部署。feature 名如 `client-state` / `client-state-chunking` / `agentic-hooks`，随版本追加。

VAPID 和 webpush 都要配齐：定时投递（cron）和 `instant` 类型消息都靠它推送，缺了就发不出去。

## 客户端状态同步（/client-state）

这是啥：一张给客户端存状态的云端表。客户端平时把要给「fire 时刻 hooks」用的数据（最近聊天摘要、设置项……存啥由你定）批量同步上来，worker 触发定时任务时就能读到最新状态。一份活状态，按 namespace 组织，客户端是唯一写者。

| 端点 | 语义 |
|------|------|
| `PUT /client-state` | 批量 upsert。body =（加密后的）`{ entries: [{ namespace, key, value, updatedAt }] }`。`updatedAt` 是 epoch 毫秒，旧于库内的条目跳过（last-write-wins）；单条 `value` 默认最大 5MB（工厂配置 `maxStateValueBytes` 可调），单次 ≤ 200 条 |
| `GET /client-state?namespace=<ns>` | 取一个 namespace 的全部条目（解密后返回，响应加密） |
| `DELETE /client-state` | 清空该用户的全部状态（设置页做「清除云端状态」按钮用） |

`value` 是任意字符串（想存对象就自己 `JSON.stringify`），落库前用 per-user key 加密。鉴权和加密头跟其它端点完全一样。

大值不用自己切：超过 200KB 的 `value` 由 worker 切片跨行存储，读取（`GET` 和 hooks 的 `ctx.readState()`）拿到的是拼好的原值，客户端无感。批量上传里某条超限/非法只拒它自己，其余照常入库——有拒绝时响应带 `data.rejected`（逐条给 `index / namespace / key / code / message`），全部成功时响应形状不变。namespace / key 里不能带控制字符（`\u0000`-`\u001f`，库内部保留）。

## Fire 时刻 hooks（服务端工具循环）

这是啥：默认情况下，AI 类任务的 prompt 在排程那一刻就冻结进数据库，cron 到点后拿冻结文本调一次 LLM 就推送——上下文停留在排程时。配置 hooks 后，worker 会在**触发那一刻**现场组装 prompt，LLM 要查资料时直接在 worker 里执行工具、多轮循环，最后推送成品，全程不需要客户端在线。

啥时候用：任务触发离排程隔得久（比如每周提醒）、希望消息基于最新状态生成，或生成过程需要查数据（配合 `/client-state`）。不配 hooks 一切照旧。

```js
export default createSingleUserCloudflareWorker((env) => ({
  // ...其余 config
  hooks: {
    // 触发时组装 prompt。返回 null 则这个任务走冻结 prompt 老链路。
    // ctx: { task, userId, readState(namespace), now, scratch }
    //   task 是解密后的任务字段（不含 apiKey / pushSubscription）；
    //   自定义字段排程时放 metadata 里，这里原样读回。
    //   scratch 是本次 fire 的便签对象：在这里塞的东西，同一次 fire 的
    //   onLLMOutput / executeToolCalls 从 ctx.scratch 拿到同一个引用；
    //   fire 结束即丢弃，不落库、不跨 fire 共享。
    async onBeforeFire(ctx) {
      const notes = await ctx.readState('notes'); // [{ namespace, key, value, updatedAt }]
      return [
        { role: 'system', content: '你是一个提醒助手。' },
        { role: 'user', content: `根据这些记录写一条提醒：${notes.map(n => n.value).join('\n')}` },
      ];
      // 也可以返回 { messages, maxToolIterations, totalTimeoutMs } 按次放宽预算
      // 或返回 { skip: true }：这次不生成，零推送直接算成功结束（不调 LLM）。
      //   一次性任务照删、循环任务照推进到下次。适合排程后对话已有新进展、
      //   这条到点已多余的情况。
    },

    // 每轮 LLM 输出后分类。ctx 形状与 @rei-standard/amsg-instant 的
    // onLLMOutput 一致（sessionId / messages / llmResponse / llmOutputText /
    // iteration / metadata / contactName / avatarUrl），instant 的
    // classifier 可以直接拿来用。四种 decision：
    //   { decision: 'finish', pushPayloads }        → 推送这些 payload，结束
    //   { decision: 'tool-request', toolCalls }     → 交给 executeToolCalls 执行
    //     （也接受 instant 形状：pushPayloads 里带 tool_request push）
    //   { decision: 'continue', nextHistory }       → 换个 history 再来一轮
    //   { decision: 'skip-push' }                   → 这次不发，结束
    async onLLMOutput(ctx) {
      const toolCalls = ctx.llmResponse?.choices?.[0]?.message?.tool_calls;
      if (Array.isArray(toolCalls) && toolCalls.length > 0) {
        return { decision: 'tool-request', toolCalls };
      }
      return {
        decision: 'finish',
        pushPayloads: [{ messageKind: 'content', message: ctx.llmOutputText }],
      };
    },

    // 工具在 worker 里就地执行（触发时客户端多半不在线，没有人替你执行）。
    // 返回 OpenAI tool-result 形状；抛错的话错误文本会作为 tool result
    // 回填给 LLM，让它自己圆场，不会整条链失败。
    async executeToolCalls(toolCalls, ctx) {
      return Promise.all(toolCalls.map(async (call) => ({
        tool_call_id: call.id,
        role: 'tool',
        content: await runMyTool(call.function.name, call.function.arguments),
      })));
    },
  },
  maxToolIterations: 5,    // LLM 轮数上限（默认 5）
  totalTimeoutMs: 240_000, // 整链墙钟超时（默认 240s）
}));
```

预算兜底：轮数到上限、或整链超过 `totalTimeoutMs`，按任务失败处理（沿用现有重试/标记逻辑）。hook 收到的 ctx 里没有 apiKey、pushSubscription、VAPID——`console.log(ctx)` 不会把密钥打进日志。

## 慢任务与 cron 占位

cron 一分钟一跳，跳与跳之间互不相让；带工具的任务跑过一分钟是常态。所以 `scheduled()` 每条任务开跑前会先占位：把库里的 `next_send_at` 顶到「现在 + 租期」，这一行在本次投递期间对下一跳不再是「到点待发」，抢不到的那一跳直接跳过这条。

租期默认 10 分钟，配了 `totalTimeoutMs` 就按它 + 2 分钟往上抬。想自己定就在 config 里加 `claimLeaseMs: 900_000`。`onBeforeFire` 里按次放宽的 `totalTimeoutMs` 占位时看不到，那种情况请显式设 `claimLeaseMs`。

`ctx.task.nextSendAt` 拿到的始终是这条任务原本的触发时刻，不是占位后的租期时间——拿它当时间锚点（窗口判断、缓存键）对得上。循环任务也按原始触发时刻推进到下一次。

## 导入入口

Worker 从 `@rei-standard/amsg-server/cloudflare` 导入（不是包根）。这个子路径只含单用户 + D1 + Web Crypto 推送那条路径，不牵扯 pg / neon / web-push，所以只装了 D1 的环境也能打包通过。

## 客户端

`@rei-standard/amsg-client` 配 `baseUrl` 指向本 Worker；若设了 `AMSG_SERVER_TOKEN`，client 也要配同样的 `serverToken`。

前端和 Worker 不同源时，浏览器会对带自定义头的请求发 CORS 预检。默认是同源、不开 CORS；跨源就在 config 里加 `cors`，填你的前端域名：

```js
export default createSingleUserCloudflareWorker((env) => ({
  // ...其余 config
  cors: { origin: 'https://你的前端域名' } // 或 '*'，或 (origin) => 允许的域名
}));
```
