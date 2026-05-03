/**
 * Semantic chunker: split a markdown note into retrievable, embedding-ready
 * chunks.
 *
 * Algorithm (PLAN Wave 4A: "chunker (heading split, window, overlap, title
 * prepend, wikilink substitution)"):
 *
 *  1. Parse the source via the shared unified pipeline (`parseMarkdown`) so
 *     frontmatter and wikilinks are already accounted for.
 *  2. Split the mdast into "sections" at heading boundaries. A section is a
 *     heading node plus every following node until the next heading at
 *     equal-or-shallower depth. Content before the first heading (if any)
 *     forms a leading section with `heading: null`.
 *  3. Within a section, if the body is short (≤ `windowTokens`) emit one
 *     chunk; otherwise slide a `windowTokens`-wide window with
 *     `overlapTokens` of overlap between consecutive windows.
 *  4. Wikilinks in the chunk text are substituted with the resolved note's
 *     display title (or basename) to improve embedding quality. If no
 *     `vaultIndex` is supplied, wikilinks pass through verbatim.
 *  5. If `title` is provided, it is prepended to each chunk's `text` (for
 *     embedding) but NOT to `rawText` (for display).
 *  6. Chunk ids are deterministic: `sha256(notePath + ":" + chunkIndex)`
 *     truncated to 16 hex characters — stable across rebuilds provided the
 *     note path and chunk ordering don't change.
 *
 * Token counting: v0.1 uses whitespace-delimited word counts
 * (`text.split(/\s+/).filter(Boolean).length`). This is a deliberate choice
 * to avoid pulling a tokenizer dependency. The true embedder token count
 * will be higher (~1.3x) for most English text; the window/overlap numbers
 * here are intentional upper bounds that leave headroom before the
 * all-MiniLM-L6-v2 512-token hard limit.
 *
 * Line tracking: `startLine` / `endLine` come from mdast position data
 * (1-indexed, inclusive). When position data is missing (rare, typically
 * only for synthesized nodes) we fall back to line 1 and count newlines.
 *
 * Layer rules (enforced by dependency-cruiser):
 *   - MAY import from `parse/`, `resolver.ts`, `path-util.ts`, `errors.ts`,
 *     npm deps, node built-ins.
 *   - MUST NOT import from `keyword/`, `graph/`, `hybrid/`, `tools/`,
 *     `resources/`, `server.ts`.
 */

import { createHash } from "node:crypto";
import { basename } from "node:path";

import type { Heading, Nodes, Parent, Root, RootContent } from "mdast";

import { parseMarkdown } from "./../parse/markdown.js";
import { resolveWikilink, type VaultIndex } from "./../resolver.js";

/** Default window size (tokens) per PLAN Wave 4A. */
export const DEFAULT_WINDOW_TOKENS = 200 as const;

/** Default overlap size (tokens) between consecutive windows per PLAN Wave 4A. */
export const DEFAULT_OVERLAP_TOKENS = 40 as const;

/** A single retrievable chunk produced by {@link chunkNote}. */
export interface Chunk {
  /** Stable id: 16 hex chars of `sha256(notePath + ":" + chunkIndex)`. */
  readonly id: string;
  /** Absolute path of the source note. */
  readonly notePath: string;
  /** 0-based ordinal within the note. */
  readonly chunkIndex: number;
  /** Nearest ancestor heading text at chunk start; `null` when before the first heading. */
  readonly heading: string | null;
  /** Chunk content to embed (title prepended when `options.title` is provided). */
  readonly text: string;
  /** Chunk content WITHOUT the title prefix — for display/diagnostics. */
  readonly rawText: string;
  /** 1-indexed line of the first line contained in this chunk. */
  readonly startLine: number;
  /** 1-indexed line of the last line contained in this chunk, inclusive. */
  readonly endLine: number;
}

/** Options for {@link chunkNote}. */
export interface ChunkOptions {
  /** Maximum tokens per chunk. Default {@link DEFAULT_WINDOW_TOKENS}. */
  readonly windowTokens?: number;
  /** Overlap tokens between consecutive windows in a long section. Default {@link DEFAULT_OVERLAP_TOKENS}. */
  readonly overlapTokens?: number;
  /** Optional display title prepended to each chunk's `text` (but not `rawText`). */
  readonly title?: string | null;
  /** Optional vault index used to substitute wikilinks with resolved titles. */
  readonly vaultIndex?: VaultIndex;
}

/**
 * Split a note into embedding-ready chunks.
 *
 * Returns an empty array for an empty (or whitespace-only) source.
 */
