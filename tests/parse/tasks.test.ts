import { describe, it, expect } from "vitest";
import { extractTasks } from "../../src/parse/tasks.js";

describe("extractTasks", () => {
  it("extracts unchecked tasks (checked === false)", () => {
    const src = "# T\n\n- [ ] first\n- [ ] second\n";
    const tasks = extractTasks(src);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.checked).toBe(false);
    expect(tasks[1]?.checked).toBe(false);
    expect(tasks.map((t) => t.text)).toEqual(["first", "second"]);
  });

  it("distinguishes checked (true) vs unchecked (false)", () => {
    const src = `# T

- [ ] open task
- [x] done task
- [X] also done
`;
    const tasks = extractTasks(src);
    expect(tasks.map((t) => t.checked)).toEqual([false, true, true]);
  });

  it("skips regular list items (checked === null, indeterminate)", () => {
    const src = `- just a bullet
- [ ] a real task
- another bullet
`;
    const tasks = extractTasks(src);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.text).toBe("a real task");
  });

  it("attaches each task to its most recent ancestor heading", () => {
    const src = `# Top

- [ ] top-level

## Goals

- [ ] under goals

## Tasks

- [ ] under tasks
- [x] completed under tasks
`;
    const tasks = extractTasks(src);
    expect(tasks).toHaveLength(4);
    expect(tasks[0]?.heading).toBe("Top");
    expect(tasks[1]?.heading).toBe("Goals");
    expect(tasks[2]?.heading).toBe("Tasks");
    expect(tasks[3]?.heading).toBe("Tasks");
  });

  it("reports 1-indexed line numbers from mdast positions", () => {
    const src = `# T

- [ ] first line 3
- [ ] second line 4
`;
    const tasks = extractTasks(src);
    expect(tasks[0]?.line).toBe(3);
    expect(tasks[1]?.line).toBe(4);
  });

  it("omits heading when no heading precedes the task", () => {
    const src = `- [ ] lonely task\n`;
    const [t] = extractTasks(src);
    expect(t?.heading).toBeUndefined();
  });

  it("does not double-count nested sub-tasks inside their parent's text", () => {
    const src = `- [ ] parent task
  - [ ] child task
`;
    const tasks = extractTasks(src);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.text).toBe("parent task");
    expect(tasks[1]?.text).toBe("child task");
  });

  it("captures headings that include inline formatting as plain text", () => {
    const src = `## *Italic* Heading

- [ ] task
`;
    const [t] = extractTasks(src);
    expect(t?.heading).toBe("Italic Heading");
  });
});
