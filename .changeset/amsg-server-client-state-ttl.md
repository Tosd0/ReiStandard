---
"@rei-standard/amsg-server": minor
---

`client_state` 支持按命名空间过期清理（config 的 `clientStateTtl`）

`client_state` 默认不过期，写进去的东西一直在——这对客户端同步上来的状态是对的，但「大内容旁路」那类用法写的是一次性内容：一条 push 塞不下的正文先写进状态、push 里只带一个引用键，客户端取走之后没人再回来删它，攒着白占库。

现在可以逐个命名空间配上天数，cron 每跳顺手清一次：

```js
clientStateTtl: {
  fire_pack: 7,     // fire_pack 下超过 7 天没更新的条目自动清掉
  scratch_pad: 1,
}
```

- 没写进配置的命名空间一个都不动，不配就是原来的行为；
- 判据是行本来就有的 `updated_at` 列，**不加列**——升级后老库不用改表结构；
- 大值分块存储的切片行跟着根行一起走，不留读不出来的垃圾行；
- 天数不是正数的条目跳过并告警一次；清理本身失败只记日志，不影响这一跳的投递。

要注意 `PUT /client-state` 和 `writeState()` 的条件写护栏（entry 上的 `version`）落的就是 `updated_at` 这一列：护栏值传自增计数器之类的小整数时，那行看起来就像 1970 年写的，第一次清理就会被扫走。给命名空间配 TTL 时，让它的写入方把 `version` 传成毫秒时间戳。

适配器接口新增可选方法 `cleanupClientState(targets)`（D1 已实现；没实现的适配器不清理）。特性位：`client-state-ttl`。
