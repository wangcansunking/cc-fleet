---
bump: minor
---
Profiles can now carry MCP servers and per-device adjustments. MCP configs live in `~/.agents/{fleet,local}/mcp/*.json` and are projected by invoking `claude mcp add-json/remove --scope user` — cc-fleet never reads or writes `~/.claude.json`, so a bug in config handling can never cost you your login. A node without the `claude` CLI reports the skip instead of silently having no MCP. `devices.<id>.add/remove` layers on top of a group, and can name any item defined anywhere in the profile without duplicating it.
