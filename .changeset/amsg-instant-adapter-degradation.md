---
"@rei-standard/amsg-instant": patch
---

两个适配器的故障不再伪装成「服务不在」：Cloudflare 配置构建失败回可读的 500，Node 上的 SSE 真流式

**Cloudflare 适配器：`createCloudflareWorker` 的构建失败有了降级路径。**

`optionsBuilder` 抛错（wrangler.toml 里 binding 名字写错、preview 环境没配、secret 被重新部署刷掉）或 `createInstantHandler` 拒绝配置时，原来异常直接冲出 `fetch`。跨域前端只能读到一句 `TypeError: Failed to fetch`（Safari 是 `Load failed`），HTTP 状态码、错误码、错误信息一概拿不到；预检 OPTIONS 一起挂，浏览器于是根本不会发那条真正的 POST。运维从外面探测看到的就是「彻底离线且零报错」，而 Worker 其实部署成功、在跑，只是每次请求都在同一行抛。`blobStore` 和 `createCloudflareWorker` 一起用时尤其容易踩到——Workers 的 `env` 只在请求期可得，blob 存储的构造只能写在 `optionsBuilder` 里。

现在这条路径：

- 预检回 204，其余请求回一条能读的 500：`{ success: false, error: { code: 'INTERNAL_ERROR', message, cause } }`，`cause` 是机读的 `{ stage, name, message?, code? }`（`stage` = `'config'` 构建配置时炸的 / `'request'` handler 抛出来的），长得像凭据的串会先遮掉；
- CORS 头**回显来访的 `Origin`，不退化成 `*`**：配置都没建起来，这个部署允许哪些站点无从得知；配置一修好所有响应立刻回到 handler 自己那套 CORS；
- 回显 Origin 意味着任意第三方页面都能读到这条响应，所以构建失败那条路上跨域读到的 `cause` 只有 `stage` / `name` / `code`，不带 `message`——构建期异常的原文往往就是部署信息本身（`env.BLOB_KV is undefined` 报的是 binding 名，配置校验的报错里可能有内网域名、环境变量名）。同源请求和不带 `Origin` 的调用（`curl`、服务端之间调用）照旧拿全文；
- `Access-Control-Max-Age: 0`，故障期间答的那次预检不会留在浏览器缓存里；
- 同源调用（请求没有 `Origin` 头）依然一个 CORS 头都不加；
- 构建失败不被记住，下一个请求照常重试：binding 补上之后不用重新部署也能自己恢复。

真因除了随响应回给调用方，也照常记一行 `[amsg-instant] createCloudflareWorker:` 日志，`wrangler tail` 里能看到。

**Node/Express 适配器：`toNodeHandler` 改成边收边写。**

原来它用 `response.arrayBuffer()` 把响应整个读完再交给 Node，而 instant 的默认传输就是 SSE：客户端要等整轮 LLM + 全部推送跑完才收到第一个字节，`keepaliveMs` 心跳（默认 1 秒，本来就是为了防连接闲置被掐）全被压在缓冲里，慢一点的模型撞上 nginx 默认的 `proxy_read_timeout 60s` 就是 504——而响应头写的仍然是 `text/event-stream`，从外面完全看不出传输层已经降级。现在响应体一产出就往下写，心跳按时到达，反代也不会再把连接判死。

顺带的行为变化：

- 客户端提前断开时上游那个流会被 cancel，instant 据此停掉心跳定时器、把剩下的消息切到 Web Push 兜底，不再留一个没人读的流继续跑；
- 响应中途出错（字节已经发出去一部分）时连接直接断开，而不是在流里追加一个 JSON 错误信封再正常收尾——调用方能看出这是一条没收完的流；
- 所有响应改由 chunked 传输编码发出（原来单次 `end()` 会带 `Content-Length`）。JSON 模式（`Accept: application/json`）的状态码、响应头与响应体不变。
- 这条路由上别再套会缓冲响应的中间件：`compression` 默认连 `text/event-stream` 一起压，压缩缓冲区攒够才吐字节，等于把流式又压回非流式，用它的 `filter` 跳过该路由即可。

`toVercelNodeHandler` 就是同一个函数，一并生效。

**Node 适配器：响应流没写完就结束时留一行日志。**

`pipeline` 无论因为什么失败都会先把响应销毁，所以「响应被销毁了」分不出是客户端走了还是服务端自己的流炸了；客户端断开和服务端流中途失败给的也是同一个 `ERR_STREAM_PREMATURE_CLOSE`。分不出就不硬猜：这两种情况 socket 都已经没了，往上抛只会去写一个没人读的 500，所以记一条 `console.warn`（不是 `error`——用户随手关页面是家常便饭，记成故障会把日志淹掉）。socket 层明确的 `EPIPE` / `ECONNRESET` 是对端掐了连接，照旧安静收场；其余错误照常抛给外层。

**Cloudflare 适配器：请求阶段的兜底 500 走部署自己的 CORS。**

handler 建起来之后，「允许哪些 origin」就是已知的了，这条兜底 500 用的是部署配置的那套 CORS 头，跟正常响应一致。回显来访 Origin 的降级头只用在「配置都没建起来」那条路上——那时白名单确实无从得知。
