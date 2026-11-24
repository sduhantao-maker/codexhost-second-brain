/**
 * The parts of the codexhost extension APIs this extension uses, written against codexhost's
 * `packages/shared-contracts` (Desktop API 1, Page API 1, Web API 1, backend API 1).
 */
import type { ThreadStatus } from "../core/model.js";

export interface BackendContext {
  readonly extensionId: string;
  readonly extensionDir: string;
  readonly dataDir: string;
  readSettings(): Promise<Record<string, unknown>>;
  writeSettings(values: Record<string, unknown>): Promise<Record<string, unknown>>;
  handle(method: string, handler: (params: unknown) => unknown | Promise<unknown>): void;
}

export interface ThreadTreeSnapshot {
  revision: number;
  parents: Record<string, string>;
  nodes: Record<string, { harnessId: string; title?: string; status: ThreadStatus; archived: boolean }>;
  truncated: boolean;
}

export interface DesktopSidebarRow {
  readonly element: HTMLElement;
  readonly hostId: string | null;
  readonly isLocal: boolean;
  readonly threadId: string | null;
  readonly draftId: string | null;
  isConnected(): boolean;
}

export interface StorageApi {
  get(): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<Record<string, unknown>>;
  onChange(listener: (values: Record<string, unknown>) => void): () => void;
}

export interface BackendApi {
  invoke(method: string, params?: unknown): Promise<unknown>;
}

export interface DesktopApi {
  readonly id: string;
  readonly apiVersion: 1;
  readonly signal: AbortSignal;
  sidebar: { observeRows(cb: (rows: readonly DesktopSidebarRow[]) => void): () => void };
  threads: { watchTree(cb: (tree: ThreadTreeSnapshot) => void): () => void };
  navigate: { openThread(threadId: string): Promise<void> };
  dom: {
    mount(node: Element, parent: Element, position?: "append" | "prepend" | "before" | "after"): void;
    mark(target: Element, name: string): void;
    unmark(target: Element, name: string): void;
  };
  storage: StorageApi;
  backend: BackendApi;
  track(teardown: () => void): void;
}

export type DesktopDefine = (definition: {
  activate(api: DesktopApi): void | (() => void) | Promise<void | (() => void)>;
}) => void;

export interface WebApi {
  readonly id: string;
  readonly signal: AbortSignal;
  readonly apiVersion: 1;
  dom: {
    mount(
      target: HTMLElement | "app" | "topbar" | "sidebar" | "conversation",
      position?: "append" | "prepend",
    ): { container: HTMLElement; dispose: () => void } | undefined;
  };
  track(dispose: () => void): void;
  assets: { url(path: string): string };
  storage: StorageApi;
  backend: BackendApi;
}

export interface PageApi {
  readonly id: string;
  readonly apiVersion: 1;
  readonly hostTarget: "desktop" | "web";
  readonly locale: string;
  onLocaleChange(listener: (locale: string) => void): () => void;
  readonly colorScheme: "light" | "dark";
  onColorSchemeChange(listener: (scheme: "light" | "dark") => void): () => void;
  readonly signal: AbortSignal;
  storage: StorageApi;
  backend: BackendApi;
}
