# control plane M2 — `~/.agents` 存储分层与投影（第一刀）

> 状态：实现中。上位：[`docs/design.md`](../design.md) §3、§4。前置：M1、M1.5（均已合并）。

## 1. 为什么要多一层

M1/M1.5 直接管 `~/.claude/skills/`。三个问题：

1. **从机没有自留地。** 完全接管意味着从机上新建的任何东西下次 apply 就没了 ——
   design v2 需求 5（从机自建 → 上交 → 主机采纳）无处落脚。
2. **只服务 Claude Code。** 一份 skill 应该能同时喂给 Codex、pi。存在 `~/.claude/` 里等于承认只有一个工具。
3. **规则无法分发。** 单个 `CLAUDE.md` 只能整体接管，说不出「这条规则只发给这两台」。

## 2. 本刀范围

**做**：`~/.agents/{fleet,local}` 存储、投影引擎、`projected.json` 清单、`skills/` 与 `rules/`
投影到 Claude Code、一次性迁移、备份覆盖两侧。

**不做（下一刀）**：MCP（经 `claude mcp add-json/remove`）、`commands/`、Codex 与 pi 投影目标。
理由：MCP 要 shell 出去调 `claude` CLI，是独立且更重的一块，混进来会让本刀无法单独验证。

## 3. 存储

```
~/.agents/
  fleet/          ← 主机下发。完全接管：不在 profile 里的一律删
    skills/<id>/
    rules/<id>.md
  local/          ← 从机自留地。cc-fleet 永不删改
    skills/<id>/
    rules/<id>.md
  .cc-fleet/
    backups/<ts>/     apply 前全量快照（含 fleet/ 与投影目标），保留 10 份
    projected.json    上次投影产出的文件清单
```

备份从 `~/.claude/.cc-fleet/` 挪到 `~/.agents/.cc-fleet/` —— 备份属于存储层，不属于某个工具。

## 4. 投影

`fleet/` 与 `local/` 合并后写入工具原生位置。

| 来源 | Claude Code | 合并语义 |
|---|---|---|
| `skills/<id>/` | `~/.claude/skills/<id>/` | 同 id：**`local` 覆盖 `fleet`** |
| `rules/*.md` | `~/.claude/CLAUDE.md`（拼接） | **累加**：两边都生效 |

两种语义不同，是刻意的。同名 skill 是**同一个东西的两个版本**，只能有一个赢；
规则是**各自独立的约束**，都该生效。冲突（同 id 被覆盖）要如实上报，不靠合并规则把矛盾吞掉。

`rules/` 拼接：按文件名排序，先 `fleet` 后 `local`，每段前加来源标记，文件顶部写明是生成物。

**`~/.claude/skills/` 完全归 cc-fleet 所有** —— 不是本次投影产出的文件一律删除（先备份）。
与 M1 语义一致，代价是手动放进去的东西会消失，所以 CLI 必须反复讲清楚真正的编辑入口是 `~/.agents/local/`。

**投影用复制，不用软链**：Windows 建软链要管理员或开发者模式。

## 5. `projected.json`

```jsonc
{ "version": 1, "files": ["skills/code-review/SKILL.md", "CLAUDE.md"], "projectedAt": 1787300000000 }
```

清单存在的理由不是「决定删什么」（那由完全接管决定），而是三件别的事：

1. **跨工具目标**：以后投到 `~/.codex/AGENTS.md` 这种**单文件混在别人目录里**的位置时，
   只能靠清单知道哪个文件是我们写的。
2. **MCP**：下一刀要知道哪些 server 是 cc-fleet 加的，才能在移除时只删自己那些。
3. **诚实汇报**：`cc-fleet status` 能说出「上次投了什么、现在漂了没有」。

## 6. 一次性迁移

从 M1 升上来的机器，`~/.claude/skills/` 里混着**受管内容**和**用户自己放的东西**，而 `~/.agents/` 不存在。

首次 apply 时（此时才拿得到 desired state）：

- `~/.claude/skills/<id>`，若 `<id>` **不在**本次 desired state 里 → 移进 `~/.agents/local/skills/<id>`
- 若 `<id>` **在** desired state 里 → 不动，交给投影重写

**只搬不在 desired state 里的**，这一条是关键：全都搬进 `local/` 的话，那些受管 id 会变成
「本地覆盖」，反过来把主机下发的版本永久遮住 —— 一次好心的迁移会造成一个查不出来的漂移。

迁移只在 `~/.agents/` 不存在时执行一次，且执行前先备份。

## 7. 明确的代价

1. **`~/.agents` 是新的编辑入口。** 直接改 `~/.claude/skills/` 或 `~/.claude/CLAUDE.md`
   会被下次投影覆盖（后者整个是生成物）。这是分层的必然代价。
2. **多一次复制。** 每次 apply 都要把 fleet+local 重新投影一遍。文件量在这个数量级不成问题。
3. **本刀只覆盖 Claude Code。** profile 里的 MCP 在本刀里没有投影目标，dashboard 不能显示成已生效。

## 8. 测试

**单测**
- store：fleet 完全接管、local 永不被删、路径逃逸拒绝（沿用 M1 规则）
- 投影：skills 合并（local 覆盖同 id）、rules 拼接顺序与来源标记、目标完全接管、
  空 desired state 清空目标但保留目录、只碰投影目标不碰 `projects/`、`.claude.json`
- 清单：产出即记录、上次产出本次不再产出则被回收、清单损坏时退化为完全接管而非崩溃
- 迁移：不在 desired state 的 id 搬进 local、**在 desired state 的 id 不搬**、
  只执行一次、执行前有备份
- 冲突：同 id 同时存在于 fleet 与 local 时上报

**E2E（真实 HTTP）**
- hub 推一个 skill → 落在 `~/.agents/fleet/` **且**投影到 `~/.claude/skills/`
- 从机在 `~/.agents/local/skills/` 里新建一个 → 投影后两个都在 → **下次 apply 后本地那个仍在**
- 同 id 冲突：local 版本出现在 `~/.claude/skills/`，且冲突被上报
- rules：两边的规则都出现在生成的 `CLAUDE.md` 里，顺序正确
- 从 M1 布局升级：手放的 skill 被搬进 `local/` 而非消失

**changeset**：`minor`。
