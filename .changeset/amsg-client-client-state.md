---
"@rei-standard/amsg-client": minor
---

新增 client_state 三方法，对接单用户 worker 的云端状态镜像（amsg-server 2.6.0 的 `/client-state` 端点）。

- `putClientState(entries)`：批量 upsert。一次请求发完全部变更（照顾 iOS 切后台前只有几秒的存活窗口）；请求体走既有加密链路（需先 `init()`），服务端按 `updatedAt` 最后写赢，重发旧批次无害。
- `getClientState(namespace)`：取一个 namespace 的全部条目，自动解密响应 envelope（同 `listMessages`）。
- `clearClientState()`：清空该用户全部云端状态（给设置页「清除云端状态」这类入口用）。

配了 `serverToken` 时三个方法都带 `X-Client-Token`。
