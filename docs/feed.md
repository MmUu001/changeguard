# 签名变更 feed 与 keyring 签名链

CLI 可以读取一份由 ChangeGuard 签发的变更 feed，而不是依赖随包快照。
**验签失败即拒绝使用该 feed**（fail-closed）：缺失签名、签名不匹配、`kid` 未知、
密钥已退役、载荷被改字节，一律按下方行为拒绝。

## 1. 两层信任模型

```
内置于 CLI 包内的长期根公钥  BUILTIN_ROOT_KEYS
        │  签名（root signature）
        ▼
签名 keyring（{keyringVersion, generatedAt?, keys[], signature}）
        │  内含各签名钥 kid / 公钥 / notBefore / retiresAt
        ▼
签名 feed（{feedVersion, publisher, generatedAt, records, signature}）
```

- **根钥**只用于签 keyring，是唯一的信任锚。它随 npm 包分发，因此信任假设等于
  包完整性（provenance + 发布签名）。
- **签名钥**只用于签 feed，全部通过 keyring 传递。日常轮换只需用根钥重新签发
  一份 keyring，**已安装的老 CLI 无需升级即可接受新的签名钥**。
- keyring 可以从不可信端点（`http(s)://`）获取：根签名在本地用内置根钥校验，
  端点无法自证，也就无法自行引入签名钥。
- 根钥更换频率极低，且需要发 CLI 版本（见 §6）。

### keyring 结构

```jsonc
{
  "keyringVersion": 1,                          // 必填，本客户端只支持 1
  "generatedAt": "2026-01-01T00:00:00.000Z",    // 可选，仅用于诊断
  "keys": [                                     // 被 keyring 授权签 feed 的钥
    {
      "kid": "ed25519:XXXXXXXXXXXX",            // 必填，必须与公钥派生值一致
      "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n…",
      "notBefore": "2026-01-01T00:00:00.000Z",  // 可选，未到点前拒绝
      "retiresAt": "2027-01-01T00:00:00.000Z"   // 可选，到点后拒绝
    }
  ],
  "signature": {                                // 根钥对「除 signature 外的全部成员」的签名
    "algorithm": "ed25519",
    "kid": "ed25519:ROOTKID00000",              // 必须是内置（或经 env 提供的）根钥
    "digest": "…",                              // 规范化载荷 SHA-256(hex)，仅诊断
    "value": "…"                                // base64 ed25519 签名
  }
}
```

`kid` 由 `ed25519:` + base64url(SHA-256(SPKI DER)) 前 16 字符派生；keyring 条目里
`kid` 与公钥不匹配会在加载阶段直接报错（`keyring-malformed`）。

### 验签顺序（任何一步失败都立即停止）

1. 加载根钥：内置 `BUILTIN_ROOT_KEYS`，若设置了 `CHANGEGUARD_FEED_ROOT_KEYS`
   则再叠加该文件中的根钥（用于本地/私有部署 bootstrap）。
2. 取 keyring：`--trusted-keys` → `CHANGEGUARD_FEED_KEYS` → 内置
   `BUILTIN_FEED_KEYRING`。三者都没有时以 `keyring` 原因拒绝。
3. 校验 keyring：结构 → `keyringVersion` → `keys` 条目 → `signature` 存在与形状 →
   找到对应根钥 → 根钥有效期 → 根签名。**全部通过前，keyring 里任何 `kid`
   都不被信任。**
4. 用 keyring 中的签名钥验 feed（§2）。keyring 被拒绝时 feed 甚至不会被解析。

配置优先级与来源：

| 用途 | 来源 | 说明 |
|---|---|---|
| 根钥 | `BUILTIN_ROOT_KEYS` | 生产信任锚；数组中可并存多把，便于根钥轮换 |
| 根钥 | `CHANGEGUARD_FEED_ROOT_KEYS=<file>` | 本地/私有部署与联调用；与内置根钥**合并**，不替换 |
| keyring | `--trusted-keys <file\|url>` | 最高优先级 |
| keyring | `CHANGEGUARD_FEED_KEYS=<file\|url>` | 容器/服务端注入 |
| keyring | `BUILTIN_FEED_KEYRING` | 随包分发的 keyring，已内置（见下方说明） |

