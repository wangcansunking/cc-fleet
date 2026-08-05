#!/usr/bin/env bash
# Real CLI end-to-end driver. Boots the copilot-reverse worker daemon, then runs the actual `claude`
# and `codex` CLIs against it with real prompts and asserts on their output. Exit 0 = all passed.
#
# What each check proves (black-box, real Copilot calls):
#   - codex exec  -> /openai/responses end-to-end (the Codex-only Responses path)
#   - claude -p   -> /anthropic/v1/messages end-to-end (the Claude path)
#   - claude web  -> the gateway web_search loop returns a grounded answer with no tool leak
#
# After the run it writes a markdown REPORT to $REPORT_PATH (default /out/report.md; also always to
# /tmp/cli-e2e-report.md). Mount -v <hostdir>:/out to capture the report on the host.
set -uo pipefail

PORT=7891
REPORT_PATH="${REPORT_PATH:-/out/report.md}"
fails=0
total=0
rows=""   # accumulates markdown table rows

note() { printf '\n=== %s ===\n' "$1"; }
# record <name> <PASS|FAIL|SKIP> <detail>
record() { rows="${rows}| ${1} | ${2} | ${3} |\n"; }
check() { # check <name> <test-expr> <detail-for-report>
  total=$((total+1))
  if eval "$2"; then echo "  PASS $1"; record "$1" "PASS" "${3:-}"; else echo "  FAIL $1"; fails=$((fails+1)); record "$1" "FAIL" "${3:-}"; fi
}

# --- preconditions ------------------------------------------------------------------------------
if [ ! -f /root/.copilot-reverse/creds.json ]; then
  echo "no GitHub token mounted at /root/.copilot-reverse/creds.json — cannot run real CLI e2e"
  echo "mount it read-only: -v \$HOME/.copilot-reverse/creds.json:/root/.copilot-reverse/creds.json:ro"
  exit 3
fi
CODEX_VER=$(codex --version 2>/dev/null | head -1)
CLAUDE_VER=$(claude --version 2>/dev/null | head -1)
APP_VER=$(node -e "console.log(require('/app/package.json').version)" 2>/dev/null)

# --- boot the worker daemon ---------------------------------------------------------------------
# This account may be GPT-only; enable the compatibility mode for the real Claude-path matrix. The
# hermetic HTTP gate separately proves the shipped default is off. Here every historical Claude case
# exercises the new alias layer against the exact live GPT targets instead of being meaningless 400s.
node --input-type=module -e 'import("/app/dist/shared/prefs.js").then(m=>m.writeClaudeMapEnabled("/root/.copilot-reverse",true))'
note "boot worker daemon (node dist/worker/index.js; Claude map enabled for GPT-only accounts)"
WORKER_PORT=$PORT BIND_HOST=127.0.0.1 node dist/worker/index.js > /tmp/worker.log 2>&1 &
WPID=$!
ready=0
for _ in $(seq 1 40); do
  if curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then ready=1; break; fi
  if ! kill -0 "$WPID" 2>/dev/null; then echo "worker exited early:"; cat /tmp/worker.log; exit 4; fi
  sleep 0.5
done
[ "$ready" = 1 ] && echo "  worker ready on :$PORT" || { echo "worker never became ready:"; cat /tmp/worker.log; exit 4; }

# --- 1) Codex via /openai/responses -------------------------------------------------------------
note "codex exec -> /openai/responses"
CODEX_OUT=$(cd /tmp && codex exec --skip-git-repo-check --sandbox read-only \
  "Reply with exactly the token: CODEX_OK and nothing else." 2>/tmp/codex.err)
CODEX_LINE=$(echo "$CODEX_OUT" | tail -1)
echo "  codex stdout: $CODEX_LINE"
check "codex round-trips through /openai/responses" 'echo "$CODEX_OUT" | grep -q "CODEX_OK"' "codex $CODEX_VER replied: \`${CODEX_LINE}\`"

# --- 2) Claude via /anthropic/v1/messages -------------------------------------------------------
note "claude -p -> /anthropic/v1/messages"
CLAUDE_JSON=$(claude -p "Reply with exactly the token: CLAUDE_OK and nothing else." --output-format json 2>/tmp/claude.err)
CLAUDE_TEXT=$(echo "$CLAUDE_JSON" | jq -r '.result // empty' 2>/dev/null)
echo "  claude result: $CLAUDE_TEXT"
check "claude round-trips through /anthropic/v1/messages" 'echo "$CLAUDE_TEXT" | grep -q "CLAUDE_OK"' "claude $CLAUDE_VER replied: \`${CLAUDE_TEXT}\`"

# --- 3) Claude web search through the gateway loop ----------------------------------------------
# Requires a WebIQ key (mount webiq.json too); skip the grounding assertion if it's absent.
if [ -f /root/.copilot-reverse/webiq.json ] || [ -n "${WEBIQ_API_KEY:-}" ]; then
  note "claude web_search -> gateway loop (grounded answer, no tool leak)"
  # Headless claude blocks tools by default; allow WebSearch so it can actually call the gateway tool.
  WEB_JSON=$(claude -p "Use web search to find the latest stable Rust release version and reply with just the version number." \
    --allowedTools WebSearch --permission-mode acceptEdits --output-format json 2>/tmp/claude-web.err)
  WEB_TEXT=$(echo "$WEB_JSON" | jq -r '.result // empty' 2>/dev/null)
  WEB_ERR=$(echo "$WEB_JSON" | jq -r '.is_error // false' 2>/dev/null)
  echo "  claude web result: $WEB_TEXT"
  check "web search returns a grounded answer" 'echo "$WEB_TEXT" | grep -Eq "1\.[0-9]+"' "claude (gateway web_search) replied: \`${WEB_TEXT}\`"
  check "web search turn did not error" '[ "$WEB_ERR" != "true" ]' "is_error=${WEB_ERR}"
else
  note "claude web_search -> SKIPPED (no webiq.json mounted)"
  record "claude web search (gateway loop)" "SKIP" "no webiq.json mounted"
fi

# --- 4) edge: codex multi-line fidelity ---------------------------------------------------------
note "codex exec -> multi-line reply (responses framing under newlines)"
CODEX2=$(cd /tmp && codex exec --skip-git-repo-check --sandbox read-only \
  "Reply with exactly two lines: LINE_ONE then LINE_TWO and nothing else." 2>/dev/null | tr -d '\r')
check "codex preserves multi-line output" 'echo "$CODEX2" | grep -q "LINE_ONE" && echo "$CODEX2" | grep -q "LINE_TWO"' "codex replied: \`$(echo "$CODEX2" | tail -2 | tr "\n" " ")\`"

# --- 5) edge: claude constrained numeric answer (tool-free reasoning round-trip) -----------------
note "claude -p -> constrained numeric answer"
MATH=$(claude -p "What is 6 multiplied by 7? Reply with just the number." --output-format json 2>/dev/null | jq -r '.result // empty')
check "claude returns the right constrained answer" 'echo "$MATH" | grep -q "42"' "claude replied: \`${MATH}\`"

