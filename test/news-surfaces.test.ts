// @vitest-environment jsdom
/**
 * The bells for news about PRs and issues with the real surface adapters: on Codex Desktop a
 * conversation whose row sits in a collapsed project (an ancestor with display: none, the row of no
 * size) is counted at the top of the sidebar; on codexhost Web a conversation listed in a collapsed
 * workspace and in the Recent list gets its bell on the Recent row. Clicking a row while its bell
 * shows marks its news seen, and the summary's list opens a conversation through the surface.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RefView } from "../src/core/refs.js";
import { createDesktopAdapter } from "../src/desktop/adapter.js";
import type { DesktopApi, DesktopSidebarRow, WebApi } from "../src/host/types.js";
import type { ControllerHandle, LiveData, SurfaceAdapter } from "../src/ui/controller.js";
import { HOST_ATTRIBUTE, startHover } from "../src/ui/hover/index.js";
import { createWebAdapter } from "../src/web/adapter.js";
import { NOW, ref42, sampleSnapshot } from "./fixtures/v2.js";

const OPEN = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const FOLDED = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const news = (threadId: string, number: number, title: string): RefView => ({ ...ref42, key: `acme/widgets#${number}`, number, title, origin: { threadId, title, turn: 2 } });

function box(element: Element, left: number, top: number, width: number, height: number) {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }),
  });
}

/** A conversation row: an icon, then its title. */
function row(attributes: Record<string, string>, title: string, top: number | null): HTMLElement {
  const element = document.createElement("div");
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const text = document.createElement("span");
  text.className = "title";
  text.textContent = title;
  element.append(icon, text);
  // A row in a hidden group has no size, as the browser reports it.
  if (top === null) for (const part of [element, icon, text]) box(part, 0, 0, 0, 0);
  else {
    box(element, 0, top, 260, 32);
    box(icon, 36, top + 8, 16, 16);
    box(text, 58, top + 7, 150, 18);
  }
  return element;
}

function controller() {
  const listeners = new Set<(version: string, data: LiveData) => void>();
  const refresh = vi.fn(async () => undefined);
  const handle: ControllerHandle = {
    dispose: () => undefined,
    refresh,
    current: () => null,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const snapshot = sampleSnapshot();
  const publish = (version: string, alerts: RefView[]) => {
    for (const listener of [...listeners]) listener(version, { state: snapshot.state!, info: snapshot.info!, settings: snapshot.settings!, version, alerts, parents: {} });
  };
  return { handle, refresh, publish };
}

const overlay = () => document.querySelector(`[${HOST_ATTRIBUTE}]`)?.shadowRoot ?? null;
const bell = (threadId: string) => overlay()?.querySelector<HTMLElement>(`.news-marker[data-thread="${threadId}"]:not([hidden])`) ?? null;
const summary = () => overlay()?.querySelector<HTMLButtonElement>(".summary:not([hidden])") ?? null;
const press = (element: Element) => {
  element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true, pointerType: "mouse" }));
  (element as HTMLElement).click();
};

let stops: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  document.body.replaceChildren();
  document.documentElement.lang = "zh-CN";
});
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.useRealTimers();
});

