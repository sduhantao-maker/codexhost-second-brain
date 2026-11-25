/**
 * Sidebar hover card: resting the pointer on a conversation row for 0.4 s shows that
 * conversation's mainline (title, tags, milestones with the current one's tasks, child
 * conversations, its parent and main PRs or issues) beside the sidebar. While a row is hovered,
 * a small "◆ reached/total" badge sits next to the row's own pin and archive buttons.
 * See docs/superpowers/specs/2026-11-23-mainline-v2-design.md §6.
 *
 * Data comes from the backend's `conversation` method, per conversation, cached until the
 * controller reports a new snapshot version. From the card the user can open a child conversation
 * (with files uploaded along), ask for a summary and mark GitHub news seen; nothing here touches
 * the host's nodes: the card, the badge and the bells are overlays in a shadow root under body.
 *
 * A bell goes away only when the user acts on it, judged in the window where that happens: a click
 * (or Enter) on one of the conversation's rows while its bell or its card's news shows, "Got it" in
 * the card, "Open conversation" or "Got it" in the summary's list, or Go in the overview's PR tab.
 * Opening or switching conversations any other way leaves it. News whose conversation has no row
 * in sight here (in a collapsed group, scrolled away, not listed) is counted in one button at the
 * top of the sidebar, "🔔 N", which opens a list of it.
 */
import { ATTACH_MAX_FILE_BYTES, ATTACH_MAX_FILES, ATTACH_MAX_TOTAL_BYTES, attachmentKind, formatSize } from "../../core/attachments.js";
import type { ConversationView } from "../../core/conversation-view.js";
import { cleanText, isErrorCode } from "../../core/model.js";
import type { RefView } from "../../core/refs.js";
import { errorCodeOf, type ConversationParams } from "../../core/rpc.js";
import type { ControllerHandle, LiveData, SurfaceAdapter } from "../controller.js";
import { adoptStyles, builder, type Builder } from "../dom.js";
import { errorDetail, strings } from "../i18n.js";
import { detectScheme } from "../theme.js";
import { cardNodes, COMPOSE_IDLE, type CardActions, type CardContent, type ComposeState, type Expandable, type PendingFile, type SpawnTarget } from "./card.js";
import {
  badgeSpot,
  boxOf,
  CARD_WIDTH,
  cardSpot,
  hostContent,
  hostPopup,
  keepInside,
  newsBadgeSpot,
  onRowControl,
  SUMMARY_BAND,
  SUMMARY_SIZE,
  summarySpot,
  type Box,
} from "./layout.js";
import { hoverLocale, hoverStrings, type HoverStrings } from "./strings.js";
import { HOVER_CSS } from "./styles.js";
import { uploadFile } from "./upload.js";

/** How long the pointer rests on a row before the card shows. */
export const SHOW_DELAY_MS = 400;
/** How long the card stays after the pointer left both the row and the card. */
export const HIDE_DELAY_MS = 150;
/** Rows passed over quicker than this are not fetched. */
export const PREFETCH_DELAY_MS = 100;
/** How often the sidebar is looked up again, since the host may draw it late or anew. */
export const REBIND_MS = 1500;
export const HOST_ATTRIBUTE = "data-codexhost-mainline-hover";
const CACHE_LIMIT = 100;
const ERROR_LENGTH = 80;
/** How long a "open child conversation" button waits for its confirming second click. */
export const CONFIRM_MS = 3000;
/** After the window has the focus back from the file picker, this long for its answer. */
const PICKER_GRACE_MS = 1000;
/** A click counts for the row pressed this long before it at most. */
const PRESS_MS = 5000;
/** Clicking a row and the Enter that led to it count once. */
const ACTIVATED_MS = 1500;
/** Opening a conversation from the summary's list waits this long at most for its news to be marked seen. */
const SEEN_WAIT_MS = 1000;
/** The list the summary opens. */
const LIST_ID = "cxm-news-list";
const LIST_WIDTH = 300;
const LIST_GAP = 6;
/**
 * Where macOS draws a window's close, minimize and zoom buttons over Codex Desktop's page, in CSS
 * pixels: no element of the page shows them, so the summary is kept off this corner.
 */
const WINDOW_BUTTONS: Box = { left: 0, top: 0, right: 84, bottom: 44, width: 84, height: 44 };
/** The extension's own overlays: the capsule, this one and the ★ button. */
const OVERLAYS = "[data-codexhost-mainline], [data-codexhost-mainline-hover], [data-codexhost-mainline-favorites]";

