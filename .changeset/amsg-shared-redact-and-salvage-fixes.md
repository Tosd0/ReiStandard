---
"@rei-standard/amsg-shared": patch
---

安全修复：跟模型 ID 同形的自定义网关 Key 不再被脱敏放行；截断的 Anthropic 信封不再把 providerCode 判成 `error`

**1. `redactCredentials`：全小写、短横线分段的 Key 补上两道判定（安全修复）**

脱敏的模型名白名单靠「全小写、被短横线切成短段」的形状放行，但自建网关发的 Key 里有一类同形的——前缀不在已知凭据名单里、随机段全落在 hex 字母表里（`mycorp-aaaabbbbcccc-ddddeeeeffff`）或只有一小段字母数字来回切（`mist-al7b-secret-key1`）——会原样放行。而这段文字正是落进 amsg-server `last_error` 明文列、也随 amsg-instant 跨域 502 响应体回给调用方的那段。影响面：用这类 Key、且上游 401 会把 Key 回显进报错（`Incorrect API key provided: …`）的部署，受影响版本里 Key 可能已经明文进过 `last_error`，建议轮换。`sk-` / `xai-` 前缀、uuid、大小写混排、带下划线这些形状一直都遮，不受影响。

现在这两类形状也遮：连续 hex 段累计超过 15 个字符就当密钥材料（模型名里最长的 hex 形状是 8 位日期段）；字母数字来回切三次以上的段只放行 `8x7b` 这种 MoE 尺寸段，`al7b` 这类随机段不再豁免。已知模型名（`gpt-4o-mini-2024-07-18`、`claude-3-5-sonnet-20241022`、`nous-hermes-2-mixtral-8x7b-dpo`、48 字符以上的长模型 ID）继续原样保留；判定拿不准时宁可误遮。

**2. 截断的 Anthropic 风格错误信封：providerCode 取里层的错误类别**

Anthropic 风格信封最外层的 `"type":"error"` 只说「这是一条错误」，真正的类别在 `error.type` 上。错误响应体超过 16KB 被截断、走容错提取时，最外层这个判别字段原来会抢先占住 `providerCode`，接入方拿到的是没法判的 `error`；现在跳过它，取里层真正的类别（如 `authentication_error`），跟不截断时的取值一致——靠 `providerCode` 停止重试鉴权失败的接入方不会再一直重试。
