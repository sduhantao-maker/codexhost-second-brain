/**
 * codexhost's own window and Web: the open window is the selected sidebar row
 * (`data-row-key="session:<id>"`, where the session id is the Thread id).
 */
import type { WebApi } from "../host/types.js";
import { freeBand } from "../ui/band.js";
import type { Anchor } from "../ui/capsule.js";
import type { SurfaceAdapter } from "../ui/controller.js";

/** Sidebar rows of sessions: `session:<id>` in workspaces, `recent:<id>` in the Recent list. */
export const ROW_SELECTOR = '[data-row-key^="session:"], [data-row-key^="recent:"]';
const NON_SESSION_PREFIXES = new Set(["section", "workspace", "overflow"]);
const RIGHT_PANEL_ATTRIBUTE = "data-sidebar-right-session";
export const OPEN_EVENT = "codexhost-mainline:open-thread";

const CHECK_DELAY_MS = 200;
const SAFETY_CHECK_MS = 1500;

const rowFor = (doc: Document, threadId: string) => {
  const id = threadId.replace(/["\\]/gu, "\\$&");
  return doc.querySelector<HTMLElement>(`[data-row-key="session:${id}"], [data-row-key="recent:${id}"]`);
};

/** The Thread id of a selected sidebar row, whatever list the row sits in. */
function sessionIdOf(row: Element | null): string | undefined {
  const key = row?.getAttribute("data-row-key");
  const colon = key?.indexOf(":") ?? -1;
  if (!key || colon <= 0) return undefined;
  const prefix = key.slice(0, colon);
  const id = key.slice(colon + 1);
  return NON_SESSION_PREFIXES.has(prefix) || !id ? undefined : id;
}

/**
 * The open window, null when none is open, or undefined when the page cannot tell (the
 * sidebar is collapsed or hidden), in which case the last known window stays.
 */
export function currentWebThread(doc: Document): string | null | undefined {
  for (const selector of ['[role="treeitem"][data-row-key][aria-current="page"]', '[role="treeitem"][data-row-key][aria-selected="true"]']) {
    const id = sessionIdOf(doc.querySelector(selector));
    if (id) return id;
  }
  for (const panel of doc.querySelectorAll<HTMLElement>(`[${RIGHT_PANEL_ATTRIBUTE}]`))
    if (!panel.hidden && panel.getClientRects().length > 0) return panel.getAttribute(RIGHT_PANEL_ATTRIBUTE);
  if (doc.querySelector("[data-sidebar-hidden], [data-sidebar-collapsed]") || !doc.querySelector(ROW_SELECTOR))
    return undefined;
  return null;
}

export function webAnchor(doc: Document): Anchor | null {
  const view = doc.defaultView;
  if (!view) return null;
  const conversation = doc.querySelector('[data-cx-region="conversation"]');
  const topbar = doc.querySelector('[data-cx-region="topbar"]');
  const rect = conversation?.getBoundingClientRect();
  const bar = topbar?.getBoundingClientRect();
  const top = bar && bar.height > 0 ? bar.bottom + 8 : rect && rect.height > 0 ? rect.top + 8 : 56;
  const band = freeBand(topbar);
  if (rect && rect.width > 0) return { x: rect.left + rect.width / 2, top, band };
  return { x: view.innerWidth / 2, top, band };
}

export function openWebThread(doc: Document, threadId: string): void {
  const row = rowFor(doc, threadId);
  if (row) {
    row.click();
    return;
  }
  const view = doc.defaultView;
  if (!view) return;
  const url = new URL(view.location.href);
  url.searchParams.set("session", threadId);
  view.location.assign(url.href);
}

/** Delegation links the Web sidebar shows on its rows, child to parent. */
export function webParents(doc: Document): Record<string, string> {
  const parents: Record<string, string> = {};
  for (const row of doc.querySelectorAll<HTMLElement>("[data-row-key][data-thread-parent]")) {
    const child = sessionIdOf(row);
    const parent = row.getAttribute("data-thread-parent");
    if (child && parent && parent !== child) parents[child] = parent;
  }
  return parents;
}

export function createWebAdapter(api: WebApi, doc: Document = document): SurfaceAdapter {
  const view = doc.defaultView;
  const mounted = new Set<{ container: HTMLElement; dispose: () => void }>();
  let reportedParents = "";
  const reportParents = () => {
    const parents = webParents(doc);
    const key = JSON.stringify(parents);
    if (key === reportedParents || key === "{}") return;
    reportedParents = key;
    void api.backend.invoke("reportTree", { surface: "web", nodes: {}, parents }).catch(() => {
      reportedParents = "";
    });
  };
  const openThread = (threadId: string) => openWebThread(doc, threadId);
  const onOpenRequest = (event: Event) => {
    const detail = (event as CustomEvent<{ threadId?: unknown; handled?: boolean }>).detail;
    if (!detail || typeof detail.threadId !== "string") return;
    detail.handled = true;
    openThread(detail.threadId);
  };
  view?.addEventListener(OPEN_EVENT, onOpenRequest);

  return {
    surface: "web",
    doc,
    invoke: (method, params) => api.backend.invoke(method, params as never),
    openThread,
    anchor: () => webAnchor(doc),
    mount(host) {
      const slot = api.dom.mount(doc.body);
      if (slot) mounted.add(slot);
      (slot?.container ?? doc.body).append(host);
      return () => {
        host.remove();
        if (slot && mounted.delete(slot)) slot.dispose();
      };
    },
    watchCurrentThread(onChange) {
      let last: string | null = null;
      let pending: ReturnType<typeof setTimeout> | undefined;
      const check = () => {
        pending = undefined;
        const found = currentWebThread(doc);
        if (found !== undefined) last = found;
        onChange(last);
        reportParents();
      };
      const schedule = () => {
        pending ??= setTimeout(check, CHECK_DELAY_MS);
      };
      const observer = view ? new view.MutationObserver(schedule) : undefined;
      observer?.observe(doc.documentElement, {
        attributes: true,
        attributeFilter: ["aria-current", "aria-selected", "data-row-key", "data-thread-parent", RIGHT_PANEL_ATTRIBUTE, "hidden"],
        childList: true,
        subtree: true,
      });
      const safety = setInterval(schedule, SAFETY_CHECK_MS);
      check();
      return () => {
        observer?.disconnect();
        clearInterval(safety);
        clearTimeout(pending);
      };
    },
    sidebar: () => doc.querySelector('[data-cx-region="sidebar"]'),
    rowsFor: (threadId) => [...doc.querySelectorAll<HTMLElement>("[data-row-key]")].filter((row) => sessionIdOf(row) === threadId),
    rowAt(target) {
      const row = target instanceof Element ? target.closest<HTMLElement>("[data-row-key]") : null;
      const threadId = sessionIdOf(row);
      return row && threadId ? { element: row, threadId } : null;
    },
    // Called only while this surface's diagnostics are on (`diagnosticsOn` in the controller).
    describe() {
      const selected = doc.querySelector('[role="treeitem"][data-row-key][aria-current="page"]');
      const topbar = doc.querySelector('[data-cx-region="topbar"]')?.getBoundingClientRect();
      const anchor = webAnchor(doc);
      return {
        selectedRow: selected?.getAttribute("data-row-key")?.split(":")[0] ?? null,
        thread: currentWebThread(doc)?.slice(0, 8) ?? null,
        topbar: topbar ? [Math.round(topbar.left), Math.round(topbar.top), Math.round(topbar.width), Math.round(topbar.height)] : null,
        band: anchor?.band ? [Math.round(anchor.band.left), Math.round(anchor.band.right)] : null,
        viewport: view ? [view.innerWidth, view.innerHeight] : null,
      };
    },
    dispose() {
      view?.removeEventListener(OPEN_EVENT, onOpenRequest);
      for (const slot of mounted) slot.dispose();
      mounted.clear();
    },
  };
}