export const chunkNote = (notePath: string, source: string, options?: ChunkOptions): Chunk[] => {
  const trimmed = source.trim();
  if (trimmed === "") return [];

  const windowTokens = options?.windowTokens ?? DEFAULT_WINDOW_TOKENS;
  const overlapTokens = options?.overlapTokens ?? DEFAULT_OVERLAP_TOKENS;
  if (windowTokens <= 0) {
    throw new RangeError("chunkNote: windowTokens must be > 0");
  }
  if (overlapTokens < 0 || overlapTokens >= windowTokens) {
    throw new RangeError("chunkNote: overlapTokens must be in [0, windowTokens)");
  }

  const tree = parseMarkdown(source);
  const lines = source.split("\n");
  const sections = splitIntoSections(tree);

  const chunks: Chunk[] = [];
  for (const section of sections) {
    const windows = buildSectionWindows(section, lines, windowTokens, overlapTokens);
    for (const window of windows) {
      const chunkIndex = chunks.length;
      const rawBody = window.text;
      const substituted = options?.vaultIndex
        ? substituteWikilinks(rawBody, options.vaultIndex)
        : rawBody;
      const text = prependTitle(substituted, options?.title);
      chunks.push({
        id: chunkId(notePath, chunkIndex),
        notePath,
        chunkIndex,
        heading: section.heading,
        text,
        rawText: substituted,
        startLine: window.startLine,
        endLine: window.endLine,
      });
    }
  }
  return chunks;
};

// --- section splitting ---

interface Section {
  /** Heading text at the section's start; `null` for content before any heading. */
  readonly heading: string | null;
  /** Inclusive line range (1-indexed) of the section in the source. */
  readonly startLine: number;
  readonly endLine: number;
}

/**
 * Group top-level mdast children into sections. A section starts at a
 * heading (or at the top of the file for pre-heading content) and extends
 * until the next heading at the SAME or SHALLOWER depth. Deeper headings
 * (subsections) stay inside their parent section — we want semantically
 * coherent chunks, not micro-fragments.
 *
 * Example:
 *   # A               <- section A starts, heading = "A"
 *   body of A
 *   ## A.1            <- still inside A (deeper)
 *   body of A.1
 *   # B               <- section A ends at the previous line; B starts
 *   body of B
 */
interface Entry {
  readonly node: RootContent;
  readonly startLine: number;
  readonly endLine: number;
}

const toEntry = (node: RootContent): Entry => {
  const pos = node.position;
  const startLine = pos?.start.line ?? 1;
  const endLine = pos?.end.line ?? startLine;
  return { node, startLine, endLine };
};

/**
 * Find the index of the next heading at depth ≤ `openDepth`, starting from
 * `from`. Returns `entries.length` when no such heading exists.
 */
const findSectionEnd = (entries: readonly Entry[], from: number, openDepth: number): number => {
  for (let i = from; i < entries.length; i++) {
    const e = entries[i];
    if (e === undefined) continue;
    if (e.node.type === "heading" && (e.node as Heading).depth <= openDepth) return i;
  }
  return entries.length;
};

/** Emit a leading section for pre-heading content if any, returning the cursor. */
const emitLeadingSection = (entries: readonly Entry[], sections: Section[]): number => {
  const firstHeadingIdx = entries.findIndex((e) => e.node.type === "heading");
  // No heading at all, or heading is the very first entry → no leading section.
  if (firstHeadingIdx === 0) return 0;
  const end = firstHeadingIdx === -1 ? entries.length : firstHeadingIdx;
  const first = entries[0];
  const last = entries[end - 1];
  if (first === undefined || last === undefined) return end;
  sections.push({ heading: null, startLine: first.startLine, endLine: last.endLine });
  return end;
};

const splitIntoSections = (tree: Root): Section[] => {
  const children = tree.children;
  if (children.length === 0) return [];
  const entries: Entry[] = children.map(toEntry);

  const sections: Section[] = [];
  let cursor = emitLeadingSection(entries, sections);

  while (cursor < entries.length) {
    const openEntry = entries[cursor];
    if (openEntry === undefined || openEntry.node.type !== "heading") {
      // Defensive: after `emitLeadingSection`, `cursor` should be at a heading.
      cursor += 1;
      continue;
    }
    const heading = openEntry.node as Heading;
    const end = findSectionEnd(entries, cursor + 1, heading.depth);
    const last = entries[end - 1];
    sections.push({
      heading: headingText(heading),
      startLine: openEntry.startLine,
      endLine: last?.endLine ?? openEntry.endLine,
    });
    cursor = end;
  }

  return sections;
};

/**
 * Produce one or more chunk windows for a section. Short sections (≤ window)
 * emit a single window; longer sections emit overlapping windows.
 *
 * Line numbers in the returned windows are inferred from token line offsets
 * so that the first and last token of each window translate back to source
 * lines accurately.
 */
