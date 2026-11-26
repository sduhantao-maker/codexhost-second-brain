/**
 * Favorites in the conversation: selecting text in a message shows a "★ 收藏" button that saves
 * the selection with its conversation; and a passage the overview asks to show again is found,
 * scrolled to and highlighted. The button sits next to the host's own selection toolbar when there
 * is one ("添加到对话 | 添加批注" on codexhost Web), else just above the selection.
 *
 * Nothing here changes the host's nodes: the button is an overlay in a shadow root, and the
 * highlight uses the CSS Custom Highlight API (the selection where that is missing).
 */
import type { Locale } from "../../core/model.js";
import { errorCodeOf, type FavoriteAdded, type Reveal } from "../../core/rpc.js";
import { diagnosticsOn, hostParams, type ControllerHandle, type LiveData, type SurfaceAdapter } from "../controller.js";
import { adoptStyles, builder } from "../dom.js";
import { hoverLocale } from "../hover/strings.js";
import { isErrorCode } from "../../core/model.js";
import { errorDetail, strings } from "../i18n.js";
import { findPassage, MESSAGE_SELECTOR, messageOf, messageRoots, roleOf, scrollerOf } from "./find.js";

export const HOST_ATTRIBUTE = "data-codexhost-mainline-favorites";
export const HIGHLIGHT_NAME = "codexhost-mainline-favorite";
/** The selection settles this long before the button shows (and the host's toolbar appears). */
export const SETTLE_MS = 180;
/** The button is placed again this long after showing, once the host's toolbar is there. */
const REPLACE_MS = [120, 360];
const FEEDBACK_MS = 1400;
const FAILED_MS = 2600;
const HIGHLIGHT_MS = 12_000;
const TOAST_MS = 3200;
/** A passage to show is looked for this long, every so often, loading older turns after a while. */
const REVEAL_FOR_MS = 16_000;
const REVEAL_EVERY_MS = 450;
const REVEAL_SCROLL_AFTER_MS = 1800;
const REVEAL_SCROLLS = 14;
const GAP = 6;
const MARGIN = 8;
const MIN_CHARS = 2;

interface Strings {
  save: string;
  saving: string;
  saved: string;
  again: string;
  /** Saving failed, and why. */
  failed(reason: string): string;
  /** Why, for the causes the backend names. */
  full: string;
  busy: string;
  /** Any other cause the backend names by its code, in the capsule's words. */
  cause(code: string, message: string): string;
  title: string;
  notFound: string;
}

const zh: Strings = {
  save: "收藏",
  saving: "收藏中…",
  saved: "已收藏",
  again: "已收藏过",
  failed: (reason) => `收藏失败：${reason}`,
  full: "收藏已满，请在总览页删除不用的收藏",
  busy: "正在写入，请稍后再试",
  cause: (code, message) => strings("zh-CN").error(code, message),
  title: "收藏这段：在「第二大脑」页面的「收藏」页签里可以找到",
  notFound: "没在对话里找到这段原文，它可能在很早的轮次，或已被改动",
};

const en: Strings = {
  save: "Save",
  saving: "Saving…",
  saved: "Saved",
  again: "Saved before",
  failed: (reason) => `Could not save: ${reason}`,
  full: "the saved passages are full; delete some in the overview",
  busy: "busy; try again in a moment",
  cause: (code, message) => strings("en").error(code, message),
  title: "Save this passage: find it in the Favorites tab of the Second Brain page",
  notFound: "The saved passage is not in this conversation on screen; it may be in a very early turn, or changed",
};

/** Why saving failed, in the page's language where the backend names the cause by its code; at most 80 characters. */
export function failureReason(t: Strings, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = errorCodeOf(error);
  const reason = code === "FAVORITES_FULL" ? t.full : code === "LOCKED" ? t.busy : isErrorCode(code) ? t.cause(code, message) : errorDetail(message);
  const chars = Array.from(reason.trim());
  return chars.length > 80 ? `${chars.slice(0, 79).join("")}…` : chars.join("");
}

export function favoriteStrings(locale: Locale): Strings {
  return locale === "zh-CN" ? zh : en;
}

