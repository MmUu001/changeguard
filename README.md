# ChangeGuard 变更哨兵

> **一句话**：盯住 Stripe / OpenAI / Shopify / Twilio / Supabase 五家厂商的破坏性变更，自动扫描你的 TS / JS / Python / Go 代码定位影响点，输出可追溯的报告、PR 草稿与 codemod 补丁，Slack / Email 即时推送。判定由确定性规则引擎完成，LLM 可选润色。

- 零原生依赖：Node.js ≥ 22.13（`node:sqlite` 要求）+ 4 个纯 JS 包，Windows / macOS / Linux 开箱即用
- 离线优先：核心流水线无网络运行，`npm run demo` 内置样例仓库完整端到端
- 可审计：每条 finding 带规则 ID、命中位置、置信度；所有敏感操作写审计日志
- 多租户 SaaS：API Key（sha256）/ HMAC Cookie / GitHub SSO，Free/Pro/Team 三档，Stripe Checkout 零 SDK
- 手册内置：控制台导航含「手册」标签，支持跨手册全局搜索 + 页内 TreeWalker 高亮

---

## 快速开始

```bash
npm install
npm run demo          # 离线跑通完整流水线（不需要任何配置）
npm run serve         # 启动 HTTP 服务：控制台 http://localhost:8787
```

启动后浏览器打开 http://localhost:8787 。控制台顶栏四标签：**控制台 · 设置 · 手册 · 套餐**。

### 安装（试用 / 内部分发，tarball）

npm 官方 registry 暂未发布本包（注册通道不可用），试用版以 tarball 分发：

```bash
# 1) 拿到 changeguard-<版本>.tgz 后全局安装
npm install -g ./changeguard-0.6.1.tgz
# 2) 核对版本（应输出与 tgz 一致的版本号）
changeguard --version
# 3) 扫描任意本地仓库
changeguard scan <你的项目路径> --since 2025-01-01
```

维护者一侧打包一条命令（跑完与 npm 发布相同的八项门禁，产出可直接分发的 tgz 并自动做安装回验）：

```bash
npm run publish:tarball        # 产物落在 ../trial-kit/，可用 --dest <dir> 覆盖
```

详见 `docs/tarball-distribution.md`。

---

## 架构分层

```
CLI 入口   demo / scan / serve              src/cli.ts
    │
    ▼
编排层     scanRepository → 清单解析 / 代码分析 / 变更采集 / 影响引擎
    │
    ├─ 解析层   Tree-sitter WASM：JS / TS / Python / Go 调用点
    ├─ 变更层   GitHub Releases · OpenAPI diff · Changelog HTML · 本地种子数据
    ├─ 引擎层   确定性规则 R1–R9（重命名 / 参数变更 / 废弃 / 移除 / 类型…）
    ├─ 输出层   HTML / Markdown / PR 草稿 / codemod.patch
    └─ 润色层   LLM 事后解释（可选，核心结论不受影响）
```

## 功能矩阵

| 维度 | 支持 |
|---|---|
| 厂商 | Stripe · OpenAI · Shopify · Twilio · Supabase；注册表数据驱动（`data/providers/*.json`），扩厂商零代码（见「扩展厂商」） |
| 语言 | TypeScript / JavaScript · Python · Go |
| 清单 | `package.json` · `requirements*.txt` / `pyproject.toml` · `go.mod` |
| 规则 | 9 条确定性引擎规则（R1–R9），每条带 `ruleId` + 严重级 |
| 输出 | HTML 影响报告 · Markdown · JSON · PR 草稿 · unified diff codemod.patch |
| 通知 | Slack Webhook · SMTP 隐式 TLS · GitHub Issue（去重合并） |
| 认证 | 控制台密码（HMAC Cookie）· API Key（服务端只存 sha256）· GitHub OAuth SSO |
| 计费 | Free（2 仓 / 10 扫 / 月）· Pro（25 / 500 / $49）· Team（100 / 5000 / $99） |
| 部署 | CLI 本地 · HTTP 服务 · Docker 单机 · Docker 多实例 |

## 性能基线（本机实测，2026-11-17）

合成仓库 = TS/Python/Go 混合（70/20/10），每文件 2 个真实厂商调用点；`node dist/cli.js scan`
端到端（含 Node 启动 ≈0.1s）：

| 仓库规模 | 调用点 | 扫描耗时 |
|---|---|---|
| 100 文件 | 200 | **0.75 s** |
| 500 文件 | 1,000 | **0.84 s** |
| 2,000 文件 | 4,000 | **1.99 s** |

