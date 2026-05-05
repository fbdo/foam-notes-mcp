#!/usr/bin/env bash
set -euo pipefail

# Detect fs write / delete / mkdir patterns in src/ outside allowed modules.
# PLAN Decision #23: writes permitted only under ./.foam-mcp/ via cache.ts
# + sqlite-vec store.ts. Any other module writing to disk is a red flag.
#
# Broader than PLAN's narrow grep (which only mentioned fs.writeFile /
# fs.rm): we also catch appendFile / mkdir / rename / unlink / rm / rmSync
# and their *Sync twins. The invariant is the full "no writes outside
# cache.ts" architectural rule, not just two specific methods.

ALLOWED=(
  "src/cache.ts"
  "src/semantic/store.ts"
)

# Methods that write, rename, or delete on the filesystem. Covers both
# sync (`fs.writeFileSync`) and promise (`fs.promises.writeFile` /
# `fsp.writeFile`) usage. `rm\(` keeps `rmSync` and `rm(...)` distinct
# from property access like `foo.rm` (unlikely, but belt-and-braces).
PATTERNS=(
  "writeFile"
  "writeFileSync"
  "appendFile"
  "appendFileSync"
  "mkdir"
  "mkdirSync"
  "rename"
  "renameSync"
  "unlink"
  "unlinkSync"
  "rm\\("
  "rmSync"
)

PATTERN=$(IFS='|'; echo "${PATTERNS[*]}")

# grep -REn prefixes each match with `path:line:`. We filter out matches
# on the allowlisted paths by anchoring on that prefix.
FOUND=$(grep -REn --include='*.ts' "(fs|fsp|promises)\.(${PATTERN})" src/ \
  | grep -vE "^(${ALLOWED[0]}|${ALLOWED[1]}):" \
  || true)

if [[ -n "$FOUND" ]]; then
  echo "ERROR: fs write calls found outside the allowed modules:" >&2
  echo "$FOUND" >&2
  echo "" >&2
  echo "Allowed modules (write boundary per PLAN Decision #23):" >&2
  printf '  - %s\n' "${ALLOWED[@]}" >&2
  exit 1
fi

echo "write-boundary check: OK"
