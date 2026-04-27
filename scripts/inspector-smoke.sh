#!/usr/bin/env bash
# MCP Inspector smoke test for foam-notes-mcp.
# Wave 1: server is not implemented; this script is a stub that exits 0.
# Wave 7 will tighten this to assert 16 tools + 1 resource listable.

set -euo pipefail

if [[ ! -f "dist/server.js" ]]; then
  echo "SKIP: server not implemented (dist/server.js missing)"
  exit 0
fi

SMOKE_VAULT="${SMOKE_VAULT:-/tmp/foam-mcp-smoke-vault}"

echo "[inspector-smoke] generating 10-note vault at $SMOKE_VAULT"
npm run gen:vault -- --size 10 --out "$SMOKE_VAULT"

echo "[inspector-smoke] launching MCP Inspector against dist/server.js"
VAULT_PATH="$SMOKE_VAULT" npx -y @modelcontextprotocol/inspector --cli \
  node dist/server.js \
  || { echo "[inspector-smoke] inspector invocation failed"; exit 1; }

echo "[inspector-smoke] OK"