> 引导密钥（root1/sign1）于 2026-11-13 在开发机本地生成：根公钥与签名 keyring
> 已写入内置（`src/ingest/feed-keys.ts`），根私钥留在 git-ignored 的 `.keys/`。
> 在面向外部用户之前，应按 §7 的清单在隔离环境重走密钥仪式并通过根钥轮换
> （并行信任期 → 新 keyring → 退役旧根）完成替换。在那之前，内置信任链即为
> 本地 bootstrap 的信任根；不信任时可用 `CHANGEGUARD_FEED_ROOT_KEYS` 追加
> 其它根钥，或用 `--trusted-keys` 显式指定 keyring。

## 2. feed 信封结构（feed v1）

```jsonc
{
  "feedVersion": 1,             // 必填，正整数；本客户端支持 1
  "publisher": "changeguard",   // 签发方标识
  "generatedAt": "2026-01-01T00:00:00.000Z", // 签发运行时间（ISO）
  "records": [                  // ChangeRecord[]，与扫描管线同一结构
    {
      "id": "stripe-2025-01-01-charge-refund",
      "providerId": "stripe",          // 厂商 / 生态
      "kind": "breaking",              // breaking | deprecation | behavior | feature
      "title": "Charge.refund() rejects unknown parameters",
      "summary": "影响面提示（短）",
      "body": "可选的长描述",
      "source": "release-note",        // openapi-diff | release-note | changelog
      "sourceUrl": "https://…",        // 上游链接
      "date": "2025-01-01",            // 发布时间（ISO 日期）
      "operations": [],                // 受影响的包 / 接口 / 参数 / 枚举
      "renames": [],
      "versions": [],
      "migration": "厂商迁移建议（可选）",
      "parserSignals": [],
      "confidence": "high"
    }
  ],
  "signature": {
    "algorithm": "ed25519",
    "kid": "ed25519:…",        // 必须出现在已验证的 keyring 中
    "digest": "…",             // 规范化载荷的 SHA-256(hex)，仅用于诊断
    "value": "…"               // 规范化载荷的 ed25519 签名（base64）
  }
}
```

### 版本化规则

- 签名覆盖**信封中除 `signature` 外的所有成员**，包括客户端尚不认识的字段。
  因此新增顶层字段或 `records` 内新字段时，老客户端无需改代码即可验签（未知字段
  忽略但参与验签）。
- 删除字段、改变字段含义/类型、或改变规范化规则必须提升 `feedVersion`。
  客户端遇到高于自身上限的版本返回 `unsupported-version` 并回退。
- `records[].date` 早于扫描 `--since` 的记录在客户端侧仍会被过滤，签名本身不做过滤。

## 3. 规范化序列化（canonical JSON v1）

签名对**规范化后的 UTF-8 字节**签名，绝不对 `JSON.stringify` 的输出签名
（字段顺序、空白、缩进都会变）。规则（`src/ingest/canonical.ts`）：

| 值类型 | 规则 |
|---|---|
| 对象 | 键按 UTF-16 code unit 升序排序；无空白；`undefined` 成员省略 |
| 数组 | 保持顺序 |
| 字符串 | RFC 8259 转义（同 `JSON.stringify`） |
| 数字 | 仅有限值；`-0` 归一为 `0`；其余用 `JSON.stringify` |
| null / boolean | 原样 |
| 其他（bigint / 函数 / symbol） | 抛错 |

验签端对收到的原始 JSON **重新规范化后再验**，所以签发端文件可以带缩进、键顺序
随意，只要语义等价即可。keyring 与 feed 使用同一套规范化与签名原语
（`signBody` / `verifySignature`）。

## 4. 失败原因码

keyring 阶段（发生在 feed 解析之前）：

| 情况 | 原因码 | 默认行为 |
|---|---|---|
| 根钥文件读不了 / 未配置任何 keyring | `keyring` | error + 回退 |
| keyring 不是 JSON 对象 / 版本不支持 / `keys` 条目非法 / `kid` 与公钥不符 | `keyring-malformed` | 同上 |
| keyring 没有 `signature` 或签名形状不对 | `keyring-unsigned` | 同上 |
| 签名根钥不在已信任根钥列表 | `keyring-unknown-root` | 同上 |
| 根签名与 keyring 内容不匹配（含改一字节） | `keyring-bad-signature` | 同上 |
| 根钥尚未到 `notBefore` | `not-yet-valid` | 同上 |
| 根钥已过 `retiresAt` | `retired-key` | 同上 |

feed 阶段：

