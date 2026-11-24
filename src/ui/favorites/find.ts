/**
 * Finding text among the conversation's messages on screen. A saved passage is found however it
 * was saved (selected on screen, or a reply's Markdown source): both sides are compared by their
 * letters and digits only (see `skeleton`).
 */
import { cleanPassage, KEPT, needlesOf, skeleton } from "../../core/favorites.js";

/** Message containers: codexhost Web flow items, Codex Desktop turns, ChatGPT-style messages. */
export const MESSAGE_SELECTOR =
  "[data-chat-flow-kind], [data-turn-key], [data-content-search-turn-key], [data-message-id], [data-message-author-role]";
const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"]';

const elementOf = (node: Node | null | undefined): Element | null =>
  !node ? null : node.nodeType === 1 ? (node as Element) : node.parentElement;

/** The message a node is in; null for the composer, other fields and anything outside messages. */
export function messageOf(node: Node | null | undefined): Element | null {
  const element = elementOf(node);
  if (!element || element.closest(EDITABLE)) return null;
  return element.closest(MESSAGE_SELECTOR);
}

/** Who wrote the message a node is in, when the page says so. */
export function roleOf(node: Node | null | undefined): "agent" | "user" | undefined {
  const holder = elementOf(node)?.closest("[data-message-author-role], [data-chat-flow-kind]");
  const value = (holder?.getAttribute("data-message-author-role") ?? holder?.getAttribute("data-chat-flow-kind") ?? "").toLowerCase();
  if (value.includes("user")) return "user";
  if (value.includes("assistant") || value.includes("agent")) return "agent";
  return undefined;
}

/** The outermost message containers, in page order. */
export function messageRoots(doc: Document): Element[] {
  return [...doc.querySelectorAll(MESSAGE_SELECTOR)].filter((element) => !element.parentElement?.closest(MESSAGE_SELECTOR));
}

interface Spot {
  node: Text;
  /** Where the character starts in its text node, and where it ends (UTF-16 offsets). */
  start: number;
  end: number;
}

/** The skeleton of all text in the messages, and the text node and offset of each of its characters. */
function textMap(doc: Document): { text: string; spots: Spot[] } {
  let text = "";
  const spots: Spot[] = [];
  for (const root of messageRoots(doc)) {
    const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      const parent = node.parentElement;
      if (parent && (parent.closest("style, script, noscript") || parent.closest(EDITABLE))) continue;
      const value = node.data;
      let offset = 0;
      for (const char of value) {
        const end = offset + char.length;
        if (KEPT.test(char))
          for (const unit of char.toLowerCase()) {
            text += unit;
            spots.push({ node, start: offset, end });
          }
        offset = end;
      }
    }
  }
  return { text, spots };
}

const FULL_MAX = 4000;
const FULL_MIN = 4;
const EDGE = 40;

/**
 * Where a saved passage is on screen, as a Range, or null when it is not among the messages shown.
 * The whole passage when it is there as it was saved; otherwise from its first line to its last
 * around its most distinctive line (a reply's code blocks show labels and buttons in between).
 */
export function findPassage(doc: Document, passage: string): Range | null {
  const { text, spots } = textMap(doc);
  if (!text) return null;
  const whole = skeleton(passage);
  let start = -1;
  let end = -1;
  if (whole.length >= FULL_MIN && whole.length <= FULL_MAX) {
    start = text.indexOf(whole);
    if (start >= 0) end = start + whole.length;
  }
  if (start < 0) {
    let anchor = -1;
    let needle = "";
    for (const candidate of needlesOf(passage)) {
      anchor = text.indexOf(candidate);
      if (anchor >= 0) {
        needle = candidate;
        break;
      }
    }
    if (anchor < 0) return null;
    start = anchor;
    end = anchor + needle.length;
    const lines = cleanPassage(passage)
      .split(/\n+/u)
      .map((line) => skeleton(line))
      .filter((line) => line.length >= 2);
    const first = lines[0]?.slice(0, EDGE);
    const last = lines[lines.length - 1]?.slice(-EDGE);
    if (first) {
      const at = text.indexOf(first, Math.max(0, anchor - whole.length - 200));
      if (at >= 0 && at <= anchor) start = at;
    }
    if (last) {
      const at = text.indexOf(last, anchor);
      if (at >= 0 && at - anchor <= whole.length * 1.5 + 400) end = Math.max(end, at + last.length);
    }
  }
  const from = spots[start];
  const to = spots[end - 1];
  if (!from || !to) return null;
  const range = doc.createRange();
  range.setStart(from.node, from.start);
  range.setEnd(to.node, to.end);
  return range;
}

/** The nearest ancestor that scrolls vertically: where older turns load when scrolled to the top. */
export function scrollerOf(element: Element | null | undefined): HTMLElement | null {
  const view = element?.ownerDocument.defaultView;
  for (let node = element?.parentElement ?? null; node && view; node = node.parentElement) {
    const overflow = view.getComputedStyle(node).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight + 4) return node;
  }
  return null;
}
