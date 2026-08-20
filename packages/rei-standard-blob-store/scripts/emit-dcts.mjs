// 把 dist/*.d.ts 逐个派生出 .d.cts 孪生文件，给 exports 的 require 分支当类型入口。
// 不能只是逐字拷贝：包是 type:module，.d.ts 一律按 ESM 口味解读——.d.cts 里的相对引用
//（`from "./store.js"`、`import("./gc.js")` 类型查询）若原样指向 .js，会解析回 ESM 口味
// 的 .d.ts，moduleResolution node16 的 CJS 消费端编译报 TS1479/TS1542。派生时把相对引用
// 改写成 .cjs 后缀，让它们解析到同目录的 .d.cts 孪生文件，整棵声明树都是 CJS 口味。
//（dist 里并没有 store.cjs 这些运行时文件——tsup 把运行时打成了 index.cjs 单文件，
//  这些 .cjs 引用只活在类型解析层，Node 运行时从不加载它们。）
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

for (const f of readdirSync('dist')) {
  if (!f.endsWith('.d.ts')) continue;
  const src = readFileSync(`dist/${f}`, 'utf8');
  // 只改相对引用（./ 或 ../ 开头且以 .js 结尾）；'react' 这类裸引用不碰
  const out = src.replace(/(["'])(\.\.?\/[^"']*)\.js\1/g, '$1$2.cjs$1');
  writeFileSync(`dist/${f.slice(0, -5)}.d.cts`, out);
}
