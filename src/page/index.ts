/**
 * The overview page ("第二大脑" / "Second Brain"), mainline v2: one conversation, one mainline.
 *
 * At the top, a search finds any conversation by a clue: a number, a link or a few words. Below
 * it, four tabs. Conversations: one line each, under status tabs (active, paused, done, without a
 * mainline) and grouped by time or by project, with the conversations each delegated folded under
 * it; a line opens into its milestones, tasks and spin-offs, which can be tidied up there.
 * Favorites: the saved passages. PRs and issues: the index of every PR and issue the conversations
 * named. Settings: the agent integration, the settings with the model summaries, and the files
 * sent along with child conversations. Runs on Desktop and Web through the page API.
 */
import { formatSize } from "../core/attachments.js";
import { cleanTags, currentMilestone, normalizeStateV2, progressOf, type Conversation, type ConversationStatus, type Spinoff, type StateV2 } from "../core/conversation.js";
import { conversationView, parentOf, titleOf, type ConversationView, type MilestoneView, type TaskView, type ViewSources } from "../core/conversation-view.js";
import { isRemoteHostId, webSessionId } from "../core/hosts.js";
import { DEFAULT_SETTINGS, isErrorCode, isThreadId, localeOf, type Settings, type ThreadInfo, type ThreadStatus } from "../core/model.js";
import type { RefView } from "../core/refs.js";
import {
  errorCodeOf,
  FAVORITES_PAGE,
  FAVORITES_PAGE_MAX,
  type AgentId,
  type AttachmentsClearParams,
  type AttachmentsScope,
  type AttachmentsUsage,
  type ConversationParams,
  type FavoriteExcerpt,
  type FavoritesList,
  type FavoritesListParams,
  type FilesSize,
  type IntegrationPreview,
  type IntegrationStatus,
  type MutateV2Params,
  type RefsList,
  type SearchParams,
  type SearchResult,
  type SnapshotParams,
  type SnapshotResultV2,
  type SpawnParams,
  type SpawnResult,
  type SummarizerStatus,
  type SummaryProblem,
} from "../core/rpc.js";
import type { PageApi } from "../host/types.js";
import { builder, icon, type Builder, type Child, type IconName } from "../ui/dom.js";
import { renderMarkdown } from "./markdown.js";
import { pageStrings, type PageStrings } from "./strings.js";
import { buildForest, latest, type Forest, type TreeNode } from "./tree.js";

const POLL_MS = 3000;
const REFS_POLL_MS = 15_000;
/** The PR tab asks for fresh PR states (a GitHub lookup each) at most this often while it is on screen. */
const REFS_FRESH_MS = 60_000;
const SEARCH_DELAY_MS = 250;
const CONFIRM_MS = 3000;
const NOTICE_MS = 10_000;
const FLASH_MS = 1600;
/** Children listed under a conversation before "show all". */
const CHILDREN_SHOWN = 6;
/** Conversations without a mainline listed before "show all". */
const OTHERS_SHOWN = 30;
const MAX_DEPTH = 24;
const OPEN_EVENT = "codexhost-mainline:open-thread";
const TABS: readonly Tab[] = ["conversations", "favorites", "refs", "settings"];
const MARK = { done: "✓", current: "●", planned: "○" } as const;
const STATUSES: readonly ConversationStatus[] = ["active", "paused", "done"];
const THREAD_STATUSES = new Set<string>(["running", "waiting", "idle", "unknown"]);
const TEXT_INPUTS = new Set(["text", "search", ""]);
/** A saved passage longer than this is folded until opened. */
const PASSAGE_FOLD_CHARS = 360;
const PASSAGE_FOLD_LINES = 6;
const COPIED_MS = 1500;

/** Which status tab a conversation is listed under; a search result switches to it. */
type Group = "active" | "paused" | "done" | "others";
type Tab = "conversations" | "favorites" | "refs" | "settings";
type Grouping = "time" | "project";
const DAY_MS = 24 * 60 * 60 * 1000;

interface PageData {
  state: StateV2;
  info: Record<string, ThreadInfo>;
  /** Known delegation links, child to parent. */
  parents: Record<string, string>;
  /** Conversations on other computers the snapshot names, with their remote host. */
  hosts: Record<string, string>;
  version: string;
  command?: string;
  /** How the model summaries are doing. */
  summarizer?: SummarizerStatus;
  /** Each conversation's workspace, for grouping by project. */
  workspaces: Record<string, string>;
  /** How many passages are saved. */
  favorites: number;
  /**
   * Conversations the snapshot sent as an outline (it would have been too large otherwise), with
   * their milestones reached and in all: their rows read the progress here, their details come
   * from the backend's view.
   */
  outline: Record<string, [number, number]>;
  /** The folder of the extension's earlier name, while it is still there after its data was copied over. */
  oldFolder?: string;
}

interface EditorOptions {
  /** An empty field is a value too (no tags, nothing in progress). */
  allowEmpty?: boolean;
  /** Commit even when the text did not change (accepting a draft's title). */
  commitUnchanged?: boolean;
  /** Leaving the field commits it; otherwise leaving cancels. */
  commitOnBlur?: boolean;
}

/** The items beside the one at `index`, the next one first. */
const beside = <T>(items: readonly T[], index: number): T[] => [items[index + 1], items[index - 1]].filter((item): item is T => item !== undefined);
/** The id of a conversation's details, which its line's button controls. */
const detailId = (threadId: string) => `mlp-detail-${threadId}`;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const shortId = (threadId: string) => `#${threadId.slice(0, 8)}`;

export async function mount(root: HTMLElement, api: PageApi): Promise<() => void> {
  const page = new OverviewPage(root, api);
  await page.start();
  return () => page.stop();
}

class OverviewPage {
  readonly #root: HTMLElement;
  readonly #api: PageApi;
  readonly #doc: Document;
  readonly #h: Builder;
  #t: PageStrings;
  /** The page's language as the host last reported it. */
  #locale: string;

  #data: PageData | null = null;
  #forest: Forest | null = null;
  #groups = new Map<string, Group>();
  #settings: Settings = { ...DEFAULT_SETTINGS };
  #storageValues: Record<string, unknown> = {};
  #integrations: IntegrationStatus[] = [];
  #preview: (IntegrationPreview & { removing: boolean; opener: string }) | null = null;
  #refs: RefsList | null = null;
  #refQuery = "";
  #refsList: HTMLElement | undefined;
  #favorites: FavoritesList | null = null;
  #favoriteQuery = "";
  #favoritesList: HTMLElement | undefined;
  /** The search the loaded passages answer (the backend searches their whole text). */
  #favoritesFor: string | null = null;
  /** How many passages the tab shows: a page, and one more for each "show more". */
  #favoritesWanted = FAVORITES_PAGE;
  /** Only the answer to the latest request is shown. */
  #favoritesSeq = 0;
  /** Whole texts of passages the list sent cut short, once read. */
  readonly #fullTexts = new Map<string, string>();
  /** Long passages opened in full. */
  readonly #openPassages = new Set<string>();
  /** The passage just copied, to say so on its button for a moment. */
  #copied: string | null = null;
  /** What the files sent along with child conversations take, as last counted. */
  #attachments: AttachmentsUsage | null = null;
  #clearingAttachments = false;

  /** A failed poll clears itself once the backend answers again; a failed action waits to be read. */
  #error: { text: string; kind: "poll" | "action" } | null = null;
  #notice: { text: string; threadId?: string; hostId?: string } | null = null;
  #pending = false;
  #stopped = false;
  #localeSent = false;
  #pollSeq = 0;

  #query = "";
  #results: SearchResult[] | null = null;
  #searching = false;
  #searchError = "";
  #searchSeq = 0;
  /** Which results were in the list when they were drawn; titles become links once they are. */
  #resultsShape = "";

  #editing: string | null = null;
  /** An editor that just opened: its text is selected once, when it first gets the focus. */
  #freshEditor: string | null = null;
  /**
   * Where the focus goes after the next redraw: the first of these keys (`data-key`) still on the
   * page. Set by an action when it is done, so the focus lands on the control that started it, or
   * on the next sensible one when that control went away with what it acted on.
   */
  #focusKeys: string[] = [];
  #allOthers = false;
  readonly #expanded = new Set<string>();
  /** The page's tab, the conversation list's status tab, and how the list is grouped. */
  #tab: Tab = "conversations";
  #statusTab: Group = "active";
  #grouping: Grouping = "time";
  readonly #allChildren = new Set<string>();
  /** Text typed into the always-visible fields, kept across redraws. */
  readonly #drafts = new Map<string, string>();
  /** Full views from the backend (clues, draft facts), by conversation. */
  readonly #views = new Map<string, ConversationView>();
  readonly #viewLoading = new Set<string>();
  readonly #viewStale = new Set<string>();
  readonly #spawning = new Set<string>();
  readonly #confirming = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #resetters = new WeakMap<Element, () => void>();
  readonly #cleanup: Array<() => void> = [];

  #timer: ReturnType<typeof setTimeout> | undefined;
  #refsTimer: ReturnType<typeof setTimeout> | undefined;
  /** When the PR tab last asked for fresh PR states. */
  #refsFreshAt = Number.NEGATIVE_INFINITY;
  #searchTimer: ReturnType<typeof setTimeout> | undefined;
  #noticeTimer: ReturnType<typeof setTimeout> | undefined;
  #copiedTimer: ReturnType<typeof setTimeout> | undefined;

  readonly #container: HTMLElement;
  readonly #titleEl: HTMLElement;
  readonly #messages: HTMLElement;
  /** Says what a two-click button waits for, for screen readers. */
  readonly #live: HTMLElement;
  readonly #findInput: HTMLInputElement;
  readonly #findResults: HTMLElement;
  /** Everything below the search; redrawn as a whole, so the search box keeps its focus. */
  readonly #body: HTMLElement;

