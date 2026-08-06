---
"@rei-standard/amsg-client": minor
---

`subscribePush()` 认出并重订浏览器给的死 endpoint，订阅成功就是真能收到推送

刚 `unsubscribe()` 过又马上 `subscribe()` 时，Chromium 那边旧订阅的待删除标记还没清干净，这一小段窗口期里它不去推送服务要新地址，而是直接给一个 `https://permanently-removed.invalid/...` 的占位订阅。`.invalid` 是 RFC 2606 保留顶级域，全球 DNS 永不解析。这种订阅结构上完全正常——有 endpoint、有密钥、`getSubscription()` 也认得——之前会被原样返回、登记到服务端，之后所有推送必然发不出去。表现是最难查的那一种：用户看到「订阅成功」，服务端也存下了，两边都没有任何报错，只是到点什么都收不到。

现在 `subscribePush()` 返回的订阅保证 endpoint 是活的：拿到占位订阅就先退掉它，等浏览器把标记清干净再重订，最多试三次（间隔 800ms、1600ms）。

- 三次都是占位订阅时抛错，`err.code === 'PUSH_ENDPOINT_ZOMBIE'`，`err.details` 为 `{ attempts, endpoint }`。SDK 不产出面向用户的提示文案——那句话该怎么说、用什么语言，由接入方按自己的产品和用户群决定。
- `pushManager.subscribe()` 自己抛的错（用户拒了通知权限、运行环境没有 Push API、VAPID 公钥不合法）原样往外抛，不重试：重试只会把同一个错误多抛两遍。
- 第一次就拿到活 endpoint 时只调一次 `subscribe()`，不产生任何额外等待，与之前一致。
