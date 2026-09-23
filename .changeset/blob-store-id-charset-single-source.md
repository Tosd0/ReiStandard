---
"@rei-standard/blob-store": patch
---

令牌 id 的字符集判定收到一处

`gc` / `content-scan` / `store` 三处此前各写了一份 `[A-Za-z0-9_]` 的判定，注释互相提醒「要和 `extractRefs` 保持一致」。GC 判断一个 Blob 能不能回收，靠的就是这几处规则完全一致。现在字符集只在 `token.js` 定义一次，四处判定都用它。行为不变，公共 API 没有变化。