const CSS = `
:host { all: initial; }
.fav, .toast {
  position: fixed;
  box-sizing: border-box;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif;
  pointer-events: auto;
  -webkit-app-region: no-drag;
  app-region: no-drag;
}
.fav {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 10px;
  border: 0;
  border-radius: 8px;
  background: #1f1f1f;
  color: #fff;
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18), inset 0 0 0 1px rgba(255, 255, 255, 0.08);
}
.fav:hover { background: #333; }
.fav:focus-visible { outline: 2px solid #f5c518; outline-offset: 1px; }
.fav .star { color: #f5c518; font-size: 12px; }
.fav[data-state="saved"] .star, .fav[data-state="again"] .star { color: #4ade80; }
.fav[data-state="failed"] .star { color: #f87171; }
.fav[data-state="saving"] { cursor: progress; opacity: 0.85; }
/* A failure says why on the button; a long reason is cut, and its whole text is the tooltip. */
.fav .label { max-width: min(420px, calc(100vw - 64px)); overflow: hidden; text-overflow: ellipsis; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.toast {
  left: 50%;
  transform: translateX(-50%);
  max-width: min(520px, calc(100vw - 32px));
  padding: 8px 14px;
  border-radius: 10px;
  background: rgba(31, 31, 31, 0.94);
  color: #fff;
  font-size: 12.5px;
  line-height: 1.45;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.22);
}
[hidden] { display: none !important; }
`;

/**
 * The page-wide rule for the highlight; a constructed sheet, so a strict page CSP allows it. Dark
 * text on a strong yellow: it reads at 7:1 or more on light and dark pages alike.
 */
const HIGHLIGHT_CSS = `::highlight(${HIGHLIGHT_NAME}) { background-color: rgba(250, 204, 21, 0.8); color: #1f2328; }`;

type ButtonState = "idle" | "saving" | "saved" | "again" | "failed";

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

const boxOf = (rect: DOMRect | DOMRectReadOnly): Box => ({
  left: rect.left,
  top: rect.top,
  right: rect.right,
  bottom: rect.bottom,
  width: rect.width,
  height: rect.height,
});

const TOOLBAR_CANDIDATES = '[class*="popover" i], [class*="toolbar" i], [role="toolbar"], [role="menu"], [data-radix-popper-content-wrapper]';

/**
 * The host's own selection toolbar near the selection, if any: a small box with buttons just above
 * or below it. On codexhost Web it is the "添加到对话 | 添加批注" bar.
 */
export function hostToolbar(doc: Document, rects: readonly Box[], own: Element): Box | null {
  const first = rects[0];
  const last = rects[rects.length - 1];
  if (!first || !last) return null;
  const left = Math.min(...rects.map((rect) => rect.left)) - 160;
  const right = Math.max(...rects.map((rect) => rect.right)) + 160;
  let candidates: Element[] = [];
  try {
    candidates = [...doc.querySelectorAll(TOOLBAR_CANDIDATES), ...doc.querySelectorAll(":popover-open")];
  } catch {
    candidates = [...doc.querySelectorAll(TOOLBAR_CANDIDATES)];
  }
  let best: { box: Box; distance: number } | null = null;
  for (const element of candidates) {
    if (element === own || own.contains(element) || messageOf(element)) continue;
    if (!element.matches("button, [role=button]") && !element.querySelector("button, [role=button]")) continue;
    const box = boxOf(element.getBoundingClientRect());
    if (box.width <= 0 || box.height <= 0 || box.height > 64 || box.width > 520) continue;
    if (box.right < left || box.left > right) continue;
    const above = first.top - box.bottom;
    const below = box.top - last.bottom;
    const distance = above >= -4 && above <= 72 ? above : below >= -4 && below <= 72 ? below : Number.POSITIVE_INFINITY;
    if (distance === Number.POSITIVE_INFINITY) continue;
    if (!best || distance < best.distance) best = { box, distance };
  }
  return best?.box ?? null;
}

/**
 * Something of the host's floating over the conversation at a point, such as a selection toolbar
 * whose markup `hostToolbar` does not recognise: not a message, not around the messages, and
 * positioned. Its small box (the toolbar around the hit) is returned.
 */
export function overlayAt(doc: Document, own: Element, x: number, y: number): Box | null {
  let hits: Element[];
  try {
    hits = doc.elementsFromPoint(x, y);
  } catch {
    return null;
  }
  const top = hits.find((element) => element !== own && !own.contains(element) && element !== doc.documentElement && element !== doc.body);
  if (!top || messageOf(top) || top.querySelector(MESSAGE_SELECTOR)) return null;
  const view = doc.defaultView;
  let box: Box | null = null;
  let positioned = false;
  for (let node: Element | null = top; node && node !== doc.body; node = node.parentElement) {
    const rect = boxOf(node.getBoundingClientRect());
    if (rect.height > 64 || rect.width > 520 || node.querySelector(MESSAGE_SELECTOR)) break;
    box = rect;
    const position = view?.getComputedStyle(node).position;
    if (position === "fixed" || position === "absolute") positioned = true;
  }
  return positioned && box && box.width > 0 && box.height > 0 ? box : null;
}