| 情况 | 原因码 | 默认行为 |
|---|---|---|
| 文件/URL 不可读 | `unreachable` | 记录 error + 回退内置快照 |
| 不是合法 JSON | `malformed` | 同上 |
| 缺 `signature` / 字段不完整 | `missing-signature` | 同上 |
| 算法不是 ed25519 | `unsupported-algorithm` | 同上 |
| `kid` 不在已验证的 keyring | `unknown-kid` | 同上，并提示查看本文档 |
| 签名钥尚未到 `notBefore` | `not-yet-valid` | 同上 |
| 签名钥已过 `retiresAt` | `retired-key` | 同上 |
| 载荷或签名被篡改 | `bad-signature` | 同上 |
| `feedVersion` 高于客户端 | `unsupported-version` | 同上 |

任何拒绝都**不会**使用 feed 里的记录。默认策略是「记录 error + 警告 + 回退到随包
非签名快照 + 退出码 0」；严格模式下改为非零退出（§8）。

## 5. 签名钥轮换（日常，不需要发版）

1. `npm run feed:keygen -- --out .keys/sign1` 生成新签名钥。
2. 把新公钥（和旧公钥）写进 `signing-keys.json`，给旧钥加 `retiresAt`。
3. `npm run feed:keyring -- --root-key <root.private.pem> --root-kid <root kid> --keys signing-keys.json --out keyring.json` 重新签发 keyring。
4. 把新 keyring 与 feed 一起分发（同目录文件或 URL），发布端改用新 `kid` 签 feed。
5. 并行期结束后旧钥按 `retiresAt` 被拒绝；之后签发下一版 keyring 时直接删掉旧条目。

`retiresAt` 到期即拒绝（`now >= retiresAt`），不看签名是否数学有效。
未到 `notBefore` 的钥在生效前按 `not-yet-valid` 拒绝，可用于预热分发。

## 6. 根钥轮换（罕见，必须发版）

内置根钥无法被远程更新，因此根钥轮换**必须**伴随一次 CLI 发版：

1. 离线生成新的根钥对（§7）。
2. **并行信任期**：把新根公钥**追加**到 `BUILTIN_ROOT_KEYS`（与旧根公钥并存），
   发版。此时老版本仍只信任旧根钥，新版本信任两把。
3. 用新根钥重签 keyring 并分发。装有新版本的客户端接受它，装有旧版本的客户端
   只要 keyring 仍由旧根钥签就继续工作。
4. 全部客户端升级完成后，切到只由新根钥签名的 keyring。
5. 下一个版本再从 `BUILTIN_ROOT_KEYS` 移除旧根公钥（旧根钥可标记 `retiresAt`
   先进入退役状态）。

keyring 被**未知根钥**签名时返回 `keyring-unknown-root`，并在 detail 中列出当前
信任的根 `kid`，便于区分「根钥轮换还没发版」与「feed 端点自行签发」。

## 7. 生产密钥生成清单（正式发布前执行）

以下步骤必须在**隔离环境**（离线签发机 / 受控 CI secret）执行；私钥只存在于该
环境，只把公钥带回仓库。开发期密钥不得写入内置。

1. 在隔离环境安装依赖并进入仓库（无需联网签发）。
2. 生成根钥对（建议 1–2 把，第一把为主，第二把预置用于未来轮换）：

   ```bash
   npm run feed:keygen -- --out /secure/keys/root1
   npm run feed:keygen -- --out /secure/keys/root2
   ```

   记录打印出的 `kid`（形如 `ed25519:…`），它是公钥指纹，可以安全记录。
3. 生成签名钥对（至少 1 把，轮换前再生成下一把）：

   ```bash
   npm run feed:keygen -- --out /secure/keys/sign1
   ```

4. 用根私钥签发 keyring（在本机完成，keyring 可公开分发）：

   ```bash
   npm run feed:keyring -- \
     --root-key /secure/keys/root1.private.pem \
     --root-kid ed25519:ROOT1 \
     --keys signing-keys.json \
     --out dist/keyring.json
   ```

5. 只提交公钥：
   - 把根公钥 PEM 与 `kid` 填入 [src/ingest/feed-keys.ts](../src/ingest/feed-keys.ts)
     的 `BUILTIN_ROOT_KEYS`（多把即多条）。
   - 把第 4 步产出的 keyring 对象赋给 `BUILTIN_FEED_KEYRING`（保持
     `keyringVersion: 1` 与根签名原样）。
6. 私钥保管：`*.private.pem` 留在隔离环境或密钥管理服务；**不要**提交、不要放进
   npm 包、不要附加到 feed。`.gitignore` 已覆盖 `.keys/` 与 `*.private.pem`，
   且 `feed-keygen` 会拒绝写入仓库内未被 gitignore 的路径。
