/**
 * Runs the capsule on one surface: follows the open conversation, polls the backend, loads the
 * conversation's view and sends edits. Each surface supplies an adapter for the parts that differ.
 */
import type { StateV2 } from "../core/conversation.js";
import type { ConversationView } from "../core/conversation-view.js";
import { DEFAULT_SETTINGS, localeOf, type Settings, type ThreadInfo } from "../core/model.js";
import type { RefView } from "../core/refs.js";
import type { MutateV2Params, Reveal, SnapshotParams, SnapshotResultV2 } from "../core/rpc.js";
import { Capsule, type Anchor } from "./capsule.js";

export interface LiveData {
  state: StateV2;
  info: Record<string, ThreadInfo>;
  settings: Settings;
  version: string;
  command?: string;
  alerts: RefView[];
  /** Known delegation links, child to parent. */
  parents: Record<string, string>;
  /** A saved passage to show in the open conversation. */
  reveal?: Reveal;
}

export interface SurfaceAdapter {
  readonly surface: "desktop" | "web";
  readonly doc: Document;
  invoke(method: string, params?: unknown): Promise<unknown>;
  /** Reports the open conversation now and on every change; null when none is open. */
  watchCurrentThread(onChange: (threadId: string | null) => void): () => void;
  openThread(threadId: string): void;
  anchor(): Anchor | null;
  /** Puts the capsule on the page; the returned function takes it off again. */
  mount(host: HTMLElement): (() => void) | void;
  /**
   * What the surface sees, written to the backend log to help diagnose a misplaced capsule. Only
   * asked for while diagnostics are on (see `diagnosticsOn`): it measures much of the page.
   */
  describe?(): Record<string, unknown>;
  onData?(data: LiveData, current: string | null): void;
  dispose?(): void;
  /** The sidebar's scrolling container, where conversation rows live. */
  sidebar?(): Element | null;
  /** The conversation row under an event target, with its Thread id. */
  rowAt?(target: EventTarget | null): { element: HTMLElement; threadId: string } | null;
  /** The sidebar rows that show a conversation (it may be listed more than once). */
  rowsFor?(threadId: string): HTMLElement[];
}

/** What other modules (the sidebar hover card) get from a running controller. */
export interface ControllerHandle {
  dispose(): void;
  refresh(): Promise<void>;
  /** Called with the new snapshot version and data whenever the backend's data changed. */
  subscribe(listener: (version: string, data: LiveData) => void): () => void;
  /** The conversation open on this surface, null when none is. */
  current(): string | null;
}

export const POLL_MS = 2000;
const MAX_BACKOFF_MS = 30_000;
const FLASH_MS = 3000;
const DIAGNOSE_EVERY_MS = 5000;

