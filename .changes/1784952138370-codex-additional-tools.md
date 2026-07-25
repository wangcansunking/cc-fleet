---
bump: minor
---
fix(codex): make tools work again on Codex 0.145+ (gpt-5.6 family) — issue #4231.

Two problems, both fixed:

1. **Tools were dropped.** Newer Codex no longer puts tools at the top level of a `/responses` request — it carries them inside an `additional_tools` item in `input`. The Responses translator ignored that item, so the model reached Copilot with zero tools and could only narrate its tool calls as text ("I'm unable to access a shell tool"). We now merge `additional_tools` into the tool list.

2. **Custom tools were mistranslated.** Codex's primary tool `exec` is a `custom` tool (freeform-string input, not JSON). We were flattening it to a JSON-schema function, so the model emitted empty `{}` and Codex rejected the reply ("tool exec invoked with incompatible payload"). Copilot's `/responses` natively accepts `{type:"custom"}` tools and returns a `custom_tool_call` (verified live), so we now round-trip custom tools end-to-end: pass them through as `custom`, translate `custom_tool_call` / `custom_tool_call_output` history both ways (raw-string input), and stream them back as `custom_tool_call` + `custom_tool_call_input.delta/.done` events instead of function_call.

Verified against a live `codex exec -m gpt-5.6-luna`: a real shell tool loop now runs through the proxy (single-step and multi-step create→read-back), with the filesystem as oracle.
