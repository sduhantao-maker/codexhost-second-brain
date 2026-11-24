/**
 * The mainline capsule (v2): a draggable pill over the conversation that names what this
 * conversation does, its current milestone and the task in progress. It opens into a card with
 * the milestone timeline and its tasks, spin-offs, child conversations, links and a search. It
 * renders the view it is given and reports edits through callbacks; it never talks to the backend.
 */
import type { ConversationView, MilestoneView, RelatedView } from "../core/conversation-view.js";
import type { Locale, Settings } from "../core/model.js";
import type { RefView } from "../core/refs.js";
import { errorCodeOf, type MutateV2Params, type SearchResult } from "../core/rpc.js";
import type { Band } from "./band.js";
import { adoptStyles, builder, icon, type Builder, type IconName } from "./dom.js";
import { strings, type Strings } from "./i18n.js";
import { detectScheme, watchScheme } from "./theme.js";

/** Injected by the build from styles.css; tests run without it. */
declare const __MAINLINE_CSS__: string | undefined;
const css = typeof __MAINLINE_CSS__ === "string" ? __MAINLINE_CSS__ : "";

export interface CapsuleModel {
  threadId: string | null;
  /** The open conversation's mainline (or draft); null while it loads. */
  view: ConversationView | null;
  settings: Settings;
  offline: boolean;
  now: number;
  /** PRs and issues with unseen GitHub news. */
  alerts?: RefView[];
}

export interface Anchor {
  x: number;
  top: number;
  band?: Band | null;
}

export interface CapsuleOptions {
  doc: Document;
  locale: Locale;
  surface: "desktop" | "web";
  mutate(params: MutateV2Params): Promise<void>;
  /** Opens a child conversation for a spin-off. */
  spawn?(spinoffId: string): Promise<void>;
  openThread(threadId: string): void;
  /** Other backend calls: `search`, and `refs.seen`, which marks a PR's news as seen. */
  call?(method: string, params?: unknown): Promise<unknown>;
  /**
   * Default spot: horizontal center and top edge, in viewport pixels. With a band, the capsule
   * sits inside it when it fits, so it covers no conversation text.
   */
  anchor(): Anchor | null;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
}

const CONFIRM_MS = 3000;
const TOAST_MS = 3500;
const CAPSULE_HEIGHT = 30;
const EDGE = 8;
/** Space kept between the capsule and whatever sits beside it in the header. */
const BAND_MARGIN = 10;
/** Narrower header gaps would cut the text down too far; the capsule goes below the header then. */
const MIN_BAND_WIDTH = 260;
const SEARCH_DELAY_MS = 250;
const TASKS_SHOWN = 8;
/** More reached milestones than this at the start of the timeline fold away. */
const FOLD_REACHED_OVER = 4;
/** Reached milestones still shown when the run is folded. */
const REACHED_SHOWN = 2;
/** Key in the expanded set for the folded run of reached milestones; milestone ids have no dash. */
const REACHED_RUN = "reached-run";

type Field = "title" | "tags" | `rename:${string}`;

