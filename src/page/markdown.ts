/**
 * A small Markdown reader for saved replies (`mainline fav last` keeps a reply's Markdown source),
 * so a saved reply reads like it did in the conversation: paragraphs, headings, lists, quotes,
 * tables, code blocks, bold, italics, inline code and links. Builds DOM nodes, never HTML text.
 */
import type { Builder, Child } from "../ui/dom.js";

const FENCE = /^\s*(```|~~~)/u;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/u;
const BULLET = /^(\s*)[-*+]\s+(.*)$/u;
const NUMBERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/u;
const QUOTE = /^\s{0,3}>\s?(.*)$/u;
const TABLE_ROW = /^\s*\|.*\|\s*$/u;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/u;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/u;

/** Only web links open; anything else stays text. */
function safeHref(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

/** Bold, italics, inline code and links inside one line. */
export function inline(h: Builder, text: string): Child[] {
  const out: Child[] = [];
  const pattern = /(`+)([^`]+?)\1|\*\*([^*]+?)\*\*|__([^_]+?)__|\*([^*\s][^*]*?)\*|\[([^\]]+)\]\(([^)\s]+)\)/gu;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const [, , code, bold, boldAlt, italic, label, url] = match;
    if (code !== undefined) out.push(h("code", { class: "mlp-md-code", text: code }));
    else if (bold !== undefined || boldAlt !== undefined) out.push(h("strong", null, ...inline(h, bold ?? boldAlt ?? "")));
    else if (italic !== undefined) out.push(h("em", null, ...inline(h, italic)));
    else if (label !== undefined) {
      const href = safeHref(url ?? "");
      out.push(href ? h("a", { text: label, attrs: { href, target: "_blank", rel: "noopener noreferrer" } }) : label);
    }
    last = at + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * Splits a table row at each `|` that has no `\` before it. A loop rather than a regular
 * expression with a lookbehind: Safari before 16.4 cannot parse one, and the whole page would
 * then not load.
 */
function splitCells(row: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let at = 0; at < row.length; at += 1)
    if (row[at] === "|" && row[at - 1] !== "\\") {
      parts.push(row.slice(start, at));
      start = at + 1;
    }
  parts.push(row.slice(start));
  return parts;
}

const cells = (row: string) =>
  splitCells(
    row
      .trim()
      .replace(/^\|/u, "")
      .replace(/\|$/u, ""),
  ).map((cell) => cell.trim().replace(/\\\|/gu, "|"));

/** Quotes inside quotes shown as such; deeper ones read as text, so no reply can nest the page to a halt. */
export const MAX_QUOTE_DEPTH = 8;

export function renderMarkdown(h: Builder, source: string, depth = 0): HTMLElement[] {
  const lines = source.replace(/\r\n?/gu, "\n").split("\n");
  const blocks: HTMLElement[] = [];
  let index = 0;
  const paragraph: string[] = [];
  const flush = () => {
    if (!paragraph.length) return;
    const children: Child[] = [];
    paragraph.forEach((line, at) => {
      if (at) children.push(h("br"));
      children.push(...inline(h, line.trim()));
    });
    blocks.push(h("p", null, ...children));
    paragraph.length = 0;
  };
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      flush();
      index += 1;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").trim().startsWith(fence[1]!)) body.push(lines[index++] ?? "");
      index += 1;
      blocks.push(h("pre", { class: "mlp-md-pre" }, h("code", { text: body.join("\n") })));
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push(h("p", { class: "mlp-md-heading" }, h("strong", null, ...inline(h, heading[2] ?? ""))));
      index += 1;
      continue;
    }
    if (RULE.test(line)) {
      flush();
      blocks.push(h("hr", { class: "mlp-md-rule" }));
      index += 1;
      continue;
    }
    if (TABLE_ROW.test(line) && TABLE_RULE.test(lines[index + 1] ?? "")) {
      flush();
      const head = cells(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && TABLE_ROW.test(lines[index] ?? "")) rows.push(cells(lines[index++] ?? ""));
      blocks.push(
        h(
          "div",
          { class: "mlp-md-table" },
          h(
            "table",
            null,
            h("thead", null, h("tr", null, ...head.map((cell) => h("th", null, ...inline(h, cell))))),
            h("tbody", null, ...rows.map((row) => h("tr", null, ...head.map((_, at) => h("td", null, ...inline(h, row[at] ?? "")))))),
          ),
        ),
      );
      continue;
    }
    if (depth < MAX_QUOTE_DEPTH && QUOTE.test(line)) {
      flush();
      const quoted: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index] ?? "")) quoted.push(QUOTE.exec(lines[index++] ?? "")?.[1] ?? "");
      blocks.push(h("blockquote", { class: "mlp-md-quote" }, ...renderMarkdown(h, quoted.join("\n"), depth + 1)));
      continue;
    }
    if (BULLET.test(line) || NUMBERED.test(line)) {
      flush();
      const ordered = !BULLET.test(line);
      const items: HTMLElement[] = [];
      while (index < lines.length) {
        const current = lines[index] ?? "";
        const item = ordered ? NUMBERED.exec(current) : BULLET.exec(current);
        if (item) {
          const depth = Math.min(3, Math.floor((item[1] ?? "").replace(/\t/gu, "  ").length / 2));
          const text = ordered ? (item[3] ?? "") : (item[2] ?? "");
          items.push(h("li", { attrs: depth ? { "data-depth": String(depth) } : {} }, ...inline(h, text)));
          index += 1;
          continue;
        }
        // A wrapped line belongs to the item before it; anything else ends the list.
        if (current.trim() && /^\s{2,}\S/u.test(current) && items.length) {
          items[items.length - 1]!.append(" ", ...inline(h, current.trim()).filter((child): child is Node | string => Boolean(child)));
          index += 1;
          continue;
        }
        break;
      }
      blocks.push(h(ordered ? "ol" : "ul", { class: "mlp-md-list" }, ...items));
      continue;
    }
    paragraph.push(line);
    index += 1;
  }
  flush();
  return blocks;
}
