#!/usr/bin/env tsx
/**
 * Synthetic vault generator for foam-notes-mcp tests + perf.
 *
 * Usage:
 *   tsx scripts/gen-synthetic-vault.ts --size 10 --out tests/fixtures/vault
 *   tsx scripts/gen-synthetic-vault.ts --size 500 --out /tmp/foam-500
 *   tsx scripts/gen-synthetic-vault.ts --size 5000 --out /tmp/foam-5k --seed 42
 */
import { mkdirSync, rmSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { argv, exit } from "node:process";

interface Args {
  size: number;
  out: string;
  seed: number;
}

const parseArgs = (): Args => {
  const a: Partial<Args> = { seed: 42 };
  for (let i = 2; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (!k || v === undefined) break;
    if (k === "--size") a.size = Number(v);
    else if (k === "--out") a.out = v;
    else if (k === "--seed") a.seed = Number(v);
  }
  if (a.size === undefined) a.size = 10;
  if (!a.out) {
    if (a.size === 10) a.out = "./tests/fixtures/vault";
    else {
      console.error("--out is required for size != 10");
      exit(1);
    }
  }
  return a as Args;
};

// xorshift32 PRNG (deterministic)
const makeRng = (seed: number) => {
  let x = seed | 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 1_000_000) / 1_000_000;
  };
};

const writeNote = (root: string, rel: string, body: string, mtime?: Date): void => {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf8");
  if (mtime) utimesSync(abs, mtime, mtime);
};

const fm = (obj: Record<string, unknown>): string => {
  const lines = ["---"];
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) lines.push(`${k}: [${v.map((x) => String(x)).join(", ")}]`);
    else lines.push(`${k}: ${JSON.stringify(v)}`);
  }
  lines.push("---", "");
  return lines.join("\n");
};

const gen10 = (root: string): void => {
  // 1. 00-Index-MOC.md
  writeNote(
    root,
    "00-Index-MOC.md",
    `${fm({ title: "Index", tags: ["index", "moc"] })}# Index

- [[note-a]]
- [[note-b]]
- [[202604160900-timestamped]]
- [[folder-link-target]]
`,
  );

  // 2. 02-Areas/note-a.md
  writeNote(
    root,
    "02-Areas/note-a.md",
    `${fm({ title: "Note A", tags: ["area", "alpha"] })}# Note A

## Section One

- [ ] unchecked task in note a
- A link to [[note-b]]

Inline tag: #alpha
`,
  );

  // 3. 02-Areas/note-b.md
  writeNote(
    root,
    "02-Areas/note-b.md",
    `${fm({ title: "Note B", tags: ["area"] })}# Note B

See [[note-a|alias for A]] and the missing [[placeholder-target]].
`,
  );

  // 4. 03-Resources/202604160900-timestamped.md
  writeNote(
    root,
    "03-Resources/202604160900-timestamped.md",
    `${fm({ title: "Timestamped Note" })}# Timestamped

Real link: [[note-a]]

\`\`\`
code fence with [[fake-link-in-code]] that must be ignored
\`\`\`
`,
  );

  // 5. 03-Resources/no-frontmatter.md
  writeNote(
    root,
    "03-Resources/no-frontmatter.md",
    `# No Frontmatter

- [ ] task without frontmatter

Inline #resource tag here.
`,
  );

  // 6. 01-Projects/project-x.md
  writeNote(
    root,
    "01-Projects/project-x.md",
    `${fm({ title: "Project X", tags: ["project"] })}# Project X

## Goals

- [ ] nested task under goals

## Tasks

- [ ] nested task under tasks
- [x] completed task (should be skipped)
`,
  );

  // 7. 01-Projects/project-y.md
  writeNote(
    root,
    "01-Projects/project-y.md",
    `${fm({ title: "Project Y", tags: ["project"] })}# Project Y

Links: [[project-x]] and [[02-Areas/note-a]].

Inline hierarchical tag: #project/secondary
`,
  );

  // 8. 04-Archives/archived.md
  writeNote(
    root,
    "04-Archives/archived.md",
    `${fm({ title: "Archived", tags: ["archive"] })}# Archived

- [ ] should be excluded by default ignore
`,
  );

  // 9. folder-link-target/index.md
  writeNote(
    root,
    "folder-link-target/index.md",
    `${fm({ title: "Folder Target" })}# Folder Target

Resolved via directory-link fallback.
`,
  );

  // 10a. root ambiguous
  writeNote(
    root,
    "202604170000-ambiguous.md",
    `${fm({ title: "Ambiguous" })}# Ambiguous (root)

First of two notes with ambiguous partial title.
`,
  );
  // 10b. nested ambiguous
  writeNote(
    root,
    "01-Projects/202604170001-ambiguous.md",
    `${fm({ title: "Ambiguous" })}# Ambiguous (project)

Second of two notes with ambiguous partial title.
`,
  );
};

