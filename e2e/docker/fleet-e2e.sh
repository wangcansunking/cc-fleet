#!/usr/bin/env bash
# Two-machine fleet e2e: a hub container and a node container on a docker network.
#
# This is the only harness that tests the actual claim — "change it on one machine, every machine
# follows" — against two real hosts. The in-process e2e shares a filesystem and a process; a bug that
# only appears when the store, the tool directory and the network are genuinely separate would sail
# straight through it.
#
# No Copilot credentials are involved. That is deliberate and is itself an assertion: the control
# plane must work with no GitHub login and no subscription anywhere (docs/design.md §2).
set -uo pipefail

IMAGE="${IMAGE:-cc-fleet-fleet-e2e}"
NET="ccfleet-e2e-net"
HUB="ccfleet-hub"
CUSTOM_HUB="ccfleet-hub-custom"
NODE_A="ccfleet-node-a"
NODE_B="ccfleet-node-b"
NODE_C="ccfleet-node-c"
PORT=7992
FORMER_PORT=7892
CUSTOM_PORT=7993
OUT="${OUT:-/tmp/fleet-e2e}"

PASS=0; FAIL=0; SKIP=0
ok()   { echo "  PASS $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL $1"; FAIL=$((FAIL+1)); }
skip() { echo "  SKIP $1"; SKIP=$((SKIP+1)); }
say()  { echo; echo "=== $1 ==="; }