describe("on Codex Desktop", () => {
  it("counts a conversation in a collapsed project at the top of the sidebar, and rings on a row in sight", async () => {
    const sidebar = document.createElement("div");
    sidebar.setAttribute("data-app-action-sidebar-scroll", "");
    box(sidebar, 0, 96, 260, 600);
    const open = row({ "data-app-action-sidebar-thread-row": "" }, "结算页错位", 130);
    const project = document.createElement("div");
    const rows = document.createElement("div");
    rows.style.display = "none";
    const folded = row({ "data-app-action-sidebar-thread-row": "" }, "部署文档", null);
    rows.append(folded);
    project.append(rows);
    sidebar.append(open, project);
    document.body.append(sidebar);
    const desktopRow = (element: HTMLElement, threadId: string): DesktopSidebarRow => ({ element, hostId: "local", isLocal: true, threadId, draftId: null, isConnected: () => element.isConnected });
    const order: string[] = [];
    const invoke = vi.fn(async (method: string, params?: unknown) => {
      if (method === "refs.seen") order.push(`seen ${(params as { key: string }).key}`);
      return { ok: true };
    });
    const openThread = vi.fn(async (threadId: string) => void order.push(`open ${threadId}`));
    const api: DesktopApi = {
      id: "second-brain",
      apiVersion: 1,
      signal: new AbortController().signal,
      sidebar: {
        observeRows: (callback) => {
          callback([desktopRow(open, OPEN), desktopRow(folded, FOLDED)]);
          return () => undefined;
        },
      },
      threads: { watchTree: () => () => undefined },
      navigate: { openThread },
      dom: { mount: (node, parent) => parent.append(node), mark: () => undefined, unmark: () => undefined },
      storage: { get: async () => ({}), set: async (values) => values, onChange: () => () => undefined },
      backend: { invoke },
      track: () => undefined,
    };
    const adapter: SurfaceAdapter = createDesktopAdapter(api, document);
    const stopWatching = adapter.watchCurrentThread(() => undefined);
    const { handle, refresh, publish } = controller();
    stops.push(startHover(adapter, handle), stopWatching, () => adapter.dispose?.());
    publish("v1", [news(OPEN, 42, "fix(checkout): 窄屏下结算按钮不再压住表单"), news(FOLDED, 51, "docs: 补上回滚步骤")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(bell(OPEN)).not.toBeNull();
    expect(bell(FOLDED)).toBeNull();
    expect(summary()?.getAttribute("aria-label")).toBe("1 条 PR 与 Issue 新动态");
    // Clicking the row in sight while its bell shows: what that conversation started is seen.
    press(open.querySelector(".title")!);
    await vi.advanceTimersByTimeAsync(10);
    expect(invoke).toHaveBeenCalledWith("refs.seenForThread", { threadId: OPEN });
    expect(refresh).toHaveBeenCalled();
    // The summary's list opens the folded conversation through Desktop, its news marked seen first.
    summary()!.click();
    [...overlay()!.querySelectorAll<HTMLButtonElement>(".news-list button")].find((button) => button.textContent === "打开对话")!.click();
    await vi.advanceTimersByTimeAsync(10);
    expect(order).toEqual(["seen acme/widgets#51", `open ${FOLDED}`]);
  });
});

describe("on codexhost Web", () => {
  it("rings on the conversation's row in the Recent list when its workspace is collapsed, and counts it once no row is left in sight", async () => {
    const sidebar = document.createElement("aside");
    sidebar.setAttribute("data-cx-region", "sidebar");
    box(sidebar, 0, 0, 260, 800);
    const workspace = document.createElement("div");
    workspace.setAttribute("data-row-key", "workspace:shop-web");
    const sessions = document.createElement("div");
    sessions.style.display = "none";
    const session = row({ "data-row-key": `session:${OPEN}`, role: "treeitem" }, "结算页错位", null);
    sessions.append(session);
    const recent = row({ "data-row-key": `recent:${OPEN}`, role: "treeitem" }, "结算页错位", 300);
    sidebar.append(workspace, sessions, recent);
    document.body.append(sidebar);
    const invoke = vi.fn(async () => ({ ok: true }));
    const api: WebApi = {
      id: "second-brain",
      signal: new AbortController().signal,
      apiVersion: 1,
      dom: { mount: () => undefined },
      track: () => undefined,
      assets: { url: (file) => file },
      storage: { get: async () => ({}), set: async (values) => values, onChange: () => () => undefined },
      backend: { invoke },
    };
    const adapter = createWebAdapter(api, document);
    const { handle, publish } = controller();
    stops.push(startHover(adapter, handle), () => adapter.dispose?.());
    publish("v1", [news(OPEN, 42, "fix(checkout): 窄屏下结算按钮不再压住表单")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(bell(OPEN)).not.toBeNull();
    expect(bell(OPEN)!.style.top).toBe(`${300 + 16}px`);
    expect(summary()).toBeNull();
    // Clicking the workspace row is no click on the conversation.
    press(workspace);
    await vi.advanceTimersByTimeAsync(10);
    expect(invoke).not.toHaveBeenCalledWith("refs.seenForThread", expect.anything());
    // The Recent list scrolls it away: only the summary is left.
    box(recent, 0, 900, 260, 32);
    publish("v2", [news(OPEN, 42, "fix(checkout): 窄屏下结算按钮不再压住表单")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(bell(OPEN)).toBeNull();
    expect(summary()?.getAttribute("data-count")).toBe("1");
    // Back in sight, and clicked while its bell shows.
    box(recent, 0, 300, 260, 32);
    publish("v3", [news(OPEN, 42, "fix(checkout): 窄屏下结算按钮不再压住表单")]);
    await vi.advanceTimersByTimeAsync(0);
    press(recent.querySelector(".title")!);
    await vi.advanceTimersByTimeAsync(10);
    expect(invoke).toHaveBeenCalledWith("refs.seenForThread", { threadId: OPEN });
  });
});
