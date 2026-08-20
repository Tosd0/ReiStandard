---
"@rei-standard/blob-store": patch
---

GC 的数字参数传成 NaN/null 会静默关掉新鲜豁免——现在改为直接抛 TypeError

`minAgeMs` / `now` 现在与 `refSources` 同款待遇：只接受不传（走默认值）或非负有限数字，NaN、null、Infinity、负数、数字字符串一律抛 `TypeError`，GC 不会带着坏配置开跑。

此前这两个参数没有校验：传成 NaN（宿主用算出来的值最常见，比如 `cfg.hours * 3600000` 而 `cfg.hours` 是 undefined）或 null 时，`now - ts < minAgeMs` 恒为 false，新鲜豁免整道阀静默失效——「已 put、引用还没落到任何持久化面」这个竞态窗口里的活图会被当孤儿删掉，且结果 `aborted: false`、和正常一轮毫无区别。这是防丢数据的修复，用算出来的值配 `minAgeMs` 的宿主升级后第一轮 GC 若见到 `TypeError`，说明此前的豁免一直没生效，去修配置来源即可。