function safeStorage(view: Window | null): Storage | null {
  try {
    return view?.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Set to "1" in a surface's localStorage to turn its diagnostics on. */
export const DEBUG_KEY = "codexhost-mainline:debug";

/**
 * Diagnostics are off unless `localStorage["codexhost-mainline:debug"] === "1"` on that surface:
 * set it in the developer console of Desktop or of the Web page (and remove it to stop). Only then
 * does a surface measure itself (`describe()`, the sidebar and hover card included) after its polls,
 * and do the favorites tell where their button went and how showing a passage went: `diagnose`
 * reports, for the backend log. There is no setting for it on purpose.
 */
export function diagnosticsOn(view: Window | null | undefined): boolean {
  try {
    return safeStorage(view ?? null)?.getItem(DEBUG_KEY) === "1";
  } catch {
    return false;
  }
}

export function startController(adapter: SurfaceAdapter): ControllerHandle {
  const doc = adapter.doc;
  const view = doc.defaultView;
  const locale = localeOf(doc.documentElement.lang || view?.navigator.language);
  let data: LiveData | null = null;
  let current: string | null = null;
  /** The open conversation's view, and the snapshot version it was loaded for. */
  let loaded: { threadId: string; version: string; view: ConversationView } | null = null;
  let loading: string | null = null;
  let flashWanted = false;
  let offline = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let polling: Promise<void> | undefined;
  let again = false;
  let disposed = false;
  let localeSent = false;
  const listeners = new Set<(version: string, data: LiveData) => void>();
  let lastDiagnosis = "";
  let lastDiagnosisAt = 0;

  /** Sends what the surface sees when it changed, at most every few seconds, while diagnostics are on. */
  const diagnose = () => {
    if (!adapter.describe || disposed || !diagnosticsOn(view)) return;
    let text: string;
    try {
      text = JSON.stringify({ ...adapter.describe(), capsule: capsuleBox() });
    } catch {
      return;
    }
    if (text === lastDiagnosis || Date.now() - lastDiagnosisAt < DIAGNOSE_EVERY_MS) return;
    lastDiagnosis = text;
    lastDiagnosisAt = Date.now();
    void adapter.invoke("diagnose", { surface: adapter.surface, report: JSON.parse(text) as unknown }).catch(() => undefined);
  };
  const capsuleBox = () => {
    const host = doc.querySelector("[data-codexhost-mainline]");
    const capsuleElement = host?.shadowRoot?.querySelector(".capsule");
    const rect = capsuleElement?.getBoundingClientRect();
    return rect && rect.width > 0 ? [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width)] : null;
  };

  /**
   * The capsule over the conversation is optional (setting `showCapsule`, off by default): the
   * sidebar hover card is the main way to see a mainline. It is built when turned on and taken
   * off the page when turned off; polling and the tree report run either way.
   */
  let capsule: Capsule | null = null;
  let unmount: (() => void) | void;
  const capsuleWanted = (want: boolean): Capsule | null => {
    if (want && !capsule) {
      capsule = new Capsule({
        doc,
        locale,
        surface: adapter.surface,
        mutate: async (params: MutateV2Params) => {
          await adapter.invoke("mutate", params);
          await refresh();
        },
        spawn: async (spinoffId: string) => {
          if (!current) return;
          await adapter.invoke("spawn", { threadId: current, spinoffId });
          await refresh();
        },
        openThread: (threadId) => adapter.openThread(threadId),
        call: (method, params) => adapter.invoke(method, params),
        anchor: () => adapter.anchor(),
        storage: safeStorage(view),
      });
      unmount = adapter.mount(capsule.host);
    } else if (!want && capsule) {
      capsule.destroy();
      unmount?.();
      capsule = null;
      unmount = undefined;
    }
    return capsule;
  };

  const render = () => {
    const shown = capsuleWanted(Boolean(data?.settings.showCapsule));
    if (!shown) return;
    const viewFor = loaded && loaded.threadId === current ? loaded.view : null;
    shown.update({
      // Stay hidden until the first state and the conversation's view arrive, so nothing flickers.
      threadId: data ? current : null,
      view: viewFor,
      settings: data?.settings ?? DEFAULT_SETTINGS,
      offline,
      now: Date.now(),
      alerts: data?.alerts ?? [],
    });
  };

  /** Loads the open conversation's view when the conversation or the data changed. */
  const loadView = async () => {
    const threadId = current;
    const version = data?.version;
    if (!threadId || !version) return;
    if (loaded?.threadId === threadId && loaded.version === version) return;
    const key = `${threadId}|${version}`;
    if (loading === key) return;
    loading = key;
    try {
      const next = (await adapter.invoke("conversation", { threadId })) as ConversationView;
      if (disposed || current !== threadId) return;
      loaded = { threadId, version, view: next };
      render();
      if (flashWanted) {
        flashWanted = false;
        if (!next.draft && next.status === "active") capsule?.flash(FLASH_MS);
      }
    } catch {
      // The next poll tries again.
    } finally {
      if (loading === key) loading = null;
    }
  };

  const schedule = (ms: number) => {
    clearTimeout(timer);
    if (!disposed) timer = setTimeout(() => void refresh(), ms);
  };

  const pollOnce = async () => {
    const params: SnapshotParams = {
      ...(data ? { version: data.version } : {}),
      ...(current ? { focus: { threadId: current, surface: adapter.surface } } : {}),
      ...(localeSent ? {} : { locale, localeSource: "surface" as const }),
    };
    try {
      const result = (await adapter.invoke("snapshot", params)) as SnapshotResultV2;
      localeSent = true;
      failures = 0;
      const wasOffline = offline;
      offline = false;
      if (result.state) {
        data = {
          state: result.state,
          info: result.info ?? {},
          settings: result.settings ?? DEFAULT_SETTINGS,
          version: result.version,
          alerts: result.alerts ?? [],
          parents: result.parents ?? {},
          ...(result.command ? { command: result.command } : {}),
          ...(result.reveal ? { reveal: result.reveal } : {}),
        };
        adapter.onData?.(data, current);
        render();
        for (const listener of [...listeners]) {
          try {
            listener(result.version, data);
          } catch {
            // A listener's failure must not stop the capsule.
          }
        }
      } else if (wasOffline) render();
      else capsule?.reposition();
      await loadView();
      diagnose();
    } catch {
      if (disposed) return;
      failures += 1;
      if (!offline) {
        offline = true;
        render();
      }
    }
  };

  async function refresh(): Promise<void> {
    if (disposed) return;
    if (polling) {
      again = true;
      return polling;
    }
    if (doc.visibilityState === "hidden") {
      // Paused while hidden; becoming visible polls again.
      clearTimeout(timer);
      return;
    }
    polling = pollOnce().finally(() => {
      polling = undefined;
    });
    await polling;
    if (again && !disposed) {
      again = false;
      return refresh();
    }
    schedule(failures ? Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** failures) : POLL_MS);
  }

  const stopWatching = adapter.watchCurrentThread((threadId) => {
    if (threadId === current) return;
    const previous = current;
    current = threadId;
    // Switching from one conversation to another opens the new one's mainline for a moment.
    flashWanted = previous !== null && threadId !== null;
    render();
    void loadView();
    void refresh();
  });

  const onVisibility = () => {
    if (doc.visibilityState === "visible") void refresh();
  };
  doc.addEventListener("visibilitychange", onVisibility);
  void refresh();

  return {
    refresh,
    current: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      listeners.clear();
      clearTimeout(timer);
      stopWatching();
      doc.removeEventListener("visibilitychange", onVisibility);
      capsuleWanted(false);
      adapter.dispose?.();
    },
  };
}