/** A value for an attribute selector in double quotes. */
const quoted = (value: string) => value.replace(/["\\]/gu, "\\$&");

/** The upload stopped because the card closed. */
class Stopped extends Error {}

/** A pasted picture is called "image.png"; several in one go need names apart. */
function pastedName(file: File, next: () => number): string {
  const pasted = /^image\.(png|jpe?g|gif|webp|bmp|tiff?)$/iu.exec(file.name);
  if (file.name && !pasted) return file.name;
  const extension = pasted?.[1] ?? (file.type.startsWith("image/") ? file.type.slice(6).replace("jpeg", "jpg") : "bin");
  return `pasted-${next()}.${extension}`;
}

interface Row {
  element: HTMLElement;
  threadId: string;
  /** Where the row was when last measured; the host may swap the element for a new one meanwhile. */
  box: Box;
  /** Its conversation's bell was in sight as the pointer came onto the row (it hides while the row is hovered). */
  bell: boolean;
}

/** A row pressed: whose, where, when, and whether its conversation's news showed then. */
interface Press {
  threadId: string;
  box: Box;
  at: number;
  showing: boolean;
}

export function startHover(adapter: SurfaceAdapter, controller: ControllerHandle): () => void {
  if (!adapter.doc.defaultView || !adapter.sidebar || !adapter.rowAt) return () => undefined;
  const hover = new SidebarHover(adapter, controller);
  return () => hover.stop();
}

function isConversationView(value: unknown): value is ConversationView {
  if (typeof value !== "object" || value === null) return false;
  const view = value as Partial<Record<keyof ConversationView, unknown>>;
  return (
    typeof view.threadId === "string" &&
    typeof view.title === "string" &&
    Array.isArray(view.tags) &&
    Array.isArray(view.milestones) &&
    Array.isArray(view.children) &&
    Array.isArray(view.refs) &&
    typeof view.progress === "object" &&
    view.progress !== null
  );
}

/**
 * One short line in the card's language: an error the backend names by its code in the capsule's
 * words (a missing conversation in the card's own); any other the first line of its message, cut short.
 */
function shortError(error: unknown, t: HoverStrings): string {
  const code = errorCodeOf(error);
  const message = error instanceof Error ? error.message : String(error);
  if (code === "NO_THREAD") return t.noThread;
  if (isErrorCode(code)) return strings(t.locale).error(code, message);
  const line = errorDetail(message).split("\n")[0]?.trim() ?? "";
  const chars = Array.from(line);
  return chars.length > ERROR_LENGTH ? `${chars.slice(0, ERROR_LENGTH - 1).join("")}…` : line || "?";
}

class SidebarHover {
  readonly #adapter: SurfaceAdapter;
  readonly #doc: Document;
  readonly #win: Window & typeof globalThis;
  readonly #h: Builder;
  readonly #host: HTMLElement;
  readonly #root: HTMLElement;
  readonly #card: HTMLElement;
  readonly #badge: HTMLElement;
  /** The file picker behind the card's 📎 button; outside the card, which is rebuilt all the time. */
  readonly #picker: HTMLInputElement;
  /**
   * Tells screen readers that a button waits for its confirming click, or that a child is still
   * opening; outside the card, so rebuilding the card does not take it away mid-sentence.
   */
  readonly #live: HTMLElement;
  readonly #cleanup: Array<() => void> = [];
  readonly #actions: CardActions;
  #sidebar: Element | null = null;
  #unbindSidebar: (() => void) | undefined;
  /** The row under the pointer. */
  #row: Row | null = null;
  /** The row whose card is showing; null while the card is hidden. */
  #shown: Row | null = null;
  #overCard = false;
  #showTimer: ReturnType<typeof setTimeout> | undefined;
  #hideTimer: ReturnType<typeof setTimeout> | undefined;
  #prefetchTimer: ReturnType<typeof setTimeout> | undefined;
  #framePending = false;
  #version: string | undefined;
  /** Bumped with every new snapshot version; answers to older requests are dropped. */
  #generation = 0;
  #cache = new Map<string, ConversationView>();
  /** Views of the previous version, shown until fresh ones arrive. */
  #stale = new Map<string, ConversationView>();
  readonly #errors = new Map<string, string>();
  readonly #pending = new Map<string, object>();
  readonly #expanded = new Set<Expandable>();
  /** What the card shows now, to skip rebuilding it when nothing changed. */
  #rendered: { threadId: string; key: string } | null = null;
  /** The host's own preview of the row that the card sits beside, if any. */
  #beside: { element: Element; stop: () => void } | null = null;
  #overBeside = false;
  readonly #controller: ControllerHandle;
  /** Opening a child conversation from the card. */
  #compose: ComposeState = COMPOSE_IDLE;
  /** The files listed in #compose, by their id there. */
  readonly #files = new Map<string, File>();
  #fileSeq = 0;
  /** The file picker is open: the window has lost the focus to it, and the card stays. */
  #picking = false;
  #pickTimer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped when the card closes, which stops an upload under way. */
  #uploadRun = 0;
  #dragTimer: ReturnType<typeof setTimeout> | undefined;
  #armTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * A child conversation codexhost had not answered for in time: what was asked, in which card. What
   * was typed and attached stays until the conversation's view shows the child linked.
   */
  #awaiting: { threadId: string; target: SpawnTarget; run: number } | null = null;
  /** A render put off while the user typed; done once the field loses focus. */
  #renderLater = false;
  /** Summaries asked for from the card, by conversation, and when. */
  readonly #summarizing = new Map<string, number>();
  /** The conversation whose summary was just refused: no model is set for its agent. Shown until the card closes. */
  #summaryRefused: string | null = null;
  /** A summary asked for that failed for another reason, and why. Shown until the card closes or the next try. */
  #summaryFailed: { threadId: string; message: string } | null = null;
  /** Conversations with unseen GitHub news about PRs and issues they started, and how many. */
  #news = new Map<string, number>();
  /** That news, from the latest snapshot. */
  #alerts: RefView[] = [];
  /** The bell on each such conversation's row in the sidebar. */
  readonly #markers = new Map<string, HTMLElement>();
  /** The row pressed last, until its click. */
  #press: Press | null = null;
  /** The conversation whose news was last marked seen from its row, and when. */
  #activated: { threadId: string; at: number } | null = null;
  /** "🔔 N" at the top of the sidebar: news whose conversation has no row in sight here. */
  readonly #summary: HTMLButtonElement;
  /** The list the summary opens. */
  readonly #list: HTMLElement;
  /** The news the summary counts, newest first. */
  #unplaced: RefView[] = [];
  /** What the summary's place was worked out for (sidebar, window and text), and whether it sits over a list that scrolls. */
  #summaryFor = "";
  #summaryOverList = false;
  /** What the list shows now, to skip rebuilding it when nothing changed. */
  #listShows = "";
  #stopped = false;

  constructor(adapter: SurfaceAdapter, controller: ControllerHandle) {
    this.#adapter = adapter;
    this.#controller = controller;
    const doc = (this.#doc = adapter.doc);
    this.#win = doc.defaultView!;
    const h = (this.#h = builder(doc));
    this.#host = doc.createElement("div");
    this.#host.setAttribute(HOST_ATTRIBUTE, adapter.surface);
    const style = this.#host.style;
    style.position = "fixed";
    style.left = "0";
    style.top = "0";
    style.width = "0";
    style.height = "0";
    // Above the sidebar and the capsule (2147483000).
    style.zIndex = "2147483001";
    style.pointerEvents = "none";
    style.setProperty("-webkit-app-region", "no-drag");
    style.setProperty("app-region", "no-drag");
    const shadow = this.#host.attachShadow({ mode: "open" });
    adoptStyles(shadow, HOVER_CSS);
    this.#card = h("div", { class: "card", attrs: { role: "dialog", hidden: "" } });
    this.#badge = h("div", { class: "badge", attrs: { "aria-hidden": "true", hidden: "" } });
    this.#picker = h("input", { class: "picker", attrs: { type: "file", multiple: "", hidden: "", tabindex: "-1", "aria-hidden": "true" } });
    this.#live = h("div", { class: "sr-only", attrs: { role: "status", "aria-live": "polite" } });
    this.#summary = h("button", {
      class: "summary",
      attrs: { type: "button", hidden: "", "aria-haspopup": "dialog", "aria-expanded": "false", "aria-controls": LIST_ID },
      on: { click: () => this.#toggleList() },
    });
    this.#list = h("div", { class: "news-list", attrs: { id: LIST_ID, role: "dialog", hidden: "" } });
    this.#root = h("div", { class: "root" }, this.#card, this.#badge, this.#summary, this.#list, this.#picker, this.#live);
    shadow.append(this.#root);

    this.#actions = {
      open: (threadId) => {
        try {
          this.#adapter.openThread(threadId);
        } catch (error) {
          console.warn("[mainline] could not open the conversation", error);
        } finally {
          this.#hide();
        }
      },
      expand: (what) => {
        this.#expanded.add(what);
        this.#renderCard();
      },
      // Let the link open first; the card has done its job.
      followed: () => {
        this.#cancelHide();
        this.#hideTimer = setTimeout(() => this.#hide(), 0);
      },
      compose: (open) => {
        clearTimeout(this.#armTimer);
        this.#files.clear();
        this.#setCompose({ ...COMPOSE_IDLE, open });
        if (open) this.#focusField();
      },
      // Typing changes nothing on screen; the text is kept for the next render.
      type: (text) => {
        this.#compose = { ...this.#compose, text };
      },
      attach: () => {
        if (this.#compose.busy) return;
        // The window loses the focus to the picker: the card must not take that for leaving.
        this.#picking = true;
        clearTimeout(this.#pickTimer);
        try {
          this.#picker.click();
        } catch {
          this.#picking = false;
        }
      },
      detach: (fileId) => {
        if (this.#compose.busy) return;
        this.#files.delete(fileId);
        const { notice: _notice, ...rest } = this.#compose;
        this.#setCompose({ ...rest, files: rest.files.filter((file) => file.id !== fileId) });
      },
      spawn: (target, key) => this.#spawn(target, key),
      summarize: () => {
        const threadId = this.#shown?.threadId;
        if (!threadId) return;
        this.#summaryRefused = null;
        this.#summaryFailed = null;
        this.#summarizing.set(threadId, Date.now());
        this.#renderCard(false, true);
        void Promise.resolve()
          .then(() => this.#adapter.invoke("summarize", { threadId }))
          .catch((error: unknown) => {
            this.#summarizing.delete(threadId);
            // Another agent's conversation with no model set for those: say so, and which setting decides.
            // Any other cause the backend names (the mainlines are full, the data is busy) is said too.
            const code = errorCodeOf(error);
            if (this.#shown?.threadId === threadId) {
              if (code === "NO_SUMMARIZER") this.#summaryRefused = threadId;
              else if (isErrorCode(code)) this.#summaryFailed = { threadId, message: shortError(error, this.#strings()) };
            }
            this.#renderCard(false, true);
          });
      },
      seen: (refKey) => {
        void Promise.resolve()
          .then(() => this.#adapter.invoke("refs.seen", { key: refKey }))
          .then(() => this.#controller.refresh())
          .catch(() => undefined);
      },
    };

    this.#listen(this.#card, "pointerenter", () => {
      this.#overCard = true;
      this.#cancelHide();
    });
    this.#listen(this.#card, "pointerleave", () => {
      this.#overCard = false;
      if (!this.#row) this.#scheduleHide();
    });
    // Leaving the field: catch up on what changed meanwhile, and go if the pointer has gone too.
    this.#listen(this.#card, "focusout", () => {
      setTimeout(() => {
        if (this.#stopped || this.#typing()) return;
        if (this.#renderLater) {
          this.#renderLater = false;
          this.#renderCard();
        }
        if (this.#shown && !this.#row && !this.#overCard && !this.#overBeside) this.#scheduleHide();
      }, 0);
    });
    this.#listen(doc, "keydown", (event) => {
      if ((event as KeyboardEvent).key !== "Escape") return;
      if (this.#shown || this.#showTimer) this.#hide();
      if (!this.#list.hidden) this.#closeList(this.#focusIn(this.#list) || this.#focusIn(this.#summary));
    }, true);
    // A press anywhere but on the summary or its list closes the list.
    this.#listen(doc, "pointerdown", (event) => {
      if (this.#list.hidden) return;
      const path = event.composedPath();
      if (!path.includes(this.#list) && !path.includes(this.#summary)) this.#closeList(false);
    }, true);
    // Going to the background hides the card, unless the user is in the middle of a new problem:
    // picking files, fetching one to drop from another app, or sending them.
    this.#listen(doc, "visibilitychange", () => {
      if (doc.visibilityState === "hidden" && !this.#holding()) this.#reset();
    });
    this.#listen(this.#win, "blur", () => {
      if (!this.#holding()) this.#reset();
    });
    this.#listen(this.#picker, "change", () => {
      this.#picking = false;
      const files = [...(this.#picker.files ?? [])];
      this.#picker.value = "";
      this.#addFiles(files);
    });
    this.#listen(this.#picker, "cancel", () => {
      this.#picking = false;
    });
    // Engines without the picker's "cancel" event: the focus coming back ends the picking soon after.
    this.#listen(this.#win, "focus", () => {
      if (!this.#picking) return;
      clearTimeout(this.#pickTimer);
      this.#pickTimer = setTimeout(() => (this.#picking = false), PICKER_GRACE_MS);
    });
    // A screenshot pasted into the field, or files dropped on the card, go with the new problem.
    this.#listen(this.#card, "paste", (event) => {
      const files = [...((event as ClipboardEvent).clipboardData?.files ?? [])];
      if (!files.length || !this.#compose.open) return;
      event.preventDefault();
      this.#addFiles(files);
    });
    const dragging = (event: Event) => {
      const transfer = (event as DragEvent).dataTransfer;
      if (!transfer || !Array.from(transfer.types ?? []).includes("Files") || this.#compose.busy) return;
      event.preventDefault();
      transfer.dropEffect = "copy";
      this.#cancelHide();
      this.#card.setAttribute("data-dragging", this.#strings().dropHere);
      // "dragover" keeps coming while the files are over the card; when it stops, they have left.
      clearTimeout(this.#dragTimer);
      this.#dragTimer = setTimeout(() => this.#card.removeAttribute("data-dragging"), 250);
    };
    this.#listen(this.#card, "dragenter", dragging);
    this.#listen(this.#card, "dragover", dragging);
    this.#listen(this.#card, "drop", (event) => {
      clearTimeout(this.#dragTimer);
      this.#card.removeAttribute("data-dragging");
      const files = [...((event as DragEvent).dataTransfer?.files ?? [])];
      if (!files.length) return;
      event.preventDefault();
      this.#addFiles(files);
    });
    this.#listen(doc, "scroll", (event) => this.#onScroll(event), { capture: true, passive: true });
    this.#listen(this.#win, "resize", () => this.#onScroll(null));

    // The host may show its own preview of the row around the same time as the card: codexhost Web
    // adds it to body, Codex Desktop opens a popover (whose toggle event does not bubble, hence capture).
    const popups = new this.#win.MutationObserver(() => this.#makeRoom());
    popups.observe(doc.body ?? doc.documentElement, { childList: true });
    this.#cleanup.push(() => popups.disconnect());
    this.#listen(doc, "toggle", () => this.#makeRoom(), true);

    this.#cleanup.push(
      controller.subscribe((version, data) => {
        this.#onVersion(version);
        this.#onNews(data);
      }),
    );
    this.#bindSidebar();
    // The host may draw the sidebar late or anew, and move rows without scrolling: look again now and then.
    const rebind = setInterval(() => {
      this.#bindSidebar();
      this.#placeMarkers(true);
    }, REBIND_MS);
    this.#cleanup.push(() => clearInterval(rebind));
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#uploadRun += 1;
    clearTimeout(this.#pickTimer);
    clearTimeout(this.#dragTimer);
    this.#files.clear();
    clearTimeout(this.#showTimer);
    this.#cancelHide();
    clearTimeout(this.#prefetchTimer);
    this.#unbindSidebar?.();
    this.#unbindSidebar = undefined;
    this.#bridge(null);
    for (const stop of this.#cleanup.splice(0)) {
      try {
        stop();
      } catch {
        // Keep tearing down.
      }
    }
    this.#host.remove();
    this.#markers.clear();
    this.#alerts = [];
    this.#unplaced = [];
    this.#press = null;
    this.#cache.clear();
    this.#stale.clear();
    this.#errors.clear();
    this.#pending.clear();
    this.#row = null;
    this.#shown = null;
  }

  // -------------------------------------------------------------------------------------------
  // Following the pointer

  #listen(target: EventTarget, type: string, listener: (event: Event) => void, options?: boolean | AddEventListenerOptions): void {
    target.addEventListener(type, listener, options);
    this.#cleanup.push(() => target.removeEventListener(type, listener, options));
  }

  /** Listens on the sidebar the adapter reports, moving over when the host draws a new one. */
  #bindSidebar(): void {
    if (this.#stopped) return;
    let next: Element | null;
    try {
      next = this.#adapter.sidebar?.() ?? null;
    } catch {
      next = null;
    }
    if (next === this.#sidebar) return;
    this.#unbindSidebar?.();
    this.#unbindSidebar = undefined;
    this.#sidebar = next;
    if (this.#row && !next?.contains(this.#row.element)) this.#leaveRow();
    if (!next) return;
    const over = (event: Event) => this.#onOver(event);
    const out = (event: Event) => this.#onOut(event);
    const leave = () => this.#leaveRow();
    // Clicking a row opens it; the card would only be in the way. Whether the row's news showed is
    // noted first: the click that follows counts as seeing it.
    const down = (event: Event) => {
      this.#notePress(event);
      this.#hide();
    };
    // In the capture phase, so that the host stopping the event on the row cannot hide it from here.
    const click = (event: Event) => this.#onRowClick(event as MouseEvent);
    const key = (event: Event) => this.#onRowKey(event as KeyboardEvent);
    next.addEventListener("pointerover", over);
    next.addEventListener("pointerout", out);
    next.addEventListener("pointerleave", leave);
    next.addEventListener("pointerdown", down, true);
    next.addEventListener("click", click, true);
    next.addEventListener("keydown", key, true);
    this.#unbindSidebar = () => {
      next.removeEventListener("pointerover", over);
      next.removeEventListener("pointerout", out);
      next.removeEventListener("pointerleave", leave);
      next.removeEventListener("pointerdown", down, true);
      next.removeEventListener("click", click, true);
      next.removeEventListener("keydown", key, true);
    };
  }

  /** The conversation row under an event target, if any. */
  #rowAt(target: EventTarget | null): { element: HTMLElement; threadId: string } | null {
    try {
      return this.#adapter.rowAt?.(target) ?? null;
    } catch {
      return null;
    }
  }

  /** Whether this conversation's bell is on screen in the sidebar now. */
  #bellInSight(threadId: string): boolean {
    const marker = this.#markers.get(threadId);
    return Boolean(marker?.isConnected && !marker.hidden);
  }

  /**
   * Whether the user can see that this conversation has news: its bell in the sidebar, or the news
   * on top of its hover card. The bell hides while its row is hovered, so the row under the pointer
   * counts when the bell was in sight as the pointer came onto it.
   */
  #newsShowing(threadId: string): boolean {
    if (this.#bellInSight(threadId)) return true;
    if (this.#row?.threadId === threadId && this.#row.bell) return true;
    return this.#shown?.threadId === threadId && !this.#card.hidden && this.#card.querySelector('[data-section="news"]') !== null;
  }

  #notePress(event: Event): void {
    const hit = this.#rowAt(event.target);
    this.#press =
      hit && !onRowControl(event.target, hit.element)
        ? { threadId: hit.threadId, box: boxOf(hit.element), at: Date.now(), showing: this.#newsShowing(hit.threadId) }
        : null;
  }

  /**
   * A click that opens a conversation from its row while its bell or its card's news showed (as it
   * was when the row was pressed) marks the news of the PRs and issues it started as seen. Clicks on
   * the row's own small buttons (pin, archive, a menu) do not open it, and do not count.
   */
  #onRowClick(event: MouseEvent): void {
    const press = this.#press;
    this.#press = null;
    const recent = press && Date.now() - press.at < PRESS_MS ? press : null;
    let hit: { element: HTMLElement | null; threadId: string } | null = this.#rowAt(event.target);
    // The host drew the row anew between the press and the click: where it was pressed tells.
    if (!hit && recent && event.clientX >= recent.box.left && event.clientX <= recent.box.right && event.clientY >= recent.box.top && event.clientY <= recent.box.bottom)
      hit = { element: null, threadId: recent.threadId };
    if (!hit || (hit.element && onRowControl(event.target, hit.element))) return;
    const showing = recent?.threadId === hit.threadId ? recent.showing : this.#newsShowing(hit.threadId);
    if (showing) this.#seenFromRow(hit.threadId);
  }

  /** Enter on a row opens it too (a row that is a button or link also gets a click, which counts once with it). */
  #onRowKey(event: KeyboardEvent): void {
    if (event.key !== "Enter" || event.isComposing || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const hit = this.#rowAt(event.target);
    if (!hit || onRowControl(event.target, hit.element)) return;
    if (this.#newsShowing(hit.threadId)) this.#seenFromRow(hit.threadId);
  }

  /** Marks seen the news of every PR and issue this conversation started, as opening it from its row while the news showed. */
  #seenFromRow(threadId: string): void {
    const last = this.#activated;
    if (last?.threadId === threadId && Date.now() - last.at < ACTIVATED_MS) return;
    this.#activated = { threadId, at: Date.now() };
    void Promise.resolve()
      .then(() => this.#adapter.invoke("refs.seenForThread", { threadId }))
      .then(() => this.#controller.refresh())
      .catch(() => undefined);
  }

  #onOver(event: Event): void {
    // Touch has no hover; a long press would only leave a card behind.
    if ((event as PointerEvent).pointerType === "touch") return;
    const hit = this.#rowAt(event.target);
    if (hit) this.#enterRow(hit);
    else this.#leaveRow();
  }

  #onOut(event: Event): void {
    if ((event as PointerEvent).pointerType === "touch") return;
    const to = (event as MouseEvent).relatedTarget;
    // Moving within the sidebar: the pointerover that follows decides.
    if (to instanceof Node && this.#sidebar?.contains(to)) return;
    this.#leaveRow();
  }

  #enterRow(found: { element: HTMLElement; threadId: string }): void {
    this.#cancelHide();
    // While the user types a new problem (or one is being opened), the card stays with its conversation.
    if (this.#shown && this.#holding() && found.threadId !== this.#shown.threadId) return;
    const row = this.#row;
    if (row && row.element === found.element && row.threadId === found.threadId) return;
    // The bell hides once the pointer is on its conversation's row: note whether it was in sight first.
    const bell = this.#bellInSight(found.threadId) || (row?.threadId === found.threadId && row.bell);
    const hit: Row = { element: found.element, threadId: found.threadId, box: boxOf(found.element), bell };
    this.#row = hit;
    clearTimeout(this.#prefetchTimer);
    this.#renderBadge();
    this.#placeMarkers();
    if (!this.#cache.has(hit.threadId)) this.#prefetchTimer = setTimeout(() => this.#load(hit.threadId), PREFETCH_DELAY_MS);
    if (this.#shown) {
      // The card is open: follow the pointer at once.
      this.#show(hit);
      return;
    }
    clearTimeout(this.#showTimer);
    this.#showTimer = setTimeout(() => {
      this.#showTimer = undefined;
      if (this.#row === hit) this.#show(hit);
    }, SHOW_DELAY_MS);
  }

  #leaveRow(): void {
    clearTimeout(this.#showTimer);
    this.#showTimer = undefined;
    clearTimeout(this.#prefetchTimer);
    this.#row = null;
    this.#badge.hidden = true;
    this.#placeMarkers();
    if (this.#shown && !this.#overCard) this.#scheduleHide();
  }

  /** Hides the card soon, unless the pointer comes back to a row or onto the card (or the host's preview beside it) first. */
  #scheduleHide(): void {
    if (this.#hideTimer !== undefined) return;
    this.#hideTimer = setTimeout(() => {
      this.#hideTimer = undefined;
      if (!this.#row && !this.#overCard && !this.#overBeside && !this.#holding()) this.#hide();
    }, HIDE_DELAY_MS);
  }

  /**
   * The user is in the middle of a new problem: typing it, picking files for it or having added
   * some, or opening the child conversation. The card stays with its conversation meanwhile.
   */
  #holding(): boolean {
    return this.#compose.busy || this.#picking || this.#compose.files.length > 0 || this.#typing();
  }

  #focusField(): void {
    const field = this.#card.querySelector<HTMLInputElement>("input.compose-input");
    if (field && !field.disabled) {
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    }
  }

  /** Adds picked, pasted or dropped files to the new problem, opening its field if need be. */
  #addFiles(list: readonly File[]): void {
    if (!this.#shown || this.#compose.busy || !list.length) return;
    const t = this.#strings();
    const files = [...this.#compose.files];
    let total = files.reduce((sum, file) => sum + file.size, 0);
    let pasted = files.filter((file) => /^pasted-\d+\./u.test(file.name)).length;
    let notice: string | undefined;
    for (const file of list) {
      if (files.length >= ATTACH_MAX_FILES) {
        notice = t.tooMany(ATTACH_MAX_FILES);
        break;
      }
      const name = pastedName(file, () => ++pasted);
      if (file.size > ATTACH_MAX_FILE_BYTES) notice = t.tooLarge(name, formatSize(ATTACH_MAX_FILE_BYTES));
      else if (total + file.size > ATTACH_MAX_TOTAL_BYTES) notice = t.tooMuch(formatSize(ATTACH_MAX_TOTAL_BYTES));
      else {
        const id = `f${++this.#fileSeq}`;
        this.#files.set(id, file);
        files.push({ id, name, size: file.size, kind: attachmentKind(name, file.type) });
        total += file.size;
      }
    }
    const { result: _result, notice: _notice, ...rest } = this.#compose;
    const opening = !rest.open;
    this.#setCompose({ ...rest, open: true, files, armed: null, ...(notice ? { notice } : {}) });
    if (opening) this.#focusField();
  }

  /** Sends the files of the new problem to the backend, keeping the button's percentage current. */
  async #upload(files: readonly PendingFile[], run: number): Promise<string[]> {
    const total = files.reduce((sum, file) => sum + file.size, 0);
    let sent = 0;
    let shown = 0;
    const ids: string[] = [];
    for (const pending of files) {
      const file = this.#files.get(pending.id);
      if (!file) throw new Stopped();
      const id = await uploadFile(this.#adapter.invoke.bind(this.#adapter), file, pending.name, (bytes) => {
        if (run !== this.#uploadRun) throw new Stopped();
        sent += bytes;
        const percent = total ? Math.min(99, Math.floor((sent / total) * 100)) : 99;
        if (percent !== shown) {
          shown = percent;
          this.#setCompose({ ...this.#compose, uploading: percent });
        }
      });
      if (run !== this.#uploadRun) throw new Stopped();
      ids.push(id);
    }
    return ids;
  }

  #typing(): boolean {
    const active = this.#host.shadowRoot?.activeElement;
    return active?.tagName === "INPUT" && this.#card.contains(active);
  }

  /** Says `text` to screen readers once; the same text again is not repeated. */
  #say(text: string): void {
    if (this.#live.textContent !== text) this.#live.textContent = text;
  }

  /**
   * A child codexhost had not answered for in time shows up in its parent's view, linked: the card
   * says it opened, and what was typed and attached for it goes, as when codexhost answers at once.
   */
  #linked(threadId: string, view: ConversationView): void {
    const awaiting = this.#awaiting;
    if (!awaiting || awaiting.threadId !== threadId) return;
    const { target } = awaiting;
    let text = "";
    try {
      text = cleanText(target.text);
    } catch {
      // Nothing to match by text: only a spin-off's id can tell.
    }
    const spinoff = view.spinoffs.find(
      (item) => item.state === "spawned" && item.childThreadId && ("spinoffId" in target ? item.id === target.spinoffId : item.text === text),
    );
    if (!spinoff?.childThreadId) return;
    this.#awaiting = null;
    if (this.#shown?.threadId !== threadId || awaiting.run !== this.#uploadRun) return;
    const opened = { ok: true as const, childThreadId: spinoff.childThreadId, title: target.text };
    if ("spinoffId" in target) {
      const { result: _previous, uploading: _uploading, ...rest } = this.#compose;
      this.#compose = { ...rest, busy: false, armed: null, result: opened };
    } else {
      this.#files.clear();
      this.#compose = { ...COMPOSE_IDLE, result: opened };
    }
  }

  #setCompose(next: ComposeState): void {
    this.#compose = next;
    this.#renderCard(false, true);
  }

  /** The first click arms the button for a few seconds; a second click opens the child conversation. */
  #spawn(target: SpawnTarget, key: string): void {
    const shown = this.#shown;
    if (!shown || this.#compose.busy) return;
    clearTimeout(this.#armTimer);
    if (this.#compose.armed !== key) {
      const { result: _previous, ...rest } = this.#compose;
      this.#setCompose({ ...rest, armed: key });
      this.#armTimer = setTimeout(() => {
        if (this.#compose.armed === key && !this.#compose.busy) this.#setCompose({ ...this.#compose, armed: null });
      }, CONFIRM_MS);
      return;
    }
    const threadId = shown.threadId;
    // The files go with a new problem only; a spin-off noted earlier is opened as it is.
    const files = "spinoffId" in target ? [] : this.#compose.files;
    const run = this.#uploadRun;
    const { notice: _notice, ...composing } = this.#compose;
    this.#setCompose({ ...composing, busy: true, ...(files.length ? { uploading: 0 } : {}) });
    Promise.resolve()
      .then(() => (files.length ? this.#upload(files, run) : []))
      .then((attachments) => {
        if (attachments.length) {
          const { uploading: _done, ...rest } = this.#compose;
          this.#setCompose(rest);
        }
        const params =
          "spinoffId" in target
            ? { threadId, spinoffId: target.spinoffId }
            : { threadId, text: target.text, ...(attachments.length ? { attachments } : {}) };
        return this.#adapter.invoke("spawn", params);
      })
      .then((result) => {
        const childThreadId = (result as { childThreadId?: unknown } | null)?.childThreadId;
        if (typeof childThreadId !== "string" || !childThreadId) throw new Error(this.#strings().badResponse);
        if (this.#shown?.threadId !== threadId || run !== this.#uploadRun) return;
        this.#awaiting = null;
        const opened = { ok: true as const, childThreadId, title: target.text };
        if ("spinoffId" in target) {
          // A spin-off was opened: what is typed and attached for a new problem stays.
          const { result: _previous, uploading: _uploading, ...rest } = this.#compose;
          this.#setCompose({ ...rest, busy: false, armed: null, result: opened });
        } else {
          this.#files.clear();
          this.#setCompose({ ...COMPOSE_IDLE, result: opened });
        }
      })
      .catch((error: unknown) => {
        // Closed meanwhile: nothing is left to tell.
        if (error instanceof Stopped || this.#shown?.threadId !== threadId || run !== this.#uploadRun) return;
        const { result: _previous, uploading: _uploading, ...rest } = this.#compose;
        if (errorCodeOf(error) === "PENDING") {
          // No answer from codexhost in time: the child goes on opening in the background. Nothing
          // failed, so nothing is cleared yet: the text and files stay until the child shows up.
          this.#awaiting = { threadId, target, run };
          this.#setCompose({ ...rest, busy: false, armed: null, result: { ok: false, pending: true, message: this.#strings().spawnPending } });
          return;
        }
        this.#setCompose({ ...rest, busy: false, armed: null, result: { ok: false, message: shortError(error, this.#strings()) } });
      })
      .finally(() => {
        void this.#controller.refresh();
        if (this.#shown && !this.#row && !this.#overCard && !this.#overBeside) this.#scheduleHide();
      });
  }

  /**
   * Follows the host's own preview that the card sits beside: the pointer crosses it on the way
   * from the row to the card, so being on it keeps the card.
   */
  #bridge(element: Element | null): void {
    if (element === (this.#beside?.element ?? null)) return;
    this.#beside?.stop();
    this.#beside = null;
    this.#overBeside = false;
    if (!element) return;
    const enter = () => {
      this.#overBeside = true;
      this.#cancelHide();
    };
    const leave = () => {
      this.#overBeside = false;
      if (!this.#row && !this.#overCard) this.#scheduleHide();
    };
    element.addEventListener("pointerenter", enter);
    element.addEventListener("pointerleave", leave);
    this.#beside = {
      element,
      stop: () => {
        element.removeEventListener("pointerenter", enter);
        element.removeEventListener("pointerleave", leave);
      },
    };
  }

  #cancelHide(): void {
    clearTimeout(this.#hideTimer);
    this.#hideTimer = undefined;
  }

  /** Keeps the card, the badge and the bells on their rows while the sidebar scrolls; other scrolling is ignored. */
  #onScroll(event: Event | null): void {
    const element = this.#shown?.element ?? this.#row?.element ?? (this.#news.size ? this.#sidebar : null);
    if (!element || this.#framePending) return;
    const target = event?.target;
    // What scrolls holds the row, or is a list in the sidebar (codexhost Web's sidebar holds its own).
    if (target instanceof Node && target !== this.#doc && !target.contains(element) && !(this.#news.size && this.#sidebar?.contains(target))) return;
    this.#framePending = true;
    const run = () => {
      this.#framePending = false;
      if (this.#stopped) return;
      this.#reposition();
      // The summary moves only when what scrolled went under it.
      this.#placeMarkers(this.#summaryOverList);
    };
    if (typeof this.#win.requestAnimationFrame === "function") this.#win.requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  #reposition(): void {
    const shown = this.#shown;
    if (shown?.element.isConnected && this.#sidebar) {
      const row = boxOf(shown.element);
      const area = boxOf(this.#sidebar);
      // Its row scrolled out of the sidebar: the card no longer points at anything.
      if (area.height > 0 && (row.bottom <= area.top || row.top >= area.bottom)) this.#hide();
      else this.#placeCard();
    }
    if (this.#row) this.#renderBadge();
  }

  /** Hides everything at once, as when the page goes to the background. */
  #reset(): void {
    this.#hide();
    clearTimeout(this.#prefetchTimer);
    this.#row = null;
    this.#badge.hidden = true;
    if (!this.#list.hidden) this.#closeList(false);
  }

  // -------------------------------------------------------------------------------------------
  // Data

  #onVersion(version: string): void {
    if (this.#stopped || version === this.#version) return;
    this.#version = version;
    this.#generation += 1;
    this.#stale = this.#cache;
    this.#cache = new Map();
    this.#errors.clear();
    this.#pending.clear();
    if (this.#shown) this.#load(this.#shown.threadId);
    if (this.#row) this.#load(this.#row.threadId);
  }

  #viewOf(threadId: string): ConversationView | undefined {
    return this.#cache.get(threadId) ?? this.#stale.get(threadId);
  }

  #load(threadId: string): void {
    if (this.#stopped || this.#cache.has(threadId) || this.#pending.has(threadId)) return;
    const generation = this.#generation;
    const token = {};
    this.#pending.set(threadId, token);
    let request: Promise<unknown>;
    try {
      request = Promise.resolve(this.#adapter.invoke("conversation", { threadId } satisfies ConversationParams));
    } catch (error) {
      request = Promise.reject(error);
    }
    request
      .then(
        (result) => this.#settle(threadId, generation, token, isConversationView(result) ? result : new Error(this.#strings().badResponse)),
        (error: unknown) => this.#settle(threadId, generation, token, error instanceof Error ? error : new Error(String(error))),
      )
      .catch((error: unknown) => console.warn("[mainline] hover card", error));
  }

  #settle(threadId: string, generation: number, token: object, outcome: ConversationView | Error): void {
    if (this.#pending.get(threadId) === token) this.#pending.delete(threadId);
    if (this.#stopped) return;
    if (generation !== this.#generation) {
      // An answer from before the latest version: still better than "loading" until the fresh one arrives.
      if (outcome instanceof Error || this.#cache.has(threadId)) return;
      this.#stale.set(threadId, outcome);
    } else if (outcome instanceof Error) this.#errors.set(threadId, shortError(outcome, this.#strings()));
    else {
      this.#linked(threadId, outcome);
      this.#cache.delete(threadId);
      this.#cache.set(threadId, outcome);
      if (this.#cache.size > CACHE_LIMIT) {
        const oldest = this.#cache.keys().next().value;
        if (oldest !== undefined) this.#cache.delete(oldest);
      }
      this.#stale.delete(threadId);
      this.#errors.delete(threadId);
    }
    if (this.#shown?.threadId === threadId) this.#renderCard();
    if (this.#row?.threadId === threadId) this.#renderBadge();
  }

  // -------------------------------------------------------------------------------------------
  // Drawing

  #strings(): HoverStrings {
    return hoverStrings(hoverLocale(this.#doc));
  }

  /** Puts the overlay under body (again, if the host replaced body's children) in the sidebar's light or dark. */
  #mount(): void {
    if (!this.#host.isConnected) (this.#doc.body ?? this.#doc.documentElement).append(this.#host);
    let scheme: string;
    try {
      scheme = detectScheme(this.#doc, this.#sidebar);
    } catch {
      scheme = "light";
    }
    if (this.#root.getAttribute("data-scheme") !== scheme) this.#root.setAttribute("data-scheme", scheme);
  }

  #show(hit: Row): void {
    clearTimeout(this.#showTimer);
    this.#showTimer = undefined;
    this.#cancelHide();
    const switching = this.#shown?.threadId !== hit.threadId;
    this.#shown = hit;
    if (switching) {
      this.#expanded.clear();
      this.#rendered = null;
      clearTimeout(this.#armTimer);
      this.#uploadRun += 1;
      this.#files.clear();
      this.#compose = COMPOSE_IDLE;
      this.#awaiting = null;
    }
    this.#mount();
    this.#card.hidden = false;
    this.#renderCard(switching);
    this.#load(hit.threadId);
  }

  #hide(): void {
    clearTimeout(this.#showTimer);
    this.#showTimer = undefined;
    this.#cancelHide();
    this.#overCard = false;
    this.#bridge(null);
    clearTimeout(this.#armTimer);
    clearTimeout(this.#dragTimer);
    this.#card.removeAttribute("data-dragging");
    // Closing the card drops its files and stops an upload under way.
    this.#uploadRun += 1;
    this.#files.clear();
    this.#picking = false;
    this.#compose = COMPOSE_IDLE;
    this.#awaiting = null;
    this.#say("");
    this.#renderLater = false;
    this.#summaryRefused = null;
    this.#summaryFailed = null;
    if (!this.#shown) return;
    this.#shown = null;
    this.#rendered = null;
    this.#card.hidden = true;
    this.#card.replaceChildren();
  }

  /** Rebuilds the card when what it shows changed; `force` also while the user types in it. */
  #renderCard(fromTop = false, force = false): void {
    const shown = this.#shown;
    if (!shown) return;
    const typing = this.#typing();
    if (typing && !force) {
      // Rebuilding now would take the field (and the caret) away from the user.
      this.#renderLater = true;
      this.#placeCard();
      return;
    }
    const threadId = shown.threadId;
    const view = this.#viewOf(threadId);
    const error = this.#errors.get(threadId);
    const content: CardContent = view ? { kind: "view", view } : error !== undefined ? { kind: "error", message: error } : { kind: "loading" };
    const t = this.#strings();
    const result = this.#compose.result;
    this.#say(this.#compose.armed !== null && !this.#compose.busy ? t.armed(t.spawnChild) : result && !result.ok && result.pending ? result.message : "");
    const { text: _typed, ...compose } = this.#compose;
    // Asked for a summary: "summarizing" until a newer one arrives (or a few minutes pass).
    const asked = this.#summarizing.get(threadId);
    const summarizing = asked !== undefined && (view?.summary?.at ?? 0) < asked && Date.now() - asked < 3 * 60_000;
    if (asked !== undefined && !summarizing) this.#summarizing.delete(threadId);
    const refused = this.#summaryRefused === threadId;
    const failed = this.#summaryFailed?.threadId === threadId ? this.#summaryFailed.message : undefined;
    const key = `${t.locale}|${[...this.#expanded].sort().join(",")}|${JSON.stringify(compose)}|${summarizing}|${refused}|${failed ?? ""}|${JSON.stringify(content)}`;
    if (this.#rendered?.threadId !== threadId || this.#rendered.key !== key) {
      const scroll = fromTop ? 0 : this.#card.scrollTop;
      let nodes: Node[];
      try {
        nodes = cardNodes(content, {
          h: this.#h,
          t,
          now: Date.now(),
          expanded: this.#expanded,
          actions: this.#actions,
          compose: this.#compose,
          summarizing,
          summaryRefused: refused,
          ...(failed ? { summaryFailed: failed } : {}),
        });
      } catch (error) {
        nodes = cardNodes(
          { kind: "error", message: shortError(error, t) },
          { h: this.#h, t, now: Date.now(), expanded: this.#expanded, actions: this.#actions, compose: this.#compose },
        );
      }
      this.#card.replaceChildren(...nodes);
      this.#card.scrollTop = scroll;
      // The field was rebuilt under the user's hands: give it the focus and the caret back.
      if (typing) this.#focusField();
      this.#card.setAttribute("aria-label", view?.title ?? t.loading);
      this.#card.setAttribute("data-thread", threadId);
      this.#rendered = { threadId, key };
    }
    this.#placeCard();
  }

  /**
   * Makes room for a host preview that opened or closed, but never moves the card from under the
   * pointer: a preview closing while the user reads the card leaves the card where it is.
   */
  #makeRoom(): void {
    if (this.#shown && !this.#overCard) this.#placeCard();
  }

  #placeCard(): void {
    const shown = this.#shown;
    if (!shown) return;
    // A row the host has swapped for a new element: its last known place stands in until the pointer moves on.
    if (shown.element.isConnected) shown.box = boxOf(shown.element);
    const sidebar = this.#sidebar?.isConnected ? boxOf(this.#sidebar) : null;
    const size = { width: this.#card.offsetWidth || CARD_WIDTH, height: this.#card.offsetHeight || 0 };
    const viewport = { width: this.#win.innerWidth, height: this.#win.innerHeight };
    if ((this.#overCard || this.#holding()) && this.#card.style.left) {
      // The user is pointing at the card or typing in it: it stays put, only kept inside the window as it grows.
      this.#card.style.top = `${keepInside(parseFloat(this.#card.style.top) || 0, size.height, viewport)}px`;
      return;
    }
    const popup = hostPopup(this.#doc, shown.box, sidebar, (element) => element === this.#host || element.hasAttribute("data-codexhost-mainline"));
    this.#bridge(popup);
    const spot = cardSpot(shown.box, sidebar, size, viewport, popup ? boxOf(popup) : null);
    // For diagnosis: whether the card made room for a host preview, and what kind.
    this.#card.toggleAttribute("data-beside", popup !== null);
    if (popup) this.#card.setAttribute("data-beside", popup.closest("[popover]") ? "popover" : "fixed");
    this.#card.style.left = `${spot.left}px`;
    this.#card.style.top = `${spot.top}px`;
  }

  /** Which conversations have unseen GitHub news, from the latest snapshot. */
  #onNews(data: LiveData | undefined): void {
    if (this.#stopped || !data) return;
    const news = new Map<string, number>();
    for (const ref of data.alerts ?? []) {
      const threadId = ref.origin?.threadId;
      if (threadId) news.set(threadId, (news.get(threadId) ?? 0) + 1);
    }
    this.#news = news;
    this.#alerts = data.alerts ?? [];
    this.#placeMarkers();
  }

  /**
   * A bell on the sidebar row of each conversation with unseen GitHub news, so a maintainer's
   * reply points at the conversation it belongs to; the hovered row shows its card instead. News
   * whose conversation has no row in sight goes to the summary at the top of the sidebar.
   * `relayout`: the summary's place is worked out again even if the sidebar did not move.
   */
  #placeMarkers(relayout = false): void {
    if (this.#stopped) return;
    for (const [threadId, marker] of this.#markers)
      if (!this.#news.has(threadId)) {
        marker.remove();
        this.#markers.delete(threadId);
      }
    const t = this.#strings();
    const unplaced = new Set<string>();
    for (const [threadId, count] of this.#news) {
      let spot: { x: number; y: number } | null = null;
      for (const row of this.#adapter.rowsFor?.(threadId) ?? []) {
        // In the empty strip left of the row's icon: the title and the row's buttons stay clear.
        spot = newsBadgeSpot(row, this.#sidebar);
        if (spot) break;
      }
      if (!spot) unplaced.add(threadId);
      let marker = this.#markers.get(threadId);
      if (!spot || this.#row?.threadId === threadId) {
        if (marker) marker.hidden = true;
        continue;
      }
      if (!marker) {
        this.#mount();
        marker = this.#h("div", { class: "news-marker", attrs: { "data-thread": threadId, "aria-hidden": "true" } });
        this.#root.append(marker);
        this.#markers.set(threadId, marker);
      }
      // Just the bell, however many news there are: the hover card lists them.
      const label = "🔔";
      if (marker.textContent !== label) marker.textContent = label;
      marker.setAttribute("data-count", String(count));
      marker.title = t.news;
      marker.style.left = `${spot.x}px`;
      marker.style.top = `${spot.y}px`;
      marker.hidden = false;
    }
    this.#unplaced = this.#alerts.filter((ref) => ref.origin && unplaced.has(ref.origin.threadId));
    this.#placeSummary(relayout);
  }

  /**
   * "🔔 N" at the top of the sidebar, N being the news whose conversation has no row in sight here
   * (in a collapsed group, scrolled away, or not listed): a button that opens the list of it. It
   * sits where it covers none of the host's text or buttons (see summarySpot).
   */
  #placeSummary(relayout: boolean): void {
    const count = this.#unplaced.length;
    const sidebar = this.#sidebar?.isConnected ? boxOf(this.#sidebar) : null;
    if (!count || !sidebar || sidebar.width <= 0 || sidebar.height <= 0) {
      if (!this.#list.hidden) this.#closeList(this.#focusIn(this.#list) || this.#focusIn(this.#summary));
      this.#summary.hidden = true;
      this.#summaryFor = "";
      this.#summaryOverList = false;
      return;
    }
    const t = this.#strings();
    const label = t.summary(count);
    if (this.#summary.getAttribute("data-count") !== String(count) || this.#summary.getAttribute("aria-label") !== label) {
      this.#summary.replaceChildren(this.#h("span", { class: "summary-bell", text: "🔔", attrs: { "aria-hidden": "true" } }), this.#h("span", { text: String(count) }));
      this.#summary.setAttribute("data-count", String(count));
      this.#summary.setAttribute("aria-label", label);
      this.#summary.title = t.summaryTip(count);
    }
    if (this.#summary.hidden) {
      this.#mount();
      this.#summary.hidden = false;
    }
    const viewport = { width: this.#win.innerWidth, height: this.#win.innerHeight };
    const where = [sidebar.left, sidebar.top, sidebar.width, sidebar.height, viewport.width, viewport.height, count, t.locale].join(",");
    if (relayout || where !== this.#summaryFor) {
      this.#summaryFor = where;
      const size = { width: this.#summary.offsetWidth || SUMMARY_SIZE.width, height: this.#summary.offsetHeight || SUMMARY_SIZE.height };
      // The top of the sidebar, and above it up to the window's top edge.
      const bottom = Math.min(sidebar.top + SUMMARY_BAND, sidebar.bottom, viewport.height);
      const area: Box = { left: sidebar.left, right: sidebar.right, top: 0, bottom, width: sidebar.width, height: Math.max(0, bottom) };
      const content = hostContent(
        this.#doc,
        area,
        (element) => element === this.#host || element.matches(OVERLAYS),
        (element) => this.#rowAt(element)?.element === element,
      );
      const spot = summarySpot(sidebar, size, viewport, content, this.#adapter.surface === "desktop" ? [WINDOW_BUTTONS] : []);
      this.#summaryOverList = spot.over;
      this.#summary.style.left = `${spot.left}px`;
      this.#summary.style.top = `${spot.top}px`;
    }
    if (!this.#list.hidden) {
      this.#renderList();
      this.#placeList();
    }
  }

  /** Whether the focus is on `element` or in it, within this overlay. */
  #focusIn(element: Element): boolean {
    const active = this.#host.shadowRoot?.activeElement;
    return Boolean(active && (active === element || element.contains(active)));
  }

  #toggleList(): void {
    if (this.#list.hidden) this.#openList();
    else this.#closeList(true);
  }

  #openList(): void {
    if (!this.#unplaced.length || this.#summary.hidden) return;
    this.#listShows = "";
    this.#renderList();
    this.#list.hidden = false;
    this.#summary.setAttribute("aria-expanded", "true");
    this.#placeList();
    this.#list.querySelector<HTMLButtonElement>("button")?.focus();
  }

  /** Closes the list; `focusSummary`: the focus goes back to the summary (it was in the list). */
  #closeList(focusSummary: boolean): void {
    this.#list.hidden = true;
    this.#list.replaceChildren();
    this.#listShows = "";
    this.#summary.setAttribute("aria-expanded", "false");
    if (focusSummary && !this.#summary.hidden) this.#summary.focus();
  }

  /** Under the summary, or over it where there is no room below; inside the window either way. */
  #placeList(): void {
    const summary = boxOf(this.#summary);
    const viewport = { width: this.#win.innerWidth, height: this.#win.innerHeight };
    const width = this.#list.offsetWidth || LIST_WIDTH;
    const height = this.#list.offsetHeight || 0;
    const left = Math.max(8, Math.min(summary.left, viewport.width - 8 - width));
    const below = summary.bottom + LIST_GAP;
    const above = summary.top - LIST_GAP - height;
    const top = below + height <= viewport.height - 8 || above < 8 ? keepInside(below, height, viewport) : above;
    this.#list.style.left = `${Math.round(left)}px`;
    this.#list.style.top = `${Math.round(top)}px`;
  }

  /**
   * The news the summary counts, newest first: repository and number, title, what happened and
   * when, which conversation it came from; "Open conversation" and "Got it" on each.
   */
  #renderList(): void {
    const t = this.#strings();
    const now = Date.now();
    const shows = JSON.stringify([t.locale, Math.floor(now / 60_000), this.#unplaced.map((ref) => [ref.key, ref.title, ref.activity, ref.origin])]);
    if (shows === this.#listShows) return;
    this.#listShows = shows;
    // The focus stays on the same button, or moves to the item that takes the place of the one gone.
    const active = this.#host.shadowRoot?.activeElement;
    const focused = active && this.#list.contains(active) ? active.getAttribute("data-key") : null;
    const index = focused ? this.#unplacedIndex(focused) : -1;
    const h = this.#h;
    this.#list.setAttribute("aria-label", t.news);
    this.#list.replaceChildren(
      h("div", { class: "section-title" }, h("span", { text: t.news })),
      h("ul", { class: "news-items" }, ...this.#unplaced.map((ref) => this.#listItem(ref, t, now))),
    );
    if (!focused) return;
    const kind = focused.split(":")[0];
    const again =
      this.#list.querySelector<HTMLElement>(`[data-key="${quoted(focused)}"]`) ??
      [...this.#list.querySelectorAll<HTMLElement>(`[data-key^="${kind}:"]`)][Math.min(Math.max(index, 0), this.#unplaced.length - 1)] ??
      this.#list.querySelector<HTMLElement>("button");
    if (again) again.focus();
    else this.#summary.focus();
  }

  /** Where a button's piece of news was in the list last drawn. */
  #unplacedIndex(key: string): number {
    const items = [...this.#list.querySelectorAll(".news-item")];
    return items.findIndex((item) => item.querySelector(`[data-key="${quoted(key)}"]`) !== null);
  }

  #listItem(ref: RefView, t: HoverStrings, now: number): HTMLElement {
    const h = this.#h;
    const origin = ref.origin;
    const conversation = origin ? (origin.title ?? `#${origin.threadId.slice(0, 8)}`) : "";
    return h(
      "li",
      { class: "news-item", attrs: { "data-ref": ref.key } },
      h(
        "div",
        { class: "news-item-head" },
        h("span", { class: "ref-number", text: `${ref.repo}#${ref.number}` }),
        ref.title ? h("span", { class: "ref-title", text: ref.title, title: ref.title }) : null,
      ),
      ref.activity ? h("div", { class: "news-item-meta", text: `${t.reason(ref.activity.reason)} · ${t.time(ref.activity.at, now)}`, title: t.date(ref.activity.at) }) : null,
      origin ? h("div", { class: "news-item-meta", text: t.fromConversation(conversation, origin.turn) }) : null,
      h(
        "div",
        { class: "news-item-actions" },
        origin
          ? h("button", { class: "btn small", text: t.openConversation, attrs: { type: "button", "data-key": `open:${ref.key}` }, on: { click: () => this.#openFromList(ref) } })
          : null,
        h("button", { class: "btn small", text: t.seen, attrs: { type: "button", "data-key": `seen:${ref.key}` }, on: { click: () => this.#seenFromList(ref) } }),
      ),
    );
  }

  /** Opens the conversation a piece of news came from, once its news is marked seen (opening may reload the page). */
  #openFromList(ref: RefView): void {
    const threadId = ref.origin?.threadId;
    if (!threadId) return;
    this.#closeList(false);
    const seen = Promise.resolve()
      .then(() => this.#adapter.invoke("refs.seen", { key: ref.key }))
      .catch(() => undefined);
    void Promise.race([seen, new Promise((resolve) => setTimeout(resolve, SEEN_WAIT_MS))]).then(() => {
      if (this.#stopped) return;
      try {
        this.#adapter.openThread(threadId);
      } catch (error) {
        console.warn("[mainline] could not open the conversation", error);
      }
      void this.#controller.refresh();
    });
  }

  #seenFromList(ref: RefView): void {
    void Promise.resolve()
      .then(() => this.#adapter.invoke("refs.seen", { key: ref.key }))
      .then(() => this.#controller.refresh())
      .catch(() => undefined);
  }

  /** "◆ reached/total" beside the hovered row's own buttons, for conversations with milestones. */
  #renderBadge(): void {
    const row = this.#row;
    const progress = row ? this.#viewOf(row.threadId)?.progress : undefined;
    if (!row || !progress || !(progress.total > 0) || !row.element.isConnected) {
      this.#badge.hidden = true;
      return;
    }
    const spot = badgeSpot(row.element, this.#sidebar);
    if (!spot) {
      this.#badge.hidden = true;
      return;
    }
    if (this.#badge.hidden) this.#mount();
    const text = `${progress.done}/${progress.total}`;
    if (this.#badge.getAttribute("data-progress") !== text) {
      this.#badge.replaceChildren(this.#h("span", { class: "diamond", text: "◆" }), this.#h("span", { class: "count", text }));
      this.#badge.setAttribute("data-progress", text);
    }
    this.#badge.toggleAttribute("data-complete", progress.done >= progress.total);
    this.#badge.setAttribute("data-thread", row.threadId);
    this.#badge.style.left = `${spot.x}px`;
    this.#badge.style.top = `${spot.y}px`;
    this.#badge.hidden = false;
  }
}
