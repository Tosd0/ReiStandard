---
"@rei-standard/amsg-sw": patch
"@rei-standard/amsg-shared": patch
"@rei-standard/amsg-server": patch
"@rei-standard/amsg-instant": patch
---

通知策略统一成「要推就一定弹，不想弹就别推」

订阅是按 `userVisibleOnly: true` 建的，收到 push 却不弹通知，各家浏览器的处理不一样。iOS 那边实测下来是宽限期机制：订阅刚建好的几天里，发多少条不弹通知的 push 都不掉订阅（跟条数无关，只跟订阅建了多久有关）；宽限期一过，一条不弹的就立刻吊销；吊销后重新订阅，判定比第一次更严，之后随时可能再掉。最难查的是这个时间差——本地订阅完立刻测一轮都正常，上线几天后用户订阅才开始成片掉，而且掉订阅是静默的，服务端只看到推送返回 410。

于是通知策略的口径收敛成一条，跟客户端跑在什么设备上无关：**要推就一定弹**（`notification.show: "always"`，嫌打扰用 `tag` 折叠加 `silent: true`；弹通知不影响页面自绘，`postMessage` 照常派发），**不想弹就别推**（内容落服务端收件箱，客户端上线 `GET /outbox?since=` 补拉）。

`"when-hidden"` 标为兼容档：应用在前台时它就是一条不弹的 push，那笔账照记（规范允许 user agent 在有可见窗口时免掉展示约束，Chrome 认这条豁免，iOS 不认）。既有部署照常工作，新代码在上面两条里挑一个。文档里的场景示例统一改用 `"always"` + `tag` 折叠 + `silent: true`。

`show` 四个档各是什么、什么时候用，收进 `@rei-standard/amsg-shared` README 的「选哪个 `show`」一张表，其余包只留一句「兼容档，新代码不选」加链接。amsg-sw README 新增「不展示通知的代价」一节收口这套取舍，shared / server / instant / client 的相关段落指过去；Service Worker 规范同步新增 §4.1.2，正文与变更历史里的通知策略建议改用同一口径。纯文档改动，运行行为不变。