cleanup() {
  docker rm -f "$HUB" "$CUSTOM_HUB" "$NODE_A" "$NODE_B" "$NODE_C" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

mkdir -p "$OUT"
docker network create "$NET" >/dev/null

# ── hub ────────────────────────────────────────────────────────────────────────────────────────
say "the explicit hub port override still wins"
docker run -d --name "$CUSTOM_HUB" --network "$NET" "$IMAGE" \
  hub --foreground --port "$CUSTOM_PORT" --host 0.0.0.0 >/dev/null
for i in $(seq 1 60); do
  docker logs "$CUSTOM_HUB" 2>&1 | grep -q "listening on" && break
  sleep 1
done
CUSTOM_LOG="$(docker logs "$CUSTOM_HUB" 2>&1)"
if echo "$CUSTOM_LOG" | grep -q "listening on :$CUSTOM_PORT"; then ok "hub --port uses the custom port"; else bad "custom-port hub failed to start"; echo "$CUSTOM_LOG"; exit 1; fi
if docker exec "$CUSTOM_HUB" node -e "fetch('http://127.0.0.1:$PORT/control/device').then(()=>process.exit(1),()=>process.exit(0))"
then ok "custom-port hub did not also bind the default"; else bad "custom-port hub also bound :$PORT"; fi
docker rm -f "$CUSTOM_HUB" >/dev/null 2>&1 || true

say "start the hub container on its default port"
docker run -d --name "$HUB" --network "$NET" --network-alias hub "$IMAGE" \
  hub --foreground --host 0.0.0.0 >/dev/null

for i in $(seq 1 60); do
  docker logs "$HUB" 2>&1 | grep -q "listening on" && break
  sleep 1
done
HUB_LOG="$(docker logs "$HUB" 2>&1)"
if echo "$HUB_LOG" | grep -q "listening on :$PORT"; then ok "hub default is listening on :$PORT"; else bad "hub failed to start on its default"; echo "$HUB_LOG"; exit 1; fi
if docker exec "$HUB" node -e "fetch('http://127.0.0.1:$FORMER_PORT/control/device').then(()=>process.exit(1),()=>process.exit(0))"
then ok "former hub default :$FORMER_PORT stays closed"; else bad "former hub default :$FORMER_PORT is still listening"; fi

# The hub no longer hands out a code at startup — a machine asks, and a human here approves it. So
# what the hub must print is the instruction, not a secret.
if echo "$HUB_LOG" | grep -q "cc-fleet join http"; then ok "hub printed how to enrol a node"; else bad "hub did not say how to enrol"; echo "$HUB_LOG"; exit 1; fi
if echo "$HUB_LOG" | grep -qE '[A-Z2-9]{4}-[A-Z2-9]{4}'; then bad "hub printed an enrolment secret at startup"; else ok "hub minted no secret at startup"; fi

# The starter profile assigns the HUB's hostname; rewrite it for the node container's hostname so the
# node is actually managed rather than reported unassigned.
docker exec "$HUB" sh -c 'cat > /root/.cc-fleet/profile.json <<JSON
{
  "version": 1,
  "groups": {
    "full": {
      "skills": [ { "id": "code-review", "files": [ { "path": "SKILL.md", "content": "review carefully" } ] } ],
      "rules":  [ { "id": "commit-style", "content": "Write commit messages in the imperative mood." } ],
      "mcpServers": [ { "id": "fleet-demo", "config": { "type": "http", "url": "https://example.invalid/mcp" } } ]
    },
    "extras": {
      "skills": [ { "id": "deploy-runbook", "files": [ { "path": "SKILL.md", "content": "deploy steps" } ] } ],
      "rules": [], "mcpServers": []
    }
  },
  "assignments": { "node-a": "full", "node-b": "full" },
  "devices": { "node-a": { "add": { "skills": ["deploy-runbook"] } } }
}
JSON'
ok "profile written on the hub"

# ── node A ─────────────────────────────────────────────────────────────────────────────────────
# The direction under test: the machine BEING enrolled starts the exchange and displays a code; the
# operator approves it on the hub. Nothing is issued in between — that is the property, not a detail.
say "node A asks to join"
docker run -d --name "$NODE_A" --hostname node-a --network "$NET" "$IMAGE" \
  join --foreground "http://hub:$PORT" >/dev/null

CODE=""
for i in $(seq 1 60); do
  CODE="$(docker logs "$NODE_A" 2>&1 | grep -oE '[A-Z2-9]{4}-[A-Z2-9]{4}' | head -1)"
  [ -n "$CODE" ] && break
  sleep 1
done
if [ -n "$CODE" ]; then ok "node A showed a code on its own screen"; else bad "node A never showed a code"; docker logs "$NODE_A" 2>&1; exit 1; fi

# Waiting is not joining. If a machine can reach the hub and be enrolled by that alone, the human
# approval is decoration.
if docker exec "$HUB" node dist/cli/index.js devices 2>&1 | grep -q "node-a"
then bad "node A was enrolled before anyone approved it"; else ok "nothing was issued before approval"; fi

say "the hub shows WHICH machine is asking, before approving it"
docker exec "$HUB" node dist/cli/index.js approve > "$OUT/pending-a.log" 2>&1
if grep -q "node-a" "$OUT/pending-a.log"; then ok "the waiting machine is named, not just counted"; else bad "hub did not show the waiting machine"; cat "$OUT/pending-a.log"; fi

say "a human approves node A"
docker exec "$HUB" node dist/cli/index.js approve "$CODE" > "$OUT/approve-a.log" 2>&1
if grep -q "approved node-a" "$OUT/approve-a.log"; then ok "approve named what it let in"; else bad "approve failed"; cat "$OUT/approve-a.log"; fi

for i in $(seq 1 60); do
  docker logs "$NODE_A" 2>&1 | grep -q "applied v1" && break
  sleep 1
done
NODE_LOG="$(docker logs "$NODE_A" 2>&1)"
if echo "$NODE_LOG" | grep -q "enrolled as node-a"; then ok "node A enrolled over the network"; else bad "node A did not enrol"; echo "$NODE_LOG"; fi
if echo "$NODE_LOG" | grep -q "applied v1"; then ok "node A applied the profile"; else bad "node A never applied"; echo "$NODE_LOG"; fi

say "the skill and rules reached node A's Claude Code directory"
if docker exec "$NODE_A" cat /root/.claude/skills/code-review/SKILL.md 2>/dev/null | grep -q "review carefully"
then ok "skill projected into ~/.claude/skills"; else bad "skill missing from ~/.claude/skills"; fi

if docker exec "$NODE_A" cat /root/.agents/fleet/skills/code-review/SKILL.md 2>/dev/null | grep -q "review carefully"
then ok "skill stored in ~/.agents/fleet"; else bad "skill missing from the store"; fi

if docker exec "$NODE_A" cat /root/.claude/CLAUDE.md 2>/dev/null | grep -q "imperative mood"
then ok "rules projected into a generated CLAUDE.md"; else bad "rules missing from CLAUDE.md"; fi

if docker exec "$NODE_A" cat /root/.claude/CLAUDE.md 2>/dev/null | grep -q "GENERATED BY cc-fleet"
then ok "generated file is marked as generated"; else bad "CLAUDE.md is not marked generated"; fi

# The node must never need its own Copilot/GitHub credentials — that is the point of the fleet.
if docker exec "$NODE_A" sh -c 'test ! -f /root/.cc-fleet/creds.json'
then ok "node holds no GitHub credentials"; else bad "node unexpectedly has GitHub credentials"; fi

say "per-device override gave node A a skill its group does not include"
if docker exec "$NODE_A" cat /root/.agents/fleet/skills/deploy-runbook/SKILL.md 2>/dev/null | grep -q "deploy steps"
then ok "device-level add applied"; else bad "device-level add did not apply"; fi

say "MCP is stored, and skipped honestly because this image has no claude CLI"
if docker exec "$NODE_A" cat /root/.agents/fleet/mcp/fleet-demo.json 2>/dev/null | grep -q "example.invalid"
then ok "MCP config landed in the store"; else bad "MCP config missing from the store"; fi

# This image deliberately does NOT install Claude Code: a node without it must degrade to a reported
# skip, never to a silent success or a crash. That is the behaviour under test here.
if docker exec "$NODE_A" sh -c 'test ! -f /root/.claude.json'
then ok "~/.claude.json was never created by cc-fleet"; else bad "cc-fleet wrote ~/.claude.json"; fi

if docker exec "$NODE_A" cat /root/.agents/.cc-fleet/projected.json 2>/dev/null | grep -q '"mcpServers": \[\]'
then ok "no MCP recorded as managed when the CLI is absent"; else bad "MCP wrongly recorded as managed"; fi

if docker logs "$NODE_A" 2>&1 | grep -q "claude CLI not found"
then ok "the skip was reported, not hidden"; else bad "MCP skip was not reported"; fi

# ── the actual claim: change it once, every machine follows ─────────────────────────────────────
# This used to be a SKIP: the hub minted codes only at startup, so a second machine meant restarting
# the control plane. It is a real case now, and that is the point of the new handshake.
say "a second machine joins a RUNNING hub, with no restart and no code carried between machines"
docker run -d --name "$NODE_B" --hostname node-b --network "$NET" "$IMAGE" \
  join --foreground "http://hub:$PORT" >/dev/null

CODE_B=""
for i in $(seq 1 60); do
  CODE_B="$(docker logs "$NODE_B" 2>&1 | grep -oE '[A-Z2-9]{4}-[A-Z2-9]{4}' | head -1)"
  [ -n "$CODE_B" ] && break
  sleep 1
done
if [ -n "$CODE_B" ]; then ok "node B showed its own code"; else bad "node B never showed a code"; docker logs "$NODE_B" 2>&1; fi
if [ -n "$CODE_B" ] && [ "$CODE_B" != "$CODE" ]; then ok "each machine gets a distinct code"; else bad "node B reused node A's code"; fi

docker exec "$HUB" node dist/cli/index.js approve "$CODE_B" > "$OUT/approve-b.log" 2>&1
if grep -q "approved node-b" "$OUT/approve-b.log"; then ok "hub approved the second machine while running"; else bad "second approval failed"; cat "$OUT/approve-b.log"; fi

for i in $(seq 1 60); do
  docker logs "$NODE_B" 2>&1 | grep -q "applied v1" && break
  sleep 1
done
if docker logs "$NODE_B" 2>&1 | grep -q "applied v1"; then ok "node B applied the profile too"; else bad "node B never applied"; docker logs "$NODE_B" 2>&1 | tail -5; fi
if docker exec "$NODE_B" cat /root/.claude/skills/code-review/SKILL.md 2>/dev/null | grep -q "review carefully"
then ok "the same skill reached a second, independent machine"; else bad "second machine did not get the skill"; fi

say "a machine the operator refuses is turned away, not left hanging"
docker run -d --name "$NODE_C" --hostname node-c --network "$NET" "$IMAGE" \
  join --foreground "http://hub:$PORT" >/dev/null
CODE_C=""
for i in $(seq 1 60); do
  CODE_C="$(docker logs "$NODE_C" 2>&1 | grep -oE '[A-Z2-9]{4}-[A-Z2-9]{4}' | head -1)"
  [ -n "$CODE_C" ] && break
  sleep 1
done
if [ -n "$CODE_C" ]; then ok "the unwanted machine also just shows a code"; else bad "node C never showed a code"; fi

docker exec "$HUB" node dist/cli/index.js deny "$CODE_C" > "$OUT/deny.log" 2>&1
if grep -q "denied node-c" "$OUT/deny.log"; then ok "deny named what it turned away"; else bad "deny failed"; cat "$OUT/deny.log"; fi

for i in $(seq 1 40); do
  [ "$(docker inspect -f '{{.State.Running}}' "$NODE_C" 2>/dev/null)" = "false" ] && break
  sleep 1
done
RC_C="$(docker inspect -f '{{.State.ExitCode}}' "$NODE_C" 2>/dev/null || echo missing)"
if [ "$RC_C" != "0" ] && [ "$RC_C" != "missing" ]
then ok "the refused machine stopped, non-zero (rc=$RC_C)"; else bad "refused machine did not fail (rc=$RC_C)"; docker logs "$NODE_C" 2>&1 | tail -5; fi
if docker logs "$NODE_C" 2>&1 | grep -qi "denied"; then ok "it was told why"; else bad "it was turned away silently"; fi
if docker exec "$HUB" node dist/cli/index.js devices 2>&1 | grep -q "node-c"
then bad "a denied machine ended up in the device registry"; else ok "a denied machine is not in the fleet"; fi
docker rm -f "$NODE_C" >/dev/null 2>&1 || true

say "a device code nobody issued buys nothing"
# The network-facing secret is now 32 random bytes rather than a code a human reads, so the thing to
# prove over the wire is that guessing one gets a flat refusal. Single-use is covered in-process.
if docker exec "$HUB" sh -c "node -e \"fetch('http://127.0.0.1:$PORT/control/device/token',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({deviceCode:'never-issued-at-all'})}).then(r=>console.log('status',r.status))\"" 2>&1 | grep -q "status 401"
then ok "an unknown device code is refused"; else bad "an unknown device code was not refused"; fi


say "edit the profile on the hub -> node A follows within seconds"
docker exec "$HUB" sh -c 'sed -i "s/review carefully/REVIEWED BY THE FLEET/; s/\"version\": 1/\"version\": 2/" /root/.cc-fleet/profile.json'
for i in $(seq 1 30); do
  docker exec "$NODE_A" cat /root/.claude/skills/code-review/SKILL.md 2>/dev/null | grep -q "REVIEWED BY THE FLEET" && break
  sleep 1
done
if docker exec "$NODE_A" cat /root/.claude/skills/code-review/SKILL.md 2>/dev/null | grep -q "REVIEWED BY THE FLEET"
then ok "hub edit propagated to the node"; else bad "hub edit never reached the node"; fi

say "the node's own half survives a hub push"
docker exec "$NODE_A" sh -c 'mkdir -p /root/.agents/local/skills/mine && echo "my own work" > /root/.agents/local/skills/mine/SKILL.md'
docker exec "$HUB" sh -c 'sed -i "s/\"version\": 2/\"version\": 3/" /root/.cc-fleet/profile.json'
for i in $(seq 1 30); do
  docker logs "$NODE_A" 2>&1 | grep -q "applied v3" && break
  sleep 1
done
if docker exec "$NODE_A" cat /root/.agents/local/skills/mine/SKILL.md 2>/dev/null | grep -q "my own work"
then ok "local skill survived full takeover"; else bad "full takeover ate the node's own skill"; fi
if docker exec "$NODE_A" cat /root/.claude/skills/mine/SKILL.md 2>/dev/null | grep -q "my own work"
then ok "local skill is projected into the tool"; else bad "local skill never reached the tool"; fi

say "a file the store does not produce is removed from the tool"
docker exec "$NODE_A" sh -c 'mkdir -p /root/.claude/skills/stale && echo x > /root/.claude/skills/stale/SKILL.md'
docker exec "$HUB" sh -c 'sed -i "s/\"version\": 3/\"version\": 4/" /root/.cc-fleet/profile.json'
for i in $(seq 1 30); do
  docker logs "$NODE_A" 2>&1 | grep -q "applied v4" && break
  sleep 1
done
if docker exec "$NODE_A" sh -c 'test ! -d /root/.claude/skills/stale'
then ok "unmanaged file removed from the projection target"; else bad "unmanaged file survived takeover"; fi
if docker exec "$NODE_A" sh -c 'ls /root/.agents/.cc-fleet/backups | head -1 | grep -q .'
then ok "a backup exists for what was removed"; else bad "nothing was backed up"; fi

# ── revocation reaches a live machine ──────────────────────────────────────────────────────────
say "node authors its own skill and pushes it — it must NOT go live on its own"
docker exec "$NODE_A" sh -c 'mkdir -p /root/.agents/local/skills/node-made && echo "authored on node-a" > /root/.agents/local/skills/node-made/SKILL.md'
docker exec "$NODE_A" node dist/cli/index.js push skill/node-made > "$OUT/push.log" 2>&1
if grep -q "pushed skill/node-made" "$OUT/push.log"; then ok "push reported success"; else bad "push failed"; cat "$OUT/push.log"; fi

docker exec "$HUB" node dist/cli/index.js pending > "$OUT/pending.log" 2>&1
if grep -q "node-made" "$OUT/pending.log"; then ok "item is waiting in the hub's inbox"; else bad "item never reached the inbox"; cat "$OUT/pending.log"; fi

# The property that matters: it is in the inbox and NOT in the profile.
if docker exec "$HUB" grep -q "node-made" /root/.cc-fleet/profile.json
then bad "a pushed item reached the profile without anyone adopting it"
else ok "pushed item did NOT become fleet config on its own"; fi

say "a human adopts it — now the whole fleet gets it"
docker exec "$HUB" node dist/cli/index.js adopt node-a skill/node-made --group full > "$OUT/adopt.log" 2>&1
if grep -q "in group" "$OUT/adopt.log"; then ok "adopt reported success"; else bad "adopt failed"; cat "$OUT/adopt.log"; fi

for i in $(seq 1 30); do
  docker exec "$NODE_A" sh -c 'test -f /root/.agents/fleet/skills/node-made/SKILL.md' && break
  sleep 1
done
if docker exec "$NODE_A" cat /root/.agents/fleet/skills/node-made/SKILL.md 2>/dev/null | grep -q "authored on node-a"
then ok "adopted item came back down as fleet config"; else bad "adopted item never reached the node as managed"; fi

# `local/` belongs to the node; adoption is not permission to tidy it up.
if docker exec "$NODE_A" cat /root/.agents/local/skills/node-made/SKILL.md 2>/dev/null | grep -q "authored on node-a"
then ok "the node's own copy is left alone after adoption"; else bad "adoption deleted the node's own copy"; fi

if docker exec "$HUB" node dist/cli/index.js pending 2>&1 | grep -q "nothing pending"
then ok "inbox is empty after adoption"; else bad "adopted item still sits in the inbox"; fi

say "revoking node A ejects it from the running hub"
docker exec "$HUB" node dist/cli/index.js revoke node-a > "$OUT/revoke.log" 2>&1
if grep -q "revoked node-a" "$OUT/revoke.log"; then ok "revoke reported success"; else bad "revoke failed"; cat "$OUT/revoke.log"; fi

for i in $(seq 1 40); do
  docker logs "$NODE_A" 2>&1 | grep -qi "revoked" && break
  sleep 1
done
if docker logs "$NODE_A" 2>&1 | grep -qi "credential (401)"
then ok "node was told why it was cut off"; else bad "node was cut off silently"; docker logs "$NODE_A" 2>&1 | tail -5; fi

RC="$(docker inspect -f '{{.State.ExitCode}}' "$NODE_A" 2>/dev/null || echo missing)"
RUNNING="$(docker inspect -f '{{.State.Running}}' "$NODE_A" 2>/dev/null || echo unknown)"
if [ "$RUNNING" = "false" ] && [ "$RC" != "0" ]
then ok "revoked node exited non-zero (rc=$RC)"
else bad "revoked node did not exit non-zero (running=$RUNNING rc=$RC)"; fi

# ── report ─────────────────────────────────────────────────────────────────────────────────────
docker logs "$HUB" > "$OUT/hub.log" 2>&1
docker logs "$NODE_A" > "$OUT/node-a.log" 2>&1

echo
echo "=== summary ==="
echo "PASS $PASS  FAIL $FAIL  SKIP $SKIP"
[ "$FAIL" -eq 0 ] && echo "✅ ALL PASSED" || echo "❌ $FAIL FAILED"
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