/** Where the button goes: right of the host's toolbar (left of it at the window's edge), else above the selection. */
export function buttonSpot(rects: readonly Box[], toolbar: Box | null, size: { width: number; height: number }, viewport: { width: number; height: number }): { left: number; top: number; height: number } {
  const first = rects[0]!;
  const last = rects[rects.length - 1]!;
  const height = toolbar ? Math.max(24, Math.min(36, toolbar.height)) : size.height;
  let left: number;
  let top: number;
  if (toolbar) {
    left = toolbar.right + GAP;
    if (left + size.width > viewport.width - MARGIN) left = toolbar.left - GAP - size.width;
    top = toolbar.top + (toolbar.height - height) / 2;
  } else {
    left = last.right - size.width / 2;
    top = first.top - height - GAP;
    if (top < MARGIN) top = last.bottom + GAP;
  }
  left = Math.max(MARGIN, Math.min(left, viewport.width - size.width - MARGIN));
  top = Math.max(MARGIN, Math.min(top, viewport.height - height - MARGIN));
  return { left: Math.round(left), top: Math.round(top), height: Math.round(height) };
}

export function startFavorites(adapter: SurfaceAdapter, controller: ControllerHandle): () => void {
  if (!adapter.doc.defaultView) return () => undefined;
  const favorites = new ConversationFavorites(adapter, controller);
  return () => favorites.stop();
}

class ConversationFavorites {
  readonly #adapter: SurfaceAdapter;
  readonly #controller: ControllerHandle;
  readonly #doc: Document;
  readonly #win: Window & typeof globalThis;
  readonly #t: Strings;
  readonly #host: HTMLElement;
  readonly #button: HTMLButtonElement;
  readonly #label: HTMLElement;
  /** Says how saving went, for screen readers. */
  readonly #status: HTMLElement;
  readonly #toast: HTMLElement;
  readonly #cleanup: Array<() => void> = [];
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();
  #unmount: (() => void) | void = undefined;
  /** What the button would save: the selection when it settled. */
  #pending: { threadId: string; hostId?: string; text: string; role?: "agent" | "user" } | null = null;
  #state: ButtonState = "idle";
  #dragging = false;
  #settleTimer: ReturnType<typeof setTimeout> | undefined;
  #feedbackTimer: ReturnType<typeof setTimeout> | undefined;
  #toastTimer: ReturnType<typeof setTimeout> | undefined;
  #highlightTimer: ReturnType<typeof setTimeout> | undefined;
  #highlightSheet: CSSStyleSheet | null = null;
  readonly #revealed = new Set<string>();
  #revealing: { id: string; timer: ReturnType<typeof setTimeout> | undefined } | null = null;
  #lastReport = "";
  #stopped = false;

