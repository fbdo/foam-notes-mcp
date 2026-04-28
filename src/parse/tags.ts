/**
 * Tag extraction: inline `#tag` tokens in the body, merged with frontmatter
 * `tags` and deduplicated (case-sensitive — see PLAN decision #2).
 *
 * Hardened to skip:
 *   - fenced code blocks (```...``` or ~~~...~~~)
 *   - inline code spans (`...`)
 *   - HTML comments (<!-- ... -->)
 *   - ATX heading markers at the start of a line (`# heading`, `## heading`, …)
 *
 * This module is a leaf (parse/): it must not import from any feature layer.
 */

/**
 * Characters allowed inside a tag body. Foam/Obsidian accept
 * alphanumerics, `_`, `-`, and `/` for hierarchical tags (`#project/ui`).
 * We match at least one leading letter or digit after `#` so pure `#-` is
 * rejected, and we require the `#` to not be immediately preceded by a word
 * character (so `abc#foo` — e.g. URL fragments inside word boundaries — is
 * skipped). A leading digit is allowed (Foam accepts it).
 */
const TAG_PATTERN = /(?<![\w#])#([A-Za-z0-9][\w/-]*)/g;

const FENCED_CODE_PATTERN = /(^|\n)(?:```|~~~)[^\n]*\n[\s\S]*?(?:\n(?:```|~~~)|$)/g;
const INLINE_CODE_PATTERN = /`[^`\n]*`/g;
const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/g;
// Strip ATX heading markers at line start (up to 6 `#`, followed by a space):
// otherwise `## Heading` would register `#` as a tag starter.
const ATX_HEADING_PATTERN = /(^|\n)#{1,6}(?=\s)/g;

/** Replace matches with same-length runs of spaces, preserving line/column. */
const blankOut = (source: string, pattern: RegExp): string =>
  source.replace(pattern, (match) => match.replace(/[^\n]/g, " "));

/**
 * Extract inline body tags + frontmatter tags, merged and deduplicated
 * (case-sensitive).
 *
 * Frontmatter `tags` accepts:
 *   - an array of strings
 *   - a single string (space/comma separated — Obsidian convention)
 *
 * Any other shape is ignored silently (not thrown) to match the best-effort
 * ethos of a read-only vault indexer.
 */
export const extractTags = (source: string, frontmatter: Record<string, unknown>): string[] => {
  const bodyTags = extractInlineTags(source);
  const fmTags = normalizeFrontmatterTags(frontmatter.tags);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of [...fmTags, ...bodyTags]) {
    if (!seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out;
};

const extractInlineTags = (source: string): string[] => {
  let scrubbed = blankOut(source, FENCED_CODE_PATTERN);
  scrubbed = blankOut(scrubbed, HTML_COMMENT_PATTERN);
  scrubbed = blankOut(scrubbed, INLINE_CODE_PATTERN);
  scrubbed = blankOut(scrubbed, ATX_HEADING_PATTERN);

  const found: string[] = [];
  for (const match of scrubbed.matchAll(TAG_PATTERN)) {
    const name = match[1];
    if (name !== undefined) found.push(name);
  }
  return found;
};

const normalizeFrontmatterTags = (raw: unknown): string[] => {
  if (Array.isArray(raw)) {
    return raw.filter((t): t is string => typeof t === "string" && t.length > 0);
  }
  if (typeof raw === "string") {
    // Accept Obsidian-style space- OR comma-separated inline list.
    return raw
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  }
  return [];
};
