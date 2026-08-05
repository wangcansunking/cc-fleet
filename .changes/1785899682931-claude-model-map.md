---
bump: minor
---
feat(models): add an opt-in `/claude-map` compatibility mode for GPT-only Copilot accounts.

When enabled, Anthropic discovery exposes native Claude model identities backed by exact live GPT 5.x targets, and routes requests through the target model's real endpoint, reasoning support, and context window. Missing backends are hidden, original GPT entries remain available, OpenAI/Codex discovery is unchanged, and the feature defaults off.