const FOLDERS: [string, number][] = [
  ["03-Resources", 0.6],
  ["01-Projects", 0.8],
  ["02-Areas", 0.95],
  ["", 1.0], // root
];

const TAG_POOL = Array.from({ length: 50 }, (_, i) => `topic-${String(i).padStart(2, "0")}`);

const pickFolder = (r: number): string => {
  for (const [f, upper] of FOLDERS) if (r < upper) return f;
  return "";
};

type Rng = () => number;

const pickTags = (rng: Rng): string[] => {
  const tags: string[] = [];
  const tagCount = 1 + Math.floor(rng() * 4);
  for (let t = 0; t < tagCount; t++) {
    const tag = TAG_POOL[Math.floor(rng() * TAG_POOL.length)]!;
    if (!tags.includes(tag)) tags.push(tag);
  }
  return tags;
};

const buildSection = (
  rng: Rng,
  h: number,
  slug: string,
  nLinks: number,
  slugs: string[],
): string[] => {
  const out: string[] = [`## Section ${h + 1}`, ""];
  if (rng() < 0.2) out.push(`- [ ] task ${h} in ${slug}`, "");
  if (h === 0) {
    for (let l = 0; l < nLinks; l++) {
      const target = slugs[Math.floor(rng() * slugs.length)]!;
      out.push(`- See [[${target}]]`);
    }
    out.push("");
  }
  return out;
};

const buildNoteBody = (rng: Rng, title: string, slug: string, slugs: string[]): string => {
  const nH2 = 2 + Math.floor(rng() * 9); // 2..10
  const nLinks = 3 + Math.floor(rng() * 13); // 3..15
  const tags = pickTags(rng);
  const lines: string[] = [fm({ title, tags }), `# ${title}`, ""];
  for (let h = 0; h < nH2; h++) lines.push(...buildSection(rng, h, slug, nLinks, slugs));
  return lines.join("\n");
};

const genSynthetic = (root: string, size: number, seed: number): void => {
  const rng = makeRng(seed);
  const titles: string[] = [];
  const slugs: string[] = [];
  const paths: string[] = [];

  for (let i = 0; i < size; i++) {
    const folder = pickFolder(rng());
    const slug = `note-${String(i).padStart(5, "0")}`;
    slugs.push(slug);
    titles.push(`Note ${i}`);
    paths.push(folder ? `${folder}/${slug}.md` : `${slug}.md`);
  }

  const twoYearsMs = 2 * 365 * 24 * 3600 * 1000;
  const now = Date.now();

  for (let i = 0; i < size; i++) {
    const body = buildNoteBody(rng, titles[i]!, slugs[i]!, slugs);
    const mtime = new Date(now - Math.floor(rng() * twoYearsMs));
    writeNote(root, paths[i]!, body, mtime);
  }
};

const main = (): void => {
  const args = parseArgs();
  const out = resolve(args.out);
  if (existsSync(out)) rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  if (args.size === 10) gen10(out);
  else genSynthetic(out, args.size, args.seed);

  console.log(`Generated ${args.size}-note vault at ${out}`);
};

main();