  constructor(root: HTMLElement, api: PageApi) {
    this.#root = root;
    this.#api = api;
    this.#doc = root.ownerDocument;
    this.#locale = api.locale;
    this.#t = pageStrings(localeOf(api.locale));
    const h = (this.#h = builder(this.#doc));
    this.#titleEl = h("h1");
    this.#messages = h("div", { class: "mlp-messages" });
    this.#live = h("div", { class: "mlp-sr-only", attrs: { role: "status", "aria-live": "polite" } });
    this.#findInput = h("input", { class: "mlp-input mlp-find-input", attrs: { type: "search", autocomplete: "off", spellcheck: "false" } });
    this.#findResults = h("div", { class: "mlp-find-results", attrs: { "aria-live": "polite" } });
    this.#findResults.hidden = true;
    this.#body = h("div", { class: "mlp-body" });
    this.#container = h(
      "div",
      // The palette follows the host's light or dark scheme (page/style.css).
      { class: "mlp", attrs: { "data-scheme": api.colorScheme === "dark" ? "dark" : "light" } },
      h("header", { class: "mlp-header" }, this.#titleEl),
      this.#messages,
      this.#live,
      h("section", { class: "mlp-find", attrs: { role: "search" } }, h("div", { class: "mlp-find-box" }, icon(this.#doc, "search", "mlp-find-icon"), this.#findInput), this.#findResults),
      this.#body,
    );
    this.#findInput.addEventListener("input", () => this.#onQuery());
    this.#findInput.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      if (event.key === "Enter") {
        event.preventDefault();
        clearTimeout(this.#searchTimer);
        void this.#search(this.#findInput.value);
      } else if (event.key === "Escape" && this.#findInput.value) {
        event.preventDefault();
        this.#findInput.value = "";
        this.#onQuery();
      }
    });
    root.replaceChildren(this.#container);
  }

  async start(): Promise<void> {
    this.#cleanup.push(
      this.#api.onLocaleChange((locale) => {
        this.#locale = locale;
        this.#t = pageStrings(localeOf(locale));
        this.#localeSent = false;
        this.#render(true);
        this.#fillFind();
        // The backend writes agent-facing text in the page's language; tell it now.
        void this.#poll();
      }),
      this.#api.storage.onChange((values) => {
        this.#storageValues = values;
        this.#settings = { ...DEFAULT_SETTINGS, ...pickSettings(values) };
        this.#render();
      }),
      this.#api.onColorSchemeChange((scheme) => this.#container.setAttribute("data-scheme", scheme === "dark" ? "dark" : "light")),
    );
    const focusout = () =>
      setTimeout(() => {
        if (this.#pending && !this.#typing()) this.#render();
      }, 0);
    this.#container.addEventListener("focusout", focusout);
    this.#cleanup.push(() => this.#container.removeEventListener("focusout", focusout));
    const signal = this.#api.signal as AbortSignal | undefined;
    if (signal) {
      const abort = () => this.stop();
      signal.addEventListener("abort", abort, { once: true });
      this.#cleanup.push(() => signal.removeEventListener("abort", abort));
    }
    // Hidden, the page asks the backend nothing; shown again, it catches up at once.
    const visibility = () => {
      if (this.#hidden()) return;
      void this.#loadRefs();
      void this.#poll();
    };
    this.#doc.addEventListener("visibilitychange", visibility);
    this.#cleanup.push(() => this.#doc.removeEventListener("visibilitychange", visibility));
    this.#render(true);
    await Promise.all([this.#loadSettings(), this.#loadIntegrations(), this.#poll(), this.#loadRefs(), this.#loadFavorites()]);
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const timer of [this.#timer, this.#refsTimer, this.#searchTimer, this.#noticeTimer, this.#copiedTimer, ...this.#confirming.values()]) clearTimeout(timer);
    this.#confirming.clear();
    for (const stop of this.#cleanup.splice(0)) stop();
  }

  // -------------------------------------------------------------------------------------------
  // Loading

  /** The page is not on screen (another tab, a minimized window): its polls pause. */
  #hidden(): boolean {
    return this.#doc.visibilityState === "hidden";
  }

  async #poll(): Promise<void> {
    if (this.#stopped) return;
    const seq = ++this.#pollSeq;
    clearTimeout(this.#timer);
    // Paused; becoming visible polls again.
    if (this.#hidden()) return;
    // The PR tab just came on screen: its fresh PR states need not wait for the next round.
    if (this.#tab === "refs" && this.#refsFreshDue()) void this.#loadRefs();
    try {
      const params: SnapshotParams = {
        ...(this.#data ? { version: this.#data.version } : {}),
        ...(this.#localeSent ? {} : { locale: localeOf(this.#locale), localeSource: "page" as const }),
      };
      const result = (await this.#api.backend.invoke("snapshot", params)) as SnapshotResultV2 | null;
      // A newer poll started meanwhile (after an edit): its answer wins.
      if (this.#stopped || seq !== this.#pollSeq) return;
      this.#localeSent = true;
      if (result?.state) this.#applySnapshot(result);
    } catch (error) {
      if (this.#stopped || seq !== this.#pollSeq) return;
      this.#error = { kind: "poll", text: this.#message(error) };
      this.#render();
    }
    if (!this.#stopped && seq === this.#pollSeq && !this.#hidden()) this.#timer = setTimeout(() => void this.#poll(), POLL_MS);
  }

  #refsFreshDue(): boolean {
    return Date.now() - this.#refsFreshAt >= REFS_FRESH_MS;
  }

  #applySnapshot(result: SnapshotResultV2): void {
    let state: StateV2;
    try {
      state = normalizeStateV2(result.state);
    } catch (error) {
      this.#error = { kind: "poll", text: this.#message(error) };
      this.#render();
      return;
    }
    const saved = typeof result.favorites === "number" && Number.isFinite(result.favorites) ? result.favorites : 0;
    const savedBefore = this.#data?.favorites;
    this.#data = {
      state,
      info: readInfo(result.info),
      parents: readParents(result.parents),
      hosts: readHosts(result.hosts),
      version: String(result.version),
      ...(typeof result.command === "string" && result.command ? { command: result.command } : {}),
      ...readSummarizer(result.summarizer),
      workspaces: readWorkspaces(result.workspaces),
      favorites: saved,
      outline: readOutline(result.outline),
      ...(isRecord(result.migration) && typeof result.migration.oldFolder === "string" && result.migration.oldFolder ? { oldFolder: result.migration.oldFolder } : {}),
    };
    // A passage saved, noted or deleted anywhere changes the snapshot: reload what is shown.
    if (this.#tab === "favorites" || savedBefore !== saved) void this.#loadFavorites();
    if (this.#error?.kind === "poll") this.#error = null;
    for (const threadId of this.#expanded) void this.#loadView(threadId);
    this.#render();
  }

  /** The backend's full view adds what the snapshot lacks: clues, and the facts behind a draft. */
  async #loadView(threadId: string): Promise<void> {
    if (this.#stopped) return;
    if (this.#viewLoading.has(threadId)) {
      this.#viewStale.add(threadId);
      return;
    }
    this.#viewLoading.add(threadId);
    try {
      const view = await this.#api.backend.invoke("conversation", { threadId, ...this.#onHost(threadId) } satisfies ConversationParams);
      if (isView(view, threadId)) {
        this.#views.set(threadId, view);
        if (this.#expanded.has(threadId)) this.#render();
      }
    } catch {
      // The view made from the snapshot stands in.
    } finally {
      this.#viewLoading.delete(threadId);
    }
    if (this.#viewStale.delete(threadId)) void this.#loadView(threadId);
  }

  async #loadRefs(): Promise<void> {
    if (this.#stopped) return;
    clearTimeout(this.#refsTimer);
    // Paused; becoming visible loads them again.
    if (this.#hidden()) return;
    // Fresh PR states (a GitHub lookup each) only for the PR tab on screen, at most once a minute;
    // the other rounds only keep the list and its count current.
    const fresh = this.#tab === "refs" && this.#refsFreshDue();
    if (fresh) this.#refsFreshAt = Date.now();
    try {
      const next = (await this.#api.backend.invoke("refs.list", ...(fresh ? [{ fresh: true }] : []))) as Partial<RefsList> | null;
      // Ignore anything that is not a refs list, rather than breaking the page.
      if (next && Array.isArray(next.refs) && next.status?.conversations && next.status.github) {
        const changed = JSON.stringify(next) !== JSON.stringify(this.#refs);
        this.#refs = next as RefsList;
        if (changed) this.#render();
      }
    } catch {
      // The rest of the page still works; the next round tries again.
    }
    clearTimeout(this.#refsTimer);
    if (!this.#stopped && !this.#hidden()) this.#refsTimer = setTimeout(() => void this.#loadRefs(), REFS_POLL_MS);
  }

  /**
   * The passages for the current search, a page at a time, each cut short where long (`truncated`):
   * as many as the tab shows so far, again from the start, so a change anywhere keeps the list
   * as long as it was; with `more`, one page more.
   */
  async #loadFavorites(more = false): Promise<void> {
    if (this.#stopped) return;
    const query = this.#favoriteQuery.trim();
    if (more) this.#favoritesWanted += FAVORITES_PAGE;
    else if (query !== this.#favoritesFor) this.#favoritesWanted = FAVORITES_PAGE;
    const wanted = this.#favoritesWanted;
    const seq = ++this.#favoritesSeq;
    try {
      let list: FavoritesList | undefined;
      // Several answers when one cannot hold them all; a backend that does not page answers once.
      for (let round = 0; round < 20 && (!list || (list.nextOffset !== undefined && list.items.length < wanted)); round += 1) {
        const params: FavoritesListParams = { ...(query ? { query } : {}), ...(list?.nextOffset ? { offset: list.nextOffset } : {}), limit: Math.min(FAVORITES_PAGE_MAX, wanted - (list?.items.length ?? 0)) };
        const page = await this.#api.backend.invoke("favorites.list", params);
        if (seq !== this.#favoritesSeq || this.#stopped || !isFavoritesList(page)) return;
        const { nextOffset: _next, ...rest } = page;
        list = list
          ? { ...rest, items: [...list.items, ...page.items], titles: { ...list.titles, ...page.titles }, ...(page.nextOffset !== undefined ? { nextOffset: page.nextOffset } : {}) }
          : page;
      }
      if (!list) return;
      // "Show more" asked for this page: the focus stays on it, or goes to the search box once it is gone.
      if (more) this.#focusKeys = ["more:favorites", "favorites-search"];
      const changed = JSON.stringify(list) !== JSON.stringify(this.#favorites) || this.#favoritesFor !== query;
      this.#favorites = list;
      this.#favoritesFor = query;
      if (changed) this.#render();
    } catch {
      // The tab says it is loading; the next snapshot tries again.
    }
  }

  /** A passage's whole text: as listed, or read from the backend when the list cut it short. */
  async #fullText(item: FavoriteExcerpt): Promise<string> {
    if (!item.truncated) return item.text;
    const known = this.#fullTexts.get(item.id);
    if (known !== undefined) return known;
    const result = await this.#api.backend.invoke("favorites.get", { id: item.id });
    const text = isRecord(result) && isRecord(result.favorite) && typeof result.favorite.text === "string" ? result.favorite.text : undefined;
    if (text === undefined) throw new Error(this.#t.error(undefined, "?"));
    this.#fullTexts.set(item.id, text);
    return text;
  }

  async #loadSettings(): Promise<void> {
    try {
      this.#storageValues = await this.#api.storage.get();
      this.#settings = { ...DEFAULT_SETTINGS, ...pickSettings(this.#storageValues) };
      this.#render();
    } catch {
      // The defaults stand in.
    }
  }

  async #loadIntegrations(): Promise<void> {
    try {
      const result = await this.#api.backend.invoke("integration.status");
      this.#integrations = Array.isArray(result) ? (result as IntegrationStatus[]) : [];
      this.#render();
    } catch (error) {
      this.#error = { kind: "action", text: this.#message(error) };
      this.#render();
    }
  }

  // -------------------------------------------------------------------------------------------
  // Actions

  #message(error: unknown): string {
    return this.#t.error(errorCodeOf(error), messageOf(error));
  }

  /**
   * Runs an edit, then shows its outcome: fresh data and search results, or why it failed. `focus`
   * names where the focus goes then (see `#focusKeys`); without it, it stays where it is.
   */
  async #act(action: () => Promise<unknown>, focus?: readonly string[]): Promise<boolean> {
    try {
      await action();
    } catch (error) {
      if (this.#stopped) return false;
      this.#error = { kind: "action", text: this.#message(error) };
      if (focus) this.#focusKeys = [...focus];
      this.#render(true);
      return false;
    }
    if (this.#error?.kind === "action") this.#error = null;
    await this.#poll();
    if (this.#query.trim()) void this.#search(this.#query, true);
    if (focus) this.#focusKeys = [...focus];
    this.#render(true);
    return true;
  }

  #mutate(params: MutateV2Params, focus?: readonly string[]): Promise<boolean> {
    return this.#act(() => this.#api.backend.invoke("mutate", { ...params, ...this.#onHost(params.threadId) }), focus);
  }

  /** The `hostId` a call names a conversation's remote host by, when it is on another computer; nothing for a local one. */
  #onHost(threadId: string): { hostId?: string } {
    const hostId = this.#data?.hosts[threadId] ?? this.#data?.state.conversations[threadId]?.hostId;
    return hostId && isRemoteHostId(hostId) ? { hostId } : {};
  }

  async #spawn(threadId: string, spinoff: Spinoff, focus: readonly string[]): Promise<void> {
    const key = `${threadId}:${spinoff.id}`;
    if (this.#spawning.has(key)) return;
    this.#spawning.add(key);
    this.#render(true);
    const opened: { child?: string; host?: string; pending?: string } = {};
    const ok = await this.#act(async () => {
      try {
        const result = (await this.#api.backend.invoke("spawn", { threadId, spinoffId: spinoff.id, ...this.#onHost(threadId) } satisfies SpawnParams)) as Partial<SpawnResult> | null;
        if (typeof result?.childThreadId === "string" && result.childThreadId) opened.child = result.childThreadId;
        if (isRemoteHostId(result?.hostId)) opened.host = result.hostId;
      } catch (error) {
        // codexhost has not answered in time: the child may still open, and the next snapshot shows it. No failure.
        if (errorCodeOf(error) !== "PENDING") throw error;
        opened.pending = this.#message(error);
      }
    }, focus);
    this.#spawning.delete(key);
    if (ok) this.#showNotice(opened.pending ?? this.#t.spawnedNotice(spinoff.text), opened.child, opened.host);
    this.#render(true);
  }

  async #saveSettings(patch: Partial<Settings>): Promise<void> {
    const next = { ...this.#storageValues, ...this.#settings, ...patch };
    this.#settings = { ...this.#settings, ...patch };
    this.#render(true);
    try {
      this.#storageValues = await this.#api.storage.set(next);
    } catch (error) {
      this.#error = { kind: "action", text: this.#t.error(undefined, messageOf(error)) };
      this.#render(true);
    }
  }

  /** Shows what installing or removing would change, and moves the focus to it; `opener` gets it back after. */
  async #showPreview(agent: AgentId, removing: boolean, opener: string): Promise<void> {
    try {
      const preview = (await this.#api.backend.invoke("integration.preview", { agent, removing })) as IntegrationPreview;
      this.#preview = { ...preview, removing, opener };
      this.#focusKeys = ["integration:apply", "integration:cancel"];
    } catch (error) {
      this.#error = { kind: "action", text: this.#message(error) };
    }
    this.#render(true);
  }

  async #applyIntegration(agent: AgentId, removing: boolean): Promise<void> {
    const back = this.#previewFocus(agent);
    try {
      await this.#api.backend.invoke(removing ? "integration.uninstall" : "integration.install", { agent });
      this.#preview = null;
      this.#focusKeys = back;
      await this.#loadIntegrations();
    } catch (error) {
      let text = this.#message(error);
      // The configuration became unreadable meanwhile: why, in the page's language, from a fresh status.
      if (errorCodeOf(error) === "UNAVAILABLE") {
        await this.#loadIntegrations();
        const status = this.#integrations.find((item) => item.agent === agent);
        if (status?.problem) text = this.#t.error("UNAVAILABLE", this.#t.integrationProblem(agent, status.problem, status.cause));
      }
      this.#error = { kind: "action", text };
      this.#focusKeys = ["integration:apply", ...back];
      this.#render(true);
    }
  }

  /** Where the focus goes once a preview closes: the button that opened it, else another of the agent's. */
  #previewFocus(agent: AgentId): string[] {
    const opener = this.#preview?.opener;
    return [...(opener ? [opener] : []), `integration:${agent}:preview`, `integration:${agent}:install`, `integration:${agent}:uninstall`];
  }

  /**
   * Opens a conversation in the surface the page runs in. One on another computer names its remote
   * host (`hostId`, else what the snapshot says); codexhost Web opens it by its `web-remote:` session.
   */
  #openThread(threadId: string, hostId: string | undefined = this.#onHost(threadId).hostId): void {
    const host = isRemoteHostId(hostId) ? hostId : undefined;
    const detail: { threadId: string; hostId?: string; handled?: boolean; result?: Promise<void> } = { threadId, ...(host ? { hostId: host } : {}) };
    const view = this.#doc.defaultView;
    view?.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail }));
    // The surface that opened it says when it could not (on Desktop: a conversation of another machine).
    detail.result?.catch((error: unknown) => {
      if (this.#stopped) return;
      this.#error = { kind: "action", text: this.#t.openFailed(messageOf(error).replace(/^\[[A-Z_]+\]\s*/u, "")) };
      this.#render(true);
    });
    if (detail.handled || this.#api.hostTarget !== "web" || !view) return;
    const url = new URL(view.location.href);
    url.searchParams.set("session", webSessionId(threadId, host));
    view.location.assign(url.href);
  }

  #showNotice(text: string, threadId?: string, hostId?: string): void {
    clearTimeout(this.#noticeTimer);
    this.#notice = { text, ...(threadId ? { threadId } : {}), ...(hostId ? { hostId } : {}) };
    this.#renderMessages();
    this.#noticeTimer = setTimeout(() => this.#clearNotice(), NOTICE_MS);
  }

  #clearNotice(): void {
    clearTimeout(this.#noticeTimer);
    this.#notice = null;
    if (!this.#stopped) this.#renderMessages();
  }

  #toggle(threadId: string): void {
    if (this.#expanded.delete(threadId)) {
      if (this.#editing?.includes(threadId)) this.#editing = null;
    } else {
      this.#expanded.add(threadId);
      void this.#loadView(threadId);
    }
    this.#render(true);
  }

  #edit(key: string): void {
    this.#editing = key;
    this.#freshEditor = key;
    this.#drafts.delete(`edit:${key}`);
    this.#render(true);
  }

  /** Opens a search result in the list: unfolds its group, expands it and scrolls to it. */
  #locate(threadId: string): void {
    const data = this.#data;
    const group = this.#groups.get(threadId);
    if (!data || !group) return;
    this.#tab = "conversations";
    this.#statusTab = group;
    if (group === "others" && (this.#forest?.others.indexOf(threadId) ?? 0) >= OTHERS_SHOWN) this.#allOthers = true;
    const sources = this.#sources(data);
    let parent = parentOf(threadId, sources);
    for (let depth = 0; parent && depth < MAX_DEPTH; depth += 1) {
      this.#allChildren.add(parent);
      parent = parentOf(parent, sources);
    }
    if (!this.#expanded.has(threadId)) {
      this.#expanded.add(threadId);
      void this.#loadView(threadId);
    }
    this.#focusKeys = [`row:${threadId}`];
    this.#render(true);
    const node = [...this.#body.querySelectorAll<HTMLElement>(".mlp-node")].find((element) => element.dataset.threadId === threadId);
    if (!node) return;
    const still = this.#doc.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    node.scrollIntoView?.({ block: "center", behavior: still ? "auto" : "smooth" });
    node.setAttribute("data-flash", "");
    setTimeout(() => node.removeAttribute("data-flash"), FLASH_MS);
  }

  // -------------------------------------------------------------------------------------------
  // Search

  #onQuery(): void {
    this.#query = this.#findInput.value;
    clearTimeout(this.#searchTimer);
    if (!this.#query.trim()) {
      // Answers still on the way are for a query that is gone.
      this.#searchSeq += 1;
      this.#results = null;
      this.#searching = false;
      this.#searchError = "";
      this.#fillFind();
      return;
    }
    this.#searchTimer = setTimeout(() => void this.#search(this.#query), SEARCH_DELAY_MS);
  }

  /** `quiet` refreshes results after an edit without flashing "searching". */
  async #search(query: string, quiet = false): Promise<void> {
    const text = query.trim();
    if (!text || this.#stopped) return;
    const seq = ++this.#searchSeq;
    if (!quiet) {
      this.#searching = true;
      this.#searchError = "";
      this.#fillFind();
    }
    let results: SearchResult[] = [];
    let error = "";
    try {
      results = readResults(await this.#api.backend.invoke("search", { query: text } satisfies SearchParams));
    } catch (failure) {
      error = this.#t.findFailed(messageOf(failure));
    }
    if (seq !== this.#searchSeq || this.#stopped) return;
    this.#searching = false;
    this.#results = results;
    this.#searchError = error;
    this.#fillFind();
  }

  /** Redraws only the results, so typing in the search box is never interrupted. */
  #fillFind(): void {
    const h = this.#h;
    const t = this.#t;
    const results = this.#results;
    const nodes: Node[] = [];
    if (this.#query.trim()) {
      if (this.#searching) nodes.push(h("div", { class: "mlp-meta", text: t.finding }));
      if (this.#searchError) nodes.push(h("div", { class: "mlp-meta mlp-warn", text: this.#searchError }));
      else if (results?.length) nodes.push(...results.map((result) => this.#hit(result)));
      else if (results && !this.#searching) nodes.push(h("p", { class: "mlp-muted", text: t.findEmpty }));
    }
    this.#resultsShape = this.#shapeOf(results);
    this.#findResults.replaceChildren(...nodes);
    this.#findResults.hidden = nodes.length === 0;
  }

  #shapeOf(results: SearchResult[] | null): string {
    return (results ?? []).map((result) => (this.#groups.has(result.threadId) ? "1" : "0")).join("");
  }

  #hit(result: SearchResult): HTMLElement {
    const h = this.#h;
    const t = this.#t;
    const status = this.#liveStatus(result.threadId, result.threadStatus);
    const { done, total } = result.progress;
    const title = this.#groups.has(result.threadId)
      ? h("button", { class: "mlp-link mlp-hit-title", text: result.title, title: t.locate, attrs: { type: "button" }, on: { click: () => this.#locate(result.threadId) } })
      : h("span", { class: "mlp-hit-title", text: result.title });
    return h(
      "article",
      { class: "mlp-hit", attrs: { "data-thread-id": result.threadId } },
      h(
        "div",
        { class: "mlp-hit-head" },
        this.#statusDot(status),
        title,
        result.draft ? h("span", { class: "mlp-badge mlp-draft", text: t.draft }) : this.#statusBadge(result.status),
        h("span", { class: "mlp-spacer" }),
        h("span", { class: "mlp-meta mlp-live", text: t.threadStatus[status] }),
        this.#button(t.jump, () => this.#openThread(result.threadId, result.hostId ?? this.#onHost(result.threadId).hostId), "mlp-btn-sm"),
      ),
      result.tags.length ? this.#tags(result.tags) : null,
      h(
        "div",
        { class: "mlp-hit-meta" },
        total ? h("span", { class: "mlp-progress", text: t.progress(done, total), title: t.progressLabel(done, total) }) : null,
        result.current ? h("span", { class: "mlp-current", text: t.current(result.current) }) : null,
        result.updatedAt ? h("span", { class: "mlp-meta", text: t.time(result.updatedAt, Date.now()) }) : null,
      ),
      h("div", { class: "mlp-match", text: t.match(result.match.field, result.match.text) }),
    );
  }

  // -------------------------------------------------------------------------------------------
  // Drawing

  /** The focused element below the search, if any. */
  #active(): Element | undefined {
    const rootNode = this.#root.getRootNode();
    const active = typeof ShadowRoot !== "undefined" && rootNode instanceof ShadowRoot ? rootNode.activeElement : this.#doc.activeElement;
    return active && this.#body.contains(active) ? active : undefined;
  }

  /**
   * The user has the focus somewhere the page must not take it from: typing in the search box, or
   * outside the overview altogether.
   */
  #focusElsewhere(): boolean {
    const rootNode = this.#root.getRootNode();
    const shadow = typeof ShadowRoot !== "undefined" && rootNode instanceof ShadowRoot ? rootNode : null;
    const active = shadow ? shadow.activeElement : this.#doc.activeElement;
    const nothing = (element: Element | null) => !element || element === this.#doc.body || element === this.#doc.documentElement;
    if (shadow && !active) return !nothing(this.#doc.activeElement);
    if (nothing(active)) return false;
    return active === this.#findInput || !this.#container.contains(active);
  }

  #typing(): boolean {
    const active = this.#active();
    if (!active) return false;
    if (active.tagName === "SELECT" || active.tagName === "TEXTAREA") return true;
    return active.tagName === "INPUT" && TEXT_INPUTS.has((active as HTMLInputElement).type);
  }

  #render(force = false): void {
    if (this.#stopped) return;
    if (!force && this.#typing()) {
      this.#pending = true;
      return;
    }
    this.#pending = false;
    const t = this.#t;
    this.#titleEl.textContent = t.pageTitle;
    this.#findInput.placeholder = t.findPlaceholder;
    this.#findInput.setAttribute("aria-label", t.findLabel);
    this.#renderMessages();
    this.#forest = this.#data ? buildForest(this.#sources(this.#data)) : null;
    this.#groups = this.#forest ? groupsOf(this.#forest) : new Map();
    const focused = this.#active()?.getAttribute("data-key") ?? undefined;
    const elsewhere = this.#focusElsewhere();
    const scroll = this.#root.scrollTop;
    const content =
      this.#tab === "refs"
        ? [this.#refsSection()]
        : this.#tab === "favorites"
          ? [this.#favoritesSection()]
          : this.#tab === "settings"
          ? [this.#migrationNote(), this.#integrationSection(), this.#settingsSection(), this.#attachmentsSection()]
          : [this.#conversationsSection()];
    const panel = this.#h(
      "div",
      { class: "mlp-tabpanel", attrs: { role: "tabpanel", id: this.#tabPanelId, "aria-labelledby": this.#tabId(this.#tab) } },
      ...content,
    );
    this.#body.replaceChildren(this.#tabs(), panel);
    this.#root.scrollTop = scroll;
    if (elsewhere) this.#focusKeys = [];
    else this.#restoreFocus(focused);
    if (this.#shapeOf(this.#results) !== this.#resultsShape) this.#fillFind();
  }

  /**
   * Puts the focus back after a redraw: on the control asked for (`#focusKeys`: where an action
   * sends it), else on the control that had it, else on an editor that just opened. Controls are
   * found by their `data-key`, which stays the same across redraws.
   */
  #restoreFocus(focused: string | undefined): void {
    const wanted = this.#focusKeys;
    this.#focusKeys = [];
    const keyed = [...this.#body.querySelectorAll<HTMLElement>("[data-key]")].filter((element) => !element.hasAttribute("disabled"));
    const byKey = (key: string) => keyed.find((element) => element.dataset.key === key);
    const editor = () => keyed.find((element) => element.hasAttribute("data-autofocus") && element.dataset.key === this.#editing);
    let target: HTMLElement | undefined;
    for (const key of wanted) if ((target = byKey(key))) break;
    // An editor that just opened takes the focus from the button that opened it.
    if (!target && this.#freshEditor !== null && this.#freshEditor === this.#editing) target = editor();
    // Otherwise the control that had the focus keeps it, without scrolling the page.
    const kept = !target && focused !== undefined ? byKey(focused) : undefined;
    target ??= kept ?? editor();
    if (!target) return;
    target.focus(kept ? { preventScroll: true } : undefined);
    if (target.tagName === "INPUT" && target.dataset.key === this.#freshEditor) {
      this.#freshEditor = null;
      (target as HTMLInputElement).select();
    }
  }

  #renderMessages(): void {
    const h = this.#h;
    const t = this.#t;
    const nodes: Node[] = [];
    if (this.#error)
      nodes.push(
        h(
          "div",
          { class: "mlp-error", attrs: { role: "alert" } },
          h("span", { class: "mlp-main", text: this.#error.text }),
          this.#iconButton("close", t.close, () => {
            this.#error = null;
            this.#renderMessages();
          }),
        ),
      );
    const notice = this.#notice;
    if (notice) {
      const child = notice.threadId;
      nodes.push(
        h(
          "div",
          { class: "mlp-notice", attrs: { role: "status" } },
          h("span", { class: "mlp-main", text: notice.text }),
          child ? this.#button(t.jump, () => this.#openThread(child, notice.hostId ?? this.#onHost(child).hostId), "mlp-btn-sm") : null,
          this.#iconButton("close", t.close, () => this.#clearNotice()),
        ),
      );
    }
    this.#messages.replaceChildren(...nodes);
  }

  #sources(data: PageData): ViewSources {
    return { state: data.state, info: data.info, parents: data.parents };
  }

  #liveStatus(threadId: string, fallback?: ThreadStatus): ThreadStatus {
    const status = this.#data?.info[threadId]?.status ?? fallback;
    return status && THREAD_STATUSES.has(status) ? status : "unknown";
  }

  /**
   * The snapshot gives the mainline itself, always current; the backend's view adds the clues and,
   * for a draft, the title, tags and first request it was made from.
   */
  #viewOf(threadId: string, data: PageData): ConversationView {
    const local = conversationView(threadId, this.#sources(data));
    const remote = this.#views.get(threadId);
    if (!remote) return local;
    // Sent as an outline: the backend's view has its milestones, tasks and spin-offs.
    if (data.outline[threadId] && !remote.draft) return remote;
    return {
      ...local,
      refs: remote.refs,
      // The snapshot may cut the last request short; the backend's view has all of it.
      ...(remote.lastPrompt ? { lastPrompt: remote.lastPrompt } : {}),
      ...(local.draft && remote.draft ? { title: remote.title, tags: remote.tags, ...(remote.firstPrompt ? { firstPrompt: remote.firstPrompt } : {}) } : {}),
    };
  }

  // Conversation tree -----------------------------------------------------------------------

  get #tabPanelId(): string {
    return `mlp-${this.#api.id}-tabpanel`;
  }

  #tabId(tab: Tab): string {
    return `mlp-${this.#api.id}-tab-${tab}`;
  }

  #selectTab(tab: Tab, focus = false): void {
    this.#tab = tab;
    if (tab === "favorites") void this.#loadFavorites();
    if (tab === "settings") void this.#loadAttachments();
    if (focus) this.#focusKeys = [`tab:${tab}`];
    this.#render(true);
  }

  /**
   * Conversations, favorites, PRs and issues, settings: one at a time, so none is buried under the
   * others. One tab stop; the arrow keys, Home and End move between the tabs.
   */
  #tabs(): HTMLElement {
    const h = this.#h;
    const t = this.#t;
    const labels: Record<Tab, string> = {
      conversations: t.tabConversations(this.#forest?.count ?? 0),
      favorites: t.tabFavorites(this.#favorites?.total ?? this.#data?.favorites ?? 0),
      refs: t.tabRefs(this.#refs?.refs.length ?? 0),
      settings: t.tabSettings,
    };
    return h(
      "nav",
      { class: "mlp-tabs", attrs: { role: "tablist", "aria-label": t.pageTitle } },
      ...TABS.map((key, index) => {
        const selected = this.#tab === key;
        return h("button", {
          class: "mlp-tab",
          text: labels[key],
          attrs: {
            type: "button",
            role: "tab",
            id: this.#tabId(key),
            "aria-selected": String(selected),
            "aria-controls": this.#tabPanelId,
            tabindex: selected ? "0" : "-1",
            "data-tab": key,
            "data-key": `tab:${key}`,
          },
          on: {
            click: () => this.#selectTab(key),
            keydown: (event) => {
              const { key: pressed } = event as KeyboardEvent;
              const last = TABS.length - 1;
              const next =
                pressed === "ArrowRight" ? (index === last ? 0 : index + 1) : pressed === "ArrowLeft" ? (index === 0 ? last : index - 1) : pressed === "Home" ? 0 : pressed === "End" ? last : -1;
              const tab = TABS[next];
              if (!tab) return;
              event.preventDefault();
              this.#selectTab(tab, true);
            },
          },
        });
      }),
    );
  }

  #conversationsSection(): HTMLElement {
    const h = this.#h;
    const t = this.#t;
    const data = this.#data;
    const forest = this.#forest;
    if (!data || !forest) return h("section", { class: "mlp-section mlp-conversations" }, h("p", { class: "mlp-muted", text: t.loading }));
    const counts: Record<Group, number> = { ...forest.byStatus, others: forest.others.length };
    const statuses: Group[] = ["active", "paused", "done", ...(forest.others.length ? (["others"] as const) : [])];
    if (!statuses.includes(this.#statusTab)) this.#statusTab = "active";
    const toolbar = h(
      "div",
      { class: "mlp-toolbar" },
      h(
        "div",
        { class: "mlp-segmented", attrs: { role: "group", "aria-label": t.statusLabel } },
        ...statuses.map((status) =>
          h(
            "button",
            {
              class: "mlp-seg",
              attrs: { type: "button", "aria-pressed": String(this.#statusTab === status), "data-status-tab": status, "data-key": `status-tab:${status}` },
              on: {
                click: () => {
                  this.#statusTab = status;
                  this.#render(true);
                },
              },
            },
            h("span", { text: t.statusTabs[status] }),
            h("span", { class: "mlp-seg-count", text: String(counts[status]) }),
          ),
        ),
      ),
      h("span", { class: "mlp-spacer" }),
      this.#statusTab === "others"
        ? null
        : h(
            "div",
            { class: "mlp-segmented mlp-grouping", attrs: { role: "group", "aria-label": t.groupByLabel } },
            ...(["time", "project"] as const).map((grouping) =>
              h("button", {
                class: "mlp-seg",
                text: t.groupBy[grouping],
                attrs: { type: "button", "aria-pressed": String(this.#grouping === grouping), "data-grouping": grouping, "data-key": `grouping:${grouping}` },
                on: {
                  click: () => {
                    this.#grouping = grouping;
                    this.#render(true);
                  },
                },
              }),
            ),
          ),
    );
    const busy = data.summarizer && (data.summarizer.backfill || data.summarizer.running || data.summarizer.queued) ? this.#summarizerLine(data, false) : null;
    let list: Child[];
    if (this.#statusTab === "others") list = this.#others(forest.others, data);
    else {
      const trees = forest[this.#statusTab];
      list = trees.length ? this.#buckets(trees, data).map(([label, nodes]) => this.#bucket(label, nodes, data)) : [h("p", { class: "mlp-muted", text: t.emptyTab })];
    }
    return h("section", { class: "mlp-section mlp-conversations" }, toolbar, busy, ...list);
  }

  /** Trees in groups: by when they last moved (today, yesterday, this week, earlier) or by project. */
  #buckets(trees: readonly TreeNode[], data: PageData): Array<[string, TreeNode[]]> {
    const t = this.#t;
    const sources = this.#sources(data);
    const buckets = new Map<string, TreeNode[]>();
    const put = (label: string, node: TreeNode) => {
      const list = buckets.get(label);
      if (list) list.push(node);
      else buckets.set(label, [node]);
    };
    if (this.#grouping === "project") {
      const sorted = [...trees].sort((a, b) => latest(b, sources) - latest(a, sources));
      for (const node of sorted) put(data.workspaces[node.threadId] ?? t.noWorkspace, node);
      return [...buckets];
    }
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const order = [t.timeBuckets.today, t.timeBuckets.yesterday, t.timeBuckets.week, t.timeBuckets.earlier];
    for (const label of order) buckets.set(label, []);
    for (const node of trees) {
      const at = latest(node, sources);
      put(at >= today ? order[0]! : at >= today - DAY_MS ? order[1]! : at >= today - 6 * DAY_MS ? order[2]! : order[3]!, node);
    }
    return [...buckets].filter(([, nodes]) => nodes.length);
  }

  #bucket(label: string, nodes: readonly TreeNode[], data: PageData): HTMLElement {
    const h = this.#h;
    return h(
      "div",
      { class: "mlp-bucket" },
      h("div", { class: "mlp-bucket-title" }, h("span", { text: label }), h("span", { class: "mlp-bucket-count", text: String(nodes.length) })),
      h("div", { class: "mlp-tree" }, ...nodes.map((node) => this.#node(node, 0, data))),
    );
  }

  #others(ids: string[], data: PageData): Child[] {
    const h = this.#h;
    const t = this.#t;
    const shown = this.#allOthers ? ids : ids.slice(0, OTHERS_SHOWN);
    return [
      h("p", { class: "mlp-intro", text: t.othersIntro }),
      h("div", { class: "mlp-tree" }, ...shown.map((threadId) => this.#node({ threadId, children: [] }, 0, data))),
      ids.length > OTHERS_SHOWN
        ? this.#more(
            this.#allOthers ? t.showLess : t.showAll(ids.length),
            () => {
              this.#allOthers = !this.#allOthers;
              this.#render(true);
            },
            "more:others",
          )
        : null,
    ];
  }

  #more(label: string, onClick: () => void, key?: string): HTMLButtonElement {
    return this.#h("button", { class: "mlp-link mlp-more", text: label, attrs: { type: "button", "data-key": key }, on: { click: onClick } });
  }

  /** A conversation: one line, its details when opened, and its child conversations folded under a count. */
  #node(node: TreeNode, depth: number, data: PageData): HTMLElement {
    const h = this.#h;
    const t = this.#t;
    const threadId = node.threadId;
    const expanded = this.#expanded.has(threadId);
    const element = h(
      "div",
      {
        class: "mlp-node",
        attrs: { "data-thread-id": threadId, "data-depth": String(depth), "data-draft": node.conversation ? undefined : "", "data-expanded": expanded ? "" : undefined },
      },
      this.#line(node, data, expanded),
      expanded ? this.#detail(this.#viewOf(threadId, data), data, detailId(threadId)) : null,
    );
    if (node.children.length) {
      const open = this.#allChildren.has(threadId);
      element.append(
        h("button", {
          class: "mlp-children-toggle",
          text: open ? t.hideChildren : t.childrenCount(node.children.length),
          attrs: { type: "button", "aria-expanded": String(open), "data-key": `children:${threadId}` },
          on: {
            click: () => {
              if (open) this.#allChildren.delete(threadId);
              else this.#allChildren.add(threadId);
              this.#render(true);
            },
          },
        }),
      );
      if (open) element.append(h("div", { class: "mlp-children" }, ...node.children.map((child) => this.#node(child, depth + 1, data))));
    }
    return element;
  }

  /**
   * One line: live state, title, current milestone, progress and when it last moved. The title is
   * the button that opens the details (a click anywhere else on the line does too); "Go" beside it
   * opens the conversation.
   */
  #line(node: TreeNode, data: PageData, expanded: boolean): HTMLElement {
    const h = this.#h;
    const t = this.#t;
    const threadId = node.threadId;
    const conversation = node.conversation;
    const sources = this.#sources(data);
    const title = conversation?.title ?? titleOf(threadId, sources);
    const current = conversation ? currentMilestone(conversation) : undefined;
    const outlined = data.outline[threadId];
    const { done, total } = outlined ? { done: outlined[0], total: outlined[1] } : conversation ? progressOf(conversation) : { done: 0, total: 0 };
    const at = latest(node, sources);
    const jump = h("button", { class: "mlp-icon mlp-row-open", title: t.jump, attrs: { type: "button", "aria-label": t.jump, "data-key": `jump:${threadId}` } }, icon(this.#doc, "open"));
    jump.addEventListener("click", (event) => {
      event.stopPropagation();
      this.#openThread(threadId);
    });
    const toggle = h(
      "button",
      {
        class: "mlp-row-toggle",
        title,
        attrs: { type: "button", "aria-expanded": String(expanded), "aria-controls": expanded ? detailId(threadId) : undefined, "data-key": `row:${threadId}` },
      },
      h("span", { class: "mlp-row-title", text: title }),
      conversation ? null : h("span", { class: "mlp-badge mlp-draft", text: t.draft }),
    );
    const line = h(
      "div",
      { class: "mlp-row" },
      this.#statusDot(this.#liveStatus(threadId)),
      toggle,
      h("span", { class: "mlp-row-current", text: current?.title ?? "" }),
      total ? h("span", { class: "mlp-row-progress", text: t.progress(done, total), title: t.progressLabel(done, total) }) : null,
      at ? h("span", { class: "mlp-row-time", text: t.time(at, Date.now()) }) : null,
      jump,
      h("span", { class: "mlp-row-chevron", attrs: { "aria-hidden": "true" } }, icon(this.#doc, "chevron")),
    );
    // Clicks on the title button land here too; only "Go" (which stops them) does something else.
    line.addEventListener("click", () => this.#toggle(threadId));
    return line;
  }

  // Expanded conversation -------------------------------------------------------------------

  #detail(view: ConversationView, data: PageData, id: string): HTMLElement {
    const h = this.#h;
    const t = this.#t;
    const threadId = view.threadId;
    const now = Date.now();
    const titleKey = `title:${threadId}`;
    const tagsKey = `tags:${threadId}`;
    const parts: Child[] = [];
    // Where the focus goes after an action: each names its own control first, so a failed one
    // leaves the focus there. A conversation that leaves the list (another status, deleted) hands
    // it to the line beside it, else to the status tab.
    const leaving = () => [`row:${threadId}`, ...this.#besideRow(threadId), `status-tab:${this.#statusTab}`];

    // The row above shows only the title: tags, the last request and the editing live here.
    const prompt = view.lastPrompt ?? data.state.prompts[threadId];
    parts.push(
      h(
        "div",
        { class: "mlp-detail-meta" },
        h("span", { class: "mlp-id", text: shortId(threadId) }),
        view.updatedAt ? h("span", { class: "mlp-meta", text: t.updated(t.time(view.updatedAt, now)) }) : null,
        view.parent ? this.#threadLink(t.parent(view.parent.title), view.parent.threadId, "", `parent:${threadId}`) : null,
        view.related ? this.#threadLink(t.related(view.related.title), view.related.threadId, "", `related:${threadId}`) : null,
        view.summary ? h("span", { class: "mlp-meta", text: t.summarized(view.summary.model, t.time(view.summary.at, now)) }) : null,
        h("span", { class: "mlp-spacer" }),
        this.#button(t.jump, () => this.#openThread(threadId), "mlp-btn-sm mlp-primary", `detail-jump:${threadId}`),
        this.#button(t.resummarize, () => void this.#summarize(threadId), "mlp-btn-sm mlp-quiet", `resummarize:${threadId}`),
        view.draft ? null : this.#button(t.editTitle, () => this.#edit(titleKey), "mlp-btn-sm mlp-quiet", `open:${titleKey}`),
        view.draft ? null : this.#button(t.editTags, () => this.#edit(tagsKey), "mlp-btn-sm mlp-quiet", `open:${tagsKey}`),
      ),
      this.#pinnedNote(view),
      !view.draft && view.tags.length && this.#editing !== tagsKey ? h("div", { class: "mlp-detail-tags" }, this.#tags(view.tags)) : null,
      prompt ? h("div", { class: "mlp-oneline mlp-muted", text: t.lastPrompt(prompt.text), title: prompt.text }) : null,
    );
    if (this.#editing === titleKey)
      parts.push(
        h(
          "div",
          { class: "mlp-detail-title" },
          view.draft
            ? this.#editor(
                titleKey,
                view.title,
                t.titlePlaceholder,
                t.createMainline,
                (text, focus) => void this.#mutate({ op: "create", threadId, title: text, ...(view.tags.length ? { tags: view.tags } : {}) }, focus),
                { commitUnchanged: true, commitOnBlur: false },
              )
            : this.#editor(titleKey, view.title, t.titlePlaceholder, t.editTitle, (text, focus) => void this.#mutate({ op: "title", threadId, title: text }, focus)),
        ),
      );
    if (this.#editing === tagsKey)
      parts.push(
        h(
          "div",
          { class: "mlp-detail-tags" },
          this.#editor(tagsKey, view.tags.join(", "), t.tagsPlaceholder, t.editTags, (text, focus) => void this.#mutate({ op: "tags", threadId, tags: cleanTags(text) }, focus), {
            allowEmpty: true,
          }),
        ),
      );

    if (view.draft) {
      parts.push(
        // A draft's tags come from the backend's view, so the row cannot show them.
        view.tags.length ? h("div", { class: "mlp-detail-tags" }, this.#tags(view.tags)) : null,
        h("p", { class: "mlp-intro", text: t.draftIntro }),
        view.firstPrompt ? h("div", { class: "mlp-asked", text: t.firstPrompt(view.firstPrompt) }) : null,
        ...this.#clues(view.refs),
        // The same key as "Edit title": once the mainline exists, the focus lands there.
        this.#editing === titleKey ? null : h("div", { class: "mlp-detail-foot" }, this.#button(t.createMainline, () => this.#edit(titleKey), "mlp-primary", `open:${titleKey}`)),
      );
      return h("div", { class: "mlp-detail", attrs: { id } }, ...parts);
    }

    parts.push(h("h3", { text: t.milestones }));
    if (view.milestones.length)
      parts.push(h("ol", { class: "mlp-milestones" }, ...view.milestones.map((milestone, index) => this.#milestone(view, milestone, now, beside(view.milestones, index)))));
    else parts.push(h("p", { class: "mlp-meta", text: t.noMilestones }));
    // Without a current milestone, what is in progress still shows; the backend opens a first
    // milestone for a task added here.
    if (!view.current && view.now) parts.push(this.#doingRow(view));
    if (!view.milestones.length) parts.push(this.#adder(`taskAdd:${threadId}:`, t.addTask, (text) => this.#mutate({ op: "taskAdd", threadId, text })));
    parts.push(this.#adder(`msAdd:${threadId}`, t.addMilestone, (text) => this.#mutate({ op: "milestoneAdd", threadId, title: text })));

    const open = view.spinoffs.filter((spinoff) => spinoff.state === "open");
    const spinoffs = [...open, ...view.spinoffs.filter((spinoff) => spinoff.state !== "open")];
    parts.push(h("h3", { text: open.length ? `${t.spinoffs} · ${t.spinoffsOpen(open.length)}` : t.spinoffs }));
    if (spinoffs.length)
      parts.push(
        h("div", { class: "mlp-spins" }, ...spinoffs.map((spinoff) => this.#spinoff(view, spinoff, data, now, beside(open, open.indexOf(spinoff)).map(({ id: other }) => `confirm:spawn:${threadId}:${other}`)))),
      );
    parts.push(this.#adder(`spinAdd:${threadId}`, t.addSpinoff, (text) => this.#mutate({ op: "spinoffAdd", threadId, text })));

    parts.push(...this.#clues(view.refs));

    parts.push(
      h(
        "div",
        { class: "mlp-detail-foot" },
        h("span", { class: "mlp-label", text: t.statusLabel }),
        h(
          "div",
          { class: "mlp-segmented", attrs: { role: "group", "aria-label": t.statusLabel } },
          ...STATUSES.map((status) =>
            h("button", {
              class: "mlp-seg",
              text: t.status[status],
              attrs: { type: "button", "aria-pressed": String(view.status === status), "data-status": status, "data-key": `status:${threadId}:${status}` },
              on: {
                click: () => {
                  if (view.status !== status) void this.#mutate({ op: "status", threadId, status }, [`status:${threadId}:${status}`, ...leaving()]);
                },
              },
            }),
          ),
        ),
        h("span", { class: "mlp-spacer" }),
        this.#confirm(`delete:${threadId}`, t.deleteMainline, () => void this.#mutate({ op: "delete", threadId }, [`confirm:delete:${threadId}`, ...leaving()]), { className: "mlp-danger" }),
      ),
    );
    return h("div", { class: "mlp-detail", attrs: { id } }, ...parts);
  }

  /** Keys of the lines next to a conversation's in the list, nearest first, as drawn now. */
  #besideRow(threadId: string): string[] {
    const rows = [...this.#body.querySelectorAll<HTMLElement>(".mlp-row-toggle")].map((row) => row.dataset.key ?? "");
    const at = rows.indexOf(`row:${threadId}`);
    return at < 0 ? [] : [rows[at + 1], rows[at - 1]].filter((key): key is string => Boolean(key));
  }

  /** `neighbours`: the milestones beside this one, nearest first, for the focus once it is deleted. */
  #milestone(view: ConversationView, milestone: MilestoneView, now: number, neighbours: readonly MilestoneView[]): HTMLElement {
    const h = this.#h;
    const t = this.#t;
    const threadId = view.threadId;
    const milestoneId = milestone.id;
    const key = `${threadId}:${milestoneId}`;
    const renameKey = `msRename:${key}`;
    const addKey = `taskAdd:${key}`;
    const current = milestone.state === "current";
    const removeKey = `confirm:msRemove:${key}`;
    const remove = () =>
      void this.#mutate({ op: "milestoneRemove", threadId, milestoneId }, [
        removeKey,
        ...neighbours.map((other) => `open:msRename:${threadId}:${other.id}`),
        `msAdd:${threadId}`,
      ]);
    const head =
      this.#editing === renameKey
        ? [this.#editor(renameKey, milestone.title, t.rename, t.rename, (text, focus) => void this.#mutate({ op: "milestoneRename", threadId, milestoneId, title: text }, focus))]
        : [
            // One block of text that wraps as a whole, so the actions keep to the first line.
            h(
              "div",
              { class: "mlp-ms-text" },
              h("span", { class: "mlp-ms-title", text: milestone.title }),
              h("span", { class: "mlp-badge", attrs: { "data-ms-state": milestone.state }, text: t.milestoneState[milestone.state] }),
              milestone.doneAt ? h("span", { class: "mlp-meta", text: t.time(milestone.doneAt, now) }) : null,
            ),
            h(
              "div",
              { class: "mlp-row-actions" },
              // Only the current milestone has "Mark reached"; once reached, the next current one has it.
              current
                ? this.#button(t.reach, () => void this.#mutate({ op: "milestoneReach", threadId, milestoneId }, [`reach:${threadId}`, `focus:${key}`, `msAdd:${threadId}`]), "mlp-btn-sm", `reach:${threadId}`)
                : this.#button(t.focus, () => void this.#mutate({ op: "milestoneFocus", threadId, milestoneId }, [`focus:${key}`, `reach:${threadId}`]), "mlp-btn-sm", `focus:${key}`),
              milestone.state === "planned" ? this.#iconButton("plus", t.addTaskTo, () => this.#edit(addKey), `open:${addKey}`) : null,
              this.#iconButton("pencil", t.rename, () => this.#edit(renameKey), `open:${renameKey}`),
              // Deleting cannot be undone, so it asks once more: its done tasks go with it, unfinished ones move to the current milestone.
              this.#confirm(`msRemove:${key}`, t.removeMilestone, remove, { icon: "close" }),
            ),
          ];
    return h(
      "li",
      { class: "mlp-ms", attrs: { "data-state": milestone.state, "data-milestone-id": milestoneId } },
      h("div", { class: "mlp-ms-head" }, h("span", { class: "mlp-ms-mark", text: MARK[milestone.state], attrs: { "aria-hidden": "true" } }), ...head),
      milestone.tasks.length
        ? h(
            "ul",
            { class: "mlp-tasks" },
            ...milestone.tasks.map((task, index) =>
              this.#task(view, task, [...beside(milestone.tasks, index).map((other) => `confirm:taskRemove:${threadId}:${other.id}`), addKey, `open:${renameKey}`]),
            ),
          )
        : null,
      current && view.now ? this.#doingRow(view) : null,
      current ? this.#adder(addKey, t.addTask, (text) => this.#mutate({ op: "taskAdd", threadId, text, milestoneId })) : null,
      !current && this.#editing === addKey
        ? h("div", { class: "mlp-ms-add" }, this.#editor(addKey, "", t.addTask, t.addTaskTo, (text, focus) => void this.#mutate({ op: "taskAdd", threadId, text, milestoneId }, focus)))
        : null,
    );
  }

  /** `after`: where the focus goes once the task is deleted. */
  #task(view: ConversationView, task: TaskView, after: readonly string[]): HTMLElement {
    const h = this.#h;
    const t = this.#t;
    const threadId = view.threadId;
    const child = task.threadId;
    const removeKey = `confirm:taskRemove:${threadId}:${task.id}`;
    return h(
      "li",
      { class: "mlp-task", attrs: { "data-task-id": task.id, "data-done": task.done ? "" : undefined } },
      h("span", { class: "mlp-task-mark", text: task.done ? "✓" : "○", attrs: { "aria-hidden": "true" } }),
      h(
        "div",
        { class: "mlp-main" },
        h("span", { class: "mlp-task-text", text: task.text }),
        child ? this.#threadLink(t.carriedBy(task.threadTitle ?? shortId(child)), child, "mlp-carried", `carried:${threadId}:${task.id}`) : null,
      ),
      h(
        "div",
        { class: "mlp-row-actions" },
        task.done
          ? null
          : this.#iconButton("check", t.taskDone, () => void this.#mutate({ op: "taskDone", threadId, taskId: task.id }, [`taskDone:${threadId}:${task.id}`, removeKey]), `taskDone:${threadId}:${task.id}`),
        // Deleting cannot be undone: a second click within three seconds.
        this.#confirm(`taskRemove:${threadId}:${task.id}`, t.removeTask, () => void this.#mutate({ op: "taskRemove", threadId, taskId: task.id }, [removeKey, ...after]), { icon: "close" }),
      ),
    );
  }

  #doingRow(view: ConversationView): HTMLElement {
    const h = this.#h;
    const t = this.#t;
    const threadId = view.threadId;
    const key = `doing:${threadId}`;
    const text = view.now?.text ?? "";
    // Once nothing is in progress, the field that adds a task is next.
    const gone = [`taskAdd:${threadId}:${view.current?.id ?? ""}`, `msAdd:${threadId}`];
    if (this.#editing === key)
      return h(
        "div",
        { class: "mlp-doing-row" },
        this.#editor(key, text, t.doingPlaceholder, t.editDoing, (next, focus) => void this.#mutate({ op: "doing", threadId, text: next || null }, [...focus, ...gone]), {
          allowEmpty: true,
        }),
      );
    return h(
      "div",
      { class: "mlp-doing-row" },
      h("span", { class: "mlp-doing", text: t.doing(text) }),
      h(
        "div",
        { class: "mlp-row-actions" },
        this.#iconButton("pencil", t.editDoing, () => this.#edit(key), `open:${key}`),
        this.#iconButton("close", t.clearDoing, () => void this.#mutate({ op: "doing", threadId, text: null }, [`doingClear:${threadId}`, ...gone]), `doingClear:${threadId}`),
      ),
    );
  }

  /** `after`: where the focus goes once this spin-off is no longer open (the next open one's button). */
  #spinoff(view: ConversationView, spinoff: Spinoff, data: PageData, now: number, after: readonly string[]): HTMLElement {
    const h = this.#h;
    const t = this.#t;
    const threadId = view.threadId;
    const key = `${threadId}:${spinoff.id}`;
    const child = spinoff.childThreadId;
    const next = [...after, `spinAdd:${threadId}`];
    let actions: Child = null;
    if (spinoff.state === "spawned")
      actions = child
        ? this.#threadLink(t.spawned(titleOf(child, this.#sources(data))), child, "", `spawned:${key}`)
        : h("span", { class: "mlp-meta", text: t.spawned("…") });
    else if (spinoff.state === "open")
      actions = h(
        "div",
        { class: "mlp-spin-actions" },
        this.#spawning.has(key)
          ? h("button", { class: "mlp-btn mlp-btn-sm", text: t.spawning, attrs: { type: "button", disabled: "" } })
          : this.#confirm(`spawn:${key}`, t.spawn, () => void this.#spawn(threadId, spinoff, [`confirm:spawn:${key}`, ...next]), { className: "mlp-btn-sm mlp-primary" }),
        this.#button(t.keep, () => void this.#mutate({ op: "spinoffKeep", threadId, spinoffId: spinoff.id }, [`keep:${key}`, ...next]), "mlp-btn-sm", `keep:${key}`),
        // A dismissed spin-off cannot be brought back: a second click within three seconds.
        this.#confirm(`dismiss:${key}`, t.dismiss, () => void this.#mutate({ op: "spinoffDismiss", threadId, spinoffId: spinoff.id }, [`confirm:dismiss:${key}`, ...next]), { className: "mlp-btn-sm" }),
      );
    return h(
      "div",
      { class: "mlp-spin", attrs: { "data-spinoff-id": spinoff.id, "data-state": spinoff.state } },
      h("span", { class: "mlp-spin-mark", text: "↳", attrs: { "aria-hidden": "true" } }),
      h("div", { class: "mlp-main" }, h("div", { text: spinoff.text }), h("div", { class: "mlp-meta", text: t.time(spinoff.at, now) })),
      actions,
    );
  }

  #clues(refs: RefView[]): Child[] {
    if (!refs.length) return [];
    const h = this.#h;
    const t = this.#t;
    return [
      h("h3", { text: t.refs }),
      h(
        "div",
        { class: "mlp-clues" },
        ...refs.map((ref) =>
          h(
            "div",
            { class: "mlp-clue" },
            h("a", { class: "mlp-ref-link", text: `${t.kind[ref.kind]} #${ref.number}${ref.title ? ` ${ref.title}` : ""}`, attrs: { href: safeUrl(ref.url), target: "_blank", rel: "noopener noreferrer" } }),
            ref.state ? h("span", { class: "mlp-badge", attrs: { "data-ref-state": ref.state }, text: t.refState[ref.state] }) : null,
            h("span", { class: "mlp-meta", text: ref.repo }),
          ),
        ),
      ),
    ];
  }

  // Small parts -------------------------------------------------------------------------------

  #tags(tags: string[]): HTMLElement {
    const h = this.#h;
    return h("div", { class: "mlp-tags" }, ...tags.map((tag) => h("span", { class: "mlp-tag", text: tag })));
  }

  #statusDot(status: ThreadStatus): HTMLElement {
    const label = this.#t.threadStatus[status];
    return this.#h("span", { class: "mlp-status", title: label, attrs: { "data-status": status, role: "img", "aria-label": label } });
  }

  #statusBadge(status: ConversationStatus): HTMLElement {
    return this.#h("span", { class: "mlp-badge", attrs: { "data-conv-status": status }, text: this.#t.status[status] });
  }

  /** `key` (here and below): the control's `data-key`, by which the focus finds it again after a redraw. */
  #threadLink(text: string, threadId: string, className = "", key?: string): HTMLButtonElement {
    return this.#h("button", { class: `mlp-link ${className}`.trim(), text, attrs: { type: "button", "data-key": key }, on: { click: () => this.#openThread(threadId) } });
  }

  #button(label: string, onClick: () => void, className = "", key?: string): HTMLButtonElement {
    return this.#h("button", { class: `mlp-btn ${className}`.trim(), text: label, attrs: { type: "button", "data-key": key }, on: { click: onClick } });
  }

  #iconButton(name: IconName, label: string, onClick: () => void, key?: string): HTMLButtonElement {
    const button = this.#h("button", { class: "mlp-icon", title: label, attrs: { type: "button", "aria-label": label, "data-key": key }, on: { click: onClick } });
    button.append(icon(this.#doc, name));
    return button;
  }

  /**
   * A button that acts on the second click within three seconds. The armed state lives outside
   * the button, so a redraw in between keeps it (and the focus, by its key); screen readers hear
   * that it waits.
   */
  #confirm(key: string, label: string, onConfirm: () => void, options: { className?: string; icon?: IconName } = {}): HTMLButtonElement {
    const button = this.#h("button", { title: label, attrs: { type: "button", "data-confirm-key": key, "data-key": `confirm:${key}` } });
    const idle = () => {
      button.removeAttribute("data-confirm");
      if (options.icon) {
        button.className = "mlp-icon";
        button.setAttribute("aria-label", label);
        button.replaceChildren(icon(this.#doc, options.icon));
      } else {
        button.className = `mlp-btn ${options.className ?? ""}`.trim();
        button.textContent = label;
      }
    };
    const armed = () => {
      button.setAttribute("data-confirm", "");
      button.className = `mlp-btn ${options.icon ? "mlp-btn-sm" : (options.className ?? "")}`.trim();
      button.removeAttribute("aria-label");
      button.textContent = this.#t.confirm;
    };
    if (this.#confirming.has(key)) armed();
    else idle();
    this.#resetters.set(button, idle);
    button.addEventListener("click", () => {
      const timer = this.#confirming.get(key);
      const waiting = this.#t.armed(label);
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
          for (const other of this.#container.querySelectorAll("[data-confirm-key]"))
            if (other.getAttribute("data-confirm-key") === key) this.#resetters.get(other)?.();
        }, CONFIRM_MS),
      );
      armed();
      this.#live.textContent = waiting;
    });
    return button;
  }

  /**
   * A field that edits one value in place: Enter saves, Escape cancels. Closed from the keyboard,
   * it hands the focus back to the button that opened it (`open:<key>`); `onCommit` gets that
   * target to pass on to the edit. Left by Tab or a click, the focus goes where the user sent it.
   */
  #editor(
    key: string,
    value: string,
    placeholder: string,
    label: string,
    onCommit: (text: string, focus: readonly string[]) => void,
    options: EditorOptions = {},
  ): HTMLInputElement {
    const input = this.#h("input", { class: "mlp-input mlp-editor", attrs: { type: "text", placeholder, "aria-label": label, "data-autofocus": "", "data-key": key } });
    // What was typed survives a redraw while the editor stays open.
    const draftKey = `edit:${key}`;
    input.value = this.#drafts.get(draftKey) ?? value;
    input.addEventListener("input", () => this.#drafts.set(draftKey, input.value));
    let settled = false;
    const finish = (commit: boolean, byKeyboard: boolean) => {
      if (settled) return;
      settled = true;
      this.#drafts.delete(draftKey);
      if (this.#editing === key) this.#editing = null;
      const text = input.value.trim();
      const focus = byKeyboard ? [`open:${key}`] : [];
      if (commit && (text || options.allowEmpty) && (options.commitUnchanged || text !== value.trim())) onCommit(text, focus);
      else {
        this.#focusKeys = focus;
        this.#render(true);
      }
    };
    input.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      if (event.key === "Enter") {
        event.preventDefault();
        finish(true, true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(false, true);
      }
    });
    input.addEventListener("blur", () => {
      // A redraw that takes the field away is not the user leaving it.
      if (input.isConnected) finish(options.commitOnBlur !== false, false);
    });
    return input;
  }

  /** An always-visible field that adds an item on Enter and keeps its text across redraws. */
  #adder(key: string, placeholder: string, onCommit: (text: string) => Promise<boolean>): HTMLInputElement {
    const input = this.#h("input", { class: "mlp-input mlp-adder", attrs: { type: "text", placeholder, "aria-label": placeholder.replace(/…$/u, ""), "data-key": key } });
    input.value = this.#drafts.get(key) ?? "";
    input.addEventListener("input", () => {
      if (input.value) this.#drafts.set(key, input.value);
      else this.#drafts.delete(key);
    });
    input.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      if (event.key === "Enter") {
        event.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        input.value = "";
        this.#drafts.delete(key);
        this.#focusKeys = [key];
        void onCommit(text).then((ok) => {
          if (ok || this.#drafts.has(key)) return;
          // Keep what was typed so it can be sent again.
          this.#drafts.set(key, text);
          this.#focusKeys = [key];
          this.#render(true);
        });
      } else if (event.key === "Escape" && input.value) {
        event.preventDefault();
        input.value = "";
        this.#drafts.delete(key);
      }
    });
    return input;
  }

  // Favorites -----------------------------------------------------------------------------------

  #favoritesSection(): HTMLElement {
    const h = this.#h;
    const t = this.#t;
    const list = h("div", { class: "mlp-favorites" });
    this.#favoritesList = list;
    const search = h("input", {
      class: "mlp-input mlp-refs-search",
      attrs: { type: "search", placeholder: t.favoritesPlaceholder, "aria-label": t.favoritesPlaceholder, "data-key": "favorites-search" },
    });
    search.value = this.#favoriteQuery;
    search.addEventListener("input", () => {
      this.#favoriteQuery = search.value;
      // At once from what is loaded; then the backend's answer, which searches every whole text.
      this.#fillFavorites();
      void this.#loadFavorites();
    });
    const section = h(
      "section",
      { class: "mlp-section mlp-favorites-section" },
      h("h2", { text: t.favoritesSection }),
      h("p", { class: "mlp-intro", text: t.favoritesIntro }),
      search,
      list,
    );
    this.#fillFavorites();
    return section;
  }

  /** The title of the conversation a passage came from: as it is now, else as it was when saved. */
  #favoriteTitle(item: FavoriteExcerpt): string {
    return this.#favorites?.titles[item.threadId] ?? item.threadTitle ?? shortId(item.threadId);
  }

  /** Redraws only the list, so typing in the search box keeps its focus. */
  #fillFavorites(): void {
    const list = this.#favoritesList;
    if (!list) return;
    const h = this.#h;
    const t = this.#t;
    if (!this.#favorites) {
      list.replaceChildren(h("p", { class: "mlp-muted", text: t.loading }));
      return;
    }
    const all = this.#favorites.items;
    const words = this.#favoriteQuery.trim().toLowerCase().split(/\s+/u).filter(Boolean);
    // The loaded passages answer another search (the answer to this one is on its way): narrowed down here meanwhile.
    const narrowing = words.length > 0 && this.#favoritesFor !== this.#favoriteQuery.trim();
    const shown = narrowing
      ? all.filter((item) => {
          const haystack = [item.text, item.note ?? "", this.#favoriteTitle(item)].join("\n").toLowerCase();
          return words.every((word) => haystack.includes(word));
        })
      : all;
    const left = (this.#favorites.matched ?? all.length) - all.length;
    list.replaceChildren(
      ...(shown.length
        ? shown.map((item) => this.#favoriteItem(item))
        : [h("p", { class: "mlp-muted", text: all.length || this.#favorites.total ? t.favoritesNone : t.favoritesEmpty })]),
      ...(!narrowing && this.#favorites.nextOffset !== undefined && left > 0
        ? [this.#more(t.favoritesMore(left), () => void this.#loadFavorites(true), "more:favorites")]
        : []),
    );
  }

  #favoriteItem(item: FavoriteExcerpt): HTMLElement {
    const h = this.#h;
    const t = this.#t;
    const now = Date.now();
    // The whole text once read; until then what the list sent, which may be cut short.
    const body = this.#fullTexts.get(item.id) ?? item.text;
    const cut = item.truncated === true && !this.#fullTexts.has(item.id);
    const long = cut || body.length > PASSAGE_FOLD_CHARS || body.split("\n").length > PASSAGE_FOLD_LINES;
    const open = this.#openPassages.has(item.id);
    const noteKey = `favorite-note:${item.id}`;
    const editingNote = this.#editing === noteKey;
    const where = [item.turn ? t.turn(item.turn) : "", item.role ? t.favoriteRole[item.role] : "", t.time(item.createdAt, now)].filter(Boolean).join(" · ");
    // Each control has its key (see #focusKeys): a redraw after it acted keeps the focus on it.
    const title = this.#threadLink(this.#favoriteTitle(item), item.threadId, "mlp-favorite-title", `favorite-title:${item.id}`);
    title.title = t.openConversation;
    return h(
      "article",
      { class: "mlp-favorite", attrs: { "data-favorite": item.id } },
      h(
        "div",
        { class: "mlp-favorite-head" },
        title,
        h("span", { class: "mlp-meta", text: where }),
        h("span", { class: "mlp-spacer" }),
        this.#button(t.jumpToPassage, () => void this.#revealFavorite(item), "mlp-btn-sm mlp-primary", `favorite-jump:${item.id}`),
      ),
      // A reply the agent saved is its Markdown source: shown formatted, as it read in the conversation.
      item.source === "chat"
        ? h("div", { class: "mlp-favorite-text mlp-md", attrs: { "data-folded": long && !open ? "" : undefined } }, ...renderMarkdown(h, body))
        : h("div", { class: "mlp-favorite-text", attrs: { "data-folded": long && !open ? "" : undefined } }, body),
      long
        ? this.#more(open ? t.foldPassage : t.expandPassage, () => {
            if (open) this.#openPassages.delete(item.id);
            else {
              this.#openPassages.add(item.id);
              // Cut short in the list: the whole text comes from the backend.
              if (cut)
                void this.#fullText(item).then(
                  () => this.#render(true),
                  (error: unknown) => {
                    this.#error = { kind: "action", text: this.#message(error) };
                    this.#render(true);
                  },
                );
            }
            this.#render(true);
          }, `favorite-fold:${item.id}`)
        : null,
      editingNote
        ? this.#editor(noteKey, item.note ?? "", t.notePlaceholder, t.editNote, (note, focus) => void this.#noteFavorite(item, note, focus), { allowEmpty: true })
        : item.note
          ? h("div", { class: "mlp-asked", text: t.favoriteNote(item.note) })
          : null,
      h(
        "div",
        { class: "mlp-actions mlp-favorite-actions" },
        this.#button(this.#copied === item.id ? t.copied : t.copy, () => void this.#copyFavorite(item), "mlp-btn-sm", `favorite-copy:${item.id}`),
        editingNote ? null : this.#button(item.note ? t.editNote : t.addNote, () => this.#edit(noteKey), "mlp-btn-sm", `open:${noteKey}`),
        this.#confirm(`favorite-remove:${item.id}`, t.removeFavorite, () => void this.#removeFavorite(item), { className: "mlp-btn-sm mlp-danger" }),
      ),
    );
  }

  /** Opens the passage's conversation; the conversation finds the passage and highlights it (the backend has its whole text). */
  async #revealFavorite(item: FavoriteExcerpt): Promise<void> {
    try {
      const result = (await this.#api.backend.invoke("favorites.reveal", { id: item.id })) as { threadId?: unknown } | null;
      const hostId = (result as { hostId?: unknown } | null)?.hostId;
      this.#openThread(typeof result?.threadId === "string" ? result.threadId : item.threadId, isRemoteHostId(hostId) ? hostId : item.hostId);
    } catch (error) {
      this.#error = { kind: "action", text: this.#message(error) };
      this.#render(true);
    }
  }

  async #noteFavorite(item: FavoriteExcerpt, note: string, focus?: readonly string[]): Promise<void> {
    if (await this.#act(() => this.#api.backend.invoke("favorites.note", { id: item.id, note }), focus)) await this.#loadFavorites();
  }

  async #removeFavorite(item: FavoriteExcerpt): Promise<void> {
    if (await this.#act(() => this.#api.backend.invoke("favorites.remove", { id: item.id }))) await this.#loadFavorites();
  }

  /** Copies the whole passage, read from the backend first when the list cut it short. */
  async #copyFavorite(item: FavoriteExcerpt): Promise<void> {
    let text: string;
    try {
      text = await this.#fullText(item);
    } catch (error) {
      this.#error = { kind: "action", text: this.#message(error) };
      this.#render(true);
      return;
    }
    let copied = false;
    try {
      await this.#doc.defaultView?.navigator.clipboard.writeText(text);
      copied = Boolean(this.#doc.defaultView?.navigator.clipboard);
    } catch {
      copied = false;
    }
    if (!copied) copied = this.#copyByHand(text);
    if (!copied) {
      this.#error = { kind: "action", text: this.#t.copyFailed };
      this.#render(true);
      return;
    }
    this.#copied = item.id;
    this.#render(true);
    clearTimeout(this.#copiedTimer);
    this.#copiedTimer = setTimeout(() => {
      this.#copied = null;
      this.#render();
    }, COPIED_MS);
  }

  /** Copies through a hidden field, for pages where the clipboard API is not allowed. */
  #copyByHand(text: string): boolean {
    const area = this.#h("textarea", { attrs: { readonly: "", "aria-hidden": "true" } });
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    area.style.pointerEvents = "none";
    this.#container.append(area);
    area.select();
    let copied = false;
    try {
      copied = this.#doc.execCommand("copy");
    } catch {
      copied = false;
    }
    area.remove();
    return copied;
  }

  // PRs and issues ------------------------------------------------------------------------------

  #refsSection(): HTMLElement {
    const h = this.#h;
    const t = this.#t;
    const refs = this.#refs;
    const now = Date.now();
    const list = h("div", { class: "mlp-refs" });
    this.#refsList = list;
    const search = h("input", { class: "mlp-input mlp-refs-search", attrs: { type: "search", placeholder: t.refsPlaceholder, "aria-label": t.findRefs, "data-key": "refs-search" } });
    search.value = this.#refQuery;
    search.addEventListener("input", () => {
      this.#refQuery = search.value;
      this.#fillRefs();
    });
    const status = refs
      ? [
          h("div", {
            class: "mlp-meta",
            text: t.scanStatus(refs.status.conversations.scanned, refs.status.conversations.listed, refs.status.conversations.done, refs.status.refs, refs.status.conversations.unreadable),
          }),
          h("div", {
            class: refs.status.github.error ? "mlp-meta mlp-warn" : "mlp-meta",
            text: t.githubStatus(refs.status.github.enabled, refs.status.github.lastPollAt, refs.status.github.error, now, refs.status.refs),
          }),
        ]
      : [h("div", { class: "mlp-meta", text: t.loading })];
    const section = h("section", { class: "mlp-section mlp-refs-section" }, h("h2", { text: t.refsSection }), h("p", { class: "mlp-intro", text: t.refsIntro }), ...status, search, list);
    this.#fillRefs();
    return section;
  }

  /** Redraws only the list, so typing in the search box keeps its focus. */
  #fillRefs(): void {
    const list = this.#refsList;
    if (!list) return;
    const t = this.#t;
    const all = this.#refs?.refs ?? [];
    const query = this.#refQuery.trim().toLowerCase();
    const digits = /^[^\d]*#?(\d+)$/u.exec(query)?.[1];
    const shown = !query
      ? all
      : all.filter((ref) =>
          digits
            ? String(ref.number) === digits
            : [ref.key, ref.title, ref.note, ref.origin?.title, ref.origin?.prompt].filter(Boolean).join(" ").toLowerCase().includes(query),
        );
    list.replaceChildren(
      ...(shown.length ? shown.slice(0, 200).map((ref) => this.#refItem(ref)) : [this.#h("p", { class: "mlp-muted", text: all.length ? t.noResults : t.refsEmpty })]),
    );
  }

  #refItem(ref: RefView): HTMLElement {
    const h = this.#h;
    const t = this.#t;
    const now = Date.now();
    const origin = ref.origin;
    const unseen = ref.activity?.unseen === true;
    const jump = origin
      ? this.#button(
          t.jump,
          () => {
            if (unseen) void this.#api.backend.invoke("refs.seen", { key: ref.key }).then(() => this.#loadRefs());
            this.#openThread(origin.threadId, origin.hostId ?? this.#onHost(origin.threadId).hostId);
          },
          "",
          `ref-jump:${ref.key}`,
        )
      : null;
    return h(
      "article",
      { class: "mlp-ref", attrs: { "data-unseen": unseen ? "" : undefined } },
      h(
        "div",
        { class: "mlp-ref-head" },
        h("a", { class: "mlp-ref-link", text: `#${ref.number}${ref.title ? ` ${ref.title}` : ""}`, attrs: { href: safeUrl(ref.url), target: "_blank", rel: "noopener noreferrer" } }),
        h("span", { class: "mlp-badge", attrs: { "data-ref-state": ref.state }, text: `${t.kind[ref.kind]}${ref.state ? ` · ${t.refState[ref.state]}` : ""}` }),
        h("span", { class: "mlp-meta", text: ref.repo }),
        h("span", { class: "mlp-spacer" }),
        jump,
      ),
      h(
        "div",
        { class: "mlp-ref-meta" },
        unseen && ref.activity ? h("span", { class: "mlp-news", text: `${t.reason(ref.activity.reason)} · ${t.time(ref.activity.at, now)}` }) : null,
        origin ? h("span", { class: "mlp-meta", text: `${t.fromWindow(origin.title ?? origin.threadId.slice(0, 8))}${origin.turn ? ` ${t.turn(origin.turn)}` : ""}` }) : null,
        ref.windows > 1 ? h("span", { class: "mlp-meta", text: t.inWindows(ref.windows) }) : null,
      ),
      origin?.prompt ? h("div", { class: "mlp-asked", text: t.asked(origin.prompt) }) : null,
      ref.note ? h("div", { class: "mlp-asked", text: t.noteLabel(ref.note) }) : null,
    );
  }

  // Agent integration ---------------------------------------------------------------------------

  #integrationSection(): HTMLElement {
    const h = this.#h;
    const t = this.#t;
    const rows = this.#integrations.map((status) => {
      const agent = status.agent;
      const busy = status.state === "unavailable";
      return h(
        "div",
        { class: "mlp-integration" },
        h(
          "div",
          { class: "mlp-main" },
          h("strong", { text: t.agentName[agent] }),
          h("div", { class: "mlp-meta", text: status.problem ? t.integrationProblem(agent, status.problem, status.cause) : (status.detail ?? status.file) }),
        ),
        h("span", { class: "mlp-badge", attrs: { "data-state": status.state }, text: t.integrationState[status.state] }),
        busy ? null : this.#button(t.preview, () => void this.#showPreview(agent, false, `integration:${agent}:preview`), "", `integration:${agent}:preview`),
        busy || status.state === "installed"
          ? null
          : this.#button(status.state === "outdated" ? t.update : t.install, () => void this.#showPreview(agent, false, `integration:${agent}:install`), "mlp-primary", `integration:${agent}:install`),
        busy || status.state === "missing" ? null : this.#button(t.uninstall, () => void this.#showPreview(agent, true, `integration:${agent}:uninstall`), "", `integration:${agent}:uninstall`),
      );
    });
    const preview = this.#preview;
    return h(
      "section",
      { class: "mlp-section mlp-integrations" },
      h("h2", { text: t.integrations }),
      h("p", { class: "mlp-intro", text: t.integrationsIntro }),
      ...rows,
      preview
        ? h(
            "div",
            { class: "mlp-preview" },
            h("div", { class: "mlp-preview-title", text: t.previewTitle(t.previewAction[preview.action], preview.file) }),
            preview.problem
              ? h("p", { class: "mlp-meta", text: t.integrationProblem(preview.agent, preview.problem, preview.cause) })
              : h("pre", { class: "mlp-pre", text: preview.snippet }),
            h(
              "div",
              { class: "mlp-actions" },
              preview.action === "none" ? null : this.#button(t.applyChange, () => void this.#applyIntegration(preview.agent, preview.removing), "mlp-primary", "integration:apply"),
              this.#button(
                t.cancel,
                () => {
                  this.#focusKeys = this.#previewFocus(preview.agent);
                  this.#preview = null;
                  this.#render(true);
                },
                "",
                "integration:cancel",
              ),
            ),
          )
        : null,
      this.#data?.command ? h("p", { class: "mlp-meta", text: t.command(this.#data.command) }) : null,
    );
  }

  // Settings ------------------------------------------------------------------------------------

  /** After the data of the extension's earlier name was copied over: its old folder is still there, and may go. */
  #migrationNote(): HTMLElement | null {
    const folder = this.#data?.oldFolder;
    return folder ? this.#h("p", { class: "mlp-intro mlp-migrated", attrs: { role: "note" }, text: this.#t.migratedNote(folder) }) : null;
  }

  #settingsSection(): HTMLElement {
    const h = this.#h;
    const t = this.#t;
    const name = `mlp-drift-${this.#api.id}`;
    const radios = (["ask", "note", "off"] as const).map((policy) => {
      const input = h("input", { attrs: { type: "radio", name, value: policy, "data-key": `setting:driftPolicy:${policy}` } });
      input.checked = this.#settings.driftPolicy === policy;
      input.addEventListener("change", () => {
        if (input.checked) void this.#saveSettings({ driftPolicy: policy });
      });
      return h("label", { class: "mlp-choice" }, input, h("span", { text: t.driftPolicies[policy] }));
    });
    const capsule = h("input", { attrs: { type: "checkbox", name: "showCapsule", "data-key": "setting:showCapsule" } });
    capsule.checked = this.#settings.showCapsule;
    capsule.addEventListener("change", () => void this.#saveSettings({ showCapsule: capsule.checked }));
    const alerts = h("input", { attrs: { type: "checkbox", name: "prAlerts", "data-key": "setting:prAlerts" } });
    alerts.checked = this.#settings.prAlerts;
    alerts.addEventListener("change", () => void this.#saveSettings({ prAlerts: alerts.checked }));
    const auto = h("input", { attrs: { type: "checkbox", name: "autoSummarize", "data-key": "setting:autoSummarize" } });
    auto.checked = this.#settings.autoSummarize;
    auto.addEventListener("change", () => void this.#saveSettings({ autoSummarize: auto.checked }));
    const model = h("select", { class: "mlp-select", attrs: { name: "summarizeModel", "aria-label": t.summarizeModel, "data-key": "setting:summarizeModel" } });
    for (const value of ["follow", "claude", "codex"] as const) {
      const option = h("option", { text: t.summarizeModels[value], attrs: { value } });
      option.selected = this.#settings.summarizeModel === value;
      model.append(option);
    }
    model.addEventListener("change", () => {
      const value = model.value;
      if (value === "follow" || value === "claude" || value === "codex") void this.#saveSettings({ summarizeModel: value });
    });
    // Conversations of any other agent go to a model only when the user picks one here.
    const others = h("select", { class: "mlp-select", attrs: { name: "summarizeOthers", "aria-label": t.summarizeOthers, "data-key": "setting:summarizeOthers" } });
    for (const value of ["none", "claude", "codex"] as const) {
      const option = h("option", { text: t.summarizeOthersOptions[value], attrs: { value } });
      option.selected = this.#settings.summarizeOthers === value;
      others.append(option);
    }
    others.addEventListener("change", () => {
      const value = others.value;
      if (value === "none" || value === "claude" || value === "codex") void this.#saveSettings({ summarizeOthers: value });
    });
    return h(
      "section",
      { class: "mlp-section mlp-settings" },
      h("h2", { text: t.settings }),
      h("fieldset", { class: "mlp-field mlp-fieldset" }, h("legend", { class: "mlp-label", text: t.driftPolicy }), h("div", { class: "mlp-choices" }, ...radios)),
      h("div", { class: "mlp-field" }, h("label", { class: "mlp-choice" }, capsule, h("span", { text: t.showCapsule }))),
      h("div", { class: "mlp-field" }, h("label", { class: "mlp-choice" }, alerts, h("span", { text: t.prAlerts }))),
      h("div", { class: "mlp-field" }, h("label", { class: "mlp-choice" }, auto, h("span", { text: t.autoSummarize }))),
      h("div", { class: "mlp-field" }, h("div", { class: "mlp-label", text: t.summarizeModel }), model),
      h("div", { class: "mlp-field" }, h("div", { class: "mlp-label", text: t.summarizeOthers }), others, h("div", { class: "mlp-meta", text: t.summarizeOthersHint })),
      this.#data ? this.#summarizerLine(this.#data) : null,
    );
  }

  // Files sent along with child conversations -------------------------------------------------

  /** How much they take, and clearing them with two clicks; a button that would free nothing is left out. */
  #attachmentsSection(): HTMLElement {
    const h = this.#h;
    const t = this.#t;
    const usage = this.#attachments;
    const parts: Child[] = [h("h2", { text: t.attachmentsSection })];
    if (!usage) parts.push(h("p", { class: "mlp-muted", text: t.loading }));
    else if (!usage.all.files) parts.push(h("p", { class: "mlp-muted", text: t.attachmentsNone }));
    else
      parts.push(
        h("p", { class: "mlp-intro", text: t.attachmentsIntro }),
        h("div", { class: "mlp-attachments-usage", text: t.attachmentsUsage(usage.all.files, formatSize(usage.all.bytes)) }),
        h(
          "div",
          { class: "mlp-actions" },
          ...(this.#clearingAttachments
            ? [h("span", { class: "mlp-meta", text: t.clearingAttachments })]
            : [
                usage.done.files
                  ? this.#confirm("attachments:done", t.clearDoneAttachments(formatSize(usage.done.bytes)), () => void this.#clearAttachments("done"), { className: "mlp-btn-sm" })
                  : null,
                this.#confirm("attachments:all", t.clearAllAttachments(formatSize(usage.all.bytes)), () => void this.#clearAttachments("all"), { className: "mlp-btn-sm mlp-danger" }),
              ]),
        ),
      );
    return h("section", { class: "mlp-section mlp-attachments" }, ...parts);
  }

  /** Counts them when the settings tab opens: reading every folder is too much for each snapshot. */
  async #loadAttachments(): Promise<void> {
    if (this.#stopped) return;
    try {
      const usage = readUsage(await this.#api.backend.invoke("attachments.usage"));
      if (this.#stopped || !usage) return;
      this.#attachments = usage;
    } catch (error) {
      if (this.#stopped) return;
      this.#error = { kind: "action", text: this.#message(error) };
    }
    this.#render();
  }

  async #clearAttachments(scope: AttachmentsScope): Promise<void> {
    if (this.#clearingAttachments) return;
    this.#clearingAttachments = true;
    this.#render(true);
    const focus = [`confirm:attachments:${scope}`, "confirm:attachments:all", "tab:settings"];
    try {
      const result = await this.#api.backend.invoke("attachments.clear", { scope } satisfies AttachmentsClearParams);
      const cleared = isRecord(result) ? readFilesSize(result.cleared) : undefined;
      const usage = isRecord(result) ? readUsage(result.usage) : undefined;
      if (usage) this.#attachments = usage;
      if (cleared && !this.#stopped) this.#showNotice(this.#t.attachmentsCleared(cleared.files, formatSize(cleared.bytes)));
    } catch (error) {
      if (!this.#stopped) {
        this.#error = { kind: "action", text: this.#message(error) };
        // Some may be gone all the same: count again.
        void this.#loadAttachments();
      }
    } finally {
      this.#clearingAttachments = false;
    }
    this.#focusKeys = focus;
    this.#render(true);
  }

  // Model summaries ---------------------------------------------------------------------------

  /**
   * What the model is doing, with a button that stops the backfill. In full (the settings): also
   * today's counts, and the button that starts the backfill after a second click, saying how many
   * conversations it sends at most.
   */
  #summarizerLine(data: PageData, full = true): HTMLElement | null {
    const h = this.#h;
    const t = this.#t;
    const status = data.summarizer;
    if (!status) return null;
    const parts: Child[] = [];
    if (status.backfill)
      parts.push(
        h("span", { text: t.backfillProgress(status.backfill.done, status.backfill.total, status.backfill.failed, status.backfill.skipped, status.backfill.full ?? 0) }),
        this.#button(t.backfillStop, () => void this.#stopBackfill(), "mlp-btn-sm mlp-quiet", "backfill:stop"),
      );
    else if (status.running || status.queued) parts.push(h("span", { text: t.summarizerBusy(status.running, status.queued) }));
    if (full) {
      const { calls } = status.today;
      parts.push(h("span", { text: t.summarizerToday(status.today.count, status.today.limit, calls.claude.auto, calls.codex.auto) }));
      const manual = calls.claude.manual + calls.codex.manual;
      const backfill = calls.claude.backfill + calls.codex.backfill;
      if (manual || backfill) parts.push(h("span", { text: t.summarizerAsked(manual, backfill) }));
    }
    if (status.lastError) parts.push(h("span", { class: "mlp-error-text", text: t.summarizerError(this.#lastErrorText(status)) }));
    if (full && !status.backfill && status.toBackfill)
      parts.push(
        this.#confirm("backfill:start", t.backfillStart(status.toBackfill), () => void this.#act(() => this.#api.backend.invoke("summarize.backfill"), ["backfill:stop", "confirm:backfill:start", "tab:settings"]), {
          className: "mlp-btn-sm mlp-quiet",
        }),
      );
    return parts.length ? h("div", { class: "mlp-summarizer mlp-meta" }, ...parts) : null;
  }

  /** Why the last summary failed, in the page's language where the backend gives a code for it. */
  #lastErrorText(status: SummarizerStatus): string {
    const code = status.lastErrorCode;
    const message = status.lastError ?? "";
    if (code !== undefined && Object.hasOwn(this.#t.summaryProblem, code)) return this.#t.summaryProblem[code as SummaryProblem];
    return isErrorCode(code) ? this.#t.error(code, message) : message;
  }

  async #stopBackfill(): Promise<void> {
    if (await this.#act(() => this.#api.backend.invoke("summarize.cancel"), ["confirm:backfill:start", "backfill:stop", "tab:settings"])) this.#showNotice(this.#t.backfillStopped);
  }

  async #summarize(threadId: string): Promise<void> {
    if (await this.#act(() => this.#api.backend.invoke("summarize", { threadId, ...this.#onHost(threadId) }))) this.#showNotice(this.#t.summarizeQueued);
  }

  /** "You changed … by hand", with the way back to automatic summaries. */
  #pinnedNote(view: ConversationView): HTMLElement | null {
    const pinned = view.pinned;
    if (!pinned) return null;
    const t = this.#t;
    const parts = [
      pinned.title ? t.pinnedParts.title : null,
      pinned.tags ? t.pinnedParts.tags : null,
      pinned.status ? t.pinnedParts.status : null,
      pinned.milestones ? t.pinnedParts.milestones(pinned.milestones) : null,
    ].filter((part): part is string => part !== null);
    return this.#h(
      "div",
      { class: "mlp-pinned mlp-meta" },
      this.#h("span", { text: t.pinnedNote(parts) }),
      this.#button(t.unpin, () => void this.#mutate({ op: "unpin", threadId: view.threadId }, [`unpin:${view.threadId}`, `resummarize:${view.threadId}`]), "mlp-btn-sm mlp-quiet", `unpin:${view.threadId}`),
    );
  }
}

function readSummarizer(value: unknown): Pick<PageData, "summarizer"> {
  if (typeof value !== "object" || value === null) return {};
  const raw = value as Partial<SummarizerStatus>;
  if (typeof raw.running !== "number" || typeof raw.queued !== "number") return {};
  const count = (item: unknown) => (typeof item === "number" && Number.isFinite(item) && item >= 0 ? item : 0);
  const backfill = raw.backfill && typeof raw.backfill.done === "number" && typeof raw.backfill.total === "number" ? raw.backfill : undefined;
  const today: Record<string, unknown> = isRecord(raw.today) ? raw.today : {};
  const calls: Record<string, unknown> = isRecord(today.calls) ? today.calls : {};
  const engineCalls = (engine: "claude" | "codex") => {
    const reasons: Record<string, unknown> = isRecord(calls[engine]) ? calls[engine] : {};
    return { auto: count(reasons.auto), manual: count(reasons.manual), backfill: count(reasons.backfill) };
  };
  return {
    summarizer: {
      running: raw.running,
      queued: raw.queued,
      today: { count: count(today.count), limit: count(today.limit), calls: { claude: engineCalls("claude"), codex: engineCalls("codex") } },
      ...(backfill
        ? { backfill: { done: backfill.done, total: backfill.total, failed: count(backfill.failed), skipped: count(backfill.skipped), ...(count(backfill.full) ? { full: count(backfill.full) } : {}) } }
        : {}),
      ...(typeof raw.toBackfill === "number" && Number.isSafeInteger(raw.toBackfill) && raw.toBackfill >= 0 ? { toBackfill: raw.toBackfill } : {}),
      ...(typeof raw.lastError === "string" ? { lastError: raw.lastError.slice(0, 200) } : {}),
      ...(typeof raw.lastErrorCode === "string" ? { lastErrorCode: raw.lastErrorCode } : {}),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Reading what the backend sends: keep what is well formed, so one bad field cannot break the page.

function pickSettings(values: Record<string, unknown>): Partial<Settings> {
  const result: Partial<Settings> = {};
  if (values.driftPolicy === "ask" || values.driftPolicy === "note" || values.driftPolicy === "off") result.driftPolicy = values.driftPolicy;
  if (typeof values.showCapsule === "boolean") result.showCapsule = values.showCapsule;
  if (typeof values.autoSummarize === "boolean") result.autoSummarize = values.autoSummarize;
  if (values.summarizeModel === "follow" || values.summarizeModel === "claude" || values.summarizeModel === "codex") result.summarizeModel = values.summarizeModel;
  if (values.summarizeOthers === "none" || values.summarizeOthers === "claude" || values.summarizeOthers === "codex") result.summarizeOthers = values.summarizeOthers;
  if (typeof values.prAlerts === "boolean") result.prAlerts = values.prAlerts;
  return result;
}

function readInfo(value: unknown): Record<string, ThreadInfo> {
  const info: Record<string, ThreadInfo> = {};
  if (!isRecord(value)) return info;
  for (const [threadId, entry] of Object.entries(value)) {
    if (!isRecord(entry)) continue;
    const status = typeof entry.status === "string" && THREAD_STATUSES.has(entry.status) ? (entry.status as ThreadStatus) : "unknown";
    info[threadId] = {
      status,
      ...(typeof entry.title === "string" && entry.title.trim() ? { title: entry.title } : {}),
      ...(typeof entry.harnessId === "string" ? { harnessId: entry.harnessId } : {}),
    };
  }
  return info;
}

/** Conversations on other computers and their remote hosts; anything else is left out. */
function readHosts(value: unknown): Record<string, string> {
  const hosts: Record<string, string> = {};
  if (isRecord(value)) for (const [threadId, hostId] of Object.entries(value)) if (isThreadId(threadId) && isRemoteHostId(hostId)) hosts[threadId] = hostId;
  return hosts;
}

function readParents(value: unknown): Record<string, string> {
  const parents: Record<string, string> = {};
  if (isRecord(value)) for (const [child, parent] of Object.entries(value)) if (typeof parent === "string" && parent && parent !== child) parents[child] = parent;
  return parents;
}

function readResults(value: unknown): SearchResult[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is SearchResult =>
      isRecord(item) &&
      typeof item.threadId === "string" &&
      typeof item.title === "string" &&
      Array.isArray(item.tags) &&
      isRecord(item.progress) &&
      isRecord(item.match) &&
      typeof item.match.text === "string",
  );
}

function isView(value: unknown, threadId: string): value is ConversationView {
  return isRecord(value) && value.threadId === threadId && Array.isArray(value.refs) && Array.isArray(value.tags) && typeof value.title === "string";
}

/** Links come from conversations; only web links are followed. */
function safeUrl(url: string): string {
  return /^https?:\/\//iu.test(url) ? url : "#";
}

function groupsOf(forest: Forest): Map<string, Group> {
  const groups = new Map<string, Group>();
  const mark = (nodes: readonly TreeNode[], group: Group) => {
    for (const node of nodes) {
      groups.set(node.threadId, group);
      mark(node.children, group);
    }
  };
  mark(forest.active, "active");
  mark(forest.paused, "paused");
  mark(forest.done, "done");
  for (const threadId of forest.others) groups.set(threadId, "others");
  return groups;
}

function isFavoritesList(value: unknown): value is FavoritesList {
  return isRecord(value) && Array.isArray(value.items) && isRecord(value.titles) && typeof value.total === "number";
}

function readFilesSize(value: unknown): FilesSize | undefined {
  if (!isRecord(value)) return undefined;
  const { files, bytes } = value;
  return typeof files === "number" && Number.isSafeInteger(files) && files >= 0 && typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0
    ? { files, bytes }
    : undefined;
}

function readUsage(value: unknown): AttachmentsUsage | undefined {
  if (!isRecord(value)) return undefined;
  const all = readFilesSize(value.all);
  const done = readFilesSize(value.done);
  const unknown = readFilesSize(value.unknown);
  return all && done && unknown ? { all, done, unknown } : undefined;
}

function readOutline(value: unknown): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  if (!isRecord(value)) return out;
  const count = (item: unknown) => (typeof item === "number" && Number.isSafeInteger(item) && item >= 0 ? item : 0);
  for (const [threadId, progress] of Object.entries(value)) if (Array.isArray(progress)) out[threadId] = [count(progress[0]), count(progress[1])];
  return out;
}

function readWorkspaces(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, string> = {};
  for (const [threadId, name] of Object.entries(value as Record<string, unknown>)) if (typeof name === "string" && name) out[threadId] = name.slice(0, 80);
  return out;
}
