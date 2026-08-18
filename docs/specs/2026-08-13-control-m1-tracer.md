# control plane M1 — tracer bullet

> 状态：**已实现**（见 `src/control/`、`tests/control/`、`e2e/control-m1.e2e.test.ts`）。
> 上位文档：[`docs/design.md`](../design.md)（§2 模块边界、§7 profile、§8 apply 语义、§11 分期）。
> 本文只定义 **M1 的第一条竖切**，不是完整 M1。

## 1. 这一刀要证明什么

一条端到端最短路径：**hub 上改一个 skill → node 上落盘生效**，跨真实网络跳。

证明三件事，一件都不能推迟：

1. §2 硬约束成立 —— `control/` 不 import `worker/`，整条链路脱离 Copilot 订阅/隧道也能跑完整 E2E。
2. §8 的「完全接管」语义（**删除未纳管文件**）是对的，且它的安全网（apply 前全量备份）同时可用。
3. 抽象 channel 的形状撑得住 —— 换传输只换实现。

**先跑通链路，再逐层加厚。** 其余 M1 内容（enroll 握手、设备注册表、commands/CLAUDE.md/settings、旧 token 导入）在后续 PR。

## 2. 范围

| | 本 PR 做 | 本 PR 不做 |
|---|---|---|
| 传输 | 抽象 channel + 裸 HTTP（SSE + POST）实现 | WebSocket、devtunnel、挂 supervisor |
| 鉴权 | 预共享长期 token，fail-closed | 一次性 enroll code、TTL、指纹 pin、单台吊销 |
| 受管范围 | `~/.claude/skills/` **完全接管** | `commands/`、`CLAUDE.md`、`settings.json`、hooks、MCP、plugins |
| 安全网 | apply 前全量备份 + 保留 10 份 + `restore` | 主机推 `version: N-1` 回滚 |
| profile | 手写 `~/.cc-fleet/profile.json` | dashboard 编辑、分组 UI、版本历史 |
| 设备身份 | `os.hostname()` | 签发 deviceId、设备列表、online/offline |
| 其他 | — | 端点/模型下发、推理走 hub、needsRestart 上报 |

## 3. 模块

```
src/control/
  proto/index.ts        协议消息 + profile schema（zod）+ PROTO_VERSION
  channel.ts            抽象双向通道（Channel / ChannelServer）
  hub/
    profile-store.ts    读 + 校验 + 监听 profile.json
    hub.ts              按设备解析 desired state、连接即推、变更即广播
    auth.ts             hub token 读写（fail-closed）
  agent/
    apply.ts            skills/ 完全接管
    backup.ts           快照 / 修剪 / 恢复
    agent.ts            连接、收 apply、落盘、回报
  transport/
    http-hub.ts         express router：GET /control/events (SSE) + POST /control/msg
    http-agent.ts       客户端：SSE 消费 + POST 回报 + 退避重连
```

**硬约束由测试守：** `tests/control/boundary.test.ts` 断言 `src/control/**` 内没有任何文件 import
`worker/`、`supervisor/`、`providers/`、`tui/`。允许 import `shared/paths`（拿 dataDir）。
这条约束是 §2 的全部价值所在，靠人自觉守不住。

## 4. Profile（§7 的子集）

`~/.cc-fleet/profile.json`，手写：

```jsonc
{
  "version": 1,
  "groups": {
    "full": {
      "skills": [
        { "id": "code-review", "files": [ { "path": "SKILL.md", "content": "..." } ] }
      ]
    }
  },
  "assignments": { "laptop-home": "full" }
}
```

- `version` 单调递增整数，由人手动改；node 用它判断是否需要重新 apply。
- **未分配的设备 = 没有 desired state，node 什么都不做**，回报 `unassigned`。
  绝不 fallback 到某个默认组 —— 一台没被登记的机器不该被完全接管。这是 fail-safe 方向。
- 校验失败（schema 不符 / JSON 坏）：hub **保留上一份可用 profile**，记录错误，绝不广播半个状态。

## 5. 协议

`PROTO_VERSION = 1`。JSON 消息，字段 `t` 判别。

**node → hub**

```jsonc
{ "t": "hello",   "proto": 1, "deviceId": "laptop-home", "os": "win32", "agentVersion": "0.1.0", "appliedVersion": 0 }
{ "t": "applied", "proto": 1, "version": 1, "ok": true, "written": 3, "deleted": 1, "warnings": [] }
```

**hub → node**

```jsonc
{ "t": "apply",      "proto": 1, "version": 1, "state": { "skills": [ ... ] } }
{ "t": "unassigned", "proto": 1 }
```

proto 不匹配 → 双方拒绝并报错，不做兼容猜测。

`unassigned` **不需要 node 回帧**：hub 是发出方，本来就知道。node 侧只把它记成本地状态
（`agent.status().state === "unassigned"`）供 CLI 显示。少一个帧，少一处能撒谎的地方。

## 6. 传输：SSE + POST

选它而不是 WebSocket：**零新依赖**，且与 supervisor 已有的 `/api/events` 写法一致。
真双工由抽象 channel 遮住，M2 想换 ws 只改 `transport/`。

```
GET  /control/events?deviceId=<id>   Authorization: Bearer <token>   → SSE，hub→node
POST /control/msg                    Authorization: Bearer <token>   → JSON，node→hub
```

