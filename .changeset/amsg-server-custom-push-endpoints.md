---
"@rei-standard/amsg-server": patch
---

自定义前缀的推送地址照常登记

`PUT /push-subscription` 的 https 规则只管带主机名的地址。`fcm:<token>`、`bark:https://…` 这类不带主机名的自定义前缀地址照常登记，由宿主注入的推送通道（`webPush`）自己认格式；`file:`、`data:`、`blob:`、`javascript:`、`about:` 仍回 `400 INVALID_PUSH_SUBSCRIPTION`。升级前任务 payload 里冻结的老订阅走兜底读取时按同一规则判。
