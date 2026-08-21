# cc-fleet — Claude Code 主从配置控制面

> 状态：**v2 设计稿，待批准**。v1 见 git 历史（`git show b761fb4:docs/design.md`）。
> cc-fleet 是 [copilot-reverse](https://github.com/wangcansunking/copilot-reverse) 的**超集继任者**，带完整历史 fork。

## 0. v2 改了什么

v1 的模型是「主机说了算，从机纯执行」。实际用下来有六处要改：

| # | 变更 | 影响的 v1 决策 |
|---|---|---|
| 1 | 受管配置统一放 **`~/.agents/`**（规则拆成 `rules/*.md`，不再是单个 `CLAUDE.md`），再投影到各 agent 工具目录 | §8 受管路径 |
| 2 | 控制面**只跑 WAN**（worker 的 localhost/lan 不变） | §9 |
| 3 | **copilot-reverse 收缩为一个组件**：只做 proxy 转发 + 登录 + AUTH | §2 |
| 4 | 主机可**逐台**配置从机，不止分组 | §7 |
| 5 | 从机可自建配置并 **push 上交**，主机选择性采纳 | §4「主机说了算」 |
| 6 | dashboard 内置 **pi agent** 管理，走 copilot-reverse 的 API | §11 新增 |

第 5 条是唯一动到语义根基的：v1 是单向的。**接管本身保留**，但从机多了一块主机永不触碰的自留地。

## 1. 要解决的问题

在主机器上改一次，所有从机器跟着变；从机不该有仓库、不该装 git、不该登 GitHub、不该各自配 endpoint。
这不是同步工具，是**控制面**（control plane）。

v2 补上反方向：从机是配置的**产地**之一，不只是消费端。好用的 skill 往往诞生在某台干活的机器上，
必须有一条把它交回主机、进而分发给全队的路。

## 2. 模块边界

一个二进制，两种角色。仓库内部四块，**两条硬边界**：

```
src/
  worker/       ┐
  providers/    ├─ copilot-reverse 组件：Copilot API 转发 + 登录 + AUTH，仅此而已
  cli/auth.ts   ┘
  supervisor/   daemon + dashboard（含 pi agent）
  tui/          slash 命令
  control/      控制面
    proto/        协议 + profile schema
    hub/          主机侧：profile store、device registry、推送引擎、采纳队列
    agent/        从机侧：apply、投影、备份/回滚、状态上报、push
    transport/    SSE + POST（抽象 channel 的实现）
```

**边界一（已由测试强制）：`control/` 不得 import `worker/`／`providers/`／`supervisor/`／`tui/`。**
`tests/control/boundary.test.ts` 扫描每一条 import specifier。

**边界二（v2 新增，同样要测试强制）：`worker/` + `providers/` 不得 import `control/`。**
copilot-reverse 组件对控制面一无所知 —— 它只是一个能把请求转给 Copilot 并管好登录的东西。
以后想换掉整个 LLM 后端，只动这一块。

**不拆成独立 npm 包**：会引入 workspace/发布流程，且让与 upstream 的 git merge 变成灾难。
边界靠测试守，不靠包管理器。

## 3. `~/.agents/` —— 规范存储

各 agent 工具（Claude Code、Codex、pi…）各有各的配置目录和格式。cc-fleet 不迁就任何一个，
维护一份**工具无关的规范存储**，再投影出去：

```
~/.agents/
  fleet/            ← 主机下发。完全接管：不在 profile 里的一律删除
    skills/<id>/
    mcp/<id>.json
    commands/<id>.md
    rules/<id>.md
  local/            ← 从机自留地。cc-fleet 永不删改
    skills/<id>/
    mcp/<id>.json
    rules/<id>.md
  .cc-fleet/
    backups/<ts>/   ← apply 前的全量快照，保留 10 份
    projected.json  ← 上次投影出去的文件清单（见 §5）
```

**`rules/` 是多个文件，不是一个 `CLAUDE.md`。** 规则天然是可拆的（提交规范、测试纪律、某个项目的忌讳），
拆开才谈得上「这条规则下发给谁」—— 一整块 `CLAUDE.md` 只能整体接管，做不到逐条分组或逐台覆盖。
各工具那边仍然是单文件，所以投影时按文件名排序拼接（见 §4）。

**为什么要多一层，而不是直接管 `~/.claude/skills/`：**

1. 没有它，第 5 条无处安放 —— 自留地和受管区必须物理隔离，否则「接管」和「本地新建」只能二选一。
2. 一份内容要同时喂给多个工具。存 `~/.claude/` 就等于承认只服务 Claude Code。
3. 投影是可重放的：清单在手，`~/.claude/` 被别的东西搞乱了可以重建。

**代价（明确接受）：多一层间接。** 用户在 `~/.claude/skills/` 里直接改的东西，下次投影会被覆盖 ——
真正的编辑入口是 `~/.agents/local/`。这一条必须在 CLI 里说清楚，不能让人自己撞上。

## 4. 投影

`fleet/` 与 `local/` 合并后写入各工具的原生位置。**同名冲突时 `local/` 覆盖 `fleet/`** ——
从机上的人比远端的 profile 更知道这台机器需要什么，且这条规则让本地临时覆盖一个受管 skill 成为可能。
冲突要如实上报给 dashboard，不能默默生效。

| 来源 | Claude Code | Codex | pi |
|---|---|---|---|
| `skills/` | `~/.claude/skills/` | —（不支持） | `~/.pi/agent/skills/`（若支持，否则 skip） |
| `commands/` | `~/.claude/commands/` | — | — |
| `rules/` | `~/.claude/CLAUDE.md`（拼接） | `~/.codex/AGENTS.md`（拼接） | `~/.pi/agent/PI.md`（拼接，若支持） |
| `mcp/` | **`claude mcp add-json --scope user`**（见下） | — | —（pi 刻意不做 MCP） |
| endpoint/model | `settings.json` 的 env | `~/.codex/config.toml` | `~/.pi/agent/models.json` |

**`rules/` 的拼接规则**：按文件名排序，**先 `fleet/` 后 `local/`**，每段前加一行来源标记
（`<!-- cc-fleet: fleet/rules/commit-hygiene.md -->`），整个文件顶部写明它是生成物、
手改会被覆盖、真正的编辑入口在 `~/.agents/`。

规则与 skill 的合并语义**不同**：同名 skill 是 `local` **覆盖** `fleet`（同一个东西的两个版本），
而规则是**累加**——两边的规则都要生效。`local` 排在后面，所以真冲突时后出现的那条更具体、更晚被读到。
但这是约定，不是保证；**冲突要在 dashboard 上如实显示**，不能指望排序把矛盾消化掉。

**投影用复制，不用软链。** Windows 建软链要管理员或开发者模式，一个跨平台工具不能依赖它。
代价是要靠 `projected.json` 清单来收尾（删除本次不再产生的文件），这也正是清单存在的理由。

### MCP：不自己写 `~/.claude.json`

事实（Claude Code 2.1.220 核实）：user scope 的 MCP **只存在于 `~/.claude.json`**，
`~/.claude/settings.json` 没有 `mcpServers` 这个键。而 `~/.claude.json` 同时装着 OAuth 会话、
逐项目状态和缓存 —— v1 §8 明令不许碰的正是这个文件。

所以**不做读-改-写**，改为调用 Claude Code 自己的 CLI：

```bash
claude mcp add-json <name> '<json>' --scope user     # 投影一个受管 MCP
claude mcp remove   <name>          --scope user     # 接管语义下移除
```

让文件的主人去改自己的文件。cc-fleet 一个字节都不碰 `~/.claude.json`，
「把用户的登录态写坏」这条风险随之消失 —— 这比「先备份再小心合并」强一个数量级。

**代价：依赖从机装了 `claude` CLI。** 没装就 skip，dashboard 如实显示 skip 而**不打绿勾**
（沿用 v1 §10.3 对 marketplaces 的既有政策）。

`--mcp-config <file>` + `--strict-mcp-config` 是另一条真正绕开 `~/.claude.json` 的路，
但它是**每次调用的 flag**，管不了用户自己终端里怎么敲 `claude`。
只在 cc-fleet 自己拉起 claude 的场景用得上（例如 §8 的 dashboard agent）。

## 5. 从机 → 主机：push 与采纳

```
从机  在 ~/.agents/local/ 里写一个新 skill        —— 立刻可用（下次投影就进 ~/.claude）
从机  cc-fleet push skills/my-thing               —— 上交
主机  收进「待采纳」队列（不自动进 profile）
主机  dashboard / CLI 审阅 → 采纳                  —— 进入 store，成为受管项
主机  下次发布 → 全队拿到
```

**采纳必须是显式动作。** 自动采纳等于让任一从机向全队推送可执行指令 —— 这是 §8 那条
「本通道本质是 RCE」在反方向上的同一个风险，而且更隐蔽。

从机还会**持续上报本地状态摘要**（有哪些 local 项、版本、与 fleet 的冲突），
让 dashboard 能显示「laptop-home 有 3 个本地 skill 未上交」。上报的是清单，不是内容；
内容只在显式 push 时才走。

采纳后从机侧会出现同一个 id 同时存在于 `fleet/` 和 `local/` 的情况。
**从机在 applied 报告里提示可以清理 local 副本，但绝不自动删** —— 那是自留地。

## 6. 逐台配置

v1 只有分组。v2 保留分组作为基线，叠加**每设备覆盖**：

```jsonc
{
  "version": 12,
  "groups": { "full": { ... }, "minimal": { ... } },
  "assignments": { "laptop-home": "full", "vm-azure": "minimal" },
  "devices": {
    "vm-azure": {
      "add":      { "skills": ["deploy-runbook"] },   // 在组的基础上追加
      "remove":   { "skills": ["screenshot-ocr"] },   // 从组里剔除
      "override": { "endpoint": { "model": "gpt-5.6-sol" } }
    }
  }
}
```

解析顺序：`组` → `add`／`remove` → `override`。**分组仍是主要手段**，逐台覆盖是逃生舱 ——
如果每台都要写一段，说明分组划错了，工具不该鼓励这种用法。

## 7. WAN-only 控制面

控制面只有一种模式：**公网可达 + 强制 token + TLS**。不做局域网特例。

理由：从机本来就散在不同网络（家里、云上、公司），"局域网模式"服务不了真实拓扑，
却要多养一条代码路径和一套安全假设 —— 而安全假设的分支越多，出洞的地方越多。

隧道沿用 devtunnel（主机开一条，从机零公网暴露）。

**worker 的 `localhost`／`lan` 模式原样保留** —— 它服务的是本机的 claude/codex 客户端，
砍掉会让所有现有用户和本地开发直接不可用。控制面与 worker 是两套边界，不共用模式。

安全底线（在 hub 上公网之前必须全部到位）：

| 风险 | 处理 |
|---|---|
| 隧道 URL 近似公开 | fail-closed：无 token 拒绝一切 |
| 共享 token 泄露 = 全队沦陷 | ✅ 已解决（M1.5）：一次性 enroll code → 每设备 token → 可单台吊销；token 只存哈希 |
| 顶替隧道 URL 接到假主机 | ❌ **未解决**。从机无法验证 hub 真伪。M4 上公网前必须由 TLS 证书 pin 补齐；在此之前 hub 只能跑在可信网络 |
| skill/mcp 是可执行指令 | 双向都要人工确认：下发靠 profile 显式编辑，上交靠显式采纳 |
| MCP 配置里带 token | 主机侧加密存储，落盘 0600 |

## 8. dashboard 的 pi agent

dashboard 里内置一个能真正动手的 agent，用 [pi](https://pi.dev)（`@earendil-works/pi-coding-agent`，MIT）。

**provider 不需要写代码。** pi 的自定义 provider 就是 `~/.pi/agent/models.json` 里一段配置，
`api` 支持 `openai-completions`／`openai-responses`／`anthropic-messages` —— worker 这三个面都已在提供。
所以 cc-fleet 只需**生成这份文件**，和现在 `setup-codex` 写 `~/.codex/config.toml` 完全同构：

```jsonc
{
  "providers": {
    "cc-fleet": {
      "baseUrl": "http://127.0.0.1:7891/anthropic",
      "api": "anthropic-messages",
      "apiKey": "copilot-reverse-local",
      "models": [ { "id": "claude-opus-5", "contextWindow": 1100000, "input": ["text", "image"] } ]
    }
  }
}
```

即：新增一个 `setup-pi`，与 `setup-claude`／`setup-codex` 并列。模型与窗口取 worker 的实时 discovery，
不硬编码（v1 已有这套逻辑）。

嵌入方式用 pi 的 **RPC 模式**（stdin/stdout 上的 JSON 协议）而非 SDK：
supervisor 与 agent 进程隔离，agent 崩了不会带走 dashboard —— 与现有 supervisor/worker 的关系一致。

agent 能做什么：读设备状态、读/改 profile、审阅待采纳队列、发布、回滚。
**破坏性动作（发布、采纳、吊销设备）一律需要人确认**，不因为是 agent 就放宽 §7 那条底线。

## 9. 架构

```
┌─ HUB（主机，一台）────────────────────────────────┐
│  cc-fleet                                         │
│   ├── worker :7891    copilot-reverse 组件         │
│   │                   proxy 转发 + 登录 + AUTH      │
│   ├── supervisor      dashboard + pi agent (RPC)   │
│   └── control/hub     profile store（含逐台覆盖）   │
│                       device registry + 待采纳队列  │
└───────────────┬───────────────────────────────────┘
                │  devtunnel（TLS，WAN-only）
                │    /anthropic|/openai  → LLM 推理
                │    /control/events     → 配置下推（SSE）
                │    /control/msg        → 状态上报 + push（POST）
    ┌───────────┼───────────┬───────────┐
    ▼           ▼           ▼           ▼
 laptop-home  vm-azure    wsl        macbook
 cc-fleet（agent 模式：不起 worker、不登 GitHub）
 ~/.agents/{fleet,local} → 投影 → ~/.claude, ~/.codex, ~/.pi
```

## 10. 必须提前认下的代价

1. **主机是单点。** 主机离线 → 从机拿不到新配置，**也没法推理**。从机缓存上次 profile 照常工作；LLM 无回退。
2. **Claude Code 的加载时机。** plugins/MCP 启动时加载，skills/CLAUDE.md 下次会话生效。
   apply 后必须上报 `needsRestart`，dashboard 标黄 —— 不许假装已生效。
3. **`~/.agents` 是新的编辑入口。** 直接改 `~/.claude/skills/` 或 `~/.claude/CLAUDE.md` 会被下次投影覆盖
   （后者整个是生成物）。这是分层的必然代价，只能靠 CLI/文档反复讲清楚。
4. **MCP 投影依赖从机装了 `claude` CLI。** 这是为了不碰 `~/.claude.json` 主动选的依赖：
   宁可在没有 CLI 的机器上 skip 掉 MCP，也不去读-改-写一个装着用户凭证的文件。
   skip 必须如实显示，不许打绿勾。
5. **pi 不支持 MCP。** 官方明确把 MCP 列在「刻意不做」里，所以 MCP 这一项在 pi 上没有投影目标。
   一份 profile 里的 MCP 只对 Claude Code 生效 —— dashboard 要能显示这种「部分覆盖」，
   而不是让人以为全队所有工具都拿到了。

## 11. 分期

| 阶段 | 内容 | 出口标准 |
|---|---|---|
| **M1** ✅ 竖切 | proto、抽象 channel、SSE+POST、`skills/` 完全接管 + 备份 + restore、`hub`/`join`/`restore` | 已交付（PR #1、#2） |
| **M1.5** ✅ 安全 | enroll 一次性 code → 每设备 token → 单台吊销；`worker/`+`providers/` 不 import `control/` 的边界测试 | 已交付（PR #3）：共享 token 彻底消失。**但指纹 pin 未做（见下），所以上公网的前置条件尚未满足** |
| **M2** 存储分层 | `~/.agents/{fleet,local}` + 投影层 + `projected.json` 清单；MCP 经 `claude mcp add-json/remove` 投影（无 CLI 则 skip） | 一份 skill 同时正确出现在 Claude Code 与 pi；一个 MCP 出现在 `claude mcp list` 且 `~/.claude.json` 未被 cc-fleet 写过 |
| **M3** 双向 | `cc-fleet push`、待采纳队列、本地状态上报、冲突显示 | 从机造的 skill 能经人工采纳分发到全队 |
| **M4** WAN | 控制面挂 supervisor + devtunnel；逐台配置；endpoint/model 下发；从机推理走主机 | 异地从机零配置接入 |
| **M5** 全量 | plugins/marketplaces、settings/hooks、secrets 加密、needsRestart | profile 覆盖 §4 全部投影目标 |
| **M6** 界面 | dashboard 图形编辑 + pi agent（RPC）+ `setup-pi` | 全流程不碰 json 文件 |

顺序的两条理由：**安全（M1.5）排在能力之前**，因为 M4 一上公网，共享 token 就是全队沦陷；
**存储分层（M2）排在双向（M3）之前**，因为没有 `local/` 自留地，push 无处可写。

> **M4 之前必须补上的一件事：主机身份认证。**
> M1.5 交付了每设备 token 和单台吊销，但**没有做指纹 pin** —— 明文 HTTP 上的"指纹"需要 hub
> 持有密钥并证明持有，当时判断留给 TLS 更合适。结果是：**从机目前无法验证自己连到的是不是真 hub**，
> 隧道 URL 被顶替就会接到假主机，而假主机能下发任意可执行指令。
> 在 M4 把 hub 放上公网之前，这一条必须由 TLS（证书 pin）或 hub 密钥补齐。
> 在那之前，hub 只能跑在可信网络上 —— 这是硬约束，不是建议。

## 12. 待定

- `~/.agents` 是否要成为一个独立于 cc-fleet 的开放约定（别的工具也能读写）
- profile 是否纳入 git（完整版本历史 vs 只留 N 个快照）
- 从机上报的本地状态摘要保留多久、是否入库
- pi agent 的权限边界：能不能直接改 profile，还是只能提议