边际成本 ≈ **0.65 ms/文件**（Tree-sitter 解析 + 9 条规则引擎 + 报告生成）。典型中型仓库
（数百文件）通常在 1 秒内完成。

复现：`npx tsx scripts/gen-synth-repo.ts --files 2000 --out .changeguard/synth` 后用
`changeguard scan .changeguard/synth --since 2020-01-01 --out <dir>` 计时。

## MCP 接入（agent 场景）

`changeguard mcp` 把扫描引擎包装成 MCP Server（stdio），让 Claude Code / Cursor / Cline 在改代码前先查「这个 API 最近有没有破坏性变更」，直接拿到 `文件:行` 级影响定位。三个只读工具：`list_breaking_changes` / `check_impact` / `get_feed_status`。本地运行、只读、不联网、零新增依赖。

```json
{ "mcpServers": { "changeguard": { "command": "npx", "args": ["-y", "changeguard", "mcp"] } } }
```

完整协议契约（工具 schema / 三种客户端配置 / 安全边界）见 `docs/mcp.md`。

## 命令参考（CLI）

| 命令 | 说明 |
|---|---|
| `changeguard demo [--out <dir>]` | 离线跑通内置样例仓库全流程 |
| `changeguard scan <path> [--since <iso>] [--online] [--feed <path\|url>] [--trusted-keys <file>] [--out <dir>] [--json] [--only-matched]` | 扫描本地仓库；`--online` 抓取厂商 Releases（缓存 6h）；`--feed` 使用签名变更 feed（验签失败即回退）；`--only-matched` 仅保留锚定到具体文件的命中（过滤仓库级/依赖级提醒） |
| `changeguard pr-preview <path> [--feed <path\|url>] [--trusted-keys <file>]` | Dry-run：打印 PR 标题 / 正文 / unified diff，不改任何仓库 |
| `changeguard pr-open <owner/repo> [--since <iso>] [--base <branch>] [--installation <id>] [--feed <path\|url>] [--trusted-keys <file>]` | **真实创建 DRAFT PR**：远程拉代码 → 扫描 → codemod patches → GitHub 新分支 + commit + DRAFT PR；base 自动探测 main → master；需要 `GITHUB_TOKEN` 或 App installation 凭据 |
| `changeguard serve` | 启动 HTTP 服务（控制台 + `/webhook` GitHub App + `/webhook/stripe` 计费） |
| `changeguard tenant create <name> --plan <free\|pro\|team>` / `tenant list` | 多租户管理 |
| `changeguard key create --tenant <id> [--name]` / `key list` / `key revoke <id>` | API Key 管理；明文仅创建时打印一次 |
| `changeguard plan <tenantId> <plan>` | 手工调整套餐（不走 Stripe） |
| `changeguard bind-installation <installationId> <tenantId>` | 把 GitHub App 安装绑定到租户 |
| `changeguard audit list [--tenant <id>] [--action <name>] [--limit <n>]` | 查询审计日志 |

开发期可用 `npx tsx src/cli.ts <命令>` 直接运行；`npm run build` 后二进制入口 `changeguard` 指到 `dist/cli.js`。

> 管理类命令（`serve` / `tenant` / `key` / `plan` / `audit` / `bind-installation`）由专有扩展 `src/cli-admin.ts` 提供。Apache-2.0 分发包中不含该扩展，调用时会给出一行明确提示并以非零码退出；扫描类命令不受影响。

### 签名变更 feed

`--feed` 读取一份 ed25519 签名的变更 feed。信任是**两层**的：包内长期根公钥
（`BUILTIN_ROOT_KEYS`）签名一份 keyring，keyring 再授权具体签名钥。因此日常轮换
签名钥只需重新签发 keyring，已安装的 CLI 无需升级；只有根钥更换才需要发版。

**fail-closed**：keyring 被篡改 / 被未知根钥签名 / 缺签名，或 feed 签名缺失、
`kid` 不在已验证的 keyring、签名钥已退役、载荷被篡改，都会拒绝该 feed，不会
「验不过当没验」。默认行为是 warning + 回退到内置离线快照（exit 0）；
**CI/流水线请设置 `CHANGEGUARD_FEED_STRICT=1`**，此时任何验签失败都会以 exit 1
结束且禁止回退。keyring 与 feed 都可以用 `http(s)://` URL 分发（根签名本地校验，
端点无法自证）。schema、原因码、轮换与生产密钥清单见 [`docs/feed.md`](docs/feed.md)。

