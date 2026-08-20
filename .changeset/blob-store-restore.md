---
"@rei-standard/blob-store": minor
---

新增 store.restore(token, blob)：备份导入按原令牌把 Blob 写回原 id，令牌身份不丢。校验令牌前缀与 id 字符集（字符集外拒收，防造出 GC 永不可回收的存量）；同 id 重复 restore 为覆盖，同一份备份导两遍幂等。
