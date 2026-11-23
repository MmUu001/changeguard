# 发布到 npm（首发与后续版本）

> **注册通道不可用时**：scripts/publish.mjs --tarball 走同一套门禁产出可直接分发的 tgz，
> 详见 docs/tarball-distribution.md。本文档在拿到 npm 账号后按流程执行即可。

> 前置事实（2026-11-15 实测）：`registry.npmjs.org` 可达（PING 962ms）；
> `changeguard` 包名未被占用；本机浏览器 OAuth 回调不可用——所以**不需要**
> `npm login` 的浏览器流程，全程用 Access Token。

## 1. 创建 token（npmjs.com，约 5 分钟）

1. 登录 [npmjs.com](https://www.npmjs.com)（无账号先注册并完成邮箱验证）。
2. 头像 → **Access Tokens** → **Generate New Token** → **Granular Access Token**。
3. 设置：
   - **Token name**：`changeguard-publish-local`
   - **Expiration**：30 days（用完可再建；长期用再改 90 天）
   - **Permissions**：`Read and write`
   - **Packages and scopes**：`All packages`（或仅 `changeguard`），勾选 **Publish**
4. **立即复制 token**（`npm_...` 开头，只显示一次）。

> 为什么不用 Classic Token：Granular 可以限定包范围与权限，泄露面更小。
> 为什么不需要 2FA 交互：Granular token 在发布时替代交互式 2FA（npm 规则）。

## 2. 本地配置（PowerShell，写入用户级 .npmrc，不进任何仓库）

```powershell
npm config set //registry.npmjs.org/:_authToken=<粘贴 npm_... token> --location=user
npm whoami --registry=https://registry.npmjs.org     # 应回显你的 npm 用户名
```

**关键坑**：本项目 `.npmrc` 指向 npmmirror（国内镜像），它没有 publish 能力。
所以所有发布/查询命令都必须显式带 `--registry=https://registry.npmjs.org`
（`scripts/publish.mjs` 已内置，无需手动）。

## 3. 发布（唯一受控入口）

```powershell
npm run publish:check            # 干跑：8 项门禁逐条验证，不发布
node scripts/publish.mjs --apply # 门禁全过后真正发布
```

门禁清单（任何一项失败即拒绝发布）：

| # | 检查 | 通过条件 |
|---|---|---|
| 1 | npm 认证 | `whoami` 成功 |
| 2 | 版本可用 | 该版本号在 registry 上不存在 |
| 3 | 工作区 | `git status` 干净 |
| 4-6 | build / typecheck / tests | 全绿 |
| 7 | tarball 完整性 | `dist/cli.js`、`data/providers/*`、LICENSE×2、SECURITY.md、README、CHANGELOG 全在 |
| 8 | 许可边界 | tarball 不含 `dist/server/**`、`dist/store/**` |

> 注意：门禁检测到工作区脏会拒绝——**先提交，再发**。
> HEAD 无对应 tag 只会提示不阻塞（惯例是发完再打 tag，或先打 tag 再发均可）。

## 4. 首发后验证

```powershell
npm view changeguard version --registry=https://registry.npmjs.org
npx --yes changeguard@0.5.0 --version
npx --yes changeguard@0.5.0 demo --out .\npx-smoke
```

## 5. 回滚知识（重要）

- **24 小时内**：`npm unpublish changeguard@x.y.z --force` 可删除版本。
- **24 小时后**：不能删除，只能 `npm deprecate changeguard@x.y.z "reason"` 标记弃用。
- **版本号不可复用**：已发布的版本号永远不能再次发布（哪怕已 unpublish）。

## 6. Token 泄露处置

1. npmjs.com → Access Tokens → 立即 **Revoke**；
2. 检查最近发布记录（本包只有 `changeguard` 的版本列表）；
3. 重新创建 token 并更新本地 `npm config`。

> 本机执行 `npm config set --location=user` 后，token 存在用户级 `~/.npmrc`。
> 如需彻底清除：`npm config delete //registry.npmjs.org/:_authToken --location=user`。