```bash
npm run feed:keygen -- --out .keys/root1           # 根钥（离线保管私钥）
npm run feed:keygen -- --out .keys/sign1           # 签名钥
npm run feed:keyring -- --root-key .keys/root1.private.pem --root-kid <kid> --keys signing-keys.json
npm run feed:sign -- --key .keys/sign1.private.pem --kid <kid> --since 2023-01-01
CHANGEGUARD_FEED_ROOT_KEYS=.keys/root1.public.json \
  npx tsx src/cli.ts scan <repo> --feed .changeguard/feed.json --trusted-keys .changeguard/keyring.json
```

> 仓库内已内置引导信任链（root 公钥 + 签名 keyring，2026-11-13 本地生成；根私钥
> 留在 git-ignored 的 `.keys/`，不入库）。面向外部用户前应按 `docs/feed.md` §7
> 在隔离环境重走密钥仪式并通过根钥轮换替换。

## 控制台页面

| 页面 | 路由 | 功能 |
|---|---|---|
| 控制台 | `/` | 账户用量 / 立即扫描 / 扫描历史 / API Keys / 审计事件 |
| 设置 | `/settings` | 租户改名 · 默认扫描参数（回溯天数 1–730 / 在线模式，持久化 DB）· 通知渠道状态 + 测试发送按钮 · 快捷入口 |
| 手册 | `/manuals` | 产品介绍手册 + 使用手册；支持跨手册全局搜索（输入即时过滤）；手册页右下角浮动搜索框支持 TreeWalker 高亮定位（`?q=` 深链自动定位） |
| 套餐 | `/pricing` | 三档展示 + Stripe Checkout（零 SDK，`stripeCheckoutReady()` 自动判断）· 配额说明 |

## 环境变量

所有变量可放置在项目根 `.env`（启动时自动加载，已有系统环境变量优先）。示例见 `.env.example`。

| 分组 | 变量 | 说明 |
|---|---|---|
| **LLM（可选）** | `LLM_BASE_URL` `LLM_API_KEY` `LLM_MODEL` | 任意 OpenAI 兼容端点；不配即离线模板解释 |
| **GitHub App** | `GITHUB_APP_ID` `GITHUB_PRIVATE_KEY` `GITHUB_WEBHOOK_SECRET` `GITHUB_TOKEN` | 私钥支持 PEM 内容或文件路径；Webhook 验签必需 |
| **GitHub OAuth** | `GITHUB_OAUTH_CLIENT_ID` `GITHUB_OAUTH_CLIENT_SECRET` | 控制台 SSO 登录，可选 |
| **通知** | `SLACK_WEBHOOK_URL` `SMTP_URL` `EMAIL_TO` | SMTP 隐式 TLS，收件人逗号分隔 |
| **运行时** | `PORT` `CHANGEGUARD_DB_PATH` `CHANGEGUARD_CACHE_DIR` `CHANGEGUARD_SCAN_INTERVAL_HOURS` `CHANGEGUARD_SCHEDULED_REPOS` `CHANGEGUARD_LOG` `CHANGEGUARD_LOG_FORMAT` `CHANGEGUARD_AUDIT_RETENTION_DAYS` | DB 与缓存位置；定时扫描（0 关闭）；`CHANGEGUARD_LOG=debug` 降阈值；`CHANGEGUARD_LOG_FORMAT=json` 输出 JSON 行（每行带 `requestId`/`tenantId`/`actor`，响应头 `X-Request-Id` 可回传追踪）；审计日志保留天数（默认 90，0 关闭轮转） |
| **可观测性** | `CHANGEGUARD_METRICS_TOKEN` | 设置后开放 `GET /metrics`（Prometheus 文本格式，`Bearer` 或 `?token=` 鉴权）；未设置时端点 404（fail-closed） |
| **签名 feed** | `CHANGEGUARD_FEED_KEYS` `CHANGEGUARD_FEED_ROOT_KEYS` `CHANGEGUARD_FEED_STRICT` | 签名 keyring（文件或 URL，优先级低于 `--trusted-keys`）；额外根钥文件（与内置根钥合并）；`=1` 时验签失败非零退出且禁止回退（CI 必用） |
| **控制台** | `CHANGEGUARD_CONSOLE_PASSWORD` `CHANGEGUARD_SESSION_SECRET` | 口令启用登录（默认锁）；会话密钥建议生产必设，未设则每进程随机生成 |
| **安全开关** | `CHANGEGUARD_ALLOW_ANONYMOUS_CONSOLE` `CHANGEGUARD_ALLOW_UNSIGNED_WEBHOOK` `CHANGEGUARD_TRUST_PROXY` `CHANGEGUARD_SECURE_COOKIES` | 前两个仅本地开发使用，默认关闭（拒绝匿名控制台 / 拒绝未验签 webhook）；后两个用于反向代理部署 |
| **Stripe 计费** | `STRIPE_WEBHOOK_SECRET` `STRIPE_SECRET_KEY` `STRIPE_PRICE_PRO` `STRIPE_PRICE_TEAM` | Webhook secret 是开关；两个付费档价格 ID 在 Stripe Dashboard 创建 |

