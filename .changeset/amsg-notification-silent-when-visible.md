---
"@rei-standard/amsg-sw": minor
"@rei-standard/amsg-shared": minor
"@rei-standard/amsg-server": patch
"@rei-standard/amsg-instant": patch
---

`notification.silent` 新增 `"when-visible"`：前台安静、切后台照响

`silent` 管的是通知响不响铃、震不震，跟弹不弹（`show`）是两件独立的事。除了原有的 `true` / `false`，现在还认一个 `"when-visible"`：

| 值 | 行为 |
| --- | --- |
| 不配 / `false` | 正常响铃震动 |
| `true` | 一律不响 |
| `"when-visible"` | 有 `visibilityState === "visible"` 的窗口客户端时静音，没有就照常响 |

它是给「页面自己会把内容画出来」的那类消息准备的——聊天回复、即时对话这种用户按下发送就盯着屏幕等的。用户正看着页面时，内容页面已经渲染了，通知安静地进通知中心就够；人切后台或者锁了屏，这条照样响铃震动把他叫回来。

这一档只有 Service Worker 算得出来，跟 `show: "when-hidden"` 是同一个道理：发送端发推的那一刻并不知道用户此刻在不在前台，`silent: true` 一写死，切到后台收到的那条也不会响。实现上两者读同一份窗口可见性，一条 payload 只取一次结论，不会出现「按 A 时刻决定要弹、按 B 时刻决定静音」。

`true` / `false` / 不配的行为一个字没变。`@rei-standard/amsg-shared` 的 push builders 放行 `notification.silent: "when-visible"`，别的字符串照旧拒掉并在报错里列出合法取值；顶层 `payload.silent`（老 payload 的兜底档）与 `notification.silent` 读同一套规则。各包 README 与 Service Worker 规范里「前台自绘」的示例改用这一档。
