/**
 * codexhost's own window and Web: the open window is the selected sidebar row. Rows are keyed by the
 * conversation's session id: `session:<id>` in workspaces, `recent:<id>` in the Recent list, and
 * `linked:<workspace key>:<id>` for a conversation linked to a workspace. A local
 * conversation's session id is its Thread id; one on another computer (a remote host paired with
 * codexhost Web) has `web-remote:<base64url of JSON [hostId, threadId]>`, which parseWebSessionId
 * reads and checks. A row whose key does not decode to a conversation is ignored.
 */
import { isRemoteHostId, parseWebSessionId, webSessionId, type WebSession } from "../core/hosts.js";
import { isThreadId } from "../core/model.js";
import type { WebApi } from "../host/types.js";
import { freeBand } from "../ui/band.js";
import type { Anchor } from "../ui/capsule.js";
import type { SurfaceAdapter } from "../ui/controller.js";

/** All three row formats used by the Web sidebar for conversations. */
export const ROW_SELECTOR = '[data-row-key^="session:"], [data-row-key^="recent:"], [data-row-key^="linked:"]';
const ROW_PREFIXES = ["session:", "recent:"] as const;
const RIGHT_PANEL_ATTRIBUTE = "data-sidebar-right-session";
export const OPEN_EVENT = "codexhost-mainline:open-thread";

const CHECK_DELAY_MS = 200;
const SAFETY_CHECK_MS = 1500;
/** Conversations on other computers whose host the page remembers (the most recently seen). */
const HOSTS_KEPT = 2000;

/** The conversation a sidebar row shows; undefined for any other row (a workspace, a section), a draft, or a key that does not decode. */
export function rowSession(row: Element | null | undefined): WebSession | undefined {
  const key = row?.getAttribute("data-row-key");
  if (!key) return undefined;
  if (key.startsWith("linked:")) {
    // Workspace keys and remote session ids can both contain colons.
    const group = row?.closest("[data-sidebar-group]")?.getAttribute("data-sidebar-group");
    const prefix = `linked:${group}:`;
    return group && key.startsWith(prefix) ? parseWebSessionId(key.slice(prefix.length)) : undefined;
  }
  const prefix = ROW_PREFIXES.find((start) => key.startsWith(start));
  return prefix ? parseWebSessionId(key.slice(prefix.length)) : undefined;
}

const rowFor = (doc: Document, threadId: string, hostId?: string) => {
  return [...doc.querySelectorAll<HTMLElement>(ROW_SELECTOR)].find((row) => {
    const session = rowSession(row);
    return session?.threadId === threadId && session.hostId === hostId;
  });
};

/**
 * The open conversation, null when none is open, or undefined when the page cannot tell (the
 * sidebar is collapsed or hidden), in which case the last known one stays.
 */
export function currentWebSession(doc: Document): WebSession | null | undefined {
  for (const selector of ['[role="treeitem"][data-row-key][aria-current="page"]', '[role="treeitem"][data-row-key][aria-selected="true"]']) {
    const selected = doc.querySelector(selector);
    if (selected?.matches(ROW_SELECTOR)) return rowSession(selected) ?? null;
  }
  for (const panel of doc.querySelectorAll<HTMLElement>(`[${RIGHT_PANEL_ATTRIBUTE}]`))
    if (!panel.hidden && panel.getClientRects().length > 0) return parseWebSessionId(panel.getAttribute(RIGHT_PANEL_ATTRIBUTE)) ?? null;
  if (doc.querySelector("[data-sidebar-hidden], [data-sidebar-collapsed]") || !doc.querySelector(ROW_SELECTOR)) return undefined;
  return null;
}

