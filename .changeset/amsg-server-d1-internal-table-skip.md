---
"@rei-standard/amsg-server": patch
---

D1 的表结构自查跳过 Cloudflare 内部表，新建的库不再一查就报错

Cloudflare 会在每个新建的 D1 库里放一张自己的内部表 `_cf_KV`，而对它跑 `PRAGMA table_info` 会被 D1 的 authorizer 拒掉（`D1_ERROR: not authorized: SQLITE_AUTH`）。`describeSchema()` 会把库里的表挨个遍历一遍，走到这张表就整个抛出去，`getSchemaVersion()` / `ensureSchema()` 跟着一起废，宿主拿到的是「查不了表结构」。这张表只有新建的库才有、早先建的库没有，所以症状是新部署的后端一查就挂、老部署反而一切正常。

现在 `describeSchema()` 只认本库自己建的表，`sqlite_` 与 `_cf_` 开头的内部表一律跳过，返回的 `tables` 里也不会再出现它们。
