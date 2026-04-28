/**
 * Task extraction.
 *
 * Walks mdast `listItem` nodes with `checked: boolean` (GFM task syntax).
 * Attaches each task to the most recent ancestor ATX heading so callers can
 * display contextual `heading` alongside each task.
 *
 * Semantics (per the task brief):
 *   - `checked === true`   → completed
 *   - `checked === false`  → unchecked (this is what `find_unchecked_tasks`
 *                           looks for)
 *   - `checked === null`   → not a task at all; skipped
 *
 * `line` is 1-indexed (mdast position convention).
 *
 * This module is a leaf (parse/): it must not import from any feature layer.
 */

import type { ListItem, Node, Nodes, Parent, Root } from "mdast";
import { parseMarkdown } from "./markdown.js";

export interface Task {
  readonly text: string;
  readonly checked: boolean;
  readonly heading?: string;
  readonly line: number;
}

/**
 * Extract tasks from a raw markdown source string. Uses the shared remark
 * processor so frontmatter and wikilinks are recognized correctly.
 */
export const extractTasks = (source: string): Task[] => {
  const tree = parseMarkdown(source);
  return collectTasks(tree);
};

/** Walk an already-parsed mdast root and collect tasks. */
export const collectTasks = (tree: Root): Task[] => {
  const out: Task[] = [];
  let currentHeading: string | undefined;
  walk(tree, (node) => {
    if (node.type === "heading") {
      currentHeading = nodeToPlainText(node);
      return;
    }
    if (node.type === "listItem" && typeof (node as ListItem).checked === "boolean") {
      const li = node as ListItem;
      // `checked` is narrowed to boolean by the guard above.
      const checked = li.checked === true;
      const text = listItemTextWithoutNestedTasks(li);
      const line = li.position?.start.line ?? 0;
      const task: Task = {
        text,
        checked,
        ...(currentHeading !== undefined ? { heading: currentHeading } : {}),
        line,
      };
      out.push(task);
    }
  });
  return out;
};

/** Depth-first walk over mdast nodes, invoking `visit` on every node. */
const walk = (node: Node, visit: (n: Nodes) => void): void => {
  visit(node as Nodes);
  if ("children" in node && Array.isArray((node as Parent).children)) {
    for (const child of (node as Parent).children) {
      walk(child, visit);
    }
  }
};

/**
 * Collect plain text from a heading or paragraph-like node (text, inlineCode,
 * emphasis, strong, link labels, wikiLink aliases/values). Mirrors what
 * `mdast-util-to-string` would do but without the transitive dep.
 */
const nodeToPlainText = (node: Nodes): string => {
  if ("value" in node && typeof node.value === "string") return node.value;
  const parts: string[] = [];
  if ("children" in node && Array.isArray((node as Parent).children)) {
    for (const child of (node as Parent).children) {
      parts.push(nodeToPlainText(child as Nodes));
    }
  }
  // `remark-wiki-link` emits `wikiLink` nodes whose human-readable value lives
  // on `.data.alias` (string) or can be reconstructed from `.value`. If the
  // child walk above returned nothing, fall through to `(node as any).data`.
  if (parts.length === 0) {
    const withData = node as Nodes & {
      data?: { alias?: unknown; permalink?: unknown };
    };
    if (withData.data && typeof withData.data.alias === "string") {
      return withData.data.alias;
    }
  }
  return parts.join("");
};

const listItemTextWithoutNestedTasks = (li: ListItem): string => {
  const parts: string[] = [];
  for (const child of li.children) {
    if (child.type === "list") continue;
    parts.push(nodeToPlainText(child as Nodes));
  }
  return parts.join("").trim();
};
