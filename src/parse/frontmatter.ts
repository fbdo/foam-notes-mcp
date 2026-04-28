/**
 * Frontmatter extraction.
 *
 * Uses `gray-matter` (already a project dependency — see PLAN decision #4
 * notes about the shared remark pipeline). `gray-matter` is a fast, robust
 * YAML parser that handles the common edge cases (missing frontmatter,
 * trailing whitespace, BOM, etc.) without pulling the mdast in.
 *
 * This module is a leaf (parse/): it must not import from any feature layer.
 */

import matter from "gray-matter";

/** Typed return shape: frontmatter data + body content with delimiter stripped. */
export interface ParsedFrontmatter {
  readonly data: Record<string, unknown>;
  readonly content: string;
}

/**
 * Extract frontmatter from a markdown source string.
 *
 * Returns an empty `data` object when the source has no frontmatter; returns
 * the whole source as `content` in that case. Parsing errors (malformed YAML)
 * surface as thrown errors from `gray-matter`; callers should catch and
 * decide whether to treat the note as un-parseable or fall back to no
 * frontmatter.
 */
export const parseFrontmatter = (source: string): ParsedFrontmatter => {
  const parsed = matter(source);
  // `gray-matter` returns `data: object` typed loosely; narrow it once here.
  const data = (parsed.data ?? {}) as Record<string, unknown>;
  return {
    data,
    content: parsed.content,
  };
};
