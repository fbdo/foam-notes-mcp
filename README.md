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

## License

[MIT](./LICENSE) © Fabio Lopes
