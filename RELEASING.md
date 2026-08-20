# 发布流程

本仓库用 [Changesets](https://github.com/changesets/changesets) 管理版本号、CHANGELOG 和发布。六个包（`shared` / `client` / `instant` / `server` / `sw` / `blob-store`）各自独立版本。

## 怎么发版

1. **写 changeset**：在你的功能分支上跑

   ```bash
   npx changeset
   ```

   交互里勾选这次改动涉及哪些包、各自选 bump 级别（`patch` / `minor` / `major`），再写一句面向用户的变更摘要。命令会在 `.changeset/` 下生成一个 Markdown 文件，跟代码一起提交进 PR。

   > 只改文档、测试、CI 这类不影响发布产物的，可以不写 changeset。

2. **合并到 `main`**：你的功能 PR 正常评审、合并。

3. **「Version Packages」PR**：`main` 上一旦有待处理的 changeset，Release workflow 会自动开（或刷新）一个标题为 *Version Packages* 的 PR。这个 PR 会把 changeset 应用掉——按 bump 级别抬版本号、写进各包的 `CHANGELOG.md`、删掉已消费的 changeset 文件。`updateInternalDependencies: patch` 让被依赖包升版时，依赖方的内部依赖区间也跟着对齐。version 命令在 `changeset version` 之后还会跑 `npm install --package-lock-only` 刷新 `package-lock.json`，让锁文件里的 workspace 版本号与抬版后的 package.json 对齐，否则合并该 PR 后下一次 `npm ci` 会因锁文件过时而失败。

4. **合并「Version Packages」PR 即发版**：合并后，同一个 workflow 跑 `changeset publish`，把版本号领先于 npm 的包逐个发布（带 npm provenance），并推对应的 git tag。

## pre（`next`）模式

仓库可以进入 Changesets 的 pre 模式，把一段时间内的发布都打成预发布版：版本号带 `-next.N` 后缀、npm dist-tag 用 `next`，`latest` 停在进入 pre 模式前的稳定线上不动。`.changeset/pre.json` 存在且 `mode` 为 `pre` 就表示当前处于该模式（`tag` 字段是发布用的 dist-tag）。

- **进入**：在 `main` 上跑 `npx changeset pre enter next`，提交生成的 `.changeset/pre.json`。
- **pre 模式下发版**：流程与上文完全一样（写 changeset → 合并 → 「Version Packages」PR → 合并即发），区别只有版本号形如 `2.6.0-next.3`、发到 `next` dist-tag。用户装预发布版要显式指定：`npm install @rei-standard/amsg-client@next`。
- **退出（切回稳定版）**：跑 `npx changeset pre exit`，提交 `pre.json` 的变化，然后正常走一轮「Version Packages」PR——这一轮会把 pre 期间累计的所有变更收敛成一次稳定版发布（去掉 `-next.N` 后缀），发到 `latest`。

## 内部依赖区间

四个上层包对 `@rei-standard/amsg-shared` 用脱字号区间（以各包 `package.json` 里的实际区间为准）。在 0.x 上脱字号只放行同一 minor 内的补丁，所以 shared 出补丁时消费者自动跟随、不必协调重发；shared 升 minor 不会被自动选中，要消费者在自己的 changeset 里显式升级区间。

## 权限与密钥

发布走 npm 的 OIDC trusted publishing，不需要在仓库里配 `NPM_TOKEN`。Release workflow 申请了 `id-token: write` 权限并把 npm 升到 `>= 11.5.1`，发布时带 `--provenance`。前提是 npm 侧已为这些包配好 trusted publisher（指向本仓库的 Release workflow）。`changesets/action` 开 PR / 推 tag 用的是 GitHub 自带的 `GITHUB_TOKEN`。
