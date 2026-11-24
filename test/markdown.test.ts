// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/page/markdown.js";
import { builder } from "../src/ui/dom.js";

const render = (source: string) => {
  const root = document.createElement("div");
  root.append(...renderMarkdown(builder(document), source));
  return root;
};

describe("saved replies shown as they read", () => {
  it("formats paragraphs, emphasis, lists, quotes, code and tables", () => {
    const root = render(
      [
        "## 结论",
        "**原因**：铃铛放错了，用 `npm run check` 验证。",
        "",
        "- 第一项",
        "  接着第一项",
        "- 第二项",
        "",
        "1. 先备份",
        "2. 再迁移",
        "",
        "> 引用的一句",
        "",
        "```ts",
        "const gutter = 40;",
        "```",
        "",
        "| 项 | 结果 |",
        "| --- | --- |",
        "| 测试 | 151 通过 |",
      ].join("\n"),
    );
    expect(root.querySelector(".mlp-md-heading")!.textContent).toBe("结论");
    expect(root.querySelector("p:not(.mlp-md-heading) strong")!.textContent).toBe("原因");
    expect(root.querySelector(".mlp-md-code")!.textContent).toBe("npm run check");
    expect([...root.querySelectorAll("ul li")].map((li) => li.textContent)).toEqual(["第一项 接着第一项", "第二项"]);
    expect([...root.querySelectorAll("ol li")].map((li) => li.textContent)).toEqual(["先备份", "再迁移"]);
    expect(root.querySelector("blockquote")!.textContent).toBe("引用的一句");
    expect(root.querySelector("pre code")!.textContent).toBe("const gutter = 40;");
    expect([...root.querySelectorAll("td")].map((td) => td.textContent)).toEqual(["测试", "151 通过"]);
    expect(root.textContent).not.toContain("**");
  });

  it("opens only web links", () => {
    const root = render("看 [文档](https://example.com/docs) 和 [坏链接](javascript:alert(1))");
    const links = [...root.querySelectorAll("a")];
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["https://example.com/docs"]);
    expect(links[0]!.getAttribute("rel")).toBe("noopener noreferrer");
    expect(root.textContent).toContain("坏链接");
  });
});