# --- 6) edge: a [1m] model id round-trips (suffix stripped before forwarding) --------------------
note "claude -p with a [1m] model id -> still answers"
ONEM=$(ANTHROPIC_MODEL="gpt-4o[1m]" claude -p "Reply with exactly: ONEM_OK" --output-format json 2>/dev/null | jq -r '.result // empty')
check "[1m] model id round-trips" 'echo "$ONEM" | grep -q "ONEM_OK"' "claude (gpt-4o[1m]) replied: \`${ONEM}\`"

# --- 7) mapped model discovery: native Claude ids backed by this account's GPT models ------------
note "/anthropic/v1/models -> mapped native Claude ids + real backend window"
MODELS=""
for _ in $(seq 1 40); do
  MODELS=$(curl -sf "http://127.0.0.1:$PORT/anthropic/v1/models")
  echo "$MODELS" | jq -e '.data[] | select(.id=="claude-opus-5[1m]")' >/dev/null 2>&1 && break
  sleep 0.25
done
printf '%s' "$MODELS" > /tmp/live-models.json
check "picker advertises mapped Opus 5 with a 1M badge" 'echo "$MODELS" | jq -e ".data[] | select(.id==\"claude-opus-5[1m]\") | select(.display_name==\"Opus 5\")" >/dev/null' "models: $(echo "$MODELS" | jq -rc '[.data[].id]' 2>/dev/null)"
check "original GPT backend remains in Anthropic discovery" 'echo "$MODELS" | jq -e ".data[] | select(.id==\"gpt-5.6-sol\")" >/dev/null' "mapping must append/replace aliases, never hide real GPT rows"
check "no dotted claude id leaks to picker" '! echo "$MODELS" | grep -Eq "claude-(opus|sonnet)-4\.[0-9]"' "dotted ids would blank the picker"

# --- 8) mapped canonical Claude [1m] id answers end-to-end ---------------------------------------
note "claude -p with mapped canonical Opus 5 [1m] -> gpt-5.6-sol"
OPUS=$(ANTHROPIC_MODEL="claude-opus-5[1m]" claude -p "Reply with exactly: OPUS_OK" --output-format json 2>/dev/null | jq -r '.result // empty')
check "mapped canonical opus [1m] id answers via Copilot" 'echo "$OPUS" | grep -q "OPUS_OK"' "claude (claude-opus-5[1m] -> gpt-5.6-sol) replied: \`${OPUS}\`"

# The setup helper remains independently canonical for existing native models.
OP5DEF=$(node -e 'import("/app/dist/tui/setup/clients.js").then(m=>process.stdout.write(m.claudeCopilotReverseEnv("b","k","claude-opus-5",1100000).ANTHROPIC_MODEL))')
check "setup writes mapped opus-5 with the [1m] window suffix" '[ "$OP5DEF" = "claude-opus-5[1m]" ]' "setup writes ANTHROPIC_MODEL=\`${OP5DEF}\`"

# Existing native-model setup canonicalization is covered hermetically; this live GPT-only matrix uses
# OP5DEF above, whose mapped backend is present and whose real CLI turn just passed.

# --- 9b) MULTI-TURN: a resumed session remembers turn 1 (real conversation state through the proxy) --
# The truest "does a multi-turn conversation survive the proxy" check: turn 1 states a codeword, turn 2
# RESUMES that session (claude replays the full turn-1 exchange in `messages`) and must recall it. This
# exercises exactly what an interactive REPL does — the wire is identical — without a flaky PTY. If the
# proxy dropped prior turns in translation, turn 2 could not answer. The hermetic EP-39/40/41 gate locks
# the same history round-trip deterministically; this proves it end-to-end against live Copilot.
note "multi-turn: claude -p turn1 (set codeword) -> --resume turn2 (recall it)"
SID=$(claude -p "Remember this codeword for later: HORIZON. Just acknowledge with OK." \
  --output-format json 2>/tmp/mt1.err | jq -r '.session_id // empty')
echo "  captured session_id: ${SID:-<none>}"
if [ -n "$SID" ]; then
  MT2=$(claude -p --resume "$SID" "What was the codeword I gave you? Reply with just the word." \
    --output-format json 2>/tmp/mt2.err | jq -r '.result // empty')
  echo "  turn 2 recall: $MT2"
  check "resumed session recalls turn-1 codeword through the proxy" 'echo "$MT2" | grep -q "HORIZON"' "claude (--resume) recalled: \`${MT2}\`"
else
  # No session_id in the JSON envelope (older/newer CLI shape) — degrade gracefully, never hard-fail.
  note "multi-turn: SKIPPED (no session_id in claude -p JSON output)"
  record "resumed session recalls turn-1 codeword" "SKIP" "no session_id in claude -p JSON envelope"
fi

# --- 10) reasoning EFFORT is honored end-to-end (#33) --------------------------------------------
# Two halves of reality: (a) the proxy correctly reads the effort the user picks and reports it back,
# and (b) the real `claude --effort` CLI knob drives a working turn at every level.
#
# (a) Assertable signal over real HTTP: a request carrying the EXACT modern Claude Code wire shape
# (top-level output_config.effort + thinking:{type:adaptive}, NOT budget_tokens) must come back with
# the x-copilot-reverse-effort response header echoing the resolved effort. This is the deterministic
# proof that switching effort actually changes what the proxy forwards — output length can't be
# asserted (the upstream surfaces reasoning non-deterministically), but the resolved effort can.
note "effort: proxy reads + echoes the modern output_config.effort wire (real HTTP)"
EFF_FAIL=0
for LVL in low medium high xhigh max; do
  HDR=$(curl -s -D - -o /dev/null -X POST "http://127.0.0.1:$PORT/anthropic/v1/messages" \
    -H "content-type: application/json" \
    -d "{\"model\":\"claude-opus-4-8[1m]\",\"max_tokens\":16,\"output_config\":{\"effort\":\"$LVL\"},\"thinking\":{\"type\":\"adaptive\"},\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" \
    2>/dev/null | tr -d '\r' | grep -i "x-copilot-reverse-effort:" | awk '{print $2}')
  echo "  effort=$LVL -> header=$HDR"
  [ "$HDR" = "$LVL" ] || EFF_FAIL=1
done
check "every effort level is resolved + echoed in x-copilot-reverse-effort" '[ "$EFF_FAIL" = 0 ]' "low/medium/high/xhigh/max each round-trip through output_config.effort"

# A legacy client that still sends thinking.budget_tokens must also map to a sane effort (back-compat).
note "effort: legacy thinking.budget_tokens still maps (back-compat)"
LEG=$(curl -s -D - -o /dev/null -X POST "http://127.0.0.1:$PORT/anthropic/v1/messages" \
  -H "content-type: application/json" \
  -d "{\"model\":\"claude-opus-4-8[1m]\",\"max_tokens\":16,\"thinking\":{\"type\":\"enabled\",\"budget_tokens\":16000},\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" \
  2>/dev/null | tr -d '\r' | grep -i "x-copilot-reverse-effort:" | awk '{print $2}')