- hub 每 15s 发 SSE 注释帧保活。
- node 断线后退避重连（1s → 5s 封顶），重连即收当前 desired state（**连接即推**，不等下次变更）。
  401 例外：token 不会自己变好，重试只会刷屏并埋掉真正的原因 —— 报一次然后停。
- hub 监听 `profile.json`（`fs.watch`，200ms 去抖）→ 重载 → 广播。这是「5 秒内生效」的实现方式。
  去抖之外还比对文件内容：`fs.watch` 对一次保存会重复触发（写-改名、部分平台同时发 rename 和 change），
  且爆发可能跨过去抖窗口 —— 不比对内容的话，一次 `touch` 就会向全队白广播一轮。

**鉴权 fail-closed**：未配置 token 时**拒绝所有请求**（沿用 `shared/network.ts` LAN 模式的姿态）。
`FLEET_TOKEN` 环境变量优先于磁盘。hub token 存 `~/.cc-fleet/fleet.json`（0600），
node 存 `~/.cc-fleet/fleet-node.json`（0600，含 `hubUrl` + `token`）。

## 7. apply 语义（skills/ 完全接管）

受管根：`<claudeHome>/skills/`，`claudeHome` **必须可注入** —— 测试绝不允许碰真实 `~/.claude`。

一个 skill `{ id, files }` → 目录 `skills/<id>/<file.path>`。

1. 算 desired 文件集合。
2. 扫描 `skills/` 现有文件，**不在 desired 里的一律删除**，随后清理空目录。
3. 内容相同的文件跳过写入（`written` 计数必须诚实，mtime 也不该无谓跳动）。
4. **只碰 `skills/`**，`commands/`、`CLAUDE.md`、`projects/`、`.claude.json` 一律不动。

**拒绝整个 apply（不做部分写入）的情况**，报错回传 hub：

- `path` 含 `..`、以 `/` 或盘符开头，或规范化后逃出 `skills/<id>/`；
- `id` 含路径分隔符或为空。

理由：这条通道本质是 RCE（§9），路径逃逸必须在 agent 侧硬拒，不能指望 hub 干净。

返回 `{ written[], deleted[], warnings[], changed: boolean }`。

## 8. 备份

`changed === false` 时**完全跳过备份** —— 否则每次重连都会堆一份相同快照，10 份配额瞬间被冲干净。

有变更时，mutation 之前：`<claudeHome>/.cc-fleet/backups/<ISO时间戳>/skills/` 全量复制（`fs.cp` recursive，无需 zip 依赖）。
保留最近 10 份，超出删最旧。

`cc-fleet restore` 恢复最近一份快照（完全替换 `skills/`）。
备份没有恢复路径就只是占硬盘，所以最小 restore 一并交付。

## 9. CLI

| 命令 | 作用 |
|---|---|
| `cc-fleet hub [--port 7892]` | 前台起独立控制面 hub（tracer 脚手架；M2 折进 supervisor）。首次运行生成并打印 token |
| `cc-fleet join <hubUrl> <token>` | 前台起 agent：持久化凭证、连接、apply、回报 |
| `cc-fleet restore` | 恢复最近一份 skills 备份 |

端口 7892（7890 supervisor / 7891 worker 之后）。`join` 命名对齐 design §5。
`join` **不触发 GitHub 登录**，也不起 worker —— 从机不该登 GitHub。

## 10. 测试

**单测**（`tests/control/`）
- boundary：`src/control/**` 无 `worker/`｜`supervisor/`｜`providers/`｜`tui/` import
- proto：schema 接受合法 profile；拒绝缺字段/错类型；proto 版本不匹配
- apply：写入；重复 apply 为 no-op；删除未纳管文件；嵌套路径；空目录清理；
  `..`／绝对路径／盘符／脏 id 拒绝整单；不碰 `commands/`、`CLAUDE.md`
- backup：变更时先备份；no-op 不备份；修剪到 10；restore 往返
- profile-store：加载、校验失败保留上一份、变更触发回调
- hub：按 assignment 解析；未分配 → `unassigned`；peer 接入即推当前状态
- channel：内存实现下 hub 广播到多 peer

**E2E**（`e2e/control-m1.e2e.test.ts`，hermetic，真 HTTP，随机端口，临时 dataDir + 临时 claudeHome）
1. hub + agent 起在 loopback → skill 落盘，内容一致
2. 改 profile（version+1）→ **5 秒内** node 上生效
3. node 上预置一个未纳管文件 → apply 后被删除，且出现在备份里
4. 错误 token → 401；无 token 配置 → 全拒（fail-closed）
5. 未分配主机名 → 什么都不动，且 `agent.status().state === "unassigned"`

**不加 docker case**：`control/` 这一刀还没挂进 daemon，现有 http-e2e harness 驱动的是 worker+supervisor。
上面的 E2E 已经跨真实 HTTP 两进程。M2 把 control 挂上 supervisor 时补 docker 覆盖。
合并前仍按 CLAUDE.md 跑一次真实 `cli-e2e` 确认没打坏既有面。

**changeset**：`minor`（新功能）。

## 11. 明确接受的代价

1. 预共享 token 泄露 = 任意机器可被接管。tracer 阶段可接受（局域网 + 自己的机器），
   enroll/吊销在下一个 PR 补上，且必须在 M2 上公网之前完成。
2. hub 是前台独立进程，关掉就没有推送。M2 折进 supervisor 后消失。
3. 只管 `skills/`，所以「完全接管」此刻只对 skills 成立；node 上其他 Claude 配置仍是本地状态。
