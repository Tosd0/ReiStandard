import fs from 'node:fs';
import path from 'node:path';

// 根 package.json 必须把 packageManager 钉成 npm。
//
// 发版时 `changeset publish` 会用 package-manager-detector 探测当前用哪个包管理器，
// 而它会从当前目录向上逐级查找 lockfile。CI runner 的工作区上层目录里若存在
// pnpm-lock.yaml，就会被探到、把项目误判成 pnpm；偏偏 changesets 探到 pnpm 后即使
// `pnpm --version` 失败（runner 根本没装 pnpm）也不回退 npm，于是直接 spawn pnpm
// publish 报 ENOENT，发布卡在最后一步。
//
// 显式声明的 packageManager 字段优先级高于 lockfile 探测，能稳定钉成 npm。
// 这个脚本守住那一行，免得它被误删后只在发版时才暴雷。

const rootDir = process.cwd();
const pkgPath = path.join(rootDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const pm = pkg.packageManager;

if (typeof pm !== 'string' || !pm.startsWith('npm@')) {
  console.error(
    `[check:pm] 根 package.json 的 "packageManager" 必须声明为 "npm@<version>"，当前为 ${JSON.stringify(pm)}。`
  );
  console.error(
    '[check:pm] 缺了它，发版时 changeset publish 会把包管理器误判成 pnpm，并崩在 publish 步骤。'
  );
  process.exit(1);
}

console.log(`[check:pm] OK - packageManager = ${pm}`);
