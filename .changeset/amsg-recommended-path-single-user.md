---
"@rei-standard/amsg-server": patch
"@rei-standard/amsg-client": patch
"@rei-standard/amsg-sw": patch
"@rei-standard/amsg-instant": patch
---

文档：新接入的推荐路径收敛到 amsg-server 单用户线

**接入这套 SDK 的标准四步**写进了工作区 README：部署 worker → 装 Service Worker + 订阅推送 → 发消息 / 排任务 → **应用启动时拉一次收件箱**。第四步以前只在 API 列表里有两行说明，现在 amsg-client README 有独立一节「上线补一次收件箱」，给出翻页、ack 顺序、去重的完整写法——到了客户端不会弹通知的内容只落收件箱、不发推送，少了这步就等于没有。

**amsg-client README 按这条线重排**：开头新增「先看你接的是哪条服务端线」，把 `scheduleMessage()`（含 `messageType: 'instant'`）+ 收件箱补拉这条摆在前面，`deliver()` / `sendInstant()` 收进 instant 那条线的说明里；「上线补一次收件箱」一节提到目录第二位、正文紧跟「快速使用」。`scheduleMessage()` 的 JSDoc（会出现在 IDE 悬浮提示和 `.d.ts` 里）同步改写成同一口径。

**amsg-server README 开头新增「两条部署线」**，把单用户线（D1）和多租户线（pg / neon）的能力差异摆成一张表：服务端收件箱和 `client_state` 目前只有 D1 适配器实现，多租户线上这两组端点返回 501，不会弹通知的 payload 也只能照旧推送。新接入走单用户线，README 也给了它一段快速使用。给 pg / neon 补收件箱记为待办。

**amsg-instant 标为维护态**：它是无后端场景的产物，没有数据库也就没有服务端收件箱，push 漏掉的内容补不回来。继续修，已经在用的部署照常工作，新接入不从它起步。amsg-sw README 的「生产推荐链路」一节据此改写成「Web Push + 上线补拉 + SW dedupe」。

**两份规范按同一条线重排**。API 规范：新增 §1.1「两条部署线」把单用户线和多租户线的差异摆成一张表；第 6 章端点清单补上单用户线独有的那几组端点（`outbox` / `push-subscription` / `vapid-public-key` / `client-state` / `llm-credentials` / `capabilities`）；新增 §6.7「服务端收件箱与到达保证」，收件箱的两个端点、落行时序、哪些 payload 发推送、ack 顺序都在那一节；§10 补上 10.1 单用户线的对接流程（部署三步 + 客户端四步），原有的多租户流程顺延；§12 DoD 分成「两条线通用」与「多租户线另需满足」两组，前者把实现服务端收件箱、按 §6.7 决定发不发推送列为要求。

Service Worker 规范第 0 章的最小示例补上「订 Web Push 并 `putPushSubscription()` 登记订阅」这一步，四步齐了；§4.1.1 的前台自绘一节写明它跟弹不弹系统通知是两件独立的事。
