#!/usr/bin/env bash
# MCP Inspector smoke test for foam-notes-mcp.
#
# Asserts the server exposes exactly 6 tools by invoking the MCP Inspector
# CLI with `tools/list`. Requires `dist/server.js` to be built.

set -euo pipefail

if [[ ! -f "dist/server.js" ]]; then
  echo "SKIP: server not implemented (dist/server.js missing)"
  exit 0
fi

SMOKE_VAULT="${SMOKE_VAULT:-/tmp/foam-mcp-smoke-vault}"

echo "[inspector-smoke] generating 10-note vault at $SMOKE_VAULT"
npm run gen:vault -- --size 10 --out "$SMOKE_VAULT"

echo "[inspector-smoke] launching MCP Inspector against dist/server.js"
TOOLS_JSON=$(NO_COLOR=1 FORCE_COLOR=0 FOAM_VAULT_PATH="$SMOKE_VAULT" npx -y \
  @modelcontextprotocol/inspector --cli --method tools/list node dist/server.js) \
  || { echo "[inspector-smoke] inspector invocation failed"; exit 1; }

# Strip any ANSI escape codes that the inspector may inject around values.
TOOLS_JSON_CLEAN=$(printf '%s' "$TOOLS_JSON" | sed -E $'s/\x1b\\[[0-9;]*[mK]//g')

# Use process.stdout.write so FORCE_COLOR cannot wrap the number in ANSI codes.
TOOL_COUNT=$(FORCE_COLOR=0 NO_COLOR=1 printf '%s' "$TOOLS_JSON_CLEAN" | node -e \
  'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const d=JSON.parse(s);const n=Array.isArray(d.tools)?d.tools.length:0;process.stdout.write(String(n))})')

echo "[inspector-smoke] tool count: $TOOL_COUNT"

if [[ "$TOOL_COUNT" != "6" ]]; then
  echo "[inspector-smoke] expected 6 tools, got $TOOL_COUNT" >&2
  echo "$TOOLS_JSON_CLEAN" >&2
  exit 1
fi

echo "[inspector-smoke] OK"
