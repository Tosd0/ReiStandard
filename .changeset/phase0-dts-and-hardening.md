---
"@rei-standard/amsg-client": patch
"@rei-standard/amsg-instant": patch
"@rei-standard/amsg-server": patch
"@rei-standard/amsg-sw": patch
---

修复发布产物里损坏的 .d.ts：四个包此前用 tsup `dts: true` 处理 .js 入口，发出去的 .d.ts 是 JS 源码原文，TS 消费者 import 即报错。现改用 shared 同款两步构建（tsup 出 JS + `tsc --allowJs --emitDeclarationOnly` 出真声明），subpath 导出（server `./cloudflare`、instant `./adapters/*` `./blob/*`）的声明文件一并对齐。

amsg-server 另含两处加固：pg / neon 适配器的动态 UPDATE 列名补上与 D1 一致的白名单校验（此前直接插值进 SQL）；清理死代码（未引用的 `REQUIRED_COLUMNS`、`timingSafeEqualBytes`、schedule-message 的死分支与重复注释）。amsg-sw 清理 `createNotificationFromPayload` 永不触发的两处假值守卫。