/** The Thread id of the open window, as currentWebSession tells it. */
export function currentWebThread(doc: Document): string | null | undefined {
  const session = currentWebSession(doc);
  return session ? session.threadId : session;
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

/**
 * Opens a conversation: a click on its sidebar row, else codexhost Web's own link, `?session=` and
 * the session id: the Thread id of a local conversation; for one on another computer (`hostId`) the
 * `web-remote:` id codexhost Web gives it (what it makes of the list's `thread://…?hostId=` link too).
 */
export function openWebThread(doc: Document, threadId: string, hostId?: string): void {
  const row = rowFor(doc, threadId, hostId);
  if (row) {
    row.click();
    return;
  }
  const view = doc.defaultView;
  if (!view) return;
  const url = new URL(view.location.href);
  url.searchParams.set("session", webSessionId(threadId, hostId));
  view.location.assign(url.href);
}

/** Delegation links the Web sidebar shows on its rows, child to parent (the parent named by its session id too). */
export function webParents(doc: Document): Record<string, string> {
  return webRows(doc).parents;
}

/**
 * What the Web sidebar's rows tell the backend: delegation links, child to parent, and the remote
 * host of each conversation on another computer among them.
 */
export function webRows(doc: Document): { parents: Record<string, string>; hosts: Record<string, string> } {
  const parents: Record<string, string> = {};
  const hosts: Record<string, string> = {};
  const note = (session: WebSession | undefined) => {
    if (session?.hostId) hosts[session.threadId] = session.hostId;
    return session;
  };
  for (const row of doc.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
    const child = note(rowSession(row));
    const parent = note(parseWebSessionId(row.getAttribute("data-thread-parent")));
    if (child && parent && parent.threadId !== child.threadId) parents[child.threadId] = parent.threadId;
  }
  return { parents, hosts };
}

export function createWebAdapter(api: WebApi, doc: Document = document): SurfaceAdapter {
  const view = doc.defaultView;
  const mounted = new Set<{ container: HTMLElement; dispose: () => void }>();
  /** Conversations on other computers and their hosts: from the sidebar's rows and from the backend's snapshots. */
  const hosts = new Map<string, string>();
  const remember = (threadId: string, hostId: string) => {
    hosts.delete(threadId);
    hosts.set(threadId, hostId);
    if (hosts.size > HOSTS_KEPT) hosts.delete(hosts.keys().next().value!);
  };
  const learn = (session: WebSession | undefined) => {
    if (session?.hostId) remember(session.threadId, session.hostId);
    return session;
  };
  const hostOf = (threadId: string) => hosts.get(threadId);
  let reported = "";
  const reportRows = () => {
    const rows = webRows(doc);
    for (const [threadId, hostId] of Object.entries(rows.hosts)) remember(threadId, hostId);
    const key = JSON.stringify(rows);
    if (key === reported || (!Object.keys(rows.parents).length && !Object.keys(rows.hosts).length)) return;
    reported = key;
    void api.backend.invoke("reportTree", { surface: "web", nodes: {}, ...rows }).catch(() => {
      reported = "";
    });
  };
  const openThread = (threadId: string, hostId?: string) => openWebThread(doc, threadId, hostId ?? hostOf(threadId));
  const onOpenRequest = (event: Event) => {
    const detail = (event as CustomEvent<{ threadId?: unknown; hostId?: unknown; handled?: boolean }>).detail;
    if (!detail || typeof detail.threadId !== "string") return;
    detail.handled = true;
    openThread(detail.threadId, isRemoteHostId(detail.hostId) ? detail.hostId : undefined);
  };
  view?.addEventListener(OPEN_EVENT, onOpenRequest);

  return {
    surface: "web",
    doc,
    invoke: (method, params) => api.backend.invoke(method, params as never),
    openThread,
    hostOf,
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
    onData(data) {
      for (const [threadId, hostId] of Object.entries(data.hosts ?? {})) if (isThreadId(threadId) && isRemoteHostId(hostId)) remember(threadId, hostId);
    },
    watchCurrentThread(onChange) {
      let last: string | null = null;
      let pending: ReturnType<typeof setTimeout> | undefined;
      const check = () => {
        pending = undefined;
        const found = currentWebSession(doc);
        if (found !== undefined) last = learn(found ?? undefined)?.threadId ?? null;
        onChange(last);
        reportRows();
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
    rowsFor: (threadId) => [...doc.querySelectorAll<HTMLElement>(ROW_SELECTOR)].filter((row) => rowSession(row)?.threadId === threadId),
    rowAt(target) {
      const row = target instanceof Element ? target.closest<HTMLElement>("[data-row-key]") : null;
      const session = learn(rowSession(row));
      return row && session ? { element: row, threadId: session.threadId, ...(session.hostId ? { hostId: session.hostId } : {}) } : null;
    },
    // Called only while this surface's diagnostics are on (`diagnosticsOn` in the controller).
    describe() {
      const selected = doc.querySelector('[role="treeitem"][data-row-key][aria-current="page"]');
      const topbar = doc.querySelector('[data-cx-region="topbar"]')?.getBoundingClientRect();
      const anchor = webAnchor(doc);
      const session = currentWebSession(doc);
      return {
        selectedRow: selected?.getAttribute("data-row-key")?.split(":")[0] ?? null,
        thread: session?.threadId.slice(0, 8) ?? null,
        // Whether it is on another computer; never which.
        remote: Boolean(session?.hostId),
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
