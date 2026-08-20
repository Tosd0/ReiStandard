---
"@rei-standard/blob-store": patch
---

CJS 侧的 TypeScript 消费者现在编译得过了：exports 的 require 分支接上 CJS 口味的类型声明

此前 exports map 里 import / require 两个分支的 `types` 都指向 ESM 口味的 `dist/index.d.ts`（包是 `type: module`），`moduleResolution: node16` 的 TS 项目从 CJS 侧 require 本包会报 TS1479「The specifier only resolves to an ES module」——运行时的 `dist/index.cjs` 一直是好的，卡住的只是类型检查。`./react` 子路径同样。

现在根路径与 `./react` 的 import 分支 `types` 指 `.d.ts`、require 分支指 `.d.cts`（`types` 都放分支第一位）。`.d.cts` 生成时还会把声明里的相对引用（`./store.js` 等）改写成 `.cjs` 后缀，让整棵声明树都解析成 CJS 口味——此前 `.d.cts` 是 `.d.ts` 的逐字拷贝，相对引用解析回 ESM 口味声明，不开 `skipLibCheck` 的 CJS 消费端照样报错。ESM 侧不受影响。