const buildSectionWindows = (
  section: Section,
  allLines: readonly string[],
  windowTokens: number,
  overlapTokens: number,
): { text: string; startLine: number; endLine: number }[] => {
  // `allLines` is 0-indexed; section lines are 1-indexed inclusive.
  const startIdx = Math.max(0, section.startLine - 1);
  const endIdx = Math.min(allLines.length - 1, section.endLine - 1);
  const slice = allLines.slice(startIdx, endIdx + 1);
  const body = slice.join("\n").trim();
  if (body === "") return [];

  const tokens = tokenize(slice);
  if (tokens.length <= windowTokens) {
    return [
      {
        text: body,
        startLine: section.startLine,
        endLine: section.endLine,
      },
    ];
  }

  const step = windowTokens - overlapTokens;
  const windows: { text: string; startLine: number; endLine: number }[] = [];
  for (let i = 0; i < tokens.length; i += step) {
    const end = Math.min(i + windowTokens, tokens.length);
    const tokenSlice = tokens.slice(i, end);
    const windowText = tokenSlice.map((t) => t.value).join(" ");
    const firstToken = tokenSlice[0];
    const lastToken = tokenSlice[tokenSlice.length - 1];
    const windowStartLine =
      firstToken !== undefined ? section.startLine + firstToken.lineOffset : section.startLine;
    const windowEndLine =
      lastToken !== undefined ? section.startLine + lastToken.lineOffset : section.endLine;
    windows.push({ text: windowText, startLine: windowStartLine, endLine: windowEndLine });
    if (end === tokens.length) break;
  }
  return windows;
};

/** A whitespace-delimited token with its 0-based line offset inside the section slice. */
interface Token {
  readonly value: string;
  readonly lineOffset: number;
}

/**
 * Split a per-line slice into whitespace-delimited tokens, tagging each with
 * the 0-based line inside the slice where it begins. Purely whitespace
 * tokens are dropped.
 */
const tokenize = (lines: readonly string[]): Token[] => {
  const out: Token[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const pieces = line.split(/\s+/).filter((s) => s.length > 0);
    for (const p of pieces) {
      out.push({ value: p, lineOffset: i });
    }
  }
  return out;
};

// --- text transformations ---

/** Prepend the note title to a chunk body for embedding. */
const prependTitle = (body: string, title: string | null | undefined): string => {
  if (title === undefined || title === null || title === "") return body;
  return `${title}\n\n${body}`;
};

/**
 * Replace `[[target]]` and `[[target|alias]]` occurrences with the resolved
 * note's display name (basename without `.md`). Unresolved wikilinks are
 * left verbatim so embedders still see something literal to learn from.
 *
 * We don't attempt to read frontmatter off the resolved file here (that
 * would require I/O and a vault-wide title lookup). The basename of the
 * resolved path is a cheap and reliable fallback that still beats leaving
 * the raw `[[slug]]` in the embedding stream.
 */
const substituteWikilinks = (text: string, vaultIndex: VaultIndex): string => {
  // Linear-time; the body excludes `]` and `\n`.
  // eslint-disable-next-line sonarjs/slow-regex
  return text.replace(/\[\[([^\]\n]+?)\]\]/g, (match, body: string) => {
    const target = parseWikilinkTarget(body);
    if (target === "") return match;
    const result = resolveWikilink(target, vaultIndex);
    const [firstCandidate] = result.candidates;
    if (result.confidence === "none" || firstCandidate === undefined) return match;
    const base = basename(firstCandidate);
    return base.toLowerCase().endsWith(".md") ? base.slice(0, -3) : base;
  });
};

/** Extract just the `target` from a wikilink body, dropping `#heading` and `|alias`. */
const parseWikilinkTarget = (body: string): string => {
  const pipeIdx = body.indexOf("|");
  const left = pipeIdx >= 0 ? body.slice(0, pipeIdx) : body;
  const hashIdx = left.indexOf("#");
  const targetRaw = hashIdx >= 0 ? left.slice(0, hashIdx) : left;
  return targetRaw.trim();
};

// --- id + helpers ---

/** Compute the chunk id: 16 hex chars of sha256(notePath + ":" + chunkIndex). */
const chunkId = (notePath: string, chunkIndex: number): string =>
  createHash("sha256").update(`${notePath}:${chunkIndex.toString()}`).digest("hex").slice(0, 16);

const headingText = (node: Heading): string => nodeToPlainText(node);

/** Flatten an mdast node to plain text (mirrors logic in `src/parse/tasks.ts`). */
const nodeToPlainText = (node: Nodes): string => {
  if ("value" in node && typeof node.value === "string") return node.value;
  const parts: string[] = [];
  if ("children" in node && Array.isArray((node as Parent).children)) {
    for (const child of (node as Parent).children) {
      parts.push(nodeToPlainText(child as Nodes));
    }
  }
  if (parts.length === 0) {
    const withData = node as Nodes & { data?: { alias?: unknown } };
    if (withData.data && typeof withData.data.alias === "string") {
      return withData.data.alias;
    }
  }
  return parts.join("");
};
