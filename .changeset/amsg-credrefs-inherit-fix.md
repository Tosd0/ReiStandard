---
"@rei-standard/amsg-server": patch
"@rei-standard/amsg-client": patch
---

credRefs 继承按 chat 引用分支，空凭据任务响亮失败

`ctx.scheduleTask()` 的凭据继承改按 `credRefs.chat` 分支：父任务带 chat 引用 → 复制整份引用、内联置空（原行为）；父任务只带非 chat 引用（如仅 emotion）→ 引用与内联三件套**都**复制——此前对任何非空 credRefs 一刀切置空内联，会产出既无引用可解析又无内联凭据的空壳后代。

`prompted` / `auto` 任务 fire 时既无 `credRefs.chat` 也无内联三件套 → 按 `CREDENTIAL_MISSING` 失败进常规重试（此前会拿空凭据去撞 LLM 接口、报一句对不上号的 Invalid apiUrl）。`instant` 的「无凭据 = 纯推送」路由语义不变。

client 侧只改文档提法：可用性门槛引用 capabilities feature `'llm-credentials'`，不再写死版本号。
