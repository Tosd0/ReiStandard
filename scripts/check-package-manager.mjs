import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// 守住「整个仓库只用 npm」这件事，免得发版时才暴雷。
//
// 发版时 `changeset publish` 会逐个进入 workspace 包目录，用
// package-manager-detector 探测该用哪个包管理器：它从包目录向上逐级查找
// lockfile，撞到的第一个就算数。于是有两类雷：
//   1) 根 package.json 没声明 packageManager —— 向上遍历可能撞到 CI 工作区
//      上层目录里的 pnpm-lock，把项目误判成 pnpm；
//   2) 某个包目录里混进了 pnpm-lock.yaml / yarn.lock 之类 —— 在该包当层就被
//      判成对应包管理器。
// 偏偏 changesets 探到 pnpm 后即使没装 pnpm 也不回退 npm，直接 spawn pnpm
// publish 报 ENOENT，发布卡在最后一步。
//
// 这个脚本把两类雷都钉住：根字段必须是 npm，且仓库里不许有外来 lockfile。

const rootDir = process.cwd();
const errors = [];

// —— 检查 1：根 package.json 必须把 packageManager 钉成 npm（向上遍历的最终兜底）——
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const pm = pkg.packageManager;
if (typeof pm !== 'string' || !pm.startsWith('npm@')) {
  errors.push(`根 package.json 的 "packageManager" 必须声明为 "npm@<version>"，当前为 ${JSON.stringify(pm)}。`);
}

// —— 检查 2：仓库里不许有非 npm 的包管理器信号文件 ——
// 只看 git 跟踪的文件，天然排除 node_modules、dist、独立 worktree 等。
const FOREIGN_FILES = new Set([
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'deno.lock'
]);
const tracked = spawnSync('git', ['ls-files'], { cwd: rootDir, encoding: 'utf8' });
if (tracked.status === 0) {
  const offenders = tracked.stdout
    .split('\n')
    .filter(Boolean)
    .filter((file) => FOREIGN_FILES.has(path.basename(file)));
  for (const file of offenders) {
    errors.push(`仓库里存在外来包管理器文件 ${file}，会让 changeset publish 在该目录误判包管理器并崩在 publish，请删除。`);
  }
} else {
  console.warn('[check:pm] 跳过外来 lockfile 扫描（当前目录不是 git 仓库）。');
}

if (errors.length > 0) {
  console.error('[check:pm] 发现问题：');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`[check:pm] OK - packageManager=${pm}，且仓库内无外来 lockfile。`);
