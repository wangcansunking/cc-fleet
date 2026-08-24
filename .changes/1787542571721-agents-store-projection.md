---
bump: minor
---
Managed config now lives in a tool-agnostic store at `~/.agents` and is projected into each tool's own directory. `fleet/` is hub-managed under full takeover; `local/` belongs to the machine and cc-fleet never touches it, so a node can author its own skills without them being deleted on the next push. Rules are separate `rules/*.md` files, concatenated into a generated `~/.claude/CLAUDE.md`. Upgrading from the previous layout moves any hand-placed skill the hub does not claim into `local/` rather than deleting it. **Breaking:** `~/.claude/skills` and `~/.claude/CLAUDE.md` are now generated — edit `~/.agents/local/` instead.
