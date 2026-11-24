// @vitest-environment jsdom
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_QUOTE_DEPTH, renderMarkdown } from "../src/page/markdown.js";
import { builder } from "../src/ui/dom.js";

const render = (source: string) => {
  const root = document.createElement("div");
  root.append(...renderMarkdown(builder(document), source));
  return root;
};

const depthOf = (root: Element): number => {
  let deepest = 0;
  for (const quote of root.querySelectorAll("blockquote")) {
    let depth = 0;
    for (let node: Element | null = quote; node && node !== root; node = node.parentElement) if (node.tagName === "BLOCKQUOTE") depth += 1;
    deepest = Math.max(deepest, depth);
  }
  return deepest;
};

describe("quotes in saved replies", () => {
  it("nest at most eight deep; deeper levels read as text, and thousands of levels render at once", () => {
    for (const levels of [2_000, 20_000]) {
      const started = performance.now();
      const root = render(`${">".repeat(levels)} hi`);
      expect(performance.now() - started).toBeLessThan(500);
      expect(depthOf(root)).toBe(MAX_QUOTE_DEPTH);
      expect(root.textContent).toBe(`${">".repeat(levels - MAX_QUOTE_DEPTH)} hi`);
    }
    expect(MAX_QUOTE_DEPTH).toBe(8);
  }, 30_000);

  it("still nest as written up to that depth", () => {
    const root = render(["> one", "> > two", "> > > three"].join("\n"));
    expect(depthOf(root)).toBe(3);
    expect(root.querySelector("blockquote blockquote blockquote")!.textContent).toBe("three");
  });
});

describe("tables in saved replies", () => {
  it("split cells at pipes without a backslash before them, as before", () => {
    const root = render(["| a \\| b | c |", "| --- | --- |", "| x | y \\| z |", "|  | last |"].join("\n"));
    expect([...root.querySelectorAll("th")].map((cell) => cell.textContent)).toEqual(["a | b", "c"]);
    expect([...root.querySelectorAll("tbody tr")].map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent))).toEqual([
      ["x", "y | z"],
      ["", "last"],
    ]);
  });
});

describe("code the browser surfaces run", () => {
  // Safari before 16.4 cannot parse a lookbehind: one regular expression with it and the whole
  // bundle fails to load, so the overview page stays blank.
  it("has no lookbehind in any regular expression", async () => {
    const offenders: string[] = [];
    const walk = async (folder: string): Promise<void> => {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        const file = path.join(folder, entry.name);
        if (entry.isDirectory()) await walk(file);
        else if (/\.ts$/u.test(entry.name) && /\(\?<[=!]/u.test(await readFile(file, "utf8"))) offenders.push(path.relative(process.cwd(), file));
      }
    };
    for (const folder of ["src/core", "src/page", "src/ui", "src/desktop", "src/web"]) await walk(path.resolve(folder));
    expect(offenders).toEqual([]);
  });
});
