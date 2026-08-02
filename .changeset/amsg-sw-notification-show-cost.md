---
"@rei-standard/amsg-sw": patch
---

通知显示策略文档写清 `notification.show: false` 的代价

订阅是按 `userVisibleOnly: true` 建的，那是跟浏览器约好每条 push 都会给用户可见反馈。应用在后台时收到 push 却不展示通知，Chrome 会替你弹一条通用的「此网站在后台更新了内容」，Firefox 对这类 push 有配额、超了直接退掉订阅，iOS Web Push 可能撤销推送权限——而掉订阅是静默发生的。README 的通知策略一节补上这段代价说明，并写明 `"when-hidden"` 这一档是安全的（规范允许 user agent 在有可见窗口时免掉展示约束）。

「前台自绘 Toast」的场景示例从 `show: false` 换成 `show: "when-hidden"`：前台静默交给页面自绘、后台照弹系统通知，两边都不落空。
