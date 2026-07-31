---
"@rei-standard/amsg-shared": patch
"@rei-standard/amsg-instant": patch
"@rei-standard/amsg-server": patch
"@rei-standard/amsg-client": patch
"@rei-standard/amsg-sw": patch
---

补齐许可证文件：每个包根目录加入 MIT LICENSE 文本（此前 package.json 声明 MIT 但 tarball 里没有许可证文件）。仓库层面确立双许可——代码 MIT、`standards/` 规范文本 CC BY-NC-SA 4.0，根 README 的许可一节与 npm 元数据不再互相矛盾。
