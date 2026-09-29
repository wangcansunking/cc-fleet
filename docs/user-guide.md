# cc-fleet 使用指南

> 对应功能：M4（devtunnel + 本机 fleet dashboard）及可配置的 Claude 模型映射。本文只写已经实现且有自动化/真实链路验证的功能。

## 它解决什么

你有好几台机器都在用 Claude Code。在一台上改一次配置，其余的跟着变；
从机不需要仓库、不需要装 git、不需要登 GitHub。

## 1. 起主机（hub）

在你**常开的那台**机器上，如果从仓库源码开发运行（当前 npm 包尚未发布），先安装依赖，然后直接启动 Hub，**不需要先 build**：

```bash
npm install
```

```bash
npm run dev:hub
```

等价写法是 `npm run dev -- hub`。它会将完整 Hub（supervisor、Worker 和 Fleet Gateway）留在当前终端运行；按 `Ctrl+C` 停止这次启动的进程。单独运行 `npm run dev` 则进入交互式 TUI，不会主动启用 Hub role。如果本机已有 supervisor 在运行，该命令会复用它并提示不拥有其生命周期；此前启动 supervisor 的进程仍负责停止它。`--foreground` 是另一种仅供诊断的独立 HTTP hub，不会启动 Dashboard/Worker。

已构建的 CLI 仍可运行 `node dist/cli/index.js hub`，它会确保后台 supervisor 启动后返回；这与保持终端附着的 dev Hub 不同。`npx cc-fleet hub` 留作将来 npm 发布后的安装方式，目前请使用上面的源码命令。本指南其余 `npx cc-fleet <子命令>` 示例，在源码开发环境中统一替换为 `npm run dev -- <子命令>`（例如 `npm run dev -- approve`）。

首次会生成 profile，启用 hub role，并确保 supervisor 托管 Worker、Fleet Gateway、node agent 与 devtunnel 生命周期。命令会给出只在本机可访问的 dashboard：

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

接机器**不用重启 hub**：从机随时可以来敲门，在本机 dashboard 或 CLI 批准即可。系统开机自启动不在本阶段范围内；只要 cc-fleet/supervisor 进程在，host 进程异常退出会退避并恢复同一个 persistent URL。诊断时可用 `npm run dev -- hub --foreground --port <port>` 起 standalone HTTP hub。

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

### 3.1 在主机配置 Claude 模型映射

以下是**源码版**操作说明；仓库尚未正式发布 npm 包（见第 9 节），不要把 `npx cc-fleet` 当成已可从 npm 安装的命令。

如果你的 Copilot 账号提供的模型 ID 与希望在 Claude Code 中使用的 `claude-*` 名称不同，可以在 **hub 本机**打开 `http://127.0.0.1:7990/`，进入 **Claude map** 页：

1. 勾选 **Enable Claude alias map**。全新配置默认关闭；如果旧 `prefs.json.claudeMapEnabled` 已启用，会继承其状态。启用后仍保留五条内置推荐映射。
2. 在新增行的两个输入框分别填 alias（如 `claude-fable-6-1`）和 Copilot 模型发现返回的**精确** backend ID（如 `gemini-3-pro`，仅作格式示例，请以你的账号实际可用 ID 为准），点 **Add mapping**。backend 的下拉建议来自当前 live discovery，也允许预先填写暂未出现的 ID；不限定 `gpt-*`。
3. 点 **Save & restart** 才会持久化，并请求重启 Worker；正在进行的推理可能短暂中断。**Cancel / Reload saved** 放弃未保存的修改。编辑已有行的 backend 可以覆盖内置映射；**Disable** 禁用单条，**Enable** 重新设置该条；**Remove override** 只删除用户覆盖，内置行回退到当前版本默认值，用户新增的行则消失。**Reset to defaults** 经确认后清空所有用户条目，但保留全局开关状态。
4. 观察状态：`available` 表示目标精确 ID 出现在 live discovery，可发布和路由；黄色的 `unavailable` 表示配置已保存，但 alias 暂不发布、不映射，未来 Worker 重新发现该 backend 时会自动生效；灰色的 `disabled` 表示该条被禁用。`builtin` / `user` 标明映射来源。

也可以在 hub 的交互式 TUI（例如从源码运行 `npm run dev`）输入下列**斜杠命令**；它们不是独立的 shell 子命令：

```text
/claude-map
/claude-map on
/claude-map off
/claude-map set claude-fable-6-1 gemini-3-pro
/claude-map disable claude-haiku-4-5
/claude-map remove claude-fable-6-1
/claude-map reset
```

不带参数时显示开关、每条有效映射的来源和可用状态。`set` 可新增或覆盖；`remove` 只移除用户条目，不能删除内置默认，想关闭内置行请用 `disable`。命令保存成功后自动请求重启 Worker；如果提示“setting saved, but worker activation is incomplete”，配置已落盘，可用 TUI 的 `/restart` 重试激活。重新打开 Claude Code 的 `/model` 列表；如果客户端缓存了旧列表，重启 Claude Code/Desktop。

别把 backend 当成 Claude 客户端模型名：在 Dashboard **Profile** 页选择模型或给单台设备指定模型时填写 **alias**（例如 `claude-fable-6-1`），真正发往 Copilot 的 backend 由 hub Worker 决定。映射是**整个 hub 共享**的，所有通过该 hub/devtunnel 推理的节点继承同一套规则，不做逐设备映射；Profile 的 draft/publish 只管理客户端选用哪个 alias，**Claude map 本身无需 publish**。OpenAI/Codex 模型发现也不会多出合成的 Claude alias。

映射保存在 hub 的 `~/.cc-fleet/claude-map.json`，首次保存前兼容读取旧 `prefs.json.claudeMapEnabled`。alias 必须是小写 `claude-*`，输入末尾的 `[1m]` 会自动剥离；backend 必须是无空格的精确 ID，且不能与 alias 相同。用户条目优先于内置推荐；配置文件损坏或版本未知时，映射整体关闭并显示警告，不会部分生效，也不会被普通保存悄悄覆盖。修复该文件前先备份。有关校验和故障语义见[实现规格](specs/2026-09-05-flexible-claude-map.md)。

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
