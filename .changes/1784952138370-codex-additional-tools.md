---
bump: minor
---
fix(codex): honor tools sent via `additional_tools` so Codex 0.145+ (gpt-5.6 family) can use tools again. Newer Codex no longer puts tools at the top level of a `/responses` request — it carries them inside an `additional_tools` item in `input`. The Responses translator dropped that item, so the model reached Copilot tool-less and could only narrate its tool calls as text ("I'm unable to access a shell tool"). We now merge `additional_tools` into the tool list, and also map `custom_tool_call` / `custom_tool_call_output` history so a multi-turn custom-tool (e.g. Codex's `exec`) session keeps its context. (issue #4231)