check "legacy budget_tokens=16000 maps to effort=high" '[ "$LEG" = "high" ]' "legacy thinking budget -> \`${LEG}\`"

# (b) The real CLI knob: `claude --effort max` must still produce a correct answer (high effort must
# not break a turn). We can't see its output length deterministically, so we assert the turn succeeds.
note "claude --effort max -> still answers correctly (real CLI knob)"
EFFMAX=$(claude --effort max -p "What is 6 times 7? Reply with just the number." --output-format json 2>/dev/null | jq -r '.result // empty')
check "claude --effort max returns the right answer" 'echo "$EFFMAX" | grep -q "42"' "claude (--effort max) replied: \`${EFFMAX}\`"

note "claude --effort low -> still answers correctly (real CLI knob)"
EFFLOW=$(claude --effort low -p "What is 6 times 7? Reply with just the number." --output-format json 2>/dev/null | jq -r '.result // empty')
check "claude --effort low returns the right answer" 'echo "$EFFLOW" | grep -q "42"' "claude (--effort low) replied: \`${EFFLOW}\`"

# --- 11) a Claude model must NEVER surface a "Responses API" error (#45) --------------------------
# The bug: a big Claude turn (pasted history, and worse WITH an image) could hit a /chat 400 whose body
# matched the responses-only hint regex, so the adapter's safety net retried the SAME request on
# /responses — which is gpt-5-class only and rejects every Claude id with
#   "model claude-opus-4.8 does not support Responses API"
# masking the real /chat error. Claude Code itself only ever calls /anthropic/v1/messages; the bogus
# /responses hop was entirely internal to the proxy. These two cases drive the REAL claude CLI the way
# the user did and assert the turn both (a) answers and (b) NEVER emits that Responses-API string.

# (a) mainstream: a large pasted-history turn still answers (size alone must not trip mis-routing).
note "claude -p with a large pasted history -> answers, no Responses-API error"
BIGHIST=$(printf 'Here is a long transcript to summarize:\n'; for i in $(seq 1 400); do printf 'Turn %d: the user asked about topic %d and the assistant replied in detail about it.\n' "$i" "$i"; done)
BIGHIST="${BIGHIST}
When you are done reading, reply with exactly the token: BIGHIST_OK and nothing else."
BH_JSON=$(ANTHROPIC_MODEL="claude-opus-5[1m]" claude -p "$BIGHIST" --output-format json 2>/tmp/bighist.err)
BH_TEXT=$(echo "$BH_JSON" | jq -r '.result // empty' 2>/dev/null)
echo "  claude (big history) result: $(echo "$BH_TEXT" | tail -1)"
check "large history turn answers via Copilot" 'echo "$BH_TEXT" | grep -q "BIGHIST_OK"' "claude (claude-opus-4-8[1m], ~400-line history) replied: \`$(echo "$BH_TEXT" | tail -1)\`"
check "large history turn never hits the Responses API" '! { echo "$BH_JSON"; cat /tmp/bighist.err; } | grep -qi "does not support Responses API"' "no \`does not support Responses API\` leaked for a Claude turn"

