/**
 * Shared markdown parsing pipeline.
 *
 * Uses `unified` + `remark-parse` + `remark-gfm` + `remark-frontmatter`
 * + `remark-wiki-link` (see PLAN decision #4). The processor is built once
 * and memoized: every caller re-uses the same configured instance.
 *
 * `remark-gfm` is required to populate `checked: boolean` on task list
 * items — without it the mdast reports every `- [ ] foo` as a plain bullet
 * and `checked` stays `null`. `remark-gfm@4.0.1` is pinned (latest stable,
 * ESM-native).
 *
 * `remark-wiki-link` is pinned to `2.0.1` (latest stable at time of writing,
 * ESM-native, no breaking changes vs 2.0.0). It adds a `wikiLink` node type
 * to the mdast we return, but we do NOT rely on that node for extraction —
 * `src/parse/wikilink.ts` uses a hardened regex instead for precise
 * line/column tracking. Having the plugin in the pipeline keeps the mdast
 * faithful to the source so downstream consumers don't see wikilinks
 * misinterpreted as raw text with stray `[[` delimiters.
 */

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";
import wikiLinkPlugin from "remark-wiki-link";
import type { Root } from "mdast";

// The unified `Processor` generic signature changes across versions; we keep
// our own minimal shape so tests and consumers can reason about it without
// pulling transitive type machinery into their own files.
interface MarkdownProcessor {
  parse: (source: string) => Root;
}

let cachedProcessor: MarkdownProcessor | undefined;

/**
 * Return the singleton unified processor configured for Foam-style markdown.
 *
 * Repeated calls return the same instance.
 */
export const getProcessor = (): MarkdownProcessor => {
  if (cachedProcessor) return cachedProcessor;
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ["yaml"])
    .use(wikiLinkPlugin);
  cachedProcessor = {
    parse: (source: string): Root => processor.parse(source) as Root,
  };
  return cachedProcessor;
};

/** Parse a markdown source string into an mdast `Root` node. */
export const parseMarkdown = (source: string): Root => getProcessor().parse(source);
