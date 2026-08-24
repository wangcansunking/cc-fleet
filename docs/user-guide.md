# cc-fleet 使用指南

> 对应版本：M2（PR #5）。**本文只写已经实现、且被 e2e 覆盖的功能**；
> 还没做的部分集中在最后一节，不混在正文里。

## 它解决什么

你有好几台机器都在用 Claude Code。在一台上改一次配置，其余的跟着变；
从机不需要仓库、不需要装 git、不需要登 GitHub。

## 1. 起主机（hub）

在你**常开的那台**机器上：

```bash
npx cc-fleet hub
```

输出：

```
wrote a starter profile at /home/you/.cc-fleet/profile.json
cc-fleet hub listening on :7892
profile: /home/you/.cc-fleet/profile.json

enrol a node with (code is single-use, expires in 5 minutes):
  cc-fleet join http://<this-machine>:7892 K7QP-3M2X

run `cc-fleet enroll-code` for another one; codes die when this hub stops.
note: traffic is plain HTTP and a node cannot yet verify it reached the RIGHT hub —
      keep this on a trusted network until TLS lands.
```

**hub 必须一直开着**——它是前台进程，关掉从机就收不到推送了（M4 会把它折进后台 daemon）。

`K7QP-3M2X` 这个码：**5 分钟过期、只能用一次**。每台从机各要一个，
再要一个就重启 hub（目前只在启动时铸码）。

## 2. 接一台从机

在另一台机器上：

```bash
npx cc-fleet join http://192.168.1.10:7892 K7QP-3M2X
```

```
enrolled as laptop-home
cc-fleet node laptop-home → http://192.168.1.10:7892
store:   /home/you/.agents  (fleet/ is hub-managed; local/ is yours and never touched)
projects to: /home/you/.claude/skills and /home/you/.claude/CLAUDE.md — both are GENERATED
edit skills and rules in /home/you/.agents/local, not in /home/you/.claude
applied v1 (store +1 / -0, projected 1)
```

码只用这一次。**以后直接 `npx cc-fleet join`**（不带参数）就会用存好的凭证重连。

从机也是前台进程，得开着才收得到推送。

## 3. 改配置

profile 在主机的 `~/.cc-fleet/profile.json`，**手写 json**（图形编辑器在 M6）：

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
re-enrol with: cc-fleet join http://192.168.1.10:7892 <new-code>
```

吊销记录会保留（审计用），同一台机器可以用新码重新接入。

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

按 [`docs/design.md`](./design.md) §11 的排期：

| 你想做的 | 现状 |
|---|---|
| **MCP 下发** | ❌ 没实现。profile 里写了也不会生效（M2 下一刀） |
| **从机把 skill 上交主机** | ❌ 没实现。`local/` 只是自留地，还没有 `push`（M3） |
| **逐台单独配置** | ❌ 只有分组。`devices.<id>.add/remove/override` 还没做（M4） |
| **公网 / 异地接入** | ❌ 只能局域网。devtunnel + WAN 模式在 M4 |
| **从机走主机的 Copilot 推理** | ❌ 从机目前只同步配置，不共享 LLM 后端（M4） |
| **Codex / pi 也拿到配置** | ❌ 投影目前只到 Claude Code |
| **图形编辑 / dashboard agent** | ❌ M6 |
| **`npx cc-fleet` 直接可用** | ❌ **还没发布到 npm**。现在只能从源码跑 |

## 10. 两条安全边界，请当真

**1. hub 只能跑在可信网络上。** 现在是明文 HTTP，而且**从机无法验证自己连到的是不是真 hub**——
指纹 pin 没做，要等 M4 上 TLS。假 hub 能向你的机器下发任意可执行指令。

**2. skill 就是给 agent 的指令。** 把一台机器接进车队，等于允许主机决定它执行什么。
enroll 码短时有效且一次性、每台设备独立凭证、可单台吊销——但主机被攻破仍然等于全部从机沦陷。
这是设计上接受的代价（前提是所有机器都是你自己的）。