7. 发布前自检（在干净检出上）：
   - `npm run build && npm pack --dry-run` 确认 tarball 内无私钥、无 `.keys/`；
   - 用生产 keyring 签一份 feed，跑 `scan --feed`，确认日志出现
     `signed feed verified: … root=<kid1>`；
   - 把 keyring 改一字节与换成未知根钥各试一次，确认分别得到
     `keyring-bad-signature` / `keyring-unknown-root`；
   - 在 CI 中开启 `CHANGEGUARD_FEED_STRICT=1`（§8）。
8. 记录轮换计划：签名钥建议每年轮换（加 `retiresAt` 并行期 ≥ 1 个发布周期），
   根钥建议只在疑似泄露或算法迁移时轮换。

## 8. 严格模式与退出码

| 环境变量 | 行为 |
|---|---|
| 未设置（默认） | 验签失败 → `ERROR` + `WARN falling back…` → 使用内置离线快照 → **exit 0** |
| `CHANGEGUARD_FEED_STRICT=1` | 验签失败 → `ERROR` → **直接抛错，不回退** → CLI **exit 1**，且不生成 `--out` 产物 |

- 布尔值接受 `1` / `true` / `yes` / `on`（不区分大小写）。
- **CI/流水线必须开启严格模式**。默认的回退是为了交互式离线可用性；如果流水线
  沿用默认值，一次验签失败会静默退回旧快照，给出**过时的安全结论**而不是失败。
- exit code：`0` 成功（含默认模式的回退），`1` 严格模式下验签失败（含 keyring
  读取/格式错误、`unreachable`、`feedVersion` 不支持）。命令参数错误同样为 `1`，
  因此流水线要区分「feed 不可信」请检查 stderr 中的 `signed feed rejected [<原因码>]`。
- 日志示例（默认模式）：

  ```
  ERROR signed feed rejected [keyring-bad-signature]: signature does not match the payload (…)
  WARN  falling back to the bundled offline snapshot (unsigned); no unverified feed records are used
  ```

  严格模式只出现第二条 `ERROR signed feed rejected [<原因码>] and CHANGEGUARD_FEED_STRICT=1 forbids falling back; refusing to run with unverified or stale feed data`，
  并以 exit 1 结束。

## 9. 与 `--online` 的关系

feed 是**权威数据源**：只要配置了 `--feed`，验证通过的 feed 记录就替代随包快照，
不再合并任何其它来源。

- `--online` 在 feed 模式下被**忽略**，并打印一条 `WARN`（不做合并逻辑）。
- 需要抓取厂商 Releases / changelog 时，不要同时传 `--feed`。
- 优先级：`--feed`（验签通过）> 内置快照；`--online` 只对「无 feed」路径生效。

## 10. CLI 使用

```bash
# 1) 生成密钥对（默认写到 .keys/，已在 .gitignore 中）
npm run feed:keygen -- --out .keys/root1
npm run feed:keygen -- --out .keys/sign1

# 2) 用根私钥签发 keyring（公钥清单写在 signing-keys.json）
npm run feed:keyring -- \
  --root-key .keys/root1.private.pem \
  --root-kid ed25519:ROOT1 \
  --keys signing-keys.json \
  --out .changeguard/keyring.json

# 3) 签发 feed（默认从内置离线快照取记录）
npm run feed:sign -- \
  --key .keys/sign1.private.pem \
  --kid ed25519:SIGN1 \
  --since 2023-01-01 \
  --out .changeguard/feed.json

# 4) 扫描时验签（本地 bootstrap：用 env 提供根钥）
CHANGEGUARD_FEED_ROOT_KEYS=.keys/root1.public.json \
  npx tsx src/cli.ts scan ./fixtures/sample-repo \
  --feed .changeguard/feed.json \
  --trusted-keys .changeguard/keyring.json
```

`--feed`、`--trusted-keys` 都接受 `http(s)://` URL（15s 超时）。`scan --out`、
`pr-preview`、`pr-open` 支持同样的 `--feed` / `--trusted-keys`。

`CHANGEGUARD_FEED_ROOT_KEYS` 指向一个 JSON 文件（`{"keys":[…]}` 或裸数组，条目
形状同 keyring 的 `keys`），其中的根钥与内置根钥**合并**。

私钥安全：`scripts/feed-keygen.ts` 会拒绝把私钥写进仓库内未被 `.gitignore`
覆盖的路径；私钥文件权限为 `0600`。私钥只应存在于签发环境（CI secret 或
离线签发机），不要提交、不要塞进 feed。
