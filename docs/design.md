# cc-fleet — Claude Code 主从配置控制面

> 状态：设计草案，待批准。本文描述**要建什么、为什么**，不含实现代码。
> cc-fleet 是 [copilot-reverse](https://github.com/wangcansunking/copilot-reverse) 的**超集继任者**，带完整历史 fork。

## 1. 要解决的问题

已有 `can-claude-profile`（git 仓库 ↔ 机器）能同步 skills/MCP/CLAUDE.md，但它是**拉模型**：
每台机器自己 clone、自己 `install`。真实需求是反过来的 —— **在主机器上改一次，所有从机器跟着变**，
而且从机器不该有仓库、不该装 git、不该登 GitHub、不该各自配 endpoint。

这不是同步工具，是**控制面**（control plane）。

## 2. 模块边界

cc-fleet 一个二进制、两种角色。仓库内部分四块：

```
src/
  worker/       LLM 代理（继承）
  supervisor/   daemon + dashboard（继承）
  tui/          slash 命令（继承）
  control/      ← 新写
    proto/        协议 + profile schema
    hub/          主机侧：profile store、device registry、推送引擎
    agent/        从机侧：apply 引擎、备份/回滚、状态上报
```

**硬约束：`control/` 不得 import `worker/` 或任何 Copilot 相关模块。**
它只认一个抽象双向通道（`send` / `onMessage`），传输由外层注入。

换来三件事：控制面可以脱离隧道、脱离 Copilot 订阅，用纯 HTTP 在本机跑完整 E2E；
以后换传输（直连 / SSH / 别的宿主）不用重写；`worker/` 也不必知道 `~/.claude` 的目录结构。
**M1 刻意只做 `control/`、不接入宿主**，正是为了让这条约束在第一天就被真实验证一次 ——
并且由 `tests/control/boundary.test.ts` 扫描每一条 import 持续守住，而不是靠自觉。

## 3. 与 copilot-reverse 的关系

带完整 git 历史 fork，upstream 保留为 remote —— 上游修复用 `git merge upstream/master` 拿。
为此付出的纪律：**不做全局字面量改名**。大规模 rename 会让每次 merge 都是冲突风暴；
命名随模块被改动而逐步收敛。

已做的最小改名：

| 项 | 值 | 理由 |
|---|---|---|
| 包名 / bin | `cc-fleet` | 新产品身份 |
| 版本 | 从 `0.1.0` 重新起算 | 不继承 0.21 的语义 |
| 数据目录 | `~/.cc-fleet`（**不是** `~/.copilot-reverse`） | 两个产品可能同机共存；共用目录会争抢同一份 GitHub token / network.json / db |
| CHANGELOG | 上游的挪到 `docs/upstream-changelog.md` | 保留出处，但版本线重开 |

数据目录分家的代价：主机若已跑过 copilot-reverse，需要重新登录一次 GitHub。
**M1 补一个首次启动导入旧 token 的动作**，把这个代价抹掉。

## 4. 已确定的决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 仓库形态 | fork copilot-reverse 为**超集继任者** | 一条隧道、一套鉴权、一个 dashboard、一个进程 |
| 传输方向 | 从机连主机（主机开一条 devtunnel） | 一条隧道、一次登录；从机零公网暴露，NAT 无关 |
| 控制语义 | 主机说了算，长连接反向推送 | 主机改完，在线从机秒级生效 |
| 真相源 | 主机维护**显式 profile**，与主机自身 `~/.claude` 解耦 | 支持分组 / 版本 / 回滚；主机上的实验性配置不会误泄 |
| 接管范围 | **完全接管**（不在 profile 里的受管项一律清除） | 从机全是本人机器，状态确定性优先 |
| 鉴权 | 一次性 enroll code → 长期 device token | 可单台吊销；不像共享密钥泄一台等于泄全部 |
| LLM 流向 | 从机推理经隧道走主机的 Copilot 订阅 | 一份订阅服务所有从机；从机不登 GitHub |
| 从机常驻 | **agent 活在 cc-fleet 进程内**，不做系统服务 | 从机本来就要开着它才能连 LLM；少一个要维护的常驻件 |
| 下发内容 | skills+commands / CLAUDE.md+settings+hooks / MCP / plugins+marketplaces / endpoint+model | 全量 |
| 主机 UX | Web dashboard 图形编辑（见 §11 分期） | 直观；但工程量最大，放最后 |

## 5. 架构

```
┌─ HUB（主机，一台）─────────────────────────────┐
│  cc-fleet                                      │
│   ├── worker       :7891   LLM 代理（继承）     │
│   ├── supervisor           dashboard（继承）    │
│   └── control/hub  ← 新写                       │
│        ├── profile store   版本化 desired-state │
│        ├── device registry 设备 + token + 状态  │
│        └── /control/*      enroll + WS 推送     │
└───────────────┬────────────────────────────────┘
                │  一条 devtunnel（TLS）
                │    /v1/messages  → LLM 推理
                │    /control/ws   → 配置推送
    ┌───────────┼───────────┬───────────┐
    ▼           ▼           ▼           ▼
 laptop-home  vm-azure    wsl        macbook      ← NODE（从机，N 台）
 cc-fleet（agent 模式：不起 worker、不登 GitHub）
```

**一个二进制，两种角色。** 主机 `npx cc-fleet`；从机 `npx cc-fleet join <tunnel-url> <code>`。

> **代价：从机关掉 cc-fleet 就失联**，期间的配置变更收不到，下次启动时补齐。
> 可接受 —— 从机不开它本来也没有 LLM 后端。

## 6. 协议

### 6.1 接入（一次性）

```
主机  dashboard/TUI → 生成 enroll code        ABC-123（5 分钟 TTL，一次性）
从机  copilot-reverse join https://xxx.devtunnels.ms ABC-123
       POST /control/enroll {code, hostname, os, agentVersion}
       ← 200 {deviceId, deviceToken, masterFingerprint}
```

`deviceToken` 落盘 0600。`masterFingerprint` 由从机固定（pin），防止隧道 URL 被顶替后接到假主机。

### 6.2 常态

```
从机 → WSS /control/ws     Authorization: Bearer <deviceToken>
主机 → apply {version, desiredState}      发布时下发
从机 → applied {version, ok, warnings[], needsRestart}
从机 → heartbeat（30s）    主机据此标 online/offline/drift
```

> **实现说明（M1 起）：** 双向通道落地为 **SSE（`GET /control/events`，主机→从机）+ POST
> （`POST /control/msg`，从机→主机）**，不是 WebSocket —— 零新依赖，且与 supervisor 已有的
> `/api/events` 写法一致。二者被 `control/channel.ts` 的抽象通道遮住，换回 ws 只改 `transport/`。
> 见 [`specs/2026-08-13-control-m1-tracer.md`](specs/2026-08-13-control-m1-tracer.md) §6。

### 6.3 推理

```
从机 claude → https://<tunnel>/v1/messages   Authorization: Bearer <deviceToken>
```

**同一个凭证守两个面。** 在 dashboard 吊销一台设备 → 它同时失去配置推送**和** LLM 后端。

## 7. Profile 数据模型

```jsonc
{
  "version": 12,
  "publishedAt": "2026-08-13T09:00:00Z",
  "groups": {
    "full": {
      "skills":       [ { "id": "code-review", "files": [ {"path":"SKILL.md","content":"..."} ] } ],
      "commands":     [ ... ],
      "claudeMd":     "# Global Rules\n...",
      "settings":     { /* 深合并，本地 env 保留 */ },
      "hooks":        [ ... ],
      "mcpServers":   { /* 主机侧加密存储 */ },
      "marketplaces": [ ... ],
      "plugins":      [ ... ],
      "endpoint":     { "baseUrl": "auto", "model": "claude-opus-4.8" }
    },
    "minimal": { "skills": [...], "claudeMd": "..." }
  },
  "assignments": { "laptop-home": "full", "vm-azure": "minimal" }
}
```

`"baseUrl": "auto"` → 从机自己代入**当前连上的隧道地址**。隧道 URL 会变，绝不硬编码。

## 8. 从机 apply 语义（完全接管）

**受管路径**（不在 profile 里就删除）：

```
~/.claude/skills/  ~/.claude/commands/  ~/.claude/hooks/
~/.claude/CLAUDE.md  ~/.claude/settings.json（除 env 段）
```

**明确不碰**（"完全接管" ≠ 抹掉身份和记忆）：

```
~/.claude.json            OAuth / 凭证
~/.claude/projects/       会话历史
~/.claude/memory/ todos/  记忆
settings.json 的 env 段    本地代理 / 认证
```

**每次 apply 前自动全量备份** → `~/.claude/.cc-fleet/backups/<ts>.zip`（保留最近 10 份）。
回滚两条路：主机推 `version: N-1`，或从机本地 `cc-fleet restore`。

## 9. 安全

| 风险 | 处理 |
|---|---|
| devtunnel 的 anonymous URL 近似公开 | 沿用 copilot-reverse 现有 LAN 模式的 **fail-closed** 设计，新增 `wan` 模式；`/v1/messages` 也必须带 token，否则别人能烧你的 Copilot 配额 |
| skill 是可执行指令 → 通道本质是 RCE | enroll code 短 TTL + 一次性；device token 可单台吊销；从机 pin 主机指纹 |
| MCP 配置里带 token | 主机侧 profile 加密存储；传输走 TLS；从机落盘 0600（Claude 必须能读，无法再收紧） |
| 主机被攻破 = 全部从机沦陷 | 接受（同一人所有机器）；但保留吊销与审计日志 |

## 10. 三个必须提前认下的代价

1. **主机是单点。** 主机离线 → 从机既拿不到新配置，**也没法推理**（"一份订阅多台机"的必然结果）。
   缓解：从机缓存上次成功的 profile，离线时照常工作；但 LLM 无回退。
2. **Claude Code 的重启语义。** plugins / MCP 在**启动时**加载，skills / CLAUDE.md 下次会话生效。
   apply 后从机必须上报 `needsRestart`，dashboard 标黄 —— 不许假装已生效。
3. **marketplaces 需要 claude CLI。** 从机没装 CLI 时这一项只能 skip（沿用 can-claude-profile 现有行为），
   dashboard 要如实显示 skip 而不是绿勾。

## 11. 分期

| 阶段 | 内容 | 出口标准 |
|---|---|---|
| **M1** 骨架 | `control/{proto,hub,agent}`：enroll、推送通道、完全接管 apply（skills/commands/CLAUDE.md）、备份回滚、设备列表；顺带做旧 token 导入。**只在 `control/` 内，不 import `worker/`**，传输用纯 HTTP over LAN，profile 手写 json | `control/` 单测 + 本机双进程 E2E 全绿；局域网两台机，主机改 skill → 从机 5 秒内生效 |
| **M2** 接入宿主 | `control/` 挂到 supervisor；`/network` 新增 wan 模式 + devtunnel；endpoint/model 下发；从机推理走主机 | 异地一台从机零配置接入，`claude` 直接可用 |
| **M3** 全量 | MCP + plugins/marketplaces + settings/hooks；secrets 加密；needsRestart 上报 | profile 覆盖 §7 全部字段 |
| **M4** 界面 | dashboard 图形编辑器：设备面板、profile 编辑、分组、diff、发布/回滚 | 全流程不碰 json 文件 |

**M1 进度**：第一条竖切已交付（见
[`specs/2026-08-13-control-m1-tracer.md`](specs/2026-08-13-control-m1-tracer.md)）——
proto、抽象通道、SSE+POST 传输、`skills/` 完全接管 + 备份 + `restore`、`hub`/`join`/`restore` 三个命令。
**M1 剩余**：enroll 一次性 code + 每设备 token + 吊销 + 指纹 pin、`commands/`／`CLAUDE.md`／`settings`、
设备列表、旧 token 导入。**enroll 必须在 M2 把 hub 放上公网之前完成。**

M1–M3 用 CLI + 手写 profile 文件；图形界面放 M4。
理由：**先把控制面跑通，再做界面** —— 界面最贵，且最不影响架构正确性。
M1 不接入宿主（supervisor / 隧道 / Copilot），正是为了验证 §2 那条硬约束真的成立：
`control/` 对 `src/` 其余部分零依赖，由 `tests/control/boundary.test.ts` 逐条扫描 import 强制。

## 12. 待定

- `cc-fleet` 是否**取代** `can-claude-profile`（git 拉模型），还是两者并存（离线/冷启动仍走 git）
- profile 是否纳入 git（主机侧完整版本历史 vs 只留 N 个快照）
- 是否需要分阶段发布（canary → 全量），还是分组已经够用
