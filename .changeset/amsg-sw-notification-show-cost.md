---
"@rei-standard/amsg-sw": patch
---

通知显示策略文档写清 `notification.show: false` 的代价

订阅是按 `userVisibleOnly: true` 建的，那是跟浏览器约好每条 push 都会给用户可见反馈。应用在后台时收到 push 却不展示通知，Chrome 会替你弹一条通用的「此网站在后台更新了内容」，Firefox 对这类 push 有配额、超了直接退掉订阅，iOS 会吊销订阅——而掉订阅是静默发生的。README 的通知策略一节补上这段代价说明。

「前台自绘 Toast」的场景示例改用 `show: "always"` + `tag` 折叠 + `silent: true`：页面自绘照做（`postMessage` 跟弹不弹通知无关），系统通知被同 `tag` 的下一条覆盖掉，通知栏里始终只有一条。
