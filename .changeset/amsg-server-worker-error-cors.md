---
"@rei-standard/amsg-server": patch
---

单用户 Worker 的错误响应补上 CORS 头，服务端异常不再伪装成网络故障

配了 `cors` 的部署里，之前只有正常响应带 `Access-Control-*`，Worker 内部抛异常时回的那条 500 是裸的。跨域前端拿到没有 `Access-Control-Allow-Origin` 的响应，浏览器会把整条丢掉，`fetch` 直接 reject 成 TypeError（Safari 显示 `Load failed`、Chrome 显示 `Failed to fetch`）。结果是**服务端故障在前端长得和「Worker 连不上」一模一样**：错误码、错误信息、HTTP 状态一概读不到，只剩一条「网络失败」。真实排查里，从外部探测该 Worker 一切正常（预检 204、401 都带 CORS 头），因为只有过了鉴权的请求才会走到抛异常那段。

现在异常 500 带上和正常响应同一份 CORS 头，前端能照常读到 `{ success: false, error: { code: 'INTERNAL_ERROR' } }`，剩下的真因去 `wrangler tail` 里看 `[amsg single-user] fetch() unhandled error:` 那行。

**配置构建失败也不再静默**。`buildConfig` 自己抛错时（少绑一个 binding、环境变量被重新部署刷掉），连 CORS 策略都无从得知，之前预检和真实请求会一起拿到裸 500——预检不是 2xx，浏览器根本不会发真正那条请求，整个部署在前端看来就是彻底离线且零报错。现在这条降级路径：

- 预检回 204，真实请求回一条能读的 500；
- CORS 头**回显来访的 `Origin`，绝不退化成 `*`**。这条路径的响应体是固定的错误信封，没有数据也不带 credentials，且只在配置炸了的时候生效——配置一旦能解析，所有响应重新由 `cfg.cors` 管辖，没配 CORS 的部署不会因为一次故障变成开放的；
- 同源调用（请求没有 `Origin` 头）依然一个头都不加，与其余路径一致；
- `Access-Control-Max-Age: 0`，故障期间答复的预检不进浏览器缓存，配置修好即刻失效。

没配 `cors` 的部署（默认同源）行为不变：OPTIONS 仍然走 404，响应仍然不带任何 `Access-Control-*`。
