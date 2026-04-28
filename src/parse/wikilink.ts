/**
 * Wikilink extraction.
 *
 * Handles all four syntaxes:
 *   [[target]]
 *   [[target|alias]]
 *   [[target#heading]]
 *   [[target#heading|alias]]
 *
 * Hardened to skip:
 *   - fenced code blocks (```...``` / ~~~...~~~)
 *   - inline code spans (`...`)
 *   - HTML comments (<!-- ... -->)
 *
 * `line` is 1-indexed, `column` is 1-indexed (mdast / unified convention),
 * both point to the `[` opening bracket of the wikilink.
 *
 * This module is a leaf (parse/): it must not import from any feature layer.
 */

export interface Wikilink {
  readonly target: string;
  readonly heading?: string;
  readonly alias?: string;
  readonly line: number;
  readonly column: number;
}

/**
 * Matches `[[...]]`. The inner body is captured greedily up to the closing
 * `]]`; we parse `target`, `heading`, and `alias` from the body in a second
 * step so the regex stays readable and permissive (and so malformed links
 * don't silently trigger catastrophic backtracking). We reject newlines
 * inside the body to avoid chewing across paragraphs.
 */
const WIKILINK_PATTERN = /\[\[([^\]\n]+?)\]\]/g;

const FENCED_CODE_PATTERN = /(^|\n)(?:```|~~~)[^\n]*\n[\s\S]*?(?:\n(?:```|~~~)|$)/g;
const INLINE_CODE_PATTERN = /`[^`\n]*`/g;
const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/g;

/** Replace matches with same-length runs of spaces, preserving line/column. */
const blankOut = (source: string, pattern: RegExp): string =>
  source.replace(pattern, (match) => match.replace(/[^\n]/g, " "));

/**
 * Extract all wikilinks in a source string. Empty or whitespace-only targets
 * are dropped. Duplicate links are preserved (each occurrence has its own
 * line/column).
 */
export const extractWikilinks = (source: string): Wikilink[] => {
  let scrubbed = blankOut(source, FENCED_CODE_PATTERN);
  scrubbed = blankOut(scrubbed, HTML_COMMENT_PATTERN);
  scrubbed = blankOut(scrubbed, INLINE_CODE_PATTERN);

  const out: Wikilink[] = [];
  for (const match of scrubbed.matchAll(WIKILINK_PATTERN)) {
    const body = match[1];
    const index = match.index;
    if (body === undefined || index === undefined) continue;
    const parsed = parseWikilinkBody(body);
    if (!parsed) continue;
    const { line, column } = offsetToLineColumn(scrubbed, index);
    out.push({ ...parsed, line, column });
  }
  return out;
};

/**
 * Parse the interior of `[[ ... ]]` into target / heading? / alias?.
 * Returns `null` if the target is empty/whitespace-only.
 */
const parseWikilinkBody = (body: string): Omit<Wikilink, "line" | "column"> | null => {
  // Alias first: `target[#heading]|alias` — alias can contain `#`, so we
  // split on the first `|` only.
  const pipeIdx = body.indexOf("|");
  let left = body;
  let alias: string | undefined;
  if (pipeIdx >= 0) {
    left = body.slice(0, pipeIdx);
    alias = body.slice(pipeIdx + 1).trim();
    if (alias === "") alias = undefined;
  }

  const hashIdx = left.indexOf("#");
  let targetRaw: string;
  let headingRaw: string | undefined;
  if (hashIdx >= 0) {
    targetRaw = left.slice(0, hashIdx);
    headingRaw = left.slice(hashIdx + 1);
  } else {
    targetRaw = left;
  }

  const target = targetRaw.trim();
  if (target === "") return null;

  const heading = headingRaw?.trim();
  const result: Omit<Wikilink, "line" | "column"> = {
    target,
    ...(heading && heading.length > 0 ? { heading } : {}),
    ...(alias !== undefined ? { alias } : {}),
  };
  return result;
};

/**
 * Convert a 0-based character offset into (line, column) 1-indexed.
 * Columns are counted in code units (not grapheme clusters) for speed —
 * this matches `unified`'s position semantics for ASCII markdown, which is
 * what vault notes overwhelmingly are.
 */
const offsetToLineColumn = (source: string, offset: number): { line: number; column: number } => {
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < offset; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) {
      line += 1;
      lastNewline = i;
    }
  }
  const column = offset - lastNewline;
  return { line, column };
};
