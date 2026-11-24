---
"@rei-standard/amsg-server": minor
---

`onBeforeFire` 的推迟可以把这次触发改到唤醒时刻

返回 `{ defer: { afterMs, reschedule: true } }` 时，一次性任务的 `next_send_at` 改成唤醒时刻、`retry_after` 清空，相当于把这次触发重新排到那个时刻。过期线（`staleAfterMs`，默认 60 分钟）从新时刻算起，推多少次都不会因为离最初的时刻太远而作废。适合发送时刻事先定不下来的提醒，比如「用户走开 5 分钟后提醒」。

不带 `reschedule` 的推迟行为不变。循环任务不认这个选项，照普通推迟处理。`GET /capabilities` 的 features 新增 `before-fire-defer-reschedule`。
