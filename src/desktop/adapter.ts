/**
 * Codex Desktop: finds the open window from Desktop's own markers, opens windows through the
 * extension API, and reports the Thread tree so the backend knows titles, states and parents.
 */
import type { ThreadStatus } from "../core/model.js";
import { leadingIcon } from "../ui/hover/layout.js";
import type { TreeReport } from "../core/rpc.js";
import type { DesktopApi, DesktopSidebarRow, ThreadTreeSnapshot } from "../host/types.js";
import { freeBand, type Band } from "../ui/band.js";
import type { Anchor } from "../ui/capsule.js";
import type { LiveData, SurfaceAdapter } from "../ui/controller.js";

/** Desktop marks the Composer of the open Thread with its id. */
export const COMPOSER_ATTRIBUTE = "data-above-composer-conversation-id";
export const ACTIVE_ROW_ATTRIBUTE = "data-app-action-sidebar-thread-active";
export const HEADER_SELECTOR = "[data-app-shell-header-toolbar]";
export const SIDEBAR_SELECTOR = "[data-app-action-sidebar-scroll]";
export const NATIVE_ROW_SELECTOR = "[data-app-action-sidebar-thread-row]";
/** Rows the Sidebar Thread Tree extension draws for delegated conversations carry their id here. */
export const TREE_ROW_ATTRIBUTE = "data-codexhost-sidebar-tree-node";
/** The overview page asks the surface it runs in to open a window. */
export const OPEN_EVENT = "codexhost-mainline:open-thread";

const CHECK_DELAY_MS = 200;
const SAFETY_CHECK_MS = 1500;
const REPORT_EVERY_MS = 2000;
/**
 * The backend takes Desktop's tree as current for 20 seconds after a report, and asks codexhost
 * itself after that. An unchanged tree is reported again after this long, so that while Desktop
 * is on screen its tree stays the source and codexhost is not asked at all.
 */
export const REPORT_AGAIN_MS = 10_000;
const HEARTBEAT_MS = 5000;

const laidOut = (element: Element | null | undefined) => (element?.getClientRects().length ?? 0) > 0;

/** codexhost's settings shell on Desktop, where plugin pages such as the overview are shown. */
interface SettingsShell {
  readonly open?: boolean;
  close?(): void;
}

/**
 * Closes codexhost's settings when they are open, so a conversation opened from the overview page
 * shows instead of staying behind the settings. Nothing happens when the shell is not there.
 */
export function closeSettings(view: Window | null | undefined): boolean {
  const shell = (view as (Window & { __codexhostSettingsShellV1?: SettingsShell }) | null | undefined)?.__codexhostSettingsShellV1;
  if (!shell?.open || typeof shell.close !== "function") return false;
  shell.close();
  return true;
}

/** The shown Composer portal; Desktop keeps hidden Composers of earlier views around. */
export function openComposer(doc: Document): { threadId: string; element: Element } | undefined {
  const shown: Array<{ threadId: string; element: Element }> = [];
  const all: Array<{ threadId: string; element: Element }> = [];
  for (const element of doc.querySelectorAll(`[${COMPOSER_ATTRIBUTE}]`)) {
    const threadId = element.getAttribute(COMPOSER_ATTRIBUTE);
    // A new conversation that has not been sent yet is a draft, not a Thread.
    if (!threadId || threadId.startsWith("draft-")) continue;
    all.push({ threadId, element });
    if (laidOut(element) || laidOut(element.parentElement)) shown.push({ threadId, element });
  }
  const candidates = shown.length ? shown : all;
  const ids = new Set(candidates.map(({ threadId }) => threadId));
  return ids.size === 1 ? candidates[0] : undefined;
}

export function currentDesktopThread(doc: Document, rows: readonly DesktopSidebarRow[]): string | null {
  const composer = openComposer(doc);
  if (composer) return composer.threadId;
  for (const row of rows)
    if (row.isLocal && row.threadId && row.element.getAttribute(ACTIVE_ROW_ATTRIBUTE) === "true") return row.threadId;
  return null;
}

/** The header row that holds Desktop's toolbar: the first ancestor wide enough to be the whole row. */
export function desktopHeader(doc: Document): Element | null {
  const toolbar = doc.querySelector(HEADER_SELECTOR);
  for (let node = toolbar; node && node !== doc.body; node = node.parentElement) {
    const rect = node.getBoundingClientRect();
    if (rect.height > 80) break;
    if (rect.width >= 480 && rect.height >= 28) return node;
  }
  return null;
}

export function desktopBand(doc: Document): Band | null {
  return freeBand(desktopHeader(doc));
}

export function desktopAnchor(doc: Document): Anchor | null {
  const view = doc.defaultView;
  if (!view) return null;
  const header = doc.querySelector(HEADER_SELECTOR);
  const headerBottom = header?.getBoundingClientRect().bottom ?? 0;
  const top = headerBottom > 0 ? headerBottom + 8 : 56;
  const composer = openComposer(doc)?.element;
  const column = composer?.parentElement ?? composer;
  const rect = column?.getBoundingClientRect();
  const band = desktopBand(doc);
  if (rect && rect.width > 0) return { x: rect.left + rect.width / 2, top, band };
  return { x: view.innerWidth / 2, top, band };
}

