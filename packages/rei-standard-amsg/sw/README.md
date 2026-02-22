# @rei-standard/amsg-sw

`@rei-standard/amsg-sw` 是 ReiStandard 主动消息标准的 Service Worker 插件包。

## 文档导航

- [SDK 总览](../README.md)
- [主 README](../../../README.md)
- [Service Worker 规范](../../../standards/service-worker-specification.md)

## 安装

```bash
npm install @rei-standard/amsg-sw
```

## 使用

```js
import { installReiSW } from '@rei-standard/amsg-sw';

installReiSW(self, {
  defaultIcon: '/icon-192x192.png',
  defaultBadge: '/badge-72x72.png'
});
```

导出：

- `installReiSW`
- `REI_SW_MESSAGE_TYPE`

## 相关包

- 服务端 SDK：[`@rei-standard/amsg-server`](../server/README.md)
- 浏览器 SDK：[`@rei-standard/amsg-client`](../client/README.md)
