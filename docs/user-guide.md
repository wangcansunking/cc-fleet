# cc-fleet 使用指南

> 对应版本：M4（devtunnel + 本机 fleet dashboard）。本文只写已经实现且有自动化/真实链路验证的功能。

## 它解决什么

你有好几台机器都在用 Claude Code。在一台上改一次配置，其余的跟着变；
从机不需要仓库、不需要装 git、不需要登 GitHub。

## 1. 起主机（hub）

在你**常开的那台**机器上：

```bash
npx cc-fleet hub
```

首次会生成 profile，启用 hub role，并确保 supervisor 在应用进程中托管 Worker、Fleet Gateway、node agent 与 devtunnel 生命周期。命令会给出只在本机可访问的 dashboard：

```
fleet hub enabled — the supervisor now owns the gateway, node agent and devtunnel lifecycle
dashboard: http://127.0.0.1:7990/
```

Dashboard 的 **Tunnel** 页检测 `devtunnel` CLI 与登录状态。未安装时只展示官方安装命令；未登录时点击 device-code 登录。点击 **Enable / reconnect** 后，cc-fleet 自动创建带 `cc-fleet` label 的 persistent tunnel、配置 `7992/http` 端口并持久托管同一个 URL。

三个端口的边界：

| 端口 | 用途 | 可达性 |
|---:|---|---|
| `7990` | dashboard + 管理 API | 只监听 loopback，绝不进 tunnel |
| `7991` | 本机 Worker | 默认 loopback；原有 LAN 模式仍可选 |
| `7992` | Fleet Gateway | loopback，由 devtunnel 暴露 `/control`、`/anthropic`、`/openai` |

Dev Tunnels 是 Microsoft 的 public preview developer service，没有 SLA。匿名 tunnel 只负责连通；control 使用每设备 token，LLM 使用单独的 fleet key，未带正确凭证的公网请求在到达 Worker 前即被拒绝。

接机器**不用重启 hub**：从机随时可以来敲门，在本机 dashboard 或 CLI 批准即可。系统开机自启动不在本阶段范围内；只要 cc-fleet/supervisor 进程在，host 进程异常退出会退避并恢复同一个 persistent URL。诊断时仍可用 `cc-fleet hub --foreground --port <port>` 起 standalone HTTP hub。

## 2. 接一台从机

在另一台机器上，把 dashboard Tunnel 页显示的 HTTPS URL 传给 join：

```bash
npx cc-fleet join https://<tunnel>-7992.<region>.devtunnels.ms
```

它会打出一个码，然后停在那里等：

```
  approve this machine on the hub:

      cc-fleet approve K7QP-3M2X

  waiting…...
```

回到 hub，先看清楚是谁在敲门，再放行：

```bash
npx cc-fleet approve            # 不带码 = 列出所有等待的机器
```

```
K7QP-3M2X  laptop-home (linux, v0.1.0)  expires in ~14m
```

```bash
npx cc-fleet approve K7QP-3M2X
```

```
approved laptop-home (linux) — it will pick up its credential within seconds
```

从机那边随即继续：

```
enrolled as laptop-home
cc-fleet node laptop-home → http://192.168.1.10:7992
store:   /home/you/.agents  (fleet/ is hub-managed; local/ is yours and never touched)
projects to: /home/you/.claude/skills and /home/you/.claude/CLAUDE.md — both are GENERATED
edit skills and rules in /home/you/.agents/local, not in /home/you/.claude
applied v1 (store +1 / -0, projected 1)
```

不想放行就 `npx cc-fleet deny K7QP-3M2X`，从机会立刻停下来报错，而不是傻等到过期。

码 15 分钟过期、只能用一次。**以后直接 `npx cc-fleet join`**（不带参数）就会用存好的凭证重连。

批准后 `join` 保存凭证、通知本机 supervisor 启动 node agent，然后命令退出。只要 cc-fleet/supervisor 进程仍在，agent 会后台退避重连；401/403（吊销或身份不匹配）是终止状态，不会自动重新敲门。Hub 下发公网 endpoint、fleet LLM key 和逐设备 Claude/Codex 模型后，节点会先备份原始 `~/.claude/settings.json` 与 `~/.codex/config.toml`，再只合并 cc-fleet 管理字段。

## 3. 改配置

推荐打开本机 dashboard 的 **Profile** 页：结构化表单可改默认 Claude/Codex 模型、assignment，Advanced JSON 可编辑完整 groups/items/device overrides。**Save draft 不会影响节点**；Preview diff 按设备展示新增/删除/变更；二次确认 Publish 后才原子写 live profile。每次 publish 先保留 history，Rollback 会把旧内容作为更高的新版本发布，version 永不倒退。

也可在没有并发 dashboard/CLI 写操作时直接编辑主机的 `~/.cc-fleet/profile.json`；多端同时编辑时请使用 dashboard 的 revision/draft 流程，因为普通文件编辑器不参与 cc-fleet 的写锁：

```jsonc
{
  "version": 2,
  "groups": {
    "full": {
      "skills": [
        {
          "id": "code-review",
          "files": [
            { "path": "SKILL.md", "content": "---\nname: code-review\ndescription: ...\n---\n\n审查要点……\n" },
            { "path": "refs/checklist.md", "content": "1. ...\n" }
          ]
        }
      ],
      "rules": [
        { "id": "commit-style", "content": "提交信息用祈使句。" },
        { "id": "testing",      "content": "改动必须带测试。" }
      ]
    },
    "minimal": { "skills": [], "rules": [] }
  },
  "assignments": {
    "laptop-home": "full",
    "vm-azure":    "minimal"
  }
}
```

**保存后几秒内所有在线从机生效。** 不需要重启 hub。

