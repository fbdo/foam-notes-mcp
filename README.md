# foam-notes-mcp

Local-first MCP server for Foam-style Markdown vaults. Provides keyword, graph,
semantic, and hybrid search over wikilinks, backlinks, frontmatter, tags, and
tasks.

**Status**: in development.

See [`docs/PLAN.md`](./docs/PLAN.md) for the authoritative plan, tool
inventory, architecture, and waves checklist. Full user-facing README lands in
Wave 7.

## Platform

macOS and Linux only (Windows rejected at startup).

## Dependency policy

- Production-dep majors are blocked in Dependabot; they require a manual PR
  that cross-references `docs/PLAN.md` Locked Decisions.
- Exact-pinned packages (`@huggingface/transformers`, `sqlite-vec`,
  `remark-wiki-link`, `remark-gfm`) are ignored entirely and bumped only
  via a manual PLAN update.
- Dev-dep majors are allowed except for `@types/node` and `typescript`,
  which are pinned to the current CI Node matrix.
- PRs are grouped (vitest family, eslint family, remark family, graphology
  family, `@types/*`) to keep the queue small.
- Schedule: weekly, Monday.

## Security scanning

We use [grype](https://github.com/anchore/grype) to scan for known
vulnerabilities in our dependency tree. The scan runs in CI on every
pull request and push to `main`.

**Local usage:**

```bash
npm run quality:security
```

This runs `grype dir:. --only-fixed --fail-on high`, failing on any
HIGH or CRITICAL finding that has a fix available.

**Why CI-only (no pre-commit / pre-push hook):** grype scans take ~20s
on a warm DB and much longer on a cold one. Running them on every commit
or push would slow development noticeably and train contributors to
bypass hooks with `--no-verify`. CI is the right gate — a single
centralised scan, cached DB, consistent environment, evaluated at merge
time before anything lands on `main`.

The manual `npm run quality:security` command is available as an escape
hatch when you want to verify a dependency bump before pushing.

## License

[MIT](./LICENSE) © Fabio Lopes
