/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // === LAYER RULES (foam-notes-mcp) ===

    // parse/ and resolver.ts are leaf feature modules — they must not import from any sibling feature layer.
    {
      name: "parse-cannot-depend-on-features",
      comment:
        "parse/ is a leaf layer; must not import from keyword/, graph/, semantic/, hybrid/, tools/, resources/, or watcher",
      severity: "error",
      from: { path: "^src/parse/" },
      to: {
        path: "^src/(keyword|graph|semantic|hybrid|tools|resources|watcher)",
      },
    },
    {
      name: "resolver-cannot-depend-on-features",
      comment: "resolver.ts must not import from any sibling feature layer",
      severity: "error",
      from: { path: "^src/resolver\\.ts$" },
      to: {
        path: "^src/(keyword|graph|semantic|hybrid|tools|resources|watcher)",
      },
    },

    // keyword/, graph/, semantic/ may each import from parse/, resolver.ts, cache.ts, config.ts
    // but NOT from each other.
    {
      name: "keyword-cannot-depend-on-siblings",
      comment: "keyword/ must not import from graph/, semantic/, hybrid/, tools/, resources/",
      severity: "error",
      from: { path: "^src/keyword/" },
      to: { path: "^src/(graph|semantic|hybrid|tools|resources|watcher)" },
    },
    {
      name: "graph-cannot-depend-on-siblings",
      comment: "graph/ must not import from keyword/, semantic/, hybrid/, tools/, resources/",
      severity: "error",
      from: { path: "^src/graph/" },
      to: { path: "^src/(keyword|semantic|hybrid|tools|resources|watcher)" },
    },
    {
      name: "semantic-cannot-depend-on-siblings",
      comment: "semantic/ must not import from keyword/, graph/, hybrid/, tools/, resources/",
      severity: "error",
      from: { path: "^src/semantic/" },
      to: { path: "^src/(keyword|graph|hybrid|tools|resources|watcher)" },
    },

    // hybrid/ may import from keyword/, graph/, semantic/ — but not from tools/, resources/, or server.
    {
      name: "hybrid-cannot-depend-on-upper",
      comment: "hybrid/ must not import from tools/, resources/, or server.ts",
      severity: "error",
      from: { path: "^src/hybrid/" },
      to: { path: "^src/(tools|resources|watcher)" },
    },

    // server.ts is top — nothing may import from it.
    {
      name: "nothing-depends-on-server",
      comment: "server.ts is the entrypoint; must not be imported",
      severity: "error",
      from: { path: "^src/(?!server\\.ts$)" },
      to: { path: "^src/server\\.ts$" },
    },

    // === GENERAL RULES ===
    {
      name: "no-circular",
      comment: "No circular dependencies",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-orphans",
      comment: "All modules should be reachable from the server entry (types-only excluded)",
      severity: "warn",
      from: {
        orphan: true,
        pathNot: [
          "(^|/)\\.[^/]+",
          "\\.test\\.ts$",
          "\\.spec\\.ts$",
          "src/server\\.ts$",
          "\\.d\\.ts$",
          "(^|/)types?\\.ts$",
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
      mainFields: ["module", "main", "types", "typings"],
    },
  },
};