## 部署

**本地**：

```bash
cp .env.example .env   # 按需填写
npm run serve          # http://localhost:8787
```

**Docker 单机**：

```bash
docker compose up -d   # docker-compose.yml
```

**Docker 多实例**：

```bash
docker compose -f docker-compose.multi.yml up -d
```

> 务必把 `.changeguard/`（DB + 缓存）与 `.env` 作为卷挂载；否则容器重建丢数据。镜像无原生编译步骤，构建快体积小。

## 安全默认值（fail-closed）

服务默认按「生产可用」的安全姿态启动，未配置凭据时**不会**放行：

| 项 | 默认行为 | 本地开发如何开启 |
|---|---|---|
| 控制台 / JSON API | 默认要求登录；既无口令也无 GitHub OAuth 时返回 503 并提示配置方式 | `CHANGEGUARD_ALLOW_ANONYMOUS_CONSOLE=1`（仅开发） |
| `POST /webhook` | 未设 `GITHUB_WEBHOOK_SECRET` 时一律 401 | `CHANGEGUARD_ALLOW_UNSIGNED_WEBHOOK=1`（仅开发） |
| 会话 Cookie | `CHANGEGUARD_SESSION_SECRET` 未设时按进程随机生成，重启即失效 | 固定设置 `CHANGEGUARD_SESSION_SECRET` |
| 登录 | 同一 IP 15 分钟内最多 10 次尝试，超出返回 429 + `Retry-After` | — |
| 响应头 | CSP / `X-Content-Type-Options` / `X-Frame-Options` / `Referrer-Policy` / `Permissions-Policy` | — |
| Cookie `Secure` | 直连 TLS 或 `CHANGEGUARD_TRUST_PROXY=1` 且 `X-Forwarded-Proto: https` 时自动加 | `CHANGEGUARD_SECURE_COOKIES=1` 强制开启 |

反向代理部署时设置 `CHANGEGUARD_TRUST_PROXY=1`，否则限速会按代理 IP 聚合、Cookie 也不会带 `Secure`。

本地最简启动（放行控制台与未验签 webhook）：

```bash
CHANGEGUARD_ALLOW_ANONYMOUS_CONSOLE=1 CHANGEGUARD_ALLOW_UNSIGNED_WEBHOOK=1 npm run serve
```

## Stripe 真实联调（测试模式）