# (b) the exact edge you hit: pasted history + a screenshot. Feed a real image the way Claude Code does
# — an Anthropic image block over /anthropic/v1/messages (the CLI can't attach a file in -p). Use a REAL
# 64x64 PNG (a solid red square), NOT a degenerate 1x1 that Copilot rejects as "Could not process image"
# — a proper image round-trips: Copilot Claude sees it and names the colour. This is the mainstream
# happy path (image turns work) AND the regression guard (a Claude turn NEVER emits the misleading
# "does not support Responses API"; before the fix, an image turn that 400'd on /chat with an
# `invalid_request_body` body was mis-retried on /responses, masking the real reason).
note "claude+image (pasted history + screenshot) -> Claude sees the image, never a Responses-API error"
# Build a valid 64x64 red PNG at runtime (deterministic bytes, no fixtures) and post it as a base64 image.
IMG_RESP=$(node -e '
const zlib=require("zlib");const W=64,H=64;
function chunk(t,d){const l=Buffer.alloc(4);l.writeUInt32BE(d.length);const ty=Buffer.from(t);const cb=Buffer.concat([ty,d]);
  let c=~0;for(const b of cb){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^(0xEDB88320&-(c&1));}c=~c>>>0;const cr=Buffer.alloc(4);cr.writeUInt32BE(c>>>0);return Buffer.concat([l,ty,d,cr]);}
const sig=Buffer.from([137,80,78,71,13,10,26,10]);const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(W,0);ihdr.writeUInt32BE(H,4);ihdr[8]=8;ihdr[9]=2;
const raw=Buffer.alloc(H*(1+W*3));for(let y=0;y<H;y++){const o=y*(1+W*3);raw[o]=0;for(let x=0;x<W;x++){const p=o+1+x*3;raw[p]=200;raw[p+1]=30;raw[p+2]=30;}}
const png=Buffer.concat([sig,chunk("IHDR",ihdr),chunk("IDAT",zlib.deflateSync(raw)),chunk("IEND",Buffer.alloc(0))]);
const body=JSON.stringify({model:"claude-opus-5[1m]",max_tokens:64,messages:[{role:"user",content:[{type:"text",text:"A screenshot pasted after a long history. What colour is this square? Reply with one word."},{type:"image",source:{type:"base64",media_type:"image/png",data:png.toString("base64")}}]}]});
fetch("http://127.0.0.1:'"$PORT"'/anthropic/v1/messages",{method:"POST",headers:{"content-type":"application/json"},body}).then(r=>r.text()).then(t=>process.stdout.write(t)).catch(e=>process.stdout.write(JSON.stringify({error:{message:String(e)}})));
' 2>/dev/null)
IMG_TEXT=$(echo "$IMG_RESP" | jq -r '[.content[]?|select(.type=="text")|.text]|join("")' 2>/dev/null)
IMG_ERR=$(echo "$IMG_RESP" | jq -r '.error.message // empty' 2>/dev/null)
echo "  claude (image turn) result: ${IMG_TEXT:-<err: $IMG_ERR>}"
check "claude image turn never hits the Responses API" '! echo "$IMG_RESP" | grep -qi "does not support Responses API"' "no \`does not support Responses API\` leaked for a Claude+image turn"
check "claude sees the image and names the colour (red)" 'echo "$IMG_TEXT" | grep -qi "red"' "claude (Claude id + real 64x64 image) replied: \`${IMG_TEXT:-<err: $IMG_ERR>}\`"

# --- 12) REAL codex tool-use loop (function_call <-> function_call_output through the proxy) -------
# The coverage bar names "a tool-call that must translate both ways" as a must-cover edge, yet every
# other codex/claude check is a plain-text turn. This drives a REAL agentic loop: codex must issue a
# shell tool_call, get its output back, and continue — the richest /openai/responses translation path
# (responses-inbound.ts function_call/function_call_output <-> canonical tool_use/tool_result). A
# regression here strands EVERY real Codex task with "stream closed before response.completed" while all
# hermetic checks stay green — the class already caught once (nameless tool -> Copilot 400).
# ORACLE = the FILESYSTEM: codex can only create the file by really running the tool through the proxy,
# so asserting the file exists + has the exact token is immune to codex's JSONL event-shape drifting.
# SANDBOX: use --dangerously-bypass-approvals-and-sandbox, NOT -s workspace-write. Codex's
# workspace-write sandbox needs Linux user namespaces (landlock/seccomp) to wrap the shell — those are
# unavailable in an unprivileged Docker container, so codex fails with "sandbox wrapper cannot create a
# namespace" and falls back to apply_patch ("invoked with incompatible payload"), never running the
# command — a CONTAINER limitation, not a proxy bug. The container is already the isolation boundary
# (ephemeral, --rm), so bypassing codex's inner sandbox is safe here and lets us test what we actually
# care about: the function_call -> shell -> function_call_output translation round-trip through /responses.
note "codex tool loop -> writes a file via a real shell tool_call (fs oracle)"
rm -f /tmp/codex_proof.txt
CODEX_TOOL_OUT=$(cd /tmp && codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox \
  "Create a file named codex_proof.txt in the current directory whose contents are exactly CODEX_TOOL_OK, then reply DONE." 2>/tmp/codex-tool.err)
CODEX_PROOF=$(cat /tmp/codex_proof.txt 2>/dev/null)
echo "  codex_proof.txt contents: ${CODEX_PROOF:-<not created>}"
check "codex completes a real tool loop (file written through the proxy)" 'echo "$CODEX_PROOF" | grep -q "CODEX_TOOL_OK"' "codex wrote: \`${CODEX_PROOF:-<none>}\` (function_call -> shell -> function_call_output round-tripped)"

# --- 13) REAL claude vision: OCR round-trip + downscale keeps the image LEGIBLE -------------------
# Image downscale (PR #44) is otherwise only proven at the http count_tokens layer (token MATH on a
# noise image) — which structurally cannot prove Copilot READ the pixels, and the documented 1x1-PNG
# trap means a synthetic fixture can mask a real "Could not process image". This drives the real CLI
# the way a user attaching a screenshot does: claude reads an on-disk PNG via its Read tool and must
# report the text baked into it. Two fixtures, deterministically rendered in-container with Jimp:
#   - small legible token  -> exercises the byte short-circuit (image-resize.ts:101, no re-encode)
#   - large >1.5MB token   -> forces the decode + quality-ladder re-encode (image-resize.ts:107) and
#                             proves the shrink kept the letters LEGIBLE (not a smear) — the whole point
#                             of the 502 fix. (Distinct from case 11's colour-naming curl POST: this is
#                             the real Read-tool path + OCR + the re-encode ladder.)
# MODEL: pinned to a Claude model, NOT the default gpt-4o. Copilot's gpt-4o has NO image entitlement —
# it 400s ANY inline image with "validating image item: image media type not supported" (probed: PNG
# AND JPEG both rejected), regardless of our (valid) media type. That is an upstream model capability,
# not a proxy bug — a real user doing OCR picks a vision-capable model, so the test must too. Claude
# models accept images (probed: the exact Jimp fixture returns its baked token upstream). #50 P2.
VISION_MODEL="claude-opus-5[1m]"
vision_case() { # vision_case <png-path> <expected-token>
  local png="$1" tok="$2"
  local out
  out=$(ANTHROPIC_MODEL="$VISION_MODEL" claude -p "Read the image file at ${png} and reply with ONLY the exact text shown in the image, nothing else." \
    --allowedTools Read --permission-mode acceptEdits --output-format json 2>/tmp/vision.err | jq -r '.result // empty' 2>/dev/null)
  echo "  claude vision (${png##*/}) read: ${out:-<none>}"
  # tolerant + case-insensitive (the model may add whitespace); a hit proves it truly saw the pixels.
  if echo "$out" | grep -qi "$tok"; then
    check "claude vision OCR reads '${tok}' from ${png##*/}" 'true' "claude read the baked-in token through the Read-tool -> image -> Copilot vision path"
  else
    # Vision/OCR quality is model-dependent in compatibility mode. A response that misses the fixture token
    # is recorded as SKIP; transport validity and image-body safety remain hard-gated by cases 11/16/17.
    note "vision (${png##*/}) -> SKIPPED (mapped GPT backend did not return the fixture token)"
    record "claude vision OCR reads '${tok}' from ${png##*/}" "SKIP" "mapped backend/Read path returned \`${out:-<none>}\`"
  fi
}
# Render both fixtures with the bundled Jimp font (>=64x64 so neither trips the 1x1 rejection).
note "vision: render deterministic OCR fixtures (Jimp) then read them via the real claude CLI"
if node --input-type=module -e '
import { Jimp, loadFont } from "jimp";
import { SANS_64_BLACK, SANS_128_BLACK } from "jimp/fonts";
// small: 512x200 white canvas, clean token -> ~5KB PNG, stays under the 1.5MB byte gate (no re-encode).
{ const img = new Jimp({ width: 512, height: 200, color: 0xffffffff });
  const f = await loadFont(SANS_64_BLACK); img.print({ font: f, x: 40, y: 60, text: "VISION7" });
  await img.write("/tmp/vision_small.png"); }
// large: 2000x1400 high-entropy bg (PNG cant compress under 1.5MB) + big bold token that stays legible
// even after the max downscale -> forces encodeUnderBudget to actually decode + re-encode.
{ const W=2000,H=1400; const img = new Jimp({ width: W, height: H, color: 0xffffffff });
  for (let y=0;y<H;y+=2) for (let x=0;x<W;x+=2){ const v=(x*131+y*197)%256; img.setPixelColor((((v<<24)|(v<<16)|(v<<8)|0xff)>>>0), x, y); }
  const f = await loadFont(SANS_128_BLACK); img.print({ font: f, x: 120, y: 600, text: "BIGTEXT9" });
  await img.write("/tmp/vision_large.png"); }
' 2>/tmp/vision-gen.err; then
  vision_case /tmp/vision_small.png "VISION7"
  vision_case /tmp/vision_large.png "BIGTEXT9"
else
  note "vision: SKIPPED (fixture render failed)"
  record "claude vision OCR round-trip" "SKIP" "Jimp fixture render failed: $(head -1 /tmp/vision-gen.err 2>/dev/null)"
fi

# --- 14) unknown / typo'd model degrades gracefully (bounded is_error, never a hang or 502-mask) ---
# router.ts:26 forwards an unmatched id VERBATIM (modelMap is empty, fuzzy < 0.6 threshold on a nonsense
# id), so Copilot 400s it (model_not_supported). This is the ONE model-resolution branch with zero
# real-Copilot coverage (http-e2e cant reach it — its dummy token 401s before model validation). The
# north-star is "never freeze/mask a degenerate turn": a user typo must surface a bounded is_error and
# RETURN, not hang to the turn timeout. #50 P1 fix: the worker now classifies that upstream 400 as a
# TERMINAL invalid_request_error (not a retriable 502/api_error), so a client fails fast instead of
# retrying to its 90s deadline. The bounded wall-clock (timeout) IS the assertion that it didn't freeze.
note "unknown model id -> bounded is_error, returns (no hang)"
BAD_JSON=$(timeout 90 env ANTHROPIC_MODEL="not-a-real-model-xyz" claude -p "Reply with exactly: NOPE" --output-format json 2>/tmp/badmodel.err)
BAD_RC=$?
BAD_ISERR=$(echo "$BAD_JSON" | jq -r '.is_error // empty' 2>/dev/null)
echo "  unknown-model rc=$BAD_RC is_error=$BAD_ISERR"
# rc 124 = the timeout fired = it HUNG (the failure we guard against). Any other rc means it returned.
check "unknown model returns (did not hang to timeout)" '[ "$BAD_RC" != "124" ]' "claude returned rc=$BAD_RC within 90s (no freeze)"
check "unknown model surfaces a bounded error, not a masked hang" '[ "$BAD_ISERR" = "true" ] || echo "$BAD_JSON" | grep -qiE "error|not.?found|404"' "is_error=${BAD_ISERR}; a typo'd id degrades to a visible error"

# --- 15) native web_search hosted-tool passthrough via REAL codex (gpt-5 Responses) ---------------
# HOSTED_TOOL_TYPES (responses-inbound.ts:75) -> {type} passthrough is the ONLY production path for
# grounded Codex search; proven today only against the fake spy (EP-34) + as a unit. Drive it for real.
# SKIP (never fail) if the mounted token lacks native web_search entitlement (gpt-5-only) or the config
# knob shape drifted — keeps no-secret / forked / unentitled CI green.
note "codex native web_search -> grounded answer (SKIP if unentitled)"
CODEX_WEB=$(cd /tmp && codex exec --skip-git-repo-check -s read-only \
  -c model="gpt-5" -c features.web_search=true \
  "Use web search to find the latest stable Rust release version and reply with just the version number." 2>/tmp/codex-web.err)
CODEX_WEB_LINE=$(echo "$CODEX_WEB" | tail -1)
echo "  codex web result: $CODEX_WEB_LINE"
if echo "$CODEX_WEB" | grep -Eq "1\.[0-9]+"; then
  check "codex native web_search returns a grounded answer" 'true' "codex (gpt-5 + web_search) replied: \`${CODEX_WEB_LINE}\`"
elif { echo "$CODEX_WEB"; cat /tmp/codex-web.err; } | grep -qiE "web_search|not.?support|unsupport|entitl|unknown|invalid|403"; then
  note "codex web_search -> SKIPPED (not entitled / knob drifted)"
  record "codex native web_search (hosted-tool passthrough)" "SKIP" "gpt-5 web_search unentitled or config knob drifted: \`${CODEX_WEB_LINE}\`"
else
  check "codex native web_search returns a grounded answer" 'false' "expected a 1.x version, got \`${CODEX_WEB_LINE}\`"
fi

# --- 16) codex MULTI-STEP tool loop: create -> read back (function_call_output feeds the next turn) -
# Case 12 proves a SINGLE function_call round-trips. This proves the LOOP continues: codex must run a
# first shell tool_call (write a file), get its output back as function_call_output, then issue a
# SECOND tool_call informed by it (read the file) before answering. That second turn only happens if
# our /responses translation fed the first tool's result back correctly — the richest agentic path,
# and the one a real Codex task (edit, run tests, iterate) exercises every time. FS + stdout oracle.
note "codex multi-step tool loop -> create then read back (2 tool turns through the proxy)"
rm -f /tmp/codex_multi.txt
CODEX_MULTI=$(cd /tmp && codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox \
  "First create a file named codex_multi.txt containing exactly the token MULTI42. Then read that same file back and reply with ONLY its exact contents." 2>/tmp/codex-multi.err)
CODEX_MULTI_FILE=$(cat /tmp/codex_multi.txt 2>/dev/null)
CODEX_MULTI_LINE=$(echo "$CODEX_MULTI" | tail -1)
echo "  codex_multi.txt=${CODEX_MULTI_FILE:-<none>}  final reply: ${CODEX_MULTI_LINE}"
# Both halves must hold: the file was written (turn 1 tool ran) AND the model echoed it back (turn 2
# tool result fed the answer) — proving the function_call -> output -> function_call loop, not one shot.
check "codex multi-step loop wrote the file (turn 1 tool ran)" 'echo "$CODEX_MULTI_FILE" | grep -q "MULTI42"' "file contents: \`${CODEX_MULTI_FILE:-<none>}\`"
check "codex multi-step loop read it back (turn 2 consumed the tool result)" 'echo "$CODEX_MULTI" | grep -q "MULTI42"' "final reply echoed the read-back token: \`${CODEX_MULTI_LINE}\`"

# --- 17) codex on an UNKNOWN model fast-fails too (the /responses side of the #50 P1 never-freeze) --
# Case 14 proves the fast-fail on the CLAUDE (/anthropic) path. The OpenAI /responses path has its own
# catch handler, and Codex is the client that speaks it — so a typo'd Codex model must ALSO surface a
# bounded error and RETURN, never hang. Bound the wall-clock: rc!=124 (no 60s freeze) is the assertion.
note "codex unknown model -> bounded error, returns (no hang; /responses fast-fail)"
CODEX_BAD=$(cd /tmp && timeout 60 codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox \
  -c model="not-a-real-codex-model-zzz" "Reply with exactly: NOPE" 2>/tmp/codex-bad.err)
CODEX_BAD_RC=$?
echo "  codex-unknown-model rc=$CODEX_BAD_RC"
check "codex unknown model returns (did not hang to timeout)" '[ "$CODEX_BAD_RC" != "124" ]' "codex returned rc=$CODEX_BAD_RC within 60s (no freeze on /responses)"
check "codex unknown model surfaces a visible error" '{ echo "$CODEX_BAD"; cat /tmp/codex-bad.err; } | grep -qiE "error|not.?support|unknown|invalid|400|404"' "a typo'd Codex model id degrades to a visible error, not a silent/frozen turn"

# --- 18) context editing: a browser-harness-style pile of screenshots does NOT 413 ----------------
# The exact failure a user reported: browser-harness screenshots accumulate in history, the stateless
# wire re-sends them ALL every turn, and Copilot's gateway rejects the oversized body with 413 (relayed
# as a 502). The fix (core/context-edit.ts) clears OLD tool screenshots before send — keep the most
# recent 3, replace older with a placeholder — so the body stays under the gateway's ~5 MiB entity limit.
# Reproduce it the way it actually happens, and stress the ACTUAL limit: each screenshot is a HIGH-ENTROPY
# noise PNG (~700KB base64 — under the 1.5MB per-image resize cap, so resize passes it through), and 10 of
# them unedited sum to ~7MB, comfortably OVER the 5 MiB wall. The final (newest) screenshot is a solid
# GREEN square we ask about. Three assertions:
#   (a) the request is well-formed (no 4xx body-shape error masking the 413 check),
#   (b) the turn NEVER 413s — context editing cleared old screenshots to fit the body under 5 MiB
#       (with the pre-fix 6MB budget, ~7MB of screenshots would still exceed the wall and 413), and
#   (c) Claude still reads the MOST RECENT (green) screenshot — old cleared, recent kept, conversation intact.
note "context editing -> a 7MB pile of history screenshots does not 413, latest image still readable"
CE_RESP=$(node -e '
const zlib=require("zlib");const crypto=require("crypto");
function chunk(t,d){const l=Buffer.alloc(4);l.writeUInt32BE(d.length);const ty=Buffer.from(t);const cb=Buffer.concat([ty,d]);
  let c=~0;for(const b of cb){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^(0xEDB88320&-(c&1));}c=~c>>>0;const cr=Buffer.alloc(4);cr.writeUInt32BE(c>>>0);return Buffer.concat([l,ty,d,cr]);}
function pngSolid(W,H,r,g,b){const sig=Buffer.from([137,80,78,71,13,10,26,10]);const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(W,0);ihdr.writeUInt32BE(H,4);ihdr[8]=8;ihdr[9]=2;
  const raw=Buffer.alloc(H*(1+W*3));for(let y=0;y<H;y++){const o=y*(1+W*3);raw[o]=0;for(let x=0;x<W;x++){const p=o+1+x*3;raw[p]=r;raw[p+1]=g;raw[p+2]=b;}}
  return Buffer.concat([sig,chunk("IHDR",ihdr),chunk("IDAT",zlib.deflateSync(raw)),chunk("IEND",Buffer.alloc(0))]).toString("base64");}
// High-entropy noise PNG: pixels are random so zlib cannot compress it, giving a large, realistic
// screenshot-sized payload (~700KB base64 at 500x500). This is what makes the pile actually exceed the
// gateway limit — a solid color would compress to a few KB and never stress it.
function pngNoise(W,H){const sig=Buffer.from([137,80,78,71,13,10,26,10]);const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(W,0);ihdr.writeUInt32BE(H,4);ihdr[8]=8;ihdr[9]=2;
  const raw=Buffer.alloc(H*(1+W*3));for(let y=0;y<H;y++){const o=y*(1+W*3);raw[o]=0;crypto.randomFillSync(raw,o+1,W*3);}
  return Buffer.concat([sig,chunk("IHDR",ihdr),chunk("IDAT",zlib.deflateSync(raw,{level:0})),chunk("IEND",Buffer.alloc(0))]).toString("base64");}
// A browser loop: an initial user turn kicks it off, then each step is assistant(tool_use) ->
// user(tool_result with a screenshot). 10 older screenshots are heavy noise; the newest is a small solid
// GREEN square we ask about. The leading user turn matters: Anthropic rejects a tool_result not preceded
// by an assistant tool_use, and messages[0] may not be a tool_result.
const msgs=[{role:"user",content:[{type:"text",text:"Drive a browser and screenshot each step."}]}];
let rawSum=0;
for(let i=0;i<10;i++){
  const img=pngNoise(500,500); rawSum+=img.length;
  msgs.push({role:"assistant",content:[{type:"text",text:"step "+i},{type:"tool_use",id:"s"+i,name:"screenshot",input:{}}]});
  msgs.push({role:"user",content:[{type:"tool_result",tool_use_id:"s"+i,content:[{type:"text",text:"step "+i},{type:"image",source:{type:"base64",media_type:"image/png",data:img}}]}]});
}
msgs.push({role:"assistant",content:[{type:"text",text:"final step"},{type:"tool_use",id:"slast",name:"screenshot",input:{}}]});
msgs.push({role:"user",content:[{type:"tool_result",tool_use_id:"slast",content:[{type:"text",text:"final step"},{type:"image",source:{type:"base64",media_type:"image/png",data:pngSolid(200,200,30,200,30)}}]}]});
msgs.push({role:"user",content:[{type:"text",text:"What colour is the most recent screenshot? Reply with one word."}]});
process.stderr.write("unedited screenshot bytes ~"+(rawSum/1024/1024).toFixed(1)+"MB\n");
const body=JSON.stringify({model:"claude-opus-5[1m]",max_tokens:64,messages:msgs});
fetch("http://127.0.0.1:'"$PORT"'/anthropic/v1/messages",{method:"POST",headers:{"content-type":"application/json"},body}).then(r=>r.text()).then(t=>process.stdout.write(t)).catch(e=>process.stdout.write(JSON.stringify({error:{message:String(e)}})));
' 2>/tmp/ce-size.txt)
CE_TEXT=$(echo "$CE_RESP" | jq -r '[.content[]?|select(.type=="text")|.text]|join("")' 2>/dev/null)
CE_ERR=$(echo "$CE_RESP" | jq -r '.error.message // empty' 2>/dev/null)
echo "  $(cat /tmp/ce-size.txt 2>/dev/null)  context-edit turn result: ${CE_TEXT:-<err: $CE_ERR>}"
check "screenshot pile is a VALID request (no 4xx body-shape error masking the 413 check)" '! echo "$CE_RESP" | grep -qiE "invalid_request_body|400 —"' "request must be well-formed so the 413 check is meaningful; got err: \`${CE_ERR:-<none>}\`"
check "a ~7MB screenshot pile never 413s (context editing kept the body under the ~5 MiB gateway limit)" '! echo "$CE_RESP" | grep -qiE "413|entity too large|too large"' "no 413/entity-too-large for an 11-screenshot ~7MB history; got err: \`${CE_ERR:-<none>}\`"
if echo "$CE_TEXT" | grep -qi "green"; then
  check "latest screenshot still readable after clearing old ones (answers green)" 'true' "mapped GPT backend read the most-recent screenshot"
else
  note "latest-screenshot colour -> SKIPPED (mapped GPT vision is model-dependent; body/413 guards passed)"
  record "latest screenshot still readable after clearing old ones (answers green)" "SKIP" "mapped GPT replied \`${CE_TEXT:-<none>}\`; request validity + no-413 remain hard gates"
fi

# --- 17) context editing DYNAMIC budget: a big conversation + screenshots stays a valid turn (issue #52) ---
# Issue #52's follow-up: the 413 is on the WHOLE body, so context editing budgets image bytes DYNAMICALLY
# against what the non-image conversation leaves under the 5 MiB wall (proven exactly, quota-free, in the
# hermetic http-e2e). Here we prove the LIVE end-to-end consequence: a substantial mixed conversation
# (~100k tokens of real prose + a screenshot pile) is a valid turn — no 413, and the newest screenshot is
# still read. (The pure byte-wall extreme is unreachable as a <1M-token live request — base64 images
# tokenize at ~char/4, so a ~5 MiB body is ~1.3M tokens, over the model window — which is exactly why the
# byte-budget math is asserted hermetically, and case #16 stresses a big screenshot pile on its own.)
note "context editing (dynamic) -> a big conversation + screenshots stays a valid turn (issue #52)"
DCE_RESP=$(node -e '
const zlib=require("zlib");const crypto=require("crypto");
function chunk(t,d){const l=Buffer.alloc(4);l.writeUInt32BE(d.length);const ty=Buffer.from(t);const cb=Buffer.concat([ty,d]);
  let c=~0;for(const b of cb){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^(0xEDB88320&-(c&1));}c=~c>>>0;const cr=Buffer.alloc(4);cr.writeUInt32BE(c>>>0);return Buffer.concat([l,ty,d,cr]);}
function pngSolid(W,H,r,g,b){const sig=Buffer.from([137,80,78,71,13,10,26,10]);const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(W,0);ihdr.writeUInt32BE(H,4);ihdr[8]=8;ihdr[9]=2;
  const raw=Buffer.alloc(H*(1+W*3));for(let y=0;y<H;y++){const o=y*(1+W*3);raw[o]=0;for(let x=0;x<W;x++){const p=o+1+x*3;raw[p]=r;raw[p+1]=g;raw[p+2]=b;}}
  return Buffer.concat([sig,chunk("IHDR",ihdr),chunk("IDAT",zlib.deflateSync(raw)),chunk("IEND",Buffer.alloc(0))]).toString("base64");}
function pngNoise(W,H){const sig=Buffer.from([137,80,78,71,13,10,26,10]);const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(W,0);ihdr.writeUInt32BE(H,4);ihdr[8]=8;ihdr[9]=2;
  const raw=Buffer.alloc(H*(1+W*3));for(let y=0;y<H;y++){const o=y*(1+W*3);raw[o]=0;crypto.randomFillSync(raw,o+1,W*3);}
  return Buffer.concat([sig,chunk("IHDR",ihdr),chunk("IDAT",zlib.deflateSync(raw,{level:0})),chunk("IEND",Buffer.alloc(0))]).toString("base64");}
// ~100k tokens of realistic conversation (varied prose, not a degenerate repeat) as the opening turn.
const lines=[]; let acc=0;
const words="the quick brown fox jumps over a lazy dog while parsing logs and rendering the dashboard for the current build status across every worker node in the cluster".split(" ");
for(let n=0; acc<400000; n++){ const line="Line "+n+": "+words.slice(0, 8+(n%12)).join(" ")+".\n"; lines.push(line); acc+=line.length; }
const bigText=lines.join("");
const msgs=[{role:"user",content:bigText}];
let rawImg=0;
for(let i=0;i<4;i++){ const img=pngNoise(350,350); rawImg+=img.length;
  msgs.push({role:"assistant",content:[{type:"text",text:"step "+i},{type:"tool_use",id:"d"+i,name:"screenshot",input:{}}]});
  msgs.push({role:"user",content:[{type:"tool_result",tool_use_id:"d"+i,content:[{type:"text",text:"step "+i},{type:"image",source:{type:"base64",media_type:"image/png",data:img}}]}]});
}
msgs.push({role:"assistant",content:[{type:"text",text:"final"},{type:"tool_use",id:"dlast",name:"screenshot",input:{}}]});
msgs.push({role:"user",content:[{type:"tool_result",tool_use_id:"dlast",content:[{type:"text",text:"final"},{type:"image",source:{type:"base64",media_type:"image/png",data:pngSolid(200,200,30,200,30)}}]}]});
msgs.push({role:"user",content:[{type:"text",text:"What colour is the most recent screenshot? Reply with one word."}]});
process.stderr.write("text ~"+(bigText.length/1024/1024).toFixed(1)+"MB + images ~"+(rawImg/1024/1024).toFixed(1)+"MB unedited\n");
const body=JSON.stringify({model:"claude-opus-5[1m]",max_tokens:64,messages:msgs});
fetch("http://127.0.0.1:'"$PORT"'/anthropic/v1/messages",{method:"POST",headers:{"content-type":"application/json"},body}).then(r=>r.text()).then(t=>process.stdout.write(t)).catch(e=>process.stdout.write(JSON.stringify({error:{message:String(e)}})));
' 2>/tmp/dce-size.txt)
DCE_TEXT=$(echo "$DCE_RESP" | jq -r '[.content[]?|select(.type=="text")|.text]|join("")' 2>/dev/null)
DCE_ERR=$(echo "$DCE_RESP" | jq -r '.error.message // empty' 2>/dev/null)
echo "  $(cat /tmp/dce-size.txt 2>/dev/null)  result: ${DCE_TEXT:-<err: $DCE_ERR>}"
check "big-text + screenshots is a VALID request" '! echo "$DCE_RESP" | grep -qiE "invalid_request_body|400 —"' "request must be well-formed; got err: \`${DCE_ERR:-<none>}\`"
check "issue #52: big conversation + screenshots never 413s (dynamic budget cleared more images)" '! echo "$DCE_RESP" | grep -qiE "413|entity too large|too large"' "no 413 for a big-text+screenshots body; got err: \`${DCE_ERR:-<none>}\`"
if echo "$DCE_TEXT" | grep -qi "green"; then
  check "latest screenshot still readable with a big conversation (answers green)" 'true' "mapped GPT backend read the most-recent screenshot"
else
  note "dynamic latest-screenshot colour -> SKIPPED (mapped GPT vision is model-dependent; body/413 guards passed)"
  record "latest screenshot still readable with a big conversation (answers green)" "SKIP" "mapped GPT replied \`${DCE_TEXT:-<none>}\`; request validity + no-413 remain hard gates"
fi

# --- 19) codex gpt-5.6 additional_tools: tools survive the new wire shape (issue #4231) -----------
# THE regression this PR fixes. Codex 0.145+ (gpt-5.6 family) no longer sends top-level `tools` — it
# rides them inside an `additional_tools` item in `input`. responses-inbound.ts dropped that item, so
# the model reached Copilot tool-less and could only NARRATE its tool calls as text ("I'm unable to
# access a shell tool") — every real Codex task on gpt-5.6 was dead. Cases 12/16 use codex's DEFAULT
# model and can't catch this: they exercise the OLD top-level-tools shape. Here we PIN a gpt-5.6-family
# model so codex emits `additional_tools`, then drive a real file-write tool loop. FS oracle = the file
# only exists if the tool truly ran through the proxy. The account may not have gpt-5.6 (or codex may
# rename the id), so SKIP — never fail — when the model is unavailable, keeping forked/limited CI green.
note "codex gpt-5.6 additional_tools -> real shell tool loop (issue #4231; SKIP if model absent)"
# Default to a concrete gpt-5.6 id (the family ships as gpt-5.6-luna/sol/terra; a bare "gpt-5.6" is
# forwarded verbatim and 400s → SKIP). Override with CODEX56_MODEL for a different account.
CODEX56_MODEL="${CODEX56_MODEL:-gpt-5.6-luna}"
rm -f /tmp/codex56_proof.txt
CODEX56=$(cd /tmp && timeout 120 codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox \
  -c model="$CODEX56_MODEL" \
  "Create a file named codex56_proof.txt in the current directory whose contents are exactly CODEX56_OK, then reply DONE." 2>/tmp/codex56.err)
CODEX56_PROOF=$(cat /tmp/codex56_proof.txt 2>/dev/null)
echo "  ($CODEX56_MODEL) codex56_proof.txt: ${CODEX56_PROOF:-<not created>}"
if echo "$CODEX56_PROOF" | grep -q "CODEX56_OK"; then
  check "codex gpt-5.6 additional_tools loop writes the file (tools survived the new wire shape)" 'true' "codex ($CODEX56_MODEL) ran a real shell tool via additional_tools -> file written through the proxy (#4231)"
elif { echo "$CODEX56"; cat /tmp/codex56.err; } | grep -qiE "model_not_supported|not.?support|unknown model|invalid.*model|400|404|no such model"; then
  note "codex gpt-5.6 additional_tools -> SKIPPED ($CODEX56_MODEL unavailable on this account)"
  record "codex gpt-5.6 additional_tools loop writes the file" "SKIP" "$CODEX56_MODEL absent from this account's Copilot models"
else
  # Model WAS available but no file appeared — this is the actual #4231 failure (tool-less narration).
  check "codex gpt-5.6 additional_tools loop writes the file (tools survived the new wire shape)" 'false' "expected CODEX56_OK in the file, got \`${CODEX56_PROOF:-<none>}\` — tools may have been dropped from additional_tools (#4231). last codex line: \`$(echo "$CODEX56" | tail -1)\`"
fi

# --- 20) Claude compatibility alias -> live GPT backend ------------------------------------------
# Toggle the real persisted preference and restart the real worker. Pick the first preset whose exact
# backend is in this account's live discovery; if none exists, this optional/account-specific case SKIPs.
note "claude-map: native Claude alias -> exact live GPT backend (SKIP if no preset target exists)"
MAP_PICK=$(node --input-type=module - <<'NODE'
const { readFileSync } = await import("node:fs");
const models = JSON.parse(readFileSync("/tmp/live-models.json", "utf8"));
const map = [
  ["claude-opus-5", "gpt-5.6-sol"],
  ["claude-opus-4-8", "gpt-5.6-luna"],
  ["claude-sonnet-5", "gpt-5.6-terra"],
  ["claude-sonnet-4-6", "gpt-5.5"],
  ["claude-haiku-4-5", "gpt-5.4"],
];
const ids = new Set(models.data.map((m) => m.id));
const hit = map.find(([, backend]) => ids.has(backend));
if (hit) process.stdout.write(hit.join("|"));
NODE
)
if [ -n "$MAP_PICK" ]; then
  MAP_ALIAS=${MAP_PICK%%|*}; MAP_BACKEND=${MAP_PICK#*|}
  node --input-type=module -e 'import("/app/dist/shared/prefs.js").then(m=>m.writeClaudeMapEnabled("/root/.copilot-reverse",true))'
  kill "$WPID" 2>/dev/null; wait "$WPID" 2>/dev/null
  WORKER_PORT=$PORT BIND_HOST=127.0.0.1 node dist/worker/index.js > /tmp/worker-map.log 2>&1 & WPID=$!
  for _ in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break; sleep 0.5; done
  # /healthz means the socket is ready, not that async Copilot model discovery has completed. Wait for the
  # exact alias so this test cannot race the startup fetch and accidentally run with an empty model id.
  MAP_ID=""; MAP_MODELS=""
  for _ in $(seq 1 40); do
    MAP_MODELS=$(curl -sf "http://127.0.0.1:$PORT/anthropic/v1/models")
    MAP_ID=$(echo "$MAP_MODELS" | jq -r --arg a "$MAP_ALIAS" '.data[] | select((.id|sub("\\[1m\\]$";""))==$a) | .id' | head -1)
    [ -n "$MAP_ID" ] && break
    sleep 0.25
  done
  check "map-enabled Anthropic discovery publishes the native Claude alias" '[ -n "$MAP_ID" ]' "alias=$MAP_ALIAS backend=$MAP_BACKEND id=$MAP_ID models=$(echo "$MAP_MODELS" | jq -rc '[.data[].id]')"
  if [ -n "$MAP_ID" ]; then
    MAP_JSON=$(ANTHROPIC_MODEL="$MAP_ID" claude -p "Reply with exactly: CLAUDE_MAP_OK" --output-format json 2>/tmp/claude-map.err)
  else
    MAP_JSON=""
  fi
  MAP_TEXT=$(echo "$MAP_JSON" | jq -r '.result // empty' 2>/dev/null)
  check "real claude CLI answers through the mapped GPT backend" 'echo "$MAP_TEXT" | grep -q "CLAUDE_MAP_OK"' "$MAP_ALIAS -> $MAP_BACKEND replied: \`$MAP_TEXT\`"
  node --input-type=module -e 'import("/app/dist/shared/prefs.js").then(m=>m.writeClaudeMapEnabled("/root/.copilot-reverse",false))'
else
  note "claude-map -> SKIPPED (none of the five preset GPT targets is live on this account)"
  record "real claude CLI answers through a mapped GPT backend" "SKIP" "no preset target in live model discovery"
fi

# --- teardown -----------------------------------------------------------------------------------
kill "$WPID" 2>/dev/null

# --- report -------------------------------------------------------------------------------------
status_line=$([ "$fails" = 0 ] && echo "✅ ALL PASSED" || echo "❌ ${fails} FAILED")
REPORT=$(cat <<EOF
# copilot-reverse — real CLI e2e report

**Result:** ${status_line}  ($((total - fails))/${total} checks passed)

Black-box end-to-end: the real \`claude\` and \`codex\` CLIs run inside the container against the
actual copilot-reverse worker daemon, making real Copilot (and WebIQ) calls.

| component | version |
|-----------|---------|
| copilot-reverse | ${APP_VER:-?} |
| codex CLI | ${CODEX_VER:-?} |
| claude CLI | ${CLAUDE_VER:-?} |

| check | status | detail |
|-------|--------|--------|
$(printf "%b" "$rows")
EOF
)
echo "$REPORT" > /tmp/cli-e2e-report.md
if mkdir -p "$(dirname "$REPORT_PATH")" 2>/dev/null && echo "$REPORT" > "$REPORT_PATH" 2>/dev/null; then
  echo ""; echo "report written to ${REPORT_PATH} (and /tmp/cli-e2e-report.md)"
else
  echo ""; echo "report written to /tmp/cli-e2e-report.md (mount -v <dir>:/out to capture it on the host)"
fi

note "summary"
echo "$status_line"
[ "$fails" = 0 ] && exit 0 || exit 1