  constructor(adapter: SurfaceAdapter, controller: ControllerHandle) {
    this.#adapter = adapter;
    this.#controller = controller;
    const doc = (this.#doc = adapter.doc);
    this.#win = doc.defaultView as Window & typeof globalThis;
    this.#t = favoriteStrings(hoverLocale(doc));
    const h = builder(doc);
    this.#host = doc.createElement("div");
    this.#host.setAttribute(HOST_ATTRIBUTE, adapter.surface);
    const style = this.#host.style;
    style.position = "fixed";
    style.left = "0";
    style.top = "0";
    style.width = "0";
    style.height = "0";
    style.zIndex = "2147483002";
    style.pointerEvents = "none";
    const shadow = this.#host.attachShadow({ mode: "open" });
    adoptStyles(shadow, CSS);
    this.#label = h("span", { class: "label", text: this.#t.save });
    // Named by what it says now ("Save", "Saved", "Could not save: …"); the title tells what it does.
    this.#button = h(
      "button",
      { class: "fav", title: this.#t.title, attrs: { type: "button", hidden: "", "data-state": "idle" } },
      h("span", { class: "star", text: "★", attrs: { "aria-hidden": "true" } }),
      this.#label,
    );
    this.#status = h("div", { class: "sr-only", attrs: { role: "status", "aria-live": "polite" } });
    this.#toast = h("div", { class: "toast", attrs: { role: "status", hidden: "" } });
    shadow.append(this.#button, this.#status, this.#toast);
    // Keep the selection (and the host's toolbar) while the button is pressed.
    this.#button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    this.#button.addEventListener("mousedown", (event) => event.preventDefault());
    this.#button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.#save();
    });
    this.#unmount = adapter.mount(this.#host);

    this.#listen(doc, "selectionchange", () => this.#selectionChanged());
    this.#listen(doc, "pointerdown", (event) => {
      if (this.#host.contains(event.target as Node)) return;
      this.#dragging = true;
      this.#clearHighlightSoon();
    }, true);
    this.#listen(doc, "pointerup", () => {
      this.#dragging = false;
      this.#settleSoon();
    }, true);
    this.#listen(doc, "keyup", (event) => {
      if ((event as KeyboardEvent).shiftKey || (event as KeyboardEvent).key.startsWith("Arrow")) this.#settleSoon();
    }, true);
    this.#listen(doc, "keydown", (event) => {
      if ((event as KeyboardEvent).key === "Escape") this.#hideButton();
    }, true);
    this.#listen(this.#win, "scroll", () => this.#follow(), true);
    this.#listen(this.#win, "resize", () => this.#follow());
    this.#cleanup.push(controller.subscribe((_version, data) => this.#onData(data)));
    // Which message markup this surface has: the button only shows inside messages.
    this.#later(() => this.#describeMessages(), 4000);
  }

  #describeMessages(): void {
    if (!diagnosticsOn(this.#win)) return;
    const count = (selector: string) => this.#doc.querySelectorAll(selector).length;
    this.#report({
      messages: {
        flow: count("[data-chat-flow-kind]"),
        turnKey: count("[data-turn-key]"),
        searchKey: count("[data-content-search-turn-key]"),
        messageId: count("[data-message-id]"),
        role: count("[data-message-author-role]"),
        roots: messageRoots(this.#doc).length,
      },
    });
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const undo of this.#cleanup.splice(0)) undo();
    for (const timer of this.#timers) clearTimeout(timer);
    clearTimeout(this.#settleTimer);
    clearTimeout(this.#feedbackTimer);
    clearTimeout(this.#toastTimer);
    if (this.#revealing) clearTimeout(this.#revealing.timer);
    this.#clearHighlight();
    if (this.#highlightSheet) {
      const sheet = this.#highlightSheet;
      this.#doc.adoptedStyleSheets = this.#doc.adoptedStyleSheets.filter((item) => item !== sheet);
    }
    this.#unmount?.();
    this.#host.remove();
  }

  #listen(target: EventTarget, type: string, listener: (event: Event) => void, capture = false): void {
    target.addEventListener(type, listener, capture);
    this.#cleanup.push(() => target.removeEventListener(type, listener, capture));
  }

  #later(fn: () => void, ms: number): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      if (!this.#stopped) fn();
    }, ms);
    this.#timers.add(timer);
  }

  // -------------------------------------------------------------------------------------------
  // Saving a selection

  #selectionChanged(): void {
    if (this.#state === "saving") return;
    const selection = this.#win.getSelection();
    if (!selection || selection.isCollapsed) {
      if (this.#state === "idle") this.#hideButton();
      return;
    }
    // While dragging, wait for the pointer to come up; otherwise (double click, keyboard) settle.
    if (!this.#dragging) this.#settleSoon();
  }

  #settleSoon(): void {
    clearTimeout(this.#settleTimer);
    this.#settleTimer = setTimeout(() => this.#settle(), SETTLE_MS);
  }

  /** The selection, when it is text in the open conversation's messages. */
  #selected(): { range: Range; text: string; threadId: string; role?: "agent" | "user" } | null {
    const selection = this.#win.getSelection();
    const threadId = this.#controller.current();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !threadId) return null;
    if (!messageOf(selection.anchorNode) || !messageOf(selection.focusNode)) return null;
    const text = selection.toString().trim();
    if (Array.from(text).length < MIN_CHARS) return null;
    const range = selection.getRangeAt(0);
    const role = roleOf(range.startContainer);
    return { range, text, threadId, ...(role ? { role } : {}) };
  }

  #settle(): void {
    if (this.#stopped || this.#state === "saving") return;
    const found = this.#selected();
    if (!found) {
      if (this.#state === "idle") this.#hideButton();
      return;
    }
    if (this.#state !== "idle" && this.#pending?.text === found.text) return;
    // A passage of a conversation on another computer names its host too.
    this.#pending = { threadId: found.threadId, ...hostParams(this.#adapter, found.threadId), text: found.text, ...(found.role ? { role: found.role } : {}) };
    this.#setState("idle");
    this.#place(found.range);
    // The host's toolbar may appear a moment after the selection settles.
    for (const ms of REPLACE_MS) this.#later(() => this.#follow(), ms);
  }

  /** Places the button again for the current selection (scrolling, the host's toolbar appearing). */
  #follow(): void {
    if (this.#button.hidden || this.#state === "saving") return;
    const selection = this.#win.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      if (this.#state === "idle") this.#hideButton();
      return;
    }
    this.#place(selection.getRangeAt(0));
  }

  #place(range: Range): void {
    const rects = [...range.getClientRects()].map(boxOf).filter((rect) => rect.width > 0 || rect.height > 0);
    const view = { width: this.#win.innerWidth, height: this.#win.innerHeight };
    if (!rects.length || rects.every((rect) => rect.bottom < 0 || rect.top > view.height)) {
      this.#hideButton();
      return;
    }
    this.#button.hidden = false;
    const measured = this.#button.getBoundingClientRect();
    const size = { width: measured.width || 64, height: 28 };
    let toolbar = hostToolbar(this.#doc, rects, this.#host);
    let spot = buttonSpot(rects, toolbar, size, view);
    if (!toolbar) {
      // A toolbar we do not know: look where ours would go, and above the middle of the selection.
      const first = rects[0]!;
      const last = rects[rects.length - 1]!;
      toolbar =
        overlayAt(this.#doc, this.#host, spot.left + size.width / 2, spot.top + spot.height / 2) ??
        overlayAt(this.#doc, this.#host, (Math.min(first.left, last.left) + Math.max(first.right, last.right)) / 2, first.top - 18);
      if (toolbar) spot = buttonSpot(rects, toolbar, size, view);
    }
    const style = this.#button.style;
    style.left = `${spot.left}px`;
    style.top = `${spot.top}px`;
    style.height = `${spot.height}px`;
    this.#report({ shown: true, beside: Boolean(toolbar), toolbar: toolbar ? [toolbar.left, toolbar.top, toolbar.width, toolbar.height].map(Math.round) : null, at: [spot.left, spot.top] });
  }

  #hideButton(): void {
    clearTimeout(this.#feedbackTimer);
    this.#button.hidden = true;
    this.#pending = null;
    this.#setState("idle");
  }

  /** `reason`: why saving failed, shown on the button. */
  #setState(state: ButtonState, reason = ""): void {
    this.#state = state;
    this.#button.dataset.state = state;
    const label = { idle: this.#t.save, saving: this.#t.saving, saved: this.#t.saved, again: this.#t.again, failed: this.#t.failed(reason) }[state];
    this.#label.textContent = label;
    // Screen readers hear how saving went; showing the button again says nothing.
    this.#status.textContent = state === "saved" || state === "again" || state === "failed" ? label : "";
  }

  async #save(): Promise<void> {
    const pending = this.#pending;
    if (!pending || this.#state === "saving") return;
    this.#setState("saving");
    try {
      const result = (await this.#adapter.invoke("favorites.add", pending)) as FavoriteAdded;
      if (this.#stopped) return;
      this.#setState(result.added ? "saved" : "again");
      this.#feedbackTimer = setTimeout(() => this.#hideButton(), FEEDBACK_MS);
    } catch (error) {
      if (this.#stopped) return;
      const reason = failureReason(this.#t, error);
      this.#setState("failed", reason);
      this.#button.title = this.#t.failed(reason);
      // The longer label may need the button moved back inside the window.
      this.#follow();
      this.#feedbackTimer = setTimeout(() => {
        this.#button.title = this.#t.title;
        this.#hideButton();
      }, FAILED_MS);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Showing a saved passage again

  #onData(data: LiveData): void {
    const reveal = data.reveal;
    if (!reveal || this.#revealed.has(reveal.id) || reveal.threadId !== this.#controller.current()) return;
    this.#revealed.add(reveal.id);
    this.#reveal(reveal);
  }

  /** Looks for the passage until it is on screen, loading older turns after a while; then marks it. */
  #reveal(reveal: Reveal): void {
    if (this.#revealing) clearTimeout(this.#revealing.timer);
    const started = Date.now();
    let scrolls = 0;
    let tries = 0;
    /** Found, but not shown yet: the conversation is still behind something (Desktop's settings). */
    let hidden = false;
    const revealing: { id: string; timer: ReturnType<typeof setTimeout> | undefined } = { id: reveal.id, timer: undefined };
    this.#revealing = revealing;
    const finish = (found: boolean) => {
      if (this.#revealing === revealing) this.#revealing = null;
      void this.#adapter.invoke("favorites.revealed", { id: reveal.id }).catch(() => undefined);
      this.#report({ reveal: found, tries, scrolls, hidden, ms: Date.now() - started });
      // Found, the highlight says it all; otherwise say why nothing happened.
      if (!found && !hidden) this.#showToast(this.#t.notFound);
    };
    const attempt = () => {
      if (this.#stopped || this.#revealing !== revealing) return;
      if (this.#controller.current() !== reveal.threadId) {
        finish(false);
        return;
      }
      tries += 1;
      const range = findPassage(this.#doc, reveal.text);
      // Scrolling to it and marking it only work once the conversation is laid out.
      hidden = Boolean(range) && range!.getClientRects().length === 0;
      if (range && !hidden) {
        this.#highlight(range);
        finish(true);
        return;
      }
      const elapsed = Date.now() - started;
      if (elapsed >= REVEAL_FOR_MS) {
        finish(false);
        return;
      }
      // Not among the turns on screen: scroll to the top so the host loads older ones.
      if (!range && elapsed >= REVEAL_SCROLL_AFTER_MS && scrolls < REVEAL_SCROLLS) {
        const scroller = scrollerOf(messageRoots(this.#doc)[0]);
        if (scroller && scroller.scrollTop > 0) {
          scroller.scrollTop = 0;
          scrolls += 1;
        }
      }
      revealing.timer = setTimeout(attempt, REVEAL_EVERY_MS);
    };
    attempt();
  }

  #highlight(range: Range): void {
    this.#clearHighlight();
    const start = range.startContainer;
    const element = start.nodeType === 1 ? (start as Element) : start.parentElement;
    element?.scrollIntoView({ block: "center", inline: "nearest" });
    const registry = (this.#win as unknown as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;
    const HighlightClass = (this.#win as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
    if (registry && HighlightClass) {
      this.#ensureHighlightStyle();
      registry.set(HIGHLIGHT_NAME, new HighlightClass(range));
    } else {
      // Without the Highlight API, selecting the passage shows it just as well.
      const selection = this.#win.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    this.#highlightTimer = setTimeout(() => this.#clearHighlight(), HIGHLIGHT_MS);
  }

  #ensureHighlightStyle(): void {
    if (this.#highlightSheet) return;
    const Sheet = this.#win.CSSStyleSheet;
    try {
      const sheet = new Sheet();
      sheet.replaceSync(HIGHLIGHT_CSS);
      this.#doc.adoptedStyleSheets = [...this.#doc.adoptedStyleSheets, sheet];
      this.#highlightSheet = sheet;
    } catch {
      // A page that refuses the sheet still shows the passage scrolled into view.
    }
  }

  /** Clicking anywhere a moment after the passage was shown takes the highlight off. */
  #clearHighlightSoon(): void {
    if (this.#highlightTimer === undefined) return;
    this.#later(() => this.#clearHighlight(), 250);
  }

  #clearHighlight(): void {
    clearTimeout(this.#highlightTimer);
    this.#highlightTimer = undefined;
    const registry = (this.#win as unknown as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;
    registry?.delete(HIGHLIGHT_NAME);
  }

  #showToast(text: string): void {
    clearTimeout(this.#toastTimer);
    this.#toast.textContent = text;
    // Below the conversation's header.
    this.#toast.style.top = "64px";
    this.#toast.hidden = false;
    this.#toastTimer = setTimeout(() => {
      this.#toast.hidden = true;
    }, TOAST_MS);
  }

  /**
   * Tells the backend log where the button went and how showing a passage went (rate limited there),
   * only while this surface's diagnostics are on (`diagnosticsOn`).
   */
  #report(report: Record<string, unknown>): void {
    if (!diagnosticsOn(this.#win)) return;
    const text = JSON.stringify(report);
    if (text === this.#lastReport) return;
    this.#lastReport = text;
    void this.#adapter.invoke("diagnose", { surface: `${this.#adapter.surface}-favorites`, report }).catch(() => undefined);
  }
}
