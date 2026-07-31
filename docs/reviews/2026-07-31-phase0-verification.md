# 2026-07-31 复查与 Phase 0 落地记录

对照 [2026-07-26 代码组织审查报告](./2026-07-26-code-organization-review.md)，在当前 `main`（fa7b63f，含 #32–#38 的 agentic-fire 系列合并）上逐项复核，并落地 Phase 0（止血）修复。

## 复查结论

自审查以来 `main` 只有 server 包的 agentic 功能演进，报告中的问题**除个别数字变化外全部仍然成立**：

| 项 | 状态 | 备注 |
|---|---|---|
| A1 损坏的 .d.ts | 仍在 → **本次修复** | 复测构建确认 client/instant 的 .d.ts 仍含 `new TextEncoder()` 等运行时语句 |
| A2 instant↔server 复制漂移 | 仍在，略扩大 | webpush 两侧 diff 仅 102 行（server 侧新增 66 行后仍 ~350 行逐字相同）；`stream:false`、messages 探测、tool_calls 校验漂移全部复现 |
| A3 SQL 白名单只在 D1 | 仍在 → **本次修复** | pg/neon 已补白名单 |
| A4 pg/neon 85% 重复 | 仍在 | 590 行中 diff 仅 80 行 |
| A5 规范双向脱节 | 仍在 | `send-notifications-scheduled` 仍 0 实现；capabilities/client-state/vapid-public-key/X-Client-Token 在两个规范文件中仍 0 提及 |
| A6 许可证矛盾 | 仍在（**待用户决策**） | 无 LICENSE 文件；5×MIT vs README CC BY-NC-SA 4.0 |
| A7 协议常量双写 | 仍在 | multipart 常量 instant 导出、sw 本地重写 |
| A8 client README 假事件形状 | 仍在 → **本次修复** | `event: 'DELIVER'` 改为真实的 `REI_SW_EVENT` 值并说明方向 |
| A9 多租户/单用户漂移 | 仍在 | capabilities/clientState/vapidPublicKey/hooks 仍只在 single-user 线注册 |
| B1 三个巨型文件 | 仍在 | 1679 / 1665 / 981 行 |
| B2 SW IDB 管道三份拷贝 | 仍在 | 仅 `withQueueStore` 设 `oncomplete` 的漂移复现 |
| B3 handler 四种签名 | 仍在 | legacy-shim 与 typeof-sniffing 均复现 |
| B5 examples 死代码 | 仍在 | `messageKind` 0 次出现；package.json 无 scripts |
| B6 手写版本号漂移 | 扩大 → **本次修复** | server 已到 2.6.0-next.9，README 表仍写 2.5.0；v2.0.1 文件头 15 处 |
| B7 测试盲区 | 仍在 | sw/test 仍无 ENQUEUE_REQUEST/FLUSH_QUEUE 引用 |
| B8 root tests/ 手动套件 | 仍在 | `read -p` 仍在 |
| B9 发布/运维文档过期 | 仍在 | pre 模式 RELEASING.md 仍 0 提及；`vercel secrets add` 仍在 |
| B10 instant 内部重复 | 仍在 | 两套 multipart 解析（严格 vs 静默）复现 |
| C1/C3/C4/C5/C7/C8 卫生项 | 仍在 | instant engines `>=18`、无 lint 配置、`.gitignore` 首行 `ref` 等均复现 |

## Phase 0 已落地（本分支）

1. **修复 .d.ts 构建**（A1）：client / sw / instant / server 四包复制 shared 配方——tsup `dts:false` + 各自新增 `tsconfig.json` 走 `tsc --allowJs --emitDeclarationOnly`，instant 增加 `scripts/finalize-dts.mjs` 把 `dist/blob-store/*.d.ts` 挪到 exports 对应的 `dist/blob/`。已用 TS 消费端冒烟验证 7 个入口（含 server `./cloudflare`、instant `./blob/memory` subpath）全部解析出真实类型。
2. **pg/neon 补列名白名单**（A3）：`UPDATABLE_COLUMNS` 定义进 `schema.js`（顶替 0 引用的死代码 `REQUIRED_COLUMNS`），两个适配器的 `updateTaskById` / `updateTaskByUuid` 与 D1 同款拒绝未知列。
3. **删手写版本号**（B6 部分）：包 README 版本表去掉版本列（指向 package.json / npm）；15 个 server 源文件的 `v2.0.1` / `v2.4.0` 文件头删除；RELEASING.md 不再写死 `^0.2.0`。
4. **修 client README 协议错误**（A8）。
5. **死代码清理**：`REQUIRED_COLUMNS`、server `timingSafeEqualBytes`（0 引用）、schedule-message 死分支 + 16 行重复注释、sw 两处永假守卫、`dispatchPushToClients` JSDoc 补第 4 参。保留 `dropSchema` / `getTaskByUuidOnly`（在适配器公开接口/仍有引用，按"Phase 0 无 API 变化"原则留给 Phase 2）。
6. 全仓构建 + 测试复跑全绿（187 + 232 + 68 + 56 等，0 失败）。

## 未落地、需要决策/后续阶段

- **许可证**（A6）：MIT vs CC BY-NC-SA 是业务决策，需要仓库所有者拍板后补 LICENSE 文件并统一 package.json / README。
- Phase 1–4（重复收敛、结构重组、双轨对齐、防回归）见原报告计划。
