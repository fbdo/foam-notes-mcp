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
# `fsp.writeFile`) usage, AND bare named-import calls (e.g. an
# `import { mkdirSync } from "node:fs"` followed by `mkdirSync(...)`).
# The previous revision of this script was prefix-anchored to
# `(fs|fsp|promises)\.` and missed the bare-import form — which in turn
# let `mkdirSync` leak into `src/server.ts` before this Wave 6 fix.
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
  "rm"
  "rmSync"
)

PATTERN=$(IFS='|'; echo "${PATTERNS[*]}")

# Match a word-boundary'd method name followed by optional whitespace and
# an open paren. This catches both `fs.writeFile(` / `fsp.writeFile(` and
# the bare `writeFile(` form produced by a named import. `\b` on BSD grep
# (-E) treats non-word characters — including `.` — as boundaries, so the
# dotted-access case still matches. Using `\b` rather than explicit
# character classes keeps the regex compact; it has been verified to
# reject intra-identifier substrings (e.g. `mkdirSyncResult(`) on both
# BSD and GNU grep.
GREP_PATTERN="\\b(${PATTERN})\\s*\\("

# grep -REn prefixes each match with `path:line:`. We filter out matches
# on the allowlisted paths by anchoring on that prefix. We also drop
# comment lines (JSDoc `*` continuations and `//` line comments) so that
# documentation mentioning one of these method names doesn't trip the
# boundary check.
FOUND=$(grep -REn --include='*.ts' "${GREP_PATTERN}" src/ \
  | grep -vE "^(${ALLOWED[0]}|${ALLOWED[1]}):" \
  | grep -vE ":[[:space:]]*(\\*|//)" \
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
