---
"@rei-standard/amsg-client": minor
---

`avatarUrl` 本地预检改用 `@rei-standard/amsg-shared` 的统一校验，与 server / instant 对齐。现在非法（非 `data:`）URL —— 例如缺少协议的 `foo.com/a.png` —— 也会在客户端被 `console.warn` 并置空；此前 client 只检查 `data:` 与长度，会放行这类 URL（之后由服务端兜底置空）。装饰性字段不合法不会让整条请求失败的软清空策略不变。