/** What the backend needs from the tree: every delegation link, and the nodes they and the state mention. */
export function treeReport(tree: ThreadTreeSnapshot, data: LiveData | undefined, current: string | null): TreeReport {
  const parents: Record<string, string> = {};
  const ids = new Set<string>(Object.keys(data?.state.conversations ?? {}));
  if (current) ids.add(current);
  for (const [child, parent] of Object.entries(tree.parents)) {
    if (tree.nodes[child]?.archived) continue;
    parents[child] = parent;
    ids.add(child);
    ids.add(parent);
  }
  const nodes: TreeReport["nodes"] = {};
  for (const id of ids) {
    const node = tree.nodes[id];
    if (!node) continue;
    const status: ThreadStatus = node.status;
    nodes[id] = { status, harnessId: node.harnessId, ...(node.title ? { title: node.title } : {}) };
  }
  return { nodes, parents };
}

export function createDesktopAdapter(api: DesktopApi, doc: Document = document): SurfaceAdapter {
  const view = doc.defaultView;
  let rows: readonly DesktopSidebarRow[] = [];
  /** Native row elements to their Thread ids, from Desktop's own row observer. */
  let rowIds = new WeakMap<Element, string>();
  const rememberRows = (next: readonly DesktopSidebarRow[]) => {
    rowIds = new WeakMap();
    for (const row of next) if (row.isLocal && row.threadId) rowIds.set(row.element, row.threadId);
  };
  let tree: ThreadTreeSnapshot | undefined;
  let latest: LiveData | undefined;
  let current: string | null = null;
  let reportTimer: ReturnType<typeof setTimeout> | undefined;
  let lastReport = "";
  let lastReportAt = 0;

  const invoke = (method: string, params?: unknown) => api.backend.invoke(method, params);

  const report = () => {
    reportTimer = undefined;
    if (!tree || api.signal.aborted) return;
    const payload = treeReport(tree, latest, current);
    const key = JSON.stringify(payload);
    if (key === lastReport && Date.now() - lastReportAt < REPORT_AGAIN_MS) return;
    lastReport = key;
    lastReportAt = Date.now();
    void invoke("reportTree", payload).catch(() => {
      lastReport = "";
    });
  };
  const scheduleReport = () => {
    reportTimer ??= setTimeout(report, REPORT_EVERY_MS);
  };
  // While on screen, the same tree is told again now and then; hidden, the backend may ask codexhost.
  const heartbeat = setInterval(() => {
    if (doc.visibilityState !== "hidden" && !reportTimer) report();
  }, HEARTBEAT_MS);

  /** Opens the conversation, then takes the settings (and the overview page in them) out of the way. */
  const open = async (threadId: string) => {
    await api.navigate.openThread(threadId);
    closeSettings(view);
  };
  const openThread = (threadId: string) => {
    void open(threadId).catch((error: unknown) => {
      if (!api.signal.aborted) console.warn("[mainline] could not open the window", error);
    });
  };

  // The overview page asks; it learns from `result` whether the conversation opened.
  const onOpenRequest = (event: Event) => {
    const detail = (event as CustomEvent<{ threadId?: unknown; handled?: boolean; result?: Promise<void> }>).detail;
    if (!detail || typeof detail.threadId !== "string") return;
    detail.handled = true;
    detail.result = open(detail.threadId);
  };
  view?.addEventListener(OPEN_EVENT, onOpenRequest);
  const stopTree = api.threads.watchTree((next) => {
    tree = next;
    scheduleReport();
  });

  return {
    surface: "desktop",
    doc,
    invoke,
    openThread,
    anchor: () => desktopAnchor(doc),
    mount: (host) => api.dom.mount(host, doc.body),
    onData(data, threadId) {
      latest = data;
      current = threadId;
      scheduleReport();
    },
    watchCurrentThread(onChange) {
      let pending: ReturnType<typeof setTimeout> | undefined;
      const check = () => {
        pending = undefined;
        current = currentDesktopThread(doc, rows);
        onChange(current);
      };
      const schedule = () => {
        pending ??= setTimeout(check, CHECK_DELAY_MS);
      };
      const stopRows = api.sidebar.observeRows((next) => {
        rows = next;
        rememberRows(next);
        schedule();
      });
      const observer = view ? new view.MutationObserver(schedule) : undefined;
      observer?.observe(doc.documentElement, {
        attributes: true,
        attributeFilter: [COMPOSER_ATTRIBUTE, ACTIVE_ROW_ATTRIBUTE],
        childList: true,
        subtree: true,
      });
      const safety = setInterval(schedule, SAFETY_CHECK_MS);
      check();
      return () => {
        stopRows();
        observer?.disconnect();
        clearInterval(safety);
        clearTimeout(pending);
      };
    },
    sidebar: () => doc.querySelector(SIDEBAR_SELECTOR),
    rowsFor(threadId) {
      const found: HTMLElement[] = [];
      for (const tree of doc.querySelectorAll<HTMLElement>(`[${TREE_ROW_ATTRIBUTE}]`))
        if (tree.getAttribute(TREE_ROW_ATTRIBUTE) === threadId) found.push(tree);
      for (const row of rows) if (row.threadId === threadId && row.isConnected()) found.push(row.element as HTMLElement);
      return found;
    },
    rowAt(target) {
      const element = target instanceof Element ? target : null;
      const tree = element?.closest<HTMLElement>(`[${TREE_ROW_ATTRIBUTE}]`);
      const treeId = tree?.getAttribute(TREE_ROW_ATTRIBUTE);
      if (tree && treeId) return { element: tree, threadId: treeId };
      for (let node: Element | null = element; node && node !== doc.body; node = node.parentElement) {
        const threadId = rowIds.get(node);
        if (threadId) return { element: node as HTMLElement, threadId };
        if (node.matches(NATIVE_ROW_SELECTOR)) break;
      }
      const native = element?.closest<HTMLElement>(NATIVE_ROW_SELECTOR);
      const nativeId = native ? rowIds.get(native) : undefined;
      return native && nativeId ? { element: native, threadId: nativeId } : null;
    },
    // Measures much of the page: called only while this surface's diagnostics are on (`diagnosticsOn`).
    describe() {
      const box = (element: Element | null | undefined) => {
        const rect = element?.getBoundingClientRect();
        return rect ? [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)] : null;
      };
      const composer = openComposer(doc);
      const toolbar = doc.querySelector(HEADER_SELECTOR);
      const header = desktopHeader(doc);
      const band = desktopBand(doc);
      return {
        thread: current?.slice(0, 8) ?? null,
        via: composer ? "composer" : current ? "row" : "none",
        composers: doc.querySelectorAll(`[${COMPOSER_ATTRIBUTE}]`).length,
        rows: rows.length,
        toolbar: box(toolbar),
        header: header ? { tag: header.tagName.toLowerCase(), box: box(header) } : null,
        band: band ? [Math.round(band.left), Math.round(band.right)] : null,
        viewport: view ? [view.innerWidth, view.innerHeight] : null,
        anchor: (() => {
          const anchor = desktopAnchor(doc);
          return anchor ? [Math.round(anchor.x), Math.round(anchor.top)] : null;
        })(),
        composer: box(composer?.element),
        column: box(composer?.element.parentElement),
        zoom: view
          ? [view.getComputedStyle(doc.documentElement).zoom, doc.body ? view.getComputedStyle(doc.body).zoom : null, view.devicePixelRatio]
          : null,
        host: (() => {
          const host = doc.querySelector<HTMLElement>("[data-codexhost-mainline]");
          return host ? [host.style.left, host.style.top, host.parentElement?.tagName.toLowerCase() ?? null] : null;
        })(),
        // Whether the sidebar hover card can find conversation rows.
        sidebar: (() => {
          const sidebar = doc.querySelector(SIDEBAR_SELECTOR);
          if (!sidebar) return null;
          return {
            box: box(sidebar),
            rows: rows.filter((row) => sidebar.contains(row.element)).length,
            treeRows: sidebar.querySelectorAll(`[${TREE_ROW_ATTRIBUTE}]`).length,
            hover: (() => {
              const card = doc.querySelector("[data-codexhost-mainline-hover]")?.shadowRoot?.querySelector<HTMLElement>(".card");
              if (!card) return "idle";
              if (card.hidden) return "mounted";
              return { card: box(card), beside: card.getAttribute("data-beside") };
            })(),
            // GitHub news badges, and the icon of the row each one belongs to.
            news: [...(doc.querySelector("[data-codexhost-mainline-hover]")?.shadowRoot?.querySelectorAll<HTMLElement>(".news-marker:not([hidden])") ?? [])].map((marker) => {
              const threadId = marker.getAttribute("data-thread") ?? "";
              const row = rows.find((item) => item.threadId === threadId)?.element ?? doc.querySelector(`[${TREE_ROW_ATTRIBUTE}="${threadId}"]`);
              const icon = row ? leadingIcon(row) : null;
              return { at: [marker.style.left, marker.style.top], row: box(row), icon: icon ? [Math.round(icon.left), Math.round(icon.top), Math.round(icon.width)] : null };
            }),
            // "🔔 N": news whose conversation has no row in sight, and where it sits.
            summary: (() => {
              const summary = doc.querySelector("[data-codexhost-mainline-hover]")?.shadowRoot?.querySelector<HTMLElement>(".summary:not([hidden])");
              return summary ? { count: summary.getAttribute("data-count"), at: [summary.style.left, summary.style.top] } : null;
            })(),
          };
        })(),
      };
    },
    dispose() {
      clearTimeout(reportTimer);
      clearInterval(heartbeat);
      stopTree();
      view?.removeEventListener(OPEN_EVENT, onOpenRequest);
    },
  };
}
