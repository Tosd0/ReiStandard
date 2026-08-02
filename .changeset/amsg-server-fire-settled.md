---
"@rei-standard/amsg-server": minor
---

新增 `onFireSettled`：一次 fire 无论什么结局都给一次收尾回执

`onAfterSend` 只走「有 push 要发」那条路。hook 判断这次不用说话（`onBeforeFire` 返回 `{ skip: true }`、或模型跑完后 `skip-push`）、以及链路中途抛错时，宿主收不到任何收尾信号——凡是「开始时占点什么、结束时放掉」的写法都会漏。两种典型漏法：角色在这次 fire 里用 `ctx.scheduleTask` 排了一条后续任务（任务行已经真的写进库了），但记账的代码挂在发送后，这次生成最终是空的就没人记，那条任务从此只活在数据库里——面板列不出、用户取消不掉，却照样到点触发；以及 fire 开头拿的锁没有可靠的释放点，一次 skip 就把资源占满整个 TTL。

config 顶层（与 `onAfterSend` / `onStaleSkip` 并列）挂 `onFireSettled`，**只要 `onBeforeFire` 被调用过就一定会被调用一次**：

```js
async onFireSettled(info) {
  // { task, status, skipReason, sentCount, total, iterations, error,
  //   scratch, readState, writeState }
}
```

`status` 四种：

| status | 什么时候 |
|---|---|
| `sent` | pushPayloads 全部发完（`sentCount === total`） |
| `skipped` | 这次不发。`skipReason` 区分是 `onBeforeFire` 直接 `{ skip: true }`（`'before-fire'`）还是模型跑完后判定不发（`'skip-push'`） |
| `failed` | 链路抛错，`error` 带原始错误。发到第 k 段挂了也是这个：`sentCount = k`、`total` 是原本要发的段数 |
| `not-handled` | `onBeforeFire` 返回 `null`，这条任务交还给排程时冻结的 prompt 老链路。那条链路不归 fire hook 管，它后面发没发出去不体现在这里 |

`onAfterSend` 的调用点和载荷都不变，两者分工是「发送回执」与「fire 结束信号」：正常发完时两个都会调，`onAfterSend` 在前，`scratch` 是同一个引用。没配 hooks 的部署、以及不需要 LLM 的固定文本任务不走 fire 这条路径，两个都不会调。`onFireSettled` 同样是 best-effort，自身抛错只记日志。

`GET /capabilities` 的 features 追加 `fire-settled-hook`。
