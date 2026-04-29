#!/usr/bin/env bash
# MCP Inspector smoke test for foam-notes-mcp.
#
# Asserts:
#   - The server exposes exactly 12 tools (6 keyword + 6 graph).
#   - The server exposes the `foam://graph` resource.
#
# Requires `dist/server.js` to be built.

set -euo pipefail

if [[ ! -f "dist/server.js" ]]; then
  echo "SKIP: server not implemented (dist/server.js missing)"
  exit 0
fi

SMOKE_VAULT="${SMOKE_VAULT:-/tmp/foam-mcp-smoke-vault}"

echo "[inspector-smoke] generating 10-note vault at $SMOKE_VAULT"
npm run gen:vault -- --size 10 --out "$SMOKE_VAULT"

# Strip any ANSI escape codes the inspector may inject around values.
strip_ansi() {
  sed -E $'s/\x1b\\[[0-9;]*[mK]//g'
}

echo "[inspector-smoke] launching MCP Inspector — tools/list"
TOOLS_JSON=$(NO_COLOR=1 FORCE_COLOR=0 FOAM_VAULT_PATH="$SMOKE_VAULT" npx -y \
  @modelcontextprotocol/inspector --cli --method tools/list node dist/server.js) \
  || { echo "[inspector-smoke] inspector tools/list invocation failed"; exit 1; }

TOOLS_JSON_CLEAN=$(printf '%s' "$TOOLS_JSON" | strip_ansi)

# Use process.stdout.write so FORCE_COLOR cannot wrap the number in ANSI codes.
TOOL_COUNT=$(FORCE_COLOR=0 NO_COLOR=1 printf '%s' "$TOOLS_JSON_CLEAN" | node -e \
  'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const d=JSON.parse(s);const n=Array.isArray(d.tools)?d.tools.length:0;process.stdout.write(String(n))})')

echo "[inspector-smoke] tool count: $TOOL_COUNT"

if [[ "$TOOL_COUNT" != "12" ]]; then
  echo "[inspector-smoke] expected 12 tools, got $TOOL_COUNT" >&2
  echo "$TOOLS_JSON_CLEAN" >&2
  exit 1
fi

echo "[inspector-smoke] launching MCP Inspector — resources/list"
RESOURCES_JSON=$(NO_COLOR=1 FORCE_COLOR=0 FOAM_VAULT_PATH="$SMOKE_VAULT" npx -y \
  @modelcontextprotocol/inspector --cli --method resources/list node dist/server.js) \
  || { echo "[inspector-smoke] inspector resources/list invocation failed"; exit 1; }

RESOURCES_JSON_CLEAN=$(printf '%s' "$RESOURCES_JSON" | strip_ansi)

HAS_GRAPH_RESOURCE=$(FORCE_COLOR=0 NO_COLOR=1 printf '%s' "$RESOURCES_JSON_CLEAN" | node -e \
  'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const d=JSON.parse(s);const list=Array.isArray(d.resources)?d.resources:[];const found=list.some(r=>r&&r.uri==="foam://graph");process.stdout.write(found?"yes":"no")})')

echo "[inspector-smoke] foam://graph present: $HAS_GRAPH_RESOURCE"

if [[ "$HAS_GRAPH_RESOURCE" != "yes" ]]; then
  echo "[inspector-smoke] expected foam://graph in resources/list" >&2
  echo "$RESOURCES_JSON_CLEAN" >&2
  exit 1
fi

echo "[inspector-smoke] OK"