三条要点：

- **`version` 每次改动都要 +1** —— 从机靠它判断。
- **`assignments` 的键是从机的 hostname**（`cc-fleet devices` 里能看到）。
  **没被分配的机器不会被动任何东西**——这是刻意的 fail-safe，不是 bug。
- **profile 写坏了不会伤到任何人。** hub 校验失败就继续用上一份可用的，
  并在自己的输出里报错。半份配置绝不会下发。

## 4. 从机自己加东西

`~/.agents/local/` 是**从机的自留地，主机永远不碰**：

```bash
mkdir -p ~/.agents/local/skills/my-experiment
$EDITOR ~/.agents/local/skills/my-experiment/SKILL.md

mkdir -p ~/.agents/local/rules
$EDITOR ~/.agents/local/rules/my-note.md
```

下一次 apply 就会连同主机下发的一起投影到 `~/.claude/`。

**同名时本地覆盖主机的**，并且会提示：

```
applied v3 (store +0 / -0, projected 4)
  note: your local "code-review" overrides the fleet copy
```

主机侧在 hub 的输出里也看得到这条警告。

## 5. 目录到底谁管谁

```
~/.agents/                 ← 真正的编辑入口
  fleet/                   主机下发。别手改，下次 apply 会被覆盖
  local/                   你的。cc-fleet 永远不删不改
  .cc-fleet/backups/       每次变更前的全量快照，留最近 10 份

~/.claude/
  skills/                  ← 生成物。手放进去的会被删掉
  CLAUDE.md                ← 生成物，由 rules/*.md 拼接而成
  commands/  projects/     cc-fleet 完全不碰
  .claude.json             完全不碰（你的登录态在这里）
```

**这是唯一容易踩的坑：`~/.claude/skills/` 现在是投影产物。**
手动放进去的东西会在下次 apply 时被删（有备份，但别依赖它）。要加东西就加到 `~/.agents/local/`。

从 M1 升级上来的机器会**自动**把手放的 skill 搬进 `local/`——但只搬 profile 没有声明的那些。

## 6. 管设备

```bash
# 在主机上
npx cc-fleet devices
```

```
laptop-home              linux    v0.1.0      last seen 12s ago
vm-azure                 linux    v0.1.0      last seen 3m ago
old-laptop               darwin   v0.1.0      REVOKED 2h ago
```

踢掉一台：

```bash
npx cc-fleet revoke old-laptop
```

**几秒内生效，不用重启 hub。** 那台机器上的进程会打印原因并以非零码退出：

```
hub rejected this device's credential (401) — it may have been revoked
re-enrol with: cc-fleet join http://192.168.1.10:7992
```

吊销记录会保留（审计用），同一台机器重新 join、你在 hub 上再批一次就能回来。

## 7. 出问题了

**从机回滚到上一次变更前：**

```bash
npx cc-fleet restore
```

会恢复 `~/.agents/fleet/` 并立刻重新投影，所以 `~/.claude/` 也跟着回去。
`~/.agents/local/` 不受影响。

**主机回滚：** 把 profile 改回旧内容、`version` 继续往上加。别把 version 改小。

**从机连不上：** 它会自己退避重连（1s → 5s 封顶），hub 重启也不用管它。
只有凭证被拒（401）才会放弃并退出——因为那不会自己好。

## 8. 环境变量

| 变量 | 作用 |
|---|---|
| `AGENTS_HOME` | 覆盖 `~/.agents` |
| `CLAUDE_HOME` | 覆盖 `~/.claude` |
| `FLEET_HUB_URL` + `FLEET_TOKEN` | 免落盘提供从机凭证（CI / 容器用） |
| `FLEET_DEVICE_ID` | 覆盖上报的 hostname |

容器里跑双机可以直接参考 [`e2e/docker/fleet-e2e.sh`](../e2e/docker/fleet-e2e.sh)。

## 9. 现在还不能做的事

| 你想做的 | 现状 |
|---|---|
| **commands / plugins / marketplaces / settings / hooks 下发** | ❌ M5 全量 profile 尚未实现 |
| **加密 fleet secrets** | ❌ 目前只有 tunnel/LLM 凭证按 0600 落盘与 API 隐藏；通用 secrets profile 尚未实现 |
| **Codex rules/skills 与 pi 投影** | ❌ 节点的 Codex endpoint/model 已自动配置，但规范内容投影仍主要面向 Claude Code |
| **dashboard 内置 pi agent / setup-pi** | ❌ 本阶段只完成图形管理台，不含 pi RPC agent |
| **系统开机自动启动** | ❌ supervisor 仅在应用运行期间托管；未安装 systemd/launchd/Task Scheduler |
| **生产级公网 SLA** | ❌ Dev Tunnels 是 public preview，无 SLA；适合个人开发车队，不应伪装成高可用生产控制面 |
| **`npx cc-fleet` 正式发布** | ❌ npm 发布身份仍需完成 |

## 10. 两条安全边界，请当真

**1. 匿名 tunnel 不是认证。** 公网只暴露 `7992` 的 data-plane gateway：`/control` 用每设备 token，`/anthropic`/`/openai` 用单独 fleet LLM key；`/` 与 `/api/*` 返回 404，dashboard 始终只在 `127.0.0.1:7990`。不要把 `7990` 或原始 Worker 端口另行暴露。

**2. skill 就是给 agent 的指令。** 把一台机器接进车队，等于允许主机决定它执行什么。接入必须由人在本机 dashboard/CLI 逐台批准、每台设备独立凭证、可单台吊销；节点 push 也只进 pending，必须人工 adopt。主机被攻破仍然等于全部从机沦陷，这是设计上接受的单点代价（前提是所有机器都是你自己的）。
