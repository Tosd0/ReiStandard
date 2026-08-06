---
"@rei-standard/amsg-instant": minor
---

导出 `validateClientAuth` / `DEFAULT_MAX_LOOP_ITERATIONS` / `CORS_ALLOW_HEADERS`；`cors.allowHeaders` 可配置

在同一个 worker 里挂自己路由的宿主，此前只能照抄本包内部的鉴权与 CORS 实现——抄的那份不会跟着上游修：

- `validateClientAuth(request, expectedToken)`：X-Client-Token 的独立校验口（presence 检查 + 常时比较，与 handler 内部同一套语义）。返回 `{ ok: true }` 或 `{ ok: false, status: 401, body }`，宿主直接用 body 造响应即可；expectedToken 为空 = 部署没配共享密钥，一律放行。
- `DEFAULT_MAX_LOOP_ITERATIONS`（= 10）：agentic 循环的默认轮数上限，之前只有内部默认值，宿主各写各的迟早对不上。
- `CORS_ALLOW_HEADERS`：本 handler 的允许头列表；`cors.allowHeaders` 现在可配置（宿主的路由多带自定义头时覆盖，不配就是导出的这一份）。
