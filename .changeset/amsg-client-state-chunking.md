---
"@rei-standard/amsg-server": minor
---

client_state 大值透明分块 + 整批局部失败（单用户 worker）

- `PUT /client-state` 单条 value 不再受 200KB 整批 413 的限制：超过 200KB 的值由服务端切片跨行存储，`GET /client-state` 与 hook 的 `ctx.readState()` 返回拼好的原值，客户端和 hook 作者无感。单条总上限默认 5MB，工厂配置 `maxStateValueBytes` 可调。切片在码点边界（中文 / emoji 不会被劈开）；覆盖写变小不残留旧切片；块不齐全（写到一半断了）时该 key 视为不存在，读方走自己的兜底。
- 整批局部失败：批里某条超限 / 非法只拒它自己，其余照常入库。有拒绝时响应带 `data.rejected: [{ index, namespace, key, code, message }]`；全部成功时响应形状与之前完全一致。
- namespace / key 里的控制字符（`\u0000`-`\u001f`）为库内部保留，逐条拒绝。
- adapter 的 `upsertClientState` 新增可选第三参 `cleanups` 与返回值 `outcomes`；自定义 adapter 不实现也能工作（只损失存储卫生，不影响正确性）。