1. [Stripe Dashboard → Billing → Products](https://dashboard.stripe.com/test/products) 分别创建两个 Product（Pro / Team），每个 Product 创建一个 **Recurring** 价格（`recurring`，每月，任意金额），拿到 `price_xxx` 格式的价格 ID
2. 测试模式拿到测试密钥：[API Keys](https://dashboard.stripe.com/test/apikeys) → `sk_test_xxx`（Secret Key）和 `whsec_xxx`（Webhook Signing Secret，需要在 [Webhooks](https://dashboard.stripe.com/test/webhooks) 添加 endpoint 并 Endpoint Secret）
3. `.env` 里填上：
   ```
   STRIPE_SECRET_KEY=sk_test_xxx
   STRIPE_PRICE_PRO=price_xxx
   STRIPE_PRICE_TEAM=price_yyy
   STRIPE_WEBHOOK_SECRET=whsec_xxx
   ```
4. 安装官方 Stripe CLI（npm 上没有官方包，请勿 `npx stripe`）：

   ```bash
   # macOS
   brew install stripe/stripe-cli/stripe
   # Windows (Scoop)
   scoop install stripe
   # 其他平台：https://github.com/stripe/stripe-cli/releases 下载对应二进制并加入 PATH
   ```

   然后启动本地转发：

   ```bash
   stripe login            # 第一次用浏览器授权
   stripe listen --forward-to localhost:8787/webhook/stripe
   # 输出里有一个临时 webhook secret（whsec_…），Stripe Dashboard 里的 endpoint 用它
   ```
5. 启动服务后，浏览器访问 `/pricing`，点「升级到 Pro / Team」，Stripe 官方 Checkout 页面填测试卡号 `4242 4242 4242 4242`，完成支付
6. 回到控制台 `/api/account` 可看到套餐已变（Stripe webhook 回调 → 自动 `setTenantPlan`）

## 测试

```bash
npm run typecheck    # TypeScript strict 全量检查
npm test             # vitest 全量（90+ 用例分三层）
```

测试分层：

| 文件 | 覆盖 |
|---|---|
| `tests/engine.test.ts` `analyzers.test.ts` `openapi-diff.test.ts` | 核心流水线（引擎规则 / 语言分析器 / OpenAPI diff） |
| `tests/phase3.test.ts` | 多租户 + 认证 |
| `tests/phase4.test.ts` | 计费 + Webhook |
| `tests/phase5.test.ts` | 设置功能（租户改名 + 默认扫描参数 + 通知测试） |
| `tests/manual-search.test.ts` | 手册搜索（路由层 + 搜索素材前提 + 脚本接线） |
| `tests/scan-e2e.test.ts` `note-parser.test.ts` `codemod.test.ts` `manifests.test.ts` | 单元 |

## 文档

- 产品介绍手册：控制台 → 手册 或 [变更目录 `/manuals/product`]
- 使用手册：控制台 → 手册 或 [变更目录 `/manuals/usage`]
- 架构设计文档：[`docs/architecture.md`](docs/architecture.md)
- 签名变更 feed（schema / 规范化 / 轮换 / 回退）：[`docs/feed.md`](docs/feed.md)

## License

本仓库采用双许可（dual license）：

- **Apache-2.0** —— 独立 CLI 与扫描器：扫描核心、规则引擎、语言 analyzer、报告/通知、离线 seed 快照等。完整许可见 [LICENSE](LICENSE)。
- **专有（All rights reserved）** —— 托管服务端、计费、账号与租户存储、控制台、部署打包：`src/server/`、`src/store/`、Docker 相关文件。适用范围、保留权利与混合文件拆分原则见 [LICENSE-PROPRIETARY](LICENSE-PROPRIETARY)。

不在 Apache-2.0 清单内的路径，一律以 `LICENSE-PROPRIETARY` 为准。npm 分发包仅含 Apache-2.0 部分（`package.json` 的 `files` 白名单排除了 `dist/server`、`dist/store`、`dist/cli-admin` 与 Docker 文件）。

## 扩展厂商（数据驱动，零代码）

厂商注册表是纯数据：每家厂商 = `data/providers/<id>.json` 一份 manifest，启动时严格校验（字段错误直接 fail-fast，错误信息带文件名与字段）。新增一家厂商**不需要改任何代码**：

1. 写 `data/providers/<id>.json`（文件名必须等于 `id`，小写 slug）：

   ```json
   {
     "id": "acme",
     "name": "Acme API",
     "website": "https://acme.dev",
     "packages": { "npm": ["acme-sdk"], "pypi": ["acme"], "go": ["github.com/acme/acme-go"] },
     "hosts": ["api.acme.dev"],
     "factories": { "javascript": ["createAcmeClient"] },
     "sources": {
       "changelog": { "url": "https://acme.dev/changelog", "kind": "html" },
       "githubReleases": [
         { "ecosystem": "npm", "language": "javascript", "owner": "acme", "repo": "acme-node" }
       ]
     }
   }
   ```

2. （可选）放 `data/changes/<id>.seed.json` 提供离线变更记录（无种子时离线无 finding，`--online` 仍可抓 Releases）。
3. （可选）放 `data/openapi/<id>/meta.json` + 快照对，启用 OpenAPI diff。

随即生效：清单识别、Tree-sitter 调用点规则、host 匹配、在线变更采集全部自动覆盖新厂商。规则见 `src/providers/registry.ts` 的 `validateProviderManifest`（生态限 npm/pypi/go，语言限 javascript/python/go）。

## 品牌与官方渠道

**「ChangeGuard」** 是本项目的官方名称。官方发布渠道仅为 npm 的 [`changeguard`](https://www.npmjs.com/package/changeguard) 包与本仓库；任何其他渠道、名称变体（`changeguard-pro`、`@其他scope/changeguard` 等）均非官方出品。本项目 CLI 以 Apache-2.0 发布；托管服务、Web 控制台与未来的付费能力属专有范围，不随开源包分发。

## 限制 / 未来

- Go 语言：检测链路已闭环（go.mod 清单 → Tree-sitter 调用点 → 引擎规则 → 报告，e2e 钉死）；codemod 自动改写仅覆盖 JS/TS/Python，Go 只报不改
- 可观测性：`/metrics`（Prometheus 文本格式）提供扫描/LLM/队列指标；结构化日志（JSON 行 + requestId 串联）已有；仍无分布式 tracing
- 厂商：注册表已数据驱动（见上节）；语言 analyzer 仍是 JS/TS/Python/Go 四条固定规则管道

---

`npm run build` → 二进制产物在 `dist/cli.js`，`npm publish` 可发布到 npm。
