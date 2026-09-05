---
bump: minor
---
Add the WAN fleet runtime and local management dashboard. The supervisor can now own a persistent
Microsoft Dev Tunnel, a single authenticated public gateway, the control hub and a background node
agent in the same application process. The tunnel exposes only `/control`, `/anthropic` and
`/openai`; dashboard/admin routes remain loopback-only. Remote LLM requests require a separately
rotatable fleet key, while control requests keep their per-device credentials.

The local dashboard now manages tunnel setup and device-code login, enrolment approval/denial,
devices and revocation, pending push review/adoption, and revisioned profile drafts with per-device
diffs, explicit publish, history and forward-only rollback. Profiles can assign Claude/Codex models
per device, and enrolled nodes non-destructively configure both clients after first taking exact
restorable backups.
