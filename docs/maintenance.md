# 维护手册（项目稳定态交接）

> 状态声明（2026-11-17）：**v0.6.0 为稳定版本，项目进入维护模式。**
> 收敛条件已达：功能面完整、188 测试全绿、双绿门禁、四 tag 全部可复现、双许可边界
> 有测试守护。维护模式的含义：**只修 bug 与安全通告，不主动新增功能**；新功能须有
> 真实用户需求触发（当前卡在用户获取，而非工程）。

## 1. 十分钟接手清单

```powershell
cd D:\browser\guardddd\changeguard
npm ci                 # 装依赖（产出需 Node >= 22.13）
npm run check          # typecheck + lint + format:check + 188 测试，必须全绿
npm run demo           # 离线全流程冒烟（45 条 finding 附近，0 依赖配置）
npm run serve          # 控制台 http://localhost:8787（需 CHANGEGUARD_ALLOW_ANONYMOUS_CONSOLE=1 或口令）
```

## 2. 发版流程（每版固定动作，顺序不可乱）

1. 功能完成 → `npm run check` 全绿 → 提交
2. CHANGELOG：`[Unreleased]` 收口为 `[x.y.z] - 日期`，顶上留空的 `[Unreleased]`
3. `npm version x.y.z --no-git-tag-version`（同步 package.json + lock）
4. **`npm run build`**（重建 dist —— 发版铁律。vitest 走 tsx 读 src，不触发 build，
   dist 可能落后于源码）
5. `npm run check` 再跑一次
6. `npm run publish:tarball`（八项门禁 + 安装回验 + 产出 tgz 到 `../trial-kit/`）
7. `git commit chore(release): x.y.z` + `git tag -a vx.y.z`
8. `powershell -File scripts\backup-to.ps1` 刷新 bundle（有外部介质时加 `-AutoUsb` 或 `-Target`）

> npm registry 注册通道不可用期间，分发走 tarball（见 `docs/tarball-distribution.md`）；
> 账号恢复后 `npm run publish:check` → `node scripts/publish.mjs --apply` 即可切回。

## 3. 已知坑索引（全部实测踩过）

| 坑 | 详见 |
|---|---|
| pack 前必须 build（否则 dist 落后源码静默进包） | 本文件 §2.4 |
| 改 parser 后必须清 `.changeguard/cache` 再验证（缓存存**解析后**记录） | CHANGELOG 0.6.0 |
| 验签失败会静默回退快照（必须看日志行 `signed feed verified`） | `docs/feed.md` |
| tsx 服务无热重载，改 src 后需重启再验 | 本文件 |
| 种子记录必须带锚点（`operations[].sdkPaths` 或 `renames`），否则永不匹配=死数据 | `scripts/refresh-seeds.ts` 注释 |
| 试用包 = Apache-2.0 CLI 子集，`serve` 属专有分发不在包内 | `docs/tarball-distribution.md` |
| 本机 PowerShell 5.1 编码/引号/UTF-16/stderr 各类雷 | 运维脚本一律纯 ASCII + 用 node 脚本读写文件 |
| 模板字符串内嵌 `<script>`：JS 字符串里的 `\n` 要写 `\\n` | commit 3936e24 |
| `--version` 类元数据必须从 package.json 读（曾硬编码 0.1.0 五个版本） | commit 92446b1 |

## 4. 架构地图（改哪里看哪里）

| 层 | 目录 |
|---|---|
| 入口/CLI | `src/cli.ts` |
| 编排 | `src/scan.ts` |
| 分析 | `src/analyze/`（Tree-sitter 三语言）、`src/providers/`（数据驱动注册表） |
| 变更采集 | `src/ingest/`（GitHub Releases / OpenAPI diff / changelog HTML / note-parser / feed） |
| 影响引擎 | `src/impact/engine.ts`（R1–R9） |
| 输出 | `src/report/`（html / markdown / pr-draft） |
| 服务端（专有） | `src/server/`（dashboard / console-ui / api / billing / scheduler / legal） |
| 存储 | `src/store/`（sqlite / tenant / audit / apikey / billing） |
| 工具 | `src/util/`（logger / metrics / request-context / task-queue） |

### 边界铁律：付费与专有能力不进 npm 包

npm 包的边界 = Apache-2.0 的本地只读扫描能力（现有 63 文件）。以下内容**永远不进
`files` 白名单**：

- 服务端与控制台（`dist/server/**`、`dist/store/**`、manuals）——已由 publish 门禁
  的泄漏检查守护；
- 未来 Pro 许可证解锁的增强能力（付费 feed 订阅、团队规则同步、遥测、自动 PR 的
  付费档等）——实现时放**独立分发通道**（专有 tarball / 私有 registry），绝不复用
  npm 包的白名单；
- 反向守护：每次发布前 publish.mjs 的 mustHave 正向检查 + server/store 泄漏检查；
  未来新增专有模块时，同步在门禁追加对应的反向检查条目。

理由：CLI 开源是获客漏斗（允许他人合法使用甚至商用），商业价值在「数据 + 服务 +
持续更新」——这些只存在于专有侧。被复制一份静态 CLI 快照不影响护城河。

## 5. Backlog（有需求再做，无需求不做）

- R3/R9 之外的规则覆盖扩展（需真实误报率数据支撑）
- Go codemod（当前只报不改）
- seed 锚点人工标注（知识任务，`npm run feed:refresh` 有 74/80 待标注）
- 覆盖率 64% → 75%（采 `npm run test:coverage` 报告定位低覆盖模块）
- 自助删除租户已上线；剩余合规待办仅「正式法务审阅 + 真实联系邮箱」

## 6. 备份与恢复

- 备份：`scripts/backup-to.ps1`（git bundle 全量，`.keys/` 与 `.changeguard/` 不入库需单独保管）
- 恢复：`git clone <bundle>` → `npm ci` → `npm run check`（详细步骤见 `docs/backup.md`）
- **注意**：当前只有本机副本；异地化需外部介质（U 盘/移动盘/网盘，自行评估数据出境风险）

## 7. 交接注意

- git 提交身份仍为占位（`ChangeGuard Dev`），历史未改写；正式对外前可重新配置并改写
- 仓库未配置远程（刻意：用户要求不上公网）；CI 配置存在于 `.github/workflows/ci.yml`，
  推上远程即生效（首跑前确保 Node 版本矩阵为 22.x）
- 密钥：`src/ingest/feed-keys.ts` 内置 bootstrap 信任链；私钥在 `.keys/`（不入库），
  对外发布前按 `docs/feed.md` 重走密钥仪式并轮换
