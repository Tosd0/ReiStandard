---
"@rei-standard/blob-store": minor
---

新增 @rei-standard/blob-store：令牌式 Blob 存储。core（适配器模式，不碰宿主 IndexedDB）+ 孤儿 GC（mark-and-sweep，多道安全阀，宁可留孤儿不删活图）+ /react 子路径（useBlobUrl）。
