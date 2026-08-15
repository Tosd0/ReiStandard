---
"@rei-standard/amsg-server": patch
---

pg / neon 上 `runTask` 的退避守卫恢复生效；pg 连接池空闲连接出错不再拖垮进程

- **`runTask(ctx, uuid)` 在 pg / neon 部署上会重复触发还在等重试的任务。** 退避守卫读的是任务行的 `retry_after` 列，但这两个适配器取单条任务时的 SELECT 里没有这一列，守卫读到的永远是空值，等于没有守卫。结果是一条投递失败、正在退避窗口里等着的任务，每调一次 `runTask` 就立刻再跑一遍——LLM 重烧一轮、推送重试一次，重试计数也跟着涨，连按几次就把重试额度耗光，一次性任务直接进 failed。cron 那条路（`runScheduledTick`）一直是好的，只有 `runTask` 这个入口受影响；D1 部署不受影响。现在三个适配器的任务行列集收在一处共用，投递链路和读接口各一套，加列改一处就够，不会再出现「只有某一种数据库少一列」。

- **pg 适配器给连接池挂上了 `error` 监听。** 池子里空闲的连接被数据库那侧掐断时（主从切换、实例维护重启、`pg_terminate_backend`、网络中断），错误不在任何一次查询的调用栈上，业务代码的 try/catch 接不住；node-postgres 的连接池在没有监听时会把它抛成进程级未捕获异常，直接带走整个 Node 进程，日志里只留一句栈全在驱动内部的 `Connection terminated unexpectedly`。现在这类错误记成一条带 `[amsg-server pg]` 前缀的日志，出错的连接由连接池摘除，下一次查询自动重连，服务继续跑。Cloudflare Workers / Neon 的 HTTP 驱动是一次查询一个请求、两次之间不留连接，没有这个问题。

对调用方没有接口变化：方法签名、返回字段、配置项都不变。
