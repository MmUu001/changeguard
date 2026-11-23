# Tarball 分发（试用/内部分发通道）

> 背景：npm 官方 registry 的账号注册通道当前不可用（注册界面拒绝新用户、且已无第三方
> 一键登录）。在恢复之前，试用版本通过 **tarball 直发** 分发——零注册依赖、零第三方
> 托管、收件人一条命令安装。

## 维护者：打一次包（一条命令）

```powershell
npm run publish:tarball                 # 产出到 ..\trial-kit\（仓库外）
node scripts/publish.mjs --tarball --dest D:\some\dir   # 或指定目录
```

该命令会：

1. 跑与 npm 发布**完全相同**的八项门禁（do not skip：build / typecheck / 全部测试 /
   tarball 完整性 7 文件 / 许可边界无 `dist/server` 泄漏 / 工作区干净 / HEAD 版本标签提示）；
2. `npm pack` 到目标目录；
3. **安装回验**——把刚打出的 tgz 装进临时 prefix，执行 `changeguard --version`，
   输出必须等于 `package.json` 的版本（这一项曾抓到「五个版本都显示 0.1.0」的硬编码 bug）；
4. 打印收件人安装两步命令。

> 每次切版后重跑一次；旧 tgz 可随时删除（源码在 git 里，tgz 可再生）。

## 试用包的边界（重要预期管理）

试用 tarball 是 **Apache-2.0 的 CLI 子集**：demo / scan / pr-preview / pr-open 可用；
serve（Web 控制台、多租户、计费、审计）属于专有分发，**不在包内**，执行会打印明确提示。
因此：收件人能获得「扫描 + HTML 报告」的核心价值，而 SaaS 后台完全不随包分发——
既符合双许可边界，也把分发给第三方时的暴露面压缩到开源许可允许的范围（包内不含
source map；dist/ 为未混淆编译产物，属于 Apache-2.0 分发的一部分）。

## 收件人：安装与核对

```powershell
npm install -g "<收到的 changeguard-0.6.1.tgz 路径>"
changeguard --version        # 必须显示 tgz 对应的版本号，否则反馈给分发者
changeguard scan <你的项目路径> --since 2025-01-01
```

要求：Node.js ≥ 22.13（`node --version` 查看）。本地运行，源码不出机器。

## 分发渠道（由分发者选择）

- 微信 / 邮件附件（tgz 约 130KB，任何渠道都无压力）
- 内网共享盘
- 网盘（注意：tgz 含完整源码，放第三方存储前自评风险）

## 与「npm publish」的关系

| 项 | tarball 分发 | npm publish |
|---|---|---|
| 门禁 | 同一套八项 | 同一套八项 |
| 额外检查 | 安装回验（版本一致性） | registry 版本可用性 + 发布后 view 验证 |
| 认证需求 | 无 | 必须先有 registry 账号/token |
| 收件人体验 | 两条命令（需先拿到文件） | `npm i -g changeguard` / `npx changeguard` |
| 自动更新/版本发现 | 无 | 有 |

**结论**：试用阶段（≤10 人）tarball 足够；商用分发仍是 npm（或私有 registry）的职责，
等注册通道恢复后 `node scripts/publish.mjs --apply` 即可切换。
