# 发布流程

本仓库用 [Changesets](https://github.com/changesets/changesets) 管理版本号、CHANGELOG 和发布。五个包（`shared` / `client` / `instant` / `server` / `sw`）各自独立版本。

## 怎么发版

1. **写 changeset**：在你的功能分支上跑

   ```bash
   npx changeset
   ```

   交互里勾选这次改动涉及哪些包、各自选 bump 级别（`patch` / `minor` / `major`），再写一句面向用户的变更摘要。命令会在 `.changeset/` 下生成一个 Markdown 文件，跟代码一起提交进 PR。

   > 只改文档、测试、CI 这类不影响发布产物的，可以不写 changeset。

2. **合并到 `main`**：你的功能 PR 正常评审、合并。

3. **「Version Packages」PR**：`main` 上一旦有待处理的 changeset，Release workflow 会自动开（或刷新）一个标题为 *Version Packages* 的 PR。它把 changeset 应用掉——按 bump 级别抬版本号、写进各包的 `CHANGELOG.md`、删掉已消费的 changeset 文件。`updateInternalDependencies: patch` 让被依赖包升版时，依赖方的内部依赖区间也跟着对齐。

4. **合并「Version Packages」PR 即发版**：合并后，同一个 workflow 跑 `changeset publish`，把版本号领先于 npm 的包逐个发布（带 npm provenance），并推对应的 git tag。

## 内部依赖区间

四个上层包对 `@rei-standard/amsg-shared` 用 `^0.2.0`。在 0.x 上脱字号只放行同一 minor 内的补丁（`0.2.x`），所以 shared 出补丁时消费者自动跟随、不必协调重发；shared 升 minor（如 `0.3.0`）不会被自动选中，要消费者在自己的 changeset 里显式升级区间。

## 权限与密钥

发布走 npm 的 OIDC trusted publishing，不需要在仓库里配 `NPM_TOKEN`。Release workflow 申请了 `id-token: write` 权限并把 npm 升到 `>= 11.5.1`，发布时带 `--provenance`。前提是 npm 侧已为这些包配好 trusted publisher（指向本仓库的 Release workflow）。`changesets/action` 开 PR / 推 tag 用的是 GitHub 自带的 `GITHUB_TOKEN`。