/** Splits typed tags on ASCII, Chinese and enumeration commas, dropping blanks. */
function splitTags(value: string): string[] {
  return value
    .split(/[,，、]/u)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export class Capsule {
  readonly host: HTMLElement;
  readonly #doc: Document;
  readonly #shadow: ShadowRoot;
  readonly #root: HTMLElement;
  readonly #capsule: HTMLElement;
  readonly #card: HTMLElement;
  /** Says what a two-click button waits for, for screen readers. */
  readonly #live: HTMLElement;
  readonly #t: Strings;
  readonly #h: Builder;
  readonly #cleanup: Array<() => void> = [];
  /** Two-click buttons waiting for their second click, by key; the latest button drawn for each, to calm it down. */
  readonly #confirming = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #confirmResets = new Map<string, () => void>();
  readonly #expanded = new Set<string>();
  #model: CapsuleModel | null = null;
  #threadId: string | null = null;
  #open = false;
  #flashing = false;
  #hovered = false;
  #pendingCard = false;
  #editing: Field | null = null;
  #searching = false;
  #manual: { fx: number; y: number } | null = null;
  #x = 0;
  #y = 0;
  #flashTimer: ReturnType<typeof setTimeout> | undefined;
  #toastTimer: ReturnType<typeof setTimeout> | undefined;
  #searchTimer: ReturnType<typeof setTimeout> | undefined;
  #toast: HTMLElement | undefined;

  constructor(private readonly options: CapsuleOptions) {
    const doc = (this.#doc = options.doc);
    this.#t = strings(options.locale);
    this.#h = builder(doc);
    this.host = doc.createElement("div");
    this.host.setAttribute("data-codexhost-mainline", options.surface);
    const style = this.host.style;
    style.position = "fixed";
    style.zIndex = "2147483000";
    style.transform = "translateX(-50%)";
    style.left = "50%";
    style.top = "56px";
    // Over a window drag region (Electron, Tauri) the capsule must stay clickable.
    style.setProperty("-webkit-app-region", "no-drag");
    style.setProperty("app-region", "no-drag");
    this.#shadow = this.host.attachShadow({ mode: "open" });
    adoptStyles(this.#shadow, css);
    this.#capsule = this.#h("div", {
      class: "capsule",
      attrs: { role: "button", tabindex: "0", "aria-expanded": "false", "aria-haspopup": "dialog" },
    });
    this.#card = this.#h("div", { class: "card", attrs: { role: "dialog", "aria-label": this.#t.mainline } });
    this.#live = this.#h("div", { class: "sr-only", attrs: { role: "status", "aria-live": "polite" } });
    this.#root = this.#h("div", { class: "root", attrs: { hidden: "" } }, this.#capsule, this.#card, this.#live);
    this.#shadow.append(this.#root);
    this.#readPosition();
    this.#bind();
    this.#applyScheme();
    this.#cleanup.push(watchScheme(doc, () => this.#applyScheme()));
  }

  // -------------------------------------------------------------------------------------------
  // Public surface

  update(model: CapsuleModel): void {
    if (model.threadId !== this.#threadId) {
      this.#threadId = model.threadId;
      this.#editing = null;
      this.#searching = false;
      this.#expanded.clear();
      // A button armed in another conversation waits for no click here.
      for (const timer of this.#confirming.values()) clearTimeout(timer);
      this.#confirming.clear();
      this.#confirmResets.clear();
      this.#live.textContent = "";
    }
    this.#model = model;
    this.#render();
  }

  /** Opens the card for a moment, unless the user opened it or is pointing at it. */
  flash(ms = 3000): void {
    if (this.#open || !this.#model?.threadId) return;
    this.#setOpen(true, true);
    clearTimeout(this.#flashTimer);
    this.#flashTimer = setTimeout(() => this.#endFlash(), ms);
  }

  get isOpen(): boolean {
    return this.#open;
  }

  reposition(): void {
    const view = this.#doc.defaultView;
    if (!view) return;
    let x: number;
    let y: number;
    // Measure the capsule at its natural width before fitting it anywhere.
    this.#capsule.style.maxWidth = "";
    if (this.#manual) {
      // A dragged capsule keeps its left edge where it was put, and grows to the right.
      x = this.#manual.fx * view.innerWidth + (this.#capsule.offsetWidth || 160) / 2;
      y = this.#manual.y;
    } else {
      const anchor = this.options.anchor();
      x = anchor?.x ?? view.innerWidth / 2;
      y = anchor?.top ?? 56;
      const band = anchor?.band;
      const room = band ? band.right - band.left - 2 * BAND_MARGIN : 0;
      if (band && room >= MIN_BAND_WIDTH) {
        // Sit in the header's empty stretch, shortening the text to fit rather than covering the conversation.
        const width = Math.min(this.#capsule.offsetWidth || 160, room);
        if (width < (this.#capsule.offsetWidth || 0)) this.#capsule.style.maxWidth = `${Math.floor(room)}px`;
        x = Math.min(Math.max(x, band.left + BAND_MARGIN + width / 2), band.right - BAND_MARGIN - width / 2);
        y = band.top + Math.max(0, (band.height - CAPSULE_HEIGHT) / 2);
      }
    }
    this.#place(x, y);
  }

  destroy(): void {
    clearTimeout(this.#flashTimer);
    clearTimeout(this.#toastTimer);
    clearTimeout(this.#searchTimer);
    for (const timer of this.#confirming.values()) clearTimeout(timer);
    for (const stop of this.#cleanup.splice(0)) stop();
    this.host.remove();
  }

  // -------------------------------------------------------------------------------------------
  // Placement and interaction

  get #positionKey(): string {
    return `codexhost-mainline:position-v2:${this.options.surface}`;
  }

  #readPosition(): void {
    try {
      const raw = this.options.storage?.getItem(this.#positionKey);
      const parsed = raw ? (JSON.parse(raw) as { fx?: unknown; y?: unknown }) : undefined;
      if (typeof parsed?.fx === "number" && typeof parsed.y === "number") this.#manual = { fx: parsed.fx, y: parsed.y };
    } catch {
      this.#manual = null;
    }
  }

  #savePosition(): void {
    const view = this.#doc.defaultView;
    if (!view) return;
    const left = this.#x - (this.#capsule.offsetWidth || 160) / 2;
    this.#manual = { fx: left / Math.max(1, view.innerWidth), y: this.#y };
    try {
      this.options.storage?.setItem(this.#positionKey, JSON.stringify(this.#manual));
    } catch {
      // Position memory is a convenience.
    }
  }

  #resetPosition(): void {
    this.#manual = null;
    try {
      this.options.storage?.removeItem(this.#positionKey);
      this.options.storage?.removeItem(`codexhost-mainline:position:${this.options.surface}`);
    } catch {
      // Ignore.
    }
    this.reposition();
  }

  #place(x: number, y: number): void {
    const view = this.#doc.defaultView;
    if (!view) return;
    const width = this.#capsule.offsetWidth || 160;
    const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));
    this.#x = clamp(x, width / 2 + EDGE, view.innerWidth - width / 2 - EDGE);
    this.#y = clamp(y, EDGE, view.innerHeight - CAPSULE_HEIGHT - EDGE);
    this.host.style.left = `${Math.round(this.#x)}px`;
    this.host.style.top = `${Math.round(this.#y)}px`;
    const below = view.innerHeight - (this.#y + CAPSULE_HEIGHT + EDGE) - EDGE;
    const above = this.#y - 2 * EDGE;
    const flip = below < 240 && above > below;
    this.#root.toggleAttribute("data-flip", flip);
    this.#root.style.setProperty("--cxm-card-max", `${Math.max(160, Math.round(flip ? above : below))}px`);
  }

  #bind(): void {
    const capsule = this.#capsule;
    const listen = <T extends Event>(target: EventTarget, type: string, listener: (event: T) => void, options?: AddEventListenerOptions) => {
      target.addEventListener(type, listener as EventListener, options);
      this.#cleanup.push(() => target.removeEventListener(type, listener as EventListener, options));
    };
    listen<PointerEvent>(capsule, "pointerdown", (event) => {
      if (event.button !== 0) return;
      const start = { x: event.clientX, y: event.clientY, left: this.#x, top: this.#y };
      let moved = false;
      try {
        capsule.setPointerCapture?.(event.pointerId);
      } catch {
        // Synthetic events have no active pointer.
      }
      const move = (next: PointerEvent) => {
        const dx = next.clientX - start.x;
        const dy = next.clientY - start.y;
        if (!moved && Math.hypot(dx, dy) < 4) return;
        moved = true;
        this.#root.setAttribute("data-dragging", "");
        this.#place(start.left + dx, start.top + dy);
      };
      const end = () => {
        capsule.removeEventListener("pointermove", move);
        capsule.removeEventListener("pointerup", end);
        capsule.removeEventListener("pointercancel", end);
        this.#root.removeAttribute("data-dragging");
        if (moved) this.#savePosition();
        else this.#toggle();
      };
      capsule.addEventListener("pointermove", move);
      capsule.addEventListener("pointerup", end);
      capsule.addEventListener("pointercancel", end);
    });
    listen(capsule, "dblclick", () => this.#resetPosition());
    listen<KeyboardEvent>(capsule, "keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.#toggle();
      }
    });
    listen<KeyboardEvent>(this.#root, "keydown", (event) => {
      if (event.key === "Escape" && this.#open && !this.#editing && !this.#typing()) {
        event.stopPropagation();
        this.#setOpen(false);
        capsule.focus();
      }
    });
    listen(this.#root, "pointerenter", () => {
      this.#hovered = true;
    });
    listen(this.#root, "pointerleave", () => {
      this.#hovered = false;
      if (this.#flashing) {
        clearTimeout(this.#flashTimer);
        this.#flashTimer = setTimeout(() => this.#endFlash(), 800);
      }
    });
    listen(this.#card, "focusout", () => {
      // Render what arrived while an input had focus, once focus has really left it.
      setTimeout(() => {
        if (this.#pendingCard && !this.#typing()) this.#renderCard();
      }, 0);
    });
    listen<PointerEvent>(
      this.#doc,
      "pointerdown",
      (event) => {
        if (this.#open && !event.composedPath().includes(this.host)) this.#setOpen(false);
      },
      { capture: true },
    );
    const view = this.#doc.defaultView;
    if (view) listen(view, "resize", () => this.reposition());
  }

  #toggle(): void {
    this.#setOpen(!this.#open || this.#flashing);
  }

  #setOpen(open: boolean, flashing = false): void {
    this.#open = open;
    this.#flashing = open && flashing;
    if (!open) clearTimeout(this.#flashTimer);
    this.#root.toggleAttribute("data-open", open);
    this.#capsule.setAttribute("aria-expanded", String(open));
    if (open) {
      this.#renderCard();
      this.reposition();
    } else {
      this.#editing = null;
    }
  }

  #endFlash(): void {
    if (!this.#flashing || this.#hovered || this.#typing()) return;
    this.#setOpen(false);
  }

  #typing(): boolean {
    return this.#shadow.activeElement?.tagName === "INPUT";
  }

  #applyScheme(): void {
    this.#root.setAttribute("data-scheme", detectScheme(this.#doc));
  }

  #showToast(message: string): void {
    this.#toast?.remove();
    this.#toast = this.#h("div", { class: "toast", text: message, attrs: { role: "status" } });
    this.#root.append(this.#toast);
    clearTimeout(this.#toastTimer);
    this.#toastTimer = setTimeout(() => this.#toast?.remove(), TOAST_MS);
  }

  async #run(action: () => Promise<void>): Promise<boolean> {
    try {
      await action();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#showToast(this.#t.error(errorCodeOf(error), message));
      return false;
    }
  }

  #act(params: MutateV2Params): Promise<boolean> {
    return this.#run(() => this.options.mutate(params));
  }

  // -------------------------------------------------------------------------------------------
  // Rendering: the pill

  #render(): void {
    const model = this.#model;
    const visible = Boolean(model?.threadId && model.view);
    this.#root.toggleAttribute("hidden", !visible);
    if (!visible || !model?.view) {
      if (this.#open) this.#setOpen(false);
      return;
    }
    this.#renderCapsule(model.view);
    if (this.#open) this.#renderCard();
    this.reposition();
  }

  #renderCapsule(view: ConversationView): void {
    const h = this.#h;
    const t = this.#t;
    const doc = this.#doc;
    const model = this.#model!;
    const capsule = this.#capsule;
    const offline = model.offline;
    const open = view.spinoffs.filter((spinoff) => spinoff.state === "open");
    capsule.toggleAttribute("data-drift", open.length > 0 && !view.draft);
    capsule.toggleAttribute("data-empty", view.draft);
    const children: Array<Node | null> = [];
    const tooltip: string[] = [];
    if (view.draft) {
      children.push(
        h("span", { class: "dot", attrs: { "data-tone": "muted" } }),
        h("span", { class: "label", text: t.draftLabel }),
        h("span", { class: "goal", text: view.title }),
      );
      tooltip.push(t.labelled(t.draftLabel, view.title), t.noMainline);
    } else {
      const tone = offline || view.status !== "active" ? "muted" : open.length ? "drift" : "accent";
      children.push(h("span", { class: "dot", attrs: { "data-tone": tone } }), h("span", { class: "goal", text: view.title }));
      if (view.current) children.push(h("span", { class: "sep" }), h("span", { class: "milestone", text: t.current(view.current.title) }));
      if (view.now) children.push(h("span", { class: "sep" }), h("span", { class: "doing", text: `▸ ${view.now.text}` }));
      else if (open.length) children.push(h("span", { class: "sep" }), h("span", { class: "drift-text", text: `⑂ ${open[0]!.text}` }));
      if (view.progress.total) children.push(h("span", { class: "count", text: t.progress(view.progress.done, view.progress.total) }));
      tooltip.push(view.title);
      if (view.tags.length) tooltip.push(view.tags.map((tag) => `#${tag}`).join(" "));
      if (view.current) tooltip.push(t.labelled(t.milestones, view.current.title));
      if (view.now) tooltip.push(t.labelled(t.doing, view.now.text));
    }
    const news = model.alerts ?? [];
    capsule.toggleAttribute("data-alert", news.length > 0);
    if (news.length) {
      const first = news[0]!;
      const label = news.length === 1 ? t.newsOne(first.number) : t.newsMany(news.length);
      children.unshift(h("span", { class: "alert" }, icon(doc, "bell"), h("span", { text: label })));
      tooltip.unshift(...news.map((ref) => `#${ref.number} ${ref.title ?? ""} · ${t.reason(ref.activity?.reason ?? "")}`));
    }
    if (offline) tooltip.unshift(t.offline);
    children.push(icon(doc, "chevron", "chevron"));
    capsule.replaceChildren(...children.filter((child): child is Node => child !== null));
    capsule.title = tooltip.join("\n");
    capsule.setAttribute("aria-label", t.joinParts(tooltip));
  }

  // -------------------------------------------------------------------------------------------
  // Rendering: the card

  #renderCard(): void {
    if (this.#typing()) {
      this.#pendingCard = true;
      return;
    }
    this.#pendingCard = false;
    const view = this.#model?.view;
    if (!view) return;
    const scroll = this.#card.scrollTop;
    this.#card.setAttribute("aria-label", this.#t.cardLabel(view.title));
    const nodes: Node[] = [this.#head(view)];
    if (this.#searching && this.options.call) nodes.push(this.#searchPanel());
    const news = this.#model?.alerts ?? [];
    if (news.length) nodes.push(this.#section(this.#t.news, ...news.map((ref) => this.#refRow(ref, view.threadId, true))));
    nodes.push(...(view.draft ? this.#draftBody(view) : this.#mainlineBody(view)));
    this.#card.replaceChildren(...nodes);
    this.#card.scrollTop = scroll;
    const editor = this.#card.querySelector<HTMLInputElement>("input[data-autofocus]");
    if (editor) {
      editor.focus();
      editor.select();
    }
  }

  #head(view: ConversationView): HTMLElement {
    const h = this.#h;
    const t = this.#t;
    const label = view.draft ? t.draftLabel : `${t.mainline} · ${t.conversationStatus[view.status]}`;
    const search = this.options.call
      ? this.#iconButton("search", t.findConversations, () => {
          this.#searching = !this.#searching;
          this.#renderCard();
          if (this.#searching) this.#card.querySelector<HTMLInputElement>("input.search-input")?.focus();
        })
      : null;
    return h("div", { class: "head" }, h("span", { class: "tag", text: label }), h("span", { class: "spacer" }), search, this.#closeButton());
  }

  #mainlineBody(view: ConversationView): Node[] {
    const h = this.#h;
    const t = this.#t;
    const threadId = view.threadId;
    const nodes: Node[] = [];

    const goal = h("div", { class: "goal-line" });
    if (this.#editing === "title")
      goal.append(
        this.#editor(view.title, t.goalPlaceholder, (title) => {
          if (title) void this.#act({ op: "title", threadId, title });
        }),
      );
    else
      goal.append(
        h("span", { text: view.title }),
        this.#iconButton("pencil", t.edit, () => {
          this.#editing = "title";
          this.#renderCard();
        }),
      );
    nodes.push(goal);

    const tags = h("div", { class: "tags" });
    if (this.#editing === "tags")
      tags.append(
        this.#editor(view.tags.join(", "), t.tagsPlaceholder, (value) => {
          void this.#act({ op: "tags", threadId, tags: splitTags(value) });
        }),
      );
    else {
      for (const tag of view.tags) tags.append(h("span", { class: "chip", text: `#${tag}` }));
      tags.append(
        h("button", {
          class: "link",
          text: view.tags.length ? t.edit : t.editTags,
          attrs: { type: "button" },
          on: {
            click: () => {
              this.#editing = "tags";
              this.#renderCard();
            },
          },
        }),
      );
    }
    nodes.push(tags);

    if (view.parent) nodes.push(this.#relatedLine(t.fromParent(view.parent.title), view.parent));
    if (view.related) nodes.push(this.#relatedLine(t.linkedTo(view.related.title), view.related));

    nodes.push(this.#milestonesSection(view));

    const open = view.spinoffs.filter((spinoff) => spinoff.state === "open");
    const spawned = view.spinoffs.filter((spinoff) => spinoff.state === "spawned");
    if (open.length || spawned.length)
      nodes.push(
        this.#section(
          t.spinoffs,
          ...open.map((spinoff) =>
            h(
              "div",
              { class: "spinoff" },
              h("div", { class: "text", text: `⑂ ${spinoff.text}` }),
              h(
                "div",
                { class: "buttons" },
                this.#confirmButton(
                  `spawn:${threadId}:${spinoff.id}`,
                  t.spawnChild,
                  () => {
                    if (this.options.spawn) void this.#run(() => this.options.spawn!(spinoff.id));
                  },
                  { className: "primary" },
                ),
                h("button", { class: "btn", text: t.keepHere, attrs: { type: "button" }, on: { click: () => void this.#act({ op: "spinoffKeep", threadId, spinoffId: spinoff.id }) } }),
                // A dismissed spin-off cannot be brought back.
                this.#confirmButton(`dismiss:${threadId}:${spinoff.id}`, t.dismiss, () => void this.#act({ op: "spinoffDismiss", threadId, spinoffId: spinoff.id })),
              ),
            ),
          ),
          ...spawned.map((spinoff) => {
            const row = h("div", { class: "row" }, h("span", { class: "muted", text: t.spawned(spinoff.text) }));
            const child = spinoff.childThreadId;
            if (child) this.#opens(row, child);
            return row;
          }),
        ),
      );

    if (view.children.length) nodes.push(this.#section(t.children, ...view.children.map((child) => this.#childRow(child))));
    if (view.refs.length) nodes.push(this.#section(t.windowRefs, ...view.refs.slice(0, 5).map((ref) => this.#refRow(ref, threadId, false))));

    nodes.push(
      h(
        "div",
        { class: "foot" },
        view.status === "paused"
          ? h("button", { class: "btn", text: t.resume, attrs: { type: "button" }, on: { click: () => void this.#act({ op: "status", threadId, status: "active" }) } })
          : view.status === "active"
            ? h("button", { class: "btn", text: t.pause, attrs: { type: "button" }, on: { click: () => void this.#act({ op: "status", threadId, status: "paused" }) } })
            : null,
        h("span", { class: "spacer" }),
        view.status === "done"
          ? h("button", { class: "btn", text: t.reopenMainline, attrs: { type: "button" }, on: { click: () => void this.#act({ op: "status", threadId, status: "active" }) } })
          : // A status, undone with "Reopen": one click.
            h("button", { class: "btn", text: t.finishMainline, attrs: { type: "button" }, on: { click: () => void this.#act({ op: "status", threadId, status: "done" }) } }),
      ),
      h("div", { class: "hint", text: t.overviewHint[this.options.surface] }),
    );
    return nodes;
  }

  #milestonesSection(view: ConversationView): HTMLElement {
    const h = this.#h;
    const t = this.#t;
    const threadId = view.threadId;
    const rows: Node[] = [];
    if (!view.milestones.length) rows.push(h("div", { class: "muted", text: t.noMilestones }));
    // A long run of reached milestones at the start folds away, keeping the last few in sight.
    const leading = view.milestones.findIndex((milestone) => milestone.state !== "done");
    const reached = leading === -1 ? view.milestones.length : leading;
    const folded = reached > FOLD_REACHED_OVER && !this.#expanded.has(REACHED_RUN) ? reached - REACHED_SHOWN : 0;
    if (folded)
      rows.push(
        h("button", {
          class: "link task-toggle",
          text: t.earlierMilestones(folded),
          attrs: { type: "button" },
          on: {
            click: () => {
              this.#expanded.add(REACHED_RUN);
              this.#renderCard();
            },
          },
        }),
      );
    for (const milestone of view.milestones.slice(folded)) rows.push(this.#milestoneRow(view, milestone));
    rows.push(this.#adder(t.addMilestone, (title) => this.#act({ op: "milestoneAdd", threadId, title })));
    const title = view.progress.total ? t.counted(t.milestones, view.progress.done, view.progress.total) : t.milestones;
    return this.#section(title, ...rows);
  }

  #milestoneRow(view: ConversationView, milestone: MilestoneView): HTMLElement {
    const h = this.#h;
    const t = this.#t;
    const now = this.#model?.now ?? Date.now();
    const threadId = view.threadId;
    const mark = milestone.state === "done" ? "✓" : milestone.state === "current" ? "●" : "○";
    const editing = this.#editing === `rename:${milestone.id}`;
    const titleNode = editing
      ? this.#editor(milestone.title, t.addMilestone, (title) => {
          if (title) void this.#act({ op: "milestoneRename", threadId, milestoneId: milestone.id, title });
        })
      : h("span", { class: "milestone-title", text: milestone.title });
    const actions = h(
      "div",
      { class: "actions" },
      // Words, not a ✓: a tick here read as "done" and reopened reached milestones by mistake.
      milestone.state !== "current"
        ? h("button", {
            class: "link",
            text: t.makeCurrent,
            attrs: { type: "button" },
            on: {
              click: (event) => {
                event.stopPropagation();
                void this.#act({ op: "milestoneFocus", threadId, milestoneId: milestone.id });
              },
            },
          })
        : null,
      this.#iconButton("pencil", t.edit, () => {
        this.#editing = `rename:${milestone.id}`;
        this.#renderCard();
      }),
      // Deleting cannot be undone: a second click within three seconds.
      this.#confirmButton(`msRemove:${threadId}:${milestone.id}`, t.remove, () => void this.#act({ op: "milestoneRemove", threadId, milestoneId: milestone.id }), { icon: "close" }),
    );
    const head = h(
      "div",
      { class: "row milestone-row", attrs: { "data-state": milestone.state } },
      h("span", { class: "milestone-mark", text: mark }),
      h(
        "div",
        { class: "main" },
        titleNode,
        milestone.state === "done" && milestone.doneAt ? h("div", { class: "meta", text: t.time(milestone.doneAt, now) }) : null,
      ),
      editing ? null : actions,
    );
    const block = h("div", { class: "milestone", attrs: { "data-state": milestone.state } }, head);
    if (milestone.state === "current") {
      const tasks = milestone.tasks.slice(-TASKS_SHOWN);
      for (const task of tasks) {
        const doing = !task.done && view.now?.text === task.text;
        const row = h(
          "div",
          { class: "row task", attrs: { "data-done": String(task.done), ...(doing ? { "data-doing": "" } : {}) } },
          h("span", { class: "task-mark", text: task.done ? "✓" : doing ? "▸" : "·" }),
          h(
            "div",
            { class: "main" },
            h("span", { text: task.text }),
            // The way to the child for keyboards; a click anywhere on the row opens it too.
            task.threadId && task.threadTitle
              ? h("button", { class: "link by-child", text: ` · ${t.byChild(task.threadTitle)}`, title: t.open, attrs: { type: "button" } })
              : null,
          ),
          h(
            "div",
            { class: "actions" },
            task.done ? null : this.#iconButton("check", t.complete, () => void this.#act({ op: "taskDone", threadId, taskId: task.id })),
            this.#confirmButton(`taskRemove:${threadId}:${task.id}`, t.remove, () => void this.#act({ op: "taskRemove", threadId, taskId: task.id }), { icon: "close" }),
          ),
        );
        if (task.threadId) {
          row.setAttribute("data-clickable", "");
          row.addEventListener("click", () => this.options.openThread(task.threadId!));
        }
        block.append(row);
      }
      block.append(
        this.#adder(t.addTask, (text) => this.#act({ op: "taskAdd", threadId, text, milestoneId: milestone.id })),
        h(
          "div",
          { class: "buttons" },
          h("button", { class: "btn primary", text: t.reach, attrs: { type: "button" }, on: { click: () => void this.#act({ op: "milestoneReach", threadId, milestoneId: milestone.id }) } }),
        ),
      );
    } else if (milestone.tasks.length) {
      const expanded = this.#expanded.has(milestone.id);
      block.append(
        h("button", {
          class: "link task-toggle",
          text: expanded ? t.showLess : t.tasksCount(milestone.tasks.length),
          attrs: { type: "button" },
          on: {
            click: () => {
              if (expanded) this.#expanded.delete(milestone.id);
              else this.#expanded.add(milestone.id);
              this.#renderCard();
            },
          },
        }),
      );
      if (expanded)
        for (const task of milestone.tasks)
          block.append(h("div", { class: "row task", attrs: { "data-done": String(task.done) } }, h("span", { class: "task-mark", text: task.done ? "✓" : "·" }), h("div", { class: "main", text: task.text })));
    }
    return block;
  }

  #draftBody(view: ConversationView): Node[] {
    const h = this.#h;
    const t = this.#t;
    const title = h("input", { class: "field", attrs: { type: "text", placeholder: t.goalPlaceholder, "aria-label": t.goalPlaceholder } });
    title.value = view.title.startsWith("#") ? "" : view.title;
    const tags = h("input", { class: "field", attrs: { type: "text", placeholder: t.tagsPlaceholder, "aria-label": t.tagsPlaceholder } });
    tags.value = view.tags.join(", ");
    const plan = h("input", { class: "field", attrs: { type: "text", placeholder: t.planPlaceholder, "aria-label": t.planPlaceholder } });
    const create = () => {
      const goal = title.value.trim();
      if (!goal) {
        title.focus();
        return;
      }
      void this.#act({
        op: "create",
        threadId: view.threadId,
        title: goal,
        tags: splitTags(tags.value),
        milestones: plan.value.split("|").map((item) => item.trim()).filter(Boolean),
      });
    };
    for (const input of [title, tags, plan])
      input.addEventListener("keydown", (event) => {
        if (!event.isComposing && event.key === "Enter") {
          event.preventDefault();
          create();
        }
      });
    const nodes: Node[] = [
      h("div", { class: "draft-form" }, title, tags, plan, h("div", { class: "buttons" }, h("button", { class: "btn primary", text: t.setAsMainline, attrs: { type: "button" }, on: { click: create } }))),
    ];
    if (view.firstPrompt) nodes.push(h("div", { class: "asked", text: t.firstPromptLabel(view.firstPrompt) }));
    if (view.lastPrompt) nodes.push(h("div", { class: "asked", text: t.lastPromptLabel(view.lastPrompt.text) }));
    if (view.parent) nodes.push(this.#relatedLine(t.fromParent(view.parent.title), view.parent));
    if (view.children.length) nodes.push(this.#section(t.children, ...view.children.map((child) => this.#childRow(child))));
    if (view.refs.length) nodes.push(this.#section(t.windowRefs, ...view.refs.slice(0, 5).map((ref) => this.#refRow(ref, view.threadId, false))));
    nodes.push(h("div", { class: "hint", text: `${t.agentHint} ${t.overviewHint[this.options.surface]}` }));
    return nodes;
  }

  #relatedLine(text: string, related: RelatedView): HTMLElement {
    const row = this.#h("div", { class: "related" }, this.#h("span", { text }));
    this.#opens(row, related.threadId);
    return row;
  }

  /** A row that opens another conversation: by click, or by Enter or Space once it has the focus. */
  #opens(row: HTMLElement, threadId: string): void {
    row.setAttribute("data-clickable", "");
    row.setAttribute("role", "button");
    row.setAttribute("tabindex", "0");
    row.title = this.#t.open;
    row.addEventListener("click", () => this.options.openThread(threadId));
    row.addEventListener("keydown", (event) => {
      if (event.target !== row || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      this.options.openThread(threadId);
    });
  }

  #childRow(child: RelatedView): HTMLElement {
    const h = this.#h;
    const t = this.#t;
    const row = h(
      "div",
      { class: "row" },
      h("span", { class: "status", attrs: { "data-status": child.threadStatus }, title: t.status[child.threadStatus] }),
      h(
        "div",
        { class: "main" },
        h("span", { class: "who", text: child.title }),
        child.current ? h("div", { class: "meta", text: t.current(child.current) }) : null,
      ),
      child.progress ? h("span", { class: "count", text: t.progress(child.progress.done, child.progress.total) }) : null,
    );
    this.#opens(row, child.threadId);
    return row;
  }

  // -------------------------------------------------------------------------------------------
  // Search and links

  #searchPanel(): HTMLElement {
    const h = this.#h;
    const t = this.#t;
    const results = h("div", { class: "results" });
    const input = h("input", { class: "field search-input", attrs: { type: "search", placeholder: t.findConversationsPlaceholder, "aria-label": t.findConversations } });
    input.addEventListener("input", () => {
      clearTimeout(this.#searchTimer);
      const query = input.value.trim();
      this.#searchTimer = setTimeout(() => void this.#search(query, results), SEARCH_DELAY_MS);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        this.#searching = false;
        input.blur();
        this.#renderCard();
      }
    });
    return h("div", { class: "section search" }, input, results);
  }

  async #search(query: string, results: HTMLElement): Promise<void> {
    if (!query) {
      results.replaceChildren();
      return;
    }
    try {
      const found = (await this.options.call?.("search", { query })) as SearchResult[] | undefined;
      const list = Array.isArray(found) ? found : [];
      results.replaceChildren(...(list.length ? list.map((item) => this.#resultRow(item)) : [this.#h("div", { class: "muted", text: this.#t.noResults })]));
    } catch (error) {
      results.replaceChildren(this.#h("div", { class: "muted", text: this.#t.error(errorCodeOf(error), error instanceof Error ? error.message : String(error)) }));
    }
  }

  #resultRow(item: SearchResult): HTMLElement {
    const h = this.#h;
    const t = this.#t;
    const here = item.threadId === this.#model?.threadId;
    const meta = [
      item.draft ? t.draftLabel : null,
      item.progress.total ? t.progress(item.progress.done, item.progress.total) : null,
      item.current ? t.current(item.current) : null,
      item.tags.length ? item.tags.map((tag) => `#${tag}`).join(" ") : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return h(
      "div",
      { class: "row ref" },
      h("span", { class: "status", attrs: { "data-status": item.threadStatus } }),
      h(
        "div",
        { class: "main" },
        h("span", { class: "who", text: item.title }),
        meta ? h("div", { class: "meta", text: meta }) : null,
        h("div", { class: "asked", text: t.labelled(t.matchField[item.match.field], item.match.text) }),
      ),
      here
        ? h("span", { class: "muted", text: t.inThisWindow })
        : h("button", {
            class: "btn",
            text: t.jump,
            attrs: { type: "button" },
            on: {
              click: (event) => {
                event.stopPropagation();
                this.options.openThread(item.threadId);
                this.#setOpen(false);
              },
            },
          }),
    );
  }

  /** One PR or issue: what it is, where it came from, what was asked there, and a way back. */
  #refRow(ref: RefView, currentThread: string, isNews: boolean): HTMLElement {
    const h = this.#h;
    const t = this.#t;
    const now = this.#model?.now ?? Date.now();
    const origin = ref.origin;
    const here = origin?.threadId === currentThread;
    const link = h("a", {
      class: "ref-link",
      text: `#${ref.number}${ref.title ? ` ${ref.title}` : ""}`,
      title: ref.url,
      attrs: { href: ref.url, target: "_blank", rel: "noopener noreferrer" },
    });
    link.addEventListener("click", () => {
      if (isNews) void this.options.call?.("refs.seen", { key: ref.key });
    });
    const meta = [
      isNews && ref.activity ? `${t.reason(ref.activity.reason)} · ${t.time(ref.activity.at, now)}` : null,
      `${t.kind[ref.kind]}${ref.state ? ` · ${t.refState[ref.state]}` : ""}`,
      ref.repo,
      origin ? (here ? t.inThisWindow : t.fromWindow(origin.title ?? origin.threadId.slice(0, 8))) + (origin.turn ? ` ${t.turn(origin.turn)}` : "") : null,
    ]
      .filter(Boolean)
      .join(" · ");
    const jump =
      origin && !here
        ? h("button", {
            class: "btn",
            text: t.jump,
            attrs: { type: "button" },
            on: {
              click: (event) => {
                event.stopPropagation();
                void this.options.call?.("refs.seen", { key: ref.key });
                this.options.openThread(origin.threadId);
                this.#setOpen(false);
              },
            },
          })
        : null;
    return h(
      "div",
      { class: `row ref${isNews ? " news" : ""}` },
      icon(this.#doc, isNews ? "bell" : "open", "mark"),
      h(
        "div",
        { class: "main" },
        link,
        h("div", { class: "meta", text: meta }),
        origin?.prompt ? h("div", { class: "asked", text: t.asked(origin.prompt) }) : null,
        ref.note ? h("div", { class: "asked", text: t.noteLabel(ref.note) }) : null,
      ),
      jump,
    );
  }

  // -------------------------------------------------------------------------------------------
  // Small builders

  #closeButton(): HTMLElement {
    return this.#iconButton("close", this.#t.collapse, () => this.#setOpen(false));
  }

  #iconButton(name: IconName, label: string, onClick: () => void): HTMLElement {
    const button = this.#h("button", {
      class: "icon",
      title: label,
      attrs: { type: "button", "aria-label": label },
      on: {
        click: (event) => {
          event.stopPropagation();
          onClick();
        },
      },
    });
    button.append(icon(this.#doc, name));
    return button;
  }

  /**
   * A button that acts on a second click within three seconds, for what cannot be undone. The armed
   * state lives outside the button, so a redraw of the card in between keeps it; screen readers hear
   * that it waits. An icon button shows its words while it waits.
   */
  #confirmButton(key: string, label: string, onConfirm: () => void, options: { className?: string; icon?: IconName } = {}): HTMLElement {
    const button = this.#h("button", { title: label, attrs: { type: "button" } });
    const idle = () => {
      button.removeAttribute("data-confirm");
      if (options.icon) {
        button.className = "icon";
        button.setAttribute("aria-label", label);
        button.replaceChildren(icon(this.#doc, options.icon));
      } else {
        button.className = `btn ${options.className ?? ""}`.trim();
        button.textContent = label;
      }
    };
    const armed = () => {
      button.setAttribute("data-confirm", "");
      button.className = `btn ${options.icon ? "" : (options.className ?? "")}`.trim();
      button.removeAttribute("aria-label");
      button.textContent = this.#t.confirm;
    };
    if (this.#confirming.has(key)) armed();
    else idle();
    this.#confirmResets.set(key, idle);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const waiting = this.#t.armed(label);
      const timer = this.#confirming.get(key);
      if (timer !== undefined) {
        clearTimeout(timer);
        this.#confirming.delete(key);
        if (this.#live.textContent === waiting) this.#live.textContent = "";
        idle();
        onConfirm();
        return;
      }
      this.#confirming.set(
        key,
        setTimeout(() => {
          this.#confirming.delete(key);
          if (this.#live.textContent === waiting) this.#live.textContent = "";
          this.#confirmResets.get(key)?.();
        }, CONFIRM_MS),
      );
      armed();
      this.#live.textContent = waiting;
    });
    return button;
  }

  /** An inline editor: Enter or leaving the field saves, Escape cancels. */
  #editor(value: string, placeholder: string, save: (text: string) => void): HTMLInputElement {
    const input = this.#h("input", { class: "field", attrs: { type: "text", placeholder, "data-autofocus": "", "aria-label": placeholder } });
    input.value = value;
    let settled = false;
    const finish = (commit: boolean) => {
      if (settled) return;
      settled = true;
      this.#editing = null;
      const text = input.value.trim();
      if (commit && text !== value.trim()) save(text);
      else this.#renderCard();
    };
    input.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      if (event.key === "Enter") {
        event.preventDefault();
        finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
    return input;
  }

  /** A dashed "add" field that stays put for several entries in a row. */
  #adder(placeholder: string, add: (text: string) => Promise<boolean>): HTMLInputElement {
    const input = this.#h("input", { class: "field add", attrs: { type: "text", placeholder, "aria-label": placeholder } });
    input.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      if (event.key === "Enter") {
        event.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        input.value = "";
        void add(text);
      } else if (event.key === "Escape") {
        event.stopPropagation();
        input.value = "";
        input.blur();
      }
    });
    return input;
  }

  #section(title: string, ...children: Array<Node | null | false>): HTMLElement {
    return this.#h("div", { class: "section" }, this.#h("div", { class: "section-title", text: title }), ...children);
  }
}
