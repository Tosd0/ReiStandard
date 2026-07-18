---
"@rei-standard/amsg-shared": minor
"@rei-standard/amsg-server": minor
---

fire 级 scratch：hook 之间传上下文不再自己维护 Map

单次 fire 开始时库创建一个空对象，`onBeforeFire` 的 fireCtx 和同一次 fire 里每轮 `onLLMOutput` / `executeToolCalls` 的 sessionCtx 都拿到同一个 `scratch` 引用；fire 结束（finish / skip-push / 抛错 / 轮数超限）后随之丢弃。不落库、不进日志、不跨 fire 共享。amsg-shared 的 `buildSessionContext` 新增可选 `scratch` 参数（不传则字段缺席，amsg-instant 行为不变）。
