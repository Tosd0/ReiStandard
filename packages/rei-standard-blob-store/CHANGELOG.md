# @rei-standard/blob-store

## 0.1.0-next.1

### Minor Changes

- 9a852de: 新增 store.restore(token, blob)：备份导入按原令牌把 Blob 写回原 id，令牌身份不丢。校验令牌前缀与 id 字符集（字符集外拒收，防造出 GC 永不可回收的存量）；同 id 重复 restore 为覆盖，同一份备份导两遍幂等。

## 0.1.0-next.0

### Minor Changes

- 97d7138: 新增 @rei-standard/blob-store：令牌式 Blob 存储。core（适配器模式，不碰宿主 IndexedDB）+ 孤儿 GC（mark-and-sweep，多道安全阀，宁可留孤儿不删活图）+ /react 子路径（useBlobUrl）。
