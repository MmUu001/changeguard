# MCP 接入（ChangeGuard as an MCP Server）

> 让 agent 在改代码前先查「这个 API 最近有没有破坏性变更」，并把影响定位到 `文件:行`。
> 本地运行、只读、不联网。协议实现为 **legacy handshake（2025-06-18）**：当前主流客户端
> （Claude Code 2.1.292 / Cursor / VS Code / Cline / 官方 SDK）都会先探 `server/discover`
> 再回退 `initialize`，因此本 server 可被全部主流客户端连接（依据官方 client matrix，2026-10）。

## 启动方式（stdio）

```bash
# 方式 A：子命令
changeguard mcp
# 方式 B：独立 bin（无参数即为 MCP server）
changeguard-mcp
```

## 客户端配置（三种示例）

**Claude Code**（`.mcp.json` 或 `claude mcp add`）：

```json
{
  "mcpServers": {
    "changeguard": {
      "command": "npx",
      "args": ["-y", "changeguard", "mcp"]
    }
  }
}
```

**Cursor**（`~/.cursor/mcp.json`）：

```json
{
  "mcpServers": {
    "changeguard": { "command": "npx", "args": ["-y", "changeguard", "mcp"] }
  }
}
```

**Cline**（VS Code 扩展设置 → MCP Servers）：

```json
{
  "mcpServers": {
    "changeguard": { "command": "npx", "args": ["-y", "changeguard", "mcp"] }
  }
}
```

> 包尚未发布到 npm registry 时，用 tarball 安装后的绝对路径：
> `"command": "node", "args": ["<安装目录>/dist/mcp/standalone.js"]`。

## 三个工具

### `list_breaking_changes`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `provider` | enum（stripe/openai/shopify/twilio/supabase，随注册表数据驱动） | ✅ | 厂商 |
| `since` | ISO 日期 `YYYY-MM-DD` | — | 默认一年前 |

返回 Markdown：按日期倒序列出该厂商的破坏性变更，每条带 `changeId`、影响操作、迁移建议。

### `check_impact`（核心）

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `repo_path` | string | ✅ | 仓库根目录的**绝对路径** |
| `provider` | enum | — | 只查一家（默认全部检测到的） |
| `since` | ISO 日期 | — | 默认一年前 |

返回 Markdown：首行结论（`N findings: a high / b medium / c low across M files`），逐条
`文件:行 — 严重级 规则ID — 原因 [auto-fixable]`，末尾 provenance。

### `get_feed_status`

无参数。返回数据可信度声明：
- `BUILTIN`：随包快照（有签名 keyring 在位，非实时 feed）
- `VERIFIED`：外部签名 feed 验签通过（设置 `CHANGEGUARD_MCP_FEED` 指向本地 feed 文件）
- `REJECTED`：验签失败，已回退快照（附原因码）

**调用方可直接引用这句作为依据**——这是「可验证数据源」的落点。

## 安全边界（写死，不可配置绕过）

- **只读**：不落库（`persist:false`）、不写文件、不执行 codemod、不创建 PR
- **不联网**：`online:false`，不提供在线开关
- **路径约束**：`repo_path` 必须是绝对路径 + 存在 + 是目录；可设
  `CHANGEGUARD_MCP_ALLOWED_ROOTS=/abs/root1,/abs/root2` 做白名单
- **资源上限**：单次扫描 30s 超时（超时返回结构化错误，建议 agent 收窄范围）
- **stdout 纯净**：所有诊断走 stderr，stdout 只有 JSON-RPC 帧

> 官方声明（可写进对外材料）：「本 MCP server 在本地运行、只读、不联网。它不会修改你的
> 代码，也不会把代码内容发送到任何远端服务。所有分析在进程内完成，数据源为包内快照或
> 你显式指定的签名 feed。」

## 已知限制

- 协议为 legacy era；2026-07-28 的 stateless era（`server/discover` + `_meta` 版本）
  是后续版本路线，不阻塞当前所有主流客户端
- 仅 stdio transport（无 HTTP/SSE）
- 仅 Tools（无 Resources / Prompts）
- 包内快照为离线数据；在线数据需自行 `feed:refresh`（见 docs/feed.md）
