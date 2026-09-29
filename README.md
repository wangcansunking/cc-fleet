# cc-fleet

**Run one Claude Code setup across every machine you own.**

One machine is the **hub**: it holds the profile (skills, MCP servers, `CLAUDE.md`, settings,
plugins) *and* the LLM backend. Every other machine is a **node**: it enrolls with a single
command and from then on mirrors the hub — no git clone, no GitHub login, no per-machine setup.

```bash
# node — asks to join, and shows a short code
npx cc-fleet join https://xxx.devtunnels.ms

# hub — a human approves that code, and only then is a credential issued
npx cc-fleet approve ABC-DEFG
```

Change a skill on the hub → every online node has it seconds later. Point a node at a different
model → done from the hub. Retire a machine → revoke it once, and it loses both the config feed
and the LLM backend.

> **Status: pre-M1.** The control plane is designed but not built yet. See
> [`docs/design.md`](docs/design.md) for the architecture, the protocol, and the costs it accepts.
> What works today is everything inherited from upstream (see below).

---

## Relationship to copilot-reverse

cc-fleet is a **superset successor** to
[copilot-reverse](https://github.com/wangcansunking/copilot-reverse), forked with full history.
It keeps the whole upstream product — the Copilot-backed OpenAI/Anthropic endpoints, the
self-healing daemon, the TUI, the web dashboard — and adds a control plane on top.

| | copilot-reverse | cc-fleet |
|---|---|---|
| LLM proxy over your Copilot subscription | ✅ | ✅ (inherited) |
| Self-healing daemon + dashboard + TUI | ✅ | ✅ (inherited) |
| One machine configures many | ❌ | ✅ (the point) |
| Nodes need GitHub login / a git clone | — | ❌ never |

Upstream stays a remote (`git remote -v` → `upstream`), so fixes can be pulled in with
`git merge upstream/master`. Internal identifiers are deliberately **not** mass-renamed — a
blanket rename would make every upstream merge a conflict storm. Naming converges gradually,
module by module, as each is touched.

**Data dir is `~/.cc-fleet`, deliberately separate from `~/.copilot-reverse`.** Both products may
be installed on the same machine, and sharing a directory would have them fight over the same
GitHub token, `network.json` and database. The one-time cost — re-logging in on a hub that already
ran copilot-reverse — is removed in M1 by a first-run import of the legacy token.

---

## What's inherited and works today

Everything from upstream applies: `/setup-claude`, `/setup-codex`, `/model`, `/network`,
`/status`, `/doctor`, `/logs`, `/metrics`, `/dashboard`. Run `npx cc-fleet` and type `/help`.

### Flexible Claude aliases

`/claude-map` lets a hub expose native `claude-*` names backed by any exact model ID in Copilot's
live discovery. Five recommended mappings remain built in, while user entries can add aliases,
override a default, or disable one row. The same global map drives Worker routing, setup/model
pickers, the TUI, and the local dashboard; every node using this hub inherits it automatically.

```text
/claude-map
/claude-map on
/claude-map set claude-fable-6-1 gemini-3-pro
/claude-map disable claude-haiku-4-5
/claude-map remove claude-fable-6-1
/claude-map reset
```

Configuration is stored atomically in `~/.cc-fleet/claude-map.json`. A backend that is not currently
live may still be saved: it is marked **unavailable**, omitted from Anthropic discovery, and never
routed until exact discovery reports it. Saving restarts the Worker; OpenAI/Codex discovery is never
modified. The loopback dashboard has the same editor under **Claude map**. See
[`docs/specs/2026-09-05-flexible-claude-map.md`](docs/specs/2026-09-05-flexible-claude-map.md) for the
validation, precedence, migration, and failure semantics.

The upstream changelog through v0.21.0 is kept at
[`docs/upstream-changelog.md`](docs/upstream-changelog.md); `CHANGELOG.md` restarts at cc-fleet's
own v0.1.0.

---

## Development

Requires Node >= 20.

```bash
npm install
npm test          # 743 tests
npm run build
npm run dev       # interactive TUI from src/, no build needed
npm run dev:hub   # full Hub from src/ (dashboard :7990, Worker :7991, gateway :7992)
```

## License

MIT
