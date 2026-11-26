// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationView } from "../src/core/conversation-view.js";
import { DEFAULT_SETTINGS } from "../src/core/model.js";
import type { MutateV2Params, SnapshotResultV2 } from "../src/core/rpc.js";
import { ACTIVE_ROW_ATTRIBUTE, COMPOSER_ATTRIBUTE, currentDesktopThread, treeReport } from "../src/desktop/adapter.js";
import type { DesktopSidebarRow } from "../src/host/types.js";
import { freeBand } from "../src/ui/band.js";
import { Capsule, type CapsuleModel, type CapsuleOptions } from "../src/ui/capsule.js";
import { clientId, startController, type SurfaceAdapter } from "../src/ui/controller.js";
import { webSessionId } from "../src/core/hosts.js";
import type { WebApi } from "../src/host/types.js";
import { createWebAdapter, currentWebSession, currentWebThread, openWebThread, OPEN_EVENT, rowSession, webParents, webRows } from "../src/web/adapter.js";
import { NOW, ref42, sampleSearchResults, sampleSnapshot, sampleView, T } from "./fixtures/v2.js";

const shadowOf = (capsule: Capsule) => capsule.host.shadowRoot!;
const text = (root: ParentNode, selector: string) => root.querySelector(selector)?.textContent ?? "";

function pointer(target: Element, type: string, init: { clientX?: number; clientY?: number } = {}) {
  const Ctor = (window.PointerEvent ?? window.MouseEvent) as typeof MouseEvent;
  target.dispatchEvent(new Ctor(type, { bubbles: true, composed: true, button: 0, ...init }));
}

/** Clicks the pill without moving, which opens or closes the card. */
function toggle(capsule: Capsule) {
  const pill = shadowOf(capsule).querySelector(".capsule")!;
  pointer(pill, "pointerdown");
  pointer(pill, "pointerup");
}

function press(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
}

const created: Capsule[] = [];
function makeCapsule(options: Partial<CapsuleOptions> = {}): Capsule {
  const capsule = new Capsule({
    doc: document,
    locale: "zh-CN",
    surface: "web",
    mutate: async () => undefined,
    openThread: () => undefined,
    anchor: () => ({ x: 400, top: 60 }),
    ...options,
  });
  document.body.append(capsule.host);
  created.push(capsule);
  return capsule;
}

function model(view: ConversationView | null, extra: Partial<CapsuleModel> = {}): CapsuleModel {
  return { threadId: view?.threadId ?? null, view, settings: DEFAULT_SETTINGS, offline: false, now: NOW, ...extra };
}

beforeEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  document.documentElement.lang = "zh-CN";
});
afterEach(() => {
  for (const capsule of created.splice(0)) capsule.destroy();
  vi.useRealTimers();
});

describe("current window", () => {
  it("reads Desktop's Composer marker, then the active sidebar row", () => {
    const row = document.createElement("div");
    row.setAttribute(ACTIVE_ROW_ATTRIBUTE, "true");
    const rows: DesktopSidebarRow[] = [
      { element: row, hostId: "local", isLocal: true, threadId: "row-thread", draftId: null, isConnected: () => true },
    ];
    expect(currentDesktopThread(document, rows)).toBe("row-thread");
    const portal = document.createElement("div");
    portal.setAttribute(COMPOSER_ATTRIBUTE, "composer-thread");
    document.body.append(portal);
    expect(currentDesktopThread(document, rows)).toBe("composer-thread");
    expect(currentDesktopThread(document, [{ ...rows[0]!, isLocal: false, hostId: "remote" }])).toBe("composer-thread");
    // A new conversation that was never sent has a draft id, which is no Thread.
    portal.setAttribute(COMPOSER_ATTRIBUTE, "draft-e0aa");
    expect(currentDesktopThread(document, rows)).toBe("row-thread");
    portal.setAttribute(COMPOSER_ATTRIBUTE, "client-new-thread:5f0c9a1e-0000-4000-8000-000000000001");
    expect(currentDesktopThread(document, rows)).toBe("row-thread");
    // Nor is a draft's sidebar row, whatever it holds.
    expect(currentDesktopThread(document, [{ ...rows[0]!, threadId: "client-new-thread:5f0c9a1e-0000-4000-8000-000000000001" }])).toBeNull();
  });

  it("does not use a retained previous Desktop conversation when a new draft is open", () => {
    const old = document.createElement("div");
    old.setAttribute(COMPOSER_ATTRIBUTE, "old-thread");
    const draft = document.createElement("div");
    draft.setAttribute(COMPOSER_ATTRIBUTE, "draft-19");
    draft.getClientRects = () => [{ width: 10, height: 10 }] as unknown as DOMRectList;
    document.body.append(old, draft);
    expect(currentDesktopThread(document, [])).toBeNull();
    draft.setAttribute(COMPOSER_ATTRIBUTE, "new-thread");
    expect(currentDesktopThread(document, [])).toBe("new-thread");
  });

  it("reports only live delegation links from Desktop's tree", () => {
    const report = treeReport(
      {
        revision: 1,
        truncated: false,
        parents: { c1: "t1", gone: "t1" },
        nodes: {
          t1: { harnessId: "codex", title: "Parent", status: "running", archived: false },
          c1: { harnessId: "claude-code", status: "idle", archived: false },
          gone: { harnessId: "codex", status: "idle", archived: true },
          other: { harnessId: "codex", status: "idle", archived: false },
        },
      },
      undefined,
      "t1",
    );
    expect(report.parents).toEqual({ c1: "t1" });
    expect(Object.keys(report.nodes).sort()).toEqual(["c1", "t1"]);
  });

  it("reads the selected Web sidebar row and opens rows by clicking them", () => {
    document.body.innerHTML = `
      <div data-row-key="session:aaa" role="treeitem"></div>
      <div data-row-key="session:bbb" role="treeitem" aria-current="page"></div>`;
    expect(currentWebThread(document)).toBe("bbb");
    document.querySelector('[aria-current="page"]')!.removeAttribute("aria-current");
    expect(currentWebThread(document)).toBeNull();
    const clicked = vi.fn();
    document.querySelector('[data-row-key="session:aaa"]')!.addEventListener("click", clicked);
    openWebThread(document, "aaa");
    expect(clicked).toHaveBeenCalledOnce();
    document.body.innerHTML = `<div data-sidebar-collapsed="true"><div data-row-key="session:aaa"></div></div>`;
    expect(currentWebThread(document)).toBeUndefined();
  });

  it("reads rows of the Recent list, which use recent:<id> keys", () => {
    document.body.innerHTML = `
      <div data-row-key="section:native-section:0" role="treeitem"></div>
      <div data-row-key="workspace:w1" role="treeitem" aria-current="page"></div>
      <div data-row-key="recent:ccc" role="treeitem" aria-selected="true" aria-current="page"></div>`;
    expect(currentWebThread(document)).toBe("ccc");
    const clicked = vi.fn();
    document.querySelector('[data-row-key="recent:ccc"]')!.addEventListener("click", clicked);
    openWebThread(document, "ccc");
    expect(clicked).toHaveBeenCalledOnce();
  });

  it("reads the delegation links the sidebar tree writes on Web rows", () => {
    document.body.innerHTML = `
      <div data-row-key="session:aaa" role="treeitem"></div>
      <div data-row-key="session:kid" role="treeitem" data-thread-parent="aaa"></div>
      <div data-row-key="recent:kid2" role="treeitem" data-thread-parent="aaa"></div>
      <div data-row-key="workspace:w1" role="treeitem" data-thread-parent="aaa"></div>
      <div data-row-key="session:self" role="treeitem" data-thread-parent="self"></div>`;
    expect(webParents(document)).toEqual({ kid: "aaa", kid2: "aaa" });
  });
});

describe("conversations on another computer in codexhost Web", () => {
  const HOST = "remote-peer:0d1e2f3a-aaaa-4bbb-8ccc-000000000001";
  const REMOTE = "019b0001-aaaa-7bbb-8ccc-00000000000a";
  const CHILD = "019b0003-aaaa-7bbb-8ccc-00000000000c";
  const LOCAL = "019b0002-aaaa-7bbb-8ccc-00000000000b";
  const remoteKey = (threadId: string, hostId = HOST) => webSessionId(threadId, hostId);
  const base64 = (value: unknown) => `web-remote:${btoa(JSON.stringify(value)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "")}`;

  it("reads a remote row's key in the Recent and the workspace forms, and leaves local rows as they were", () => {
    document.body.innerHTML = `
      <div data-row-key="recent:${remoteKey(REMOTE)}" role="treeitem"></div>
      <div data-row-key="session:${remoteKey(REMOTE)}" role="treeitem"></div>
      <div data-row-key="session:${LOCAL}" role="treeitem"></div>
      <div data-row-key="recent:${LOCAL}" role="treeitem"></div>`;
    const rows = [...document.querySelectorAll("[data-row-key]")];
    expect(rows.map((row) => rowSession(row))).toEqual([
      { threadId: REMOTE, hostId: HOST },
      { threadId: REMOTE, hostId: HOST },
      { threadId: LOCAL },
      { threadId: LOCAL },
    ]);
  });

  it("reads and opens conversations linked into a workspace, including remote ones", () => {
    const group = "remote-workspace:group";
    document.body.innerHTML = `<div data-sidebar-group="${group}">
      <div role="treeitem" aria-current="page" data-row-key="linked:${group}:${remoteKey(REMOTE)}"></div>
      <div role="treeitem" data-row-key="linked:${group}:${LOCAL}"></div>
      <div role="treeitem" data-row-key="linked:${group}:${remoteKey("draft-19")}"></div>
    </div>`;
    const [row, local, draft] = [...document.querySelectorAll("[role=treeitem]")];
    expect(currentWebSession(document)).toEqual({ threadId: REMOTE, hostId: HOST });
    expect(rowSession(local)).toEqual({ threadId: LOCAL });
    expect(rowSession(draft)).toBeUndefined();
    expect(webRows(document).hosts).toEqual({ [REMOTE]: HOST });
    const clicked = vi.fn();
    row!.addEventListener("click", clicked);
    openWebThread(document, REMOTE, HOST);
    expect(clicked).toHaveBeenCalledOnce();
  });

  it("ignores a row whose key does not decode: bad base64, a bad host id, a bad conversation id, a draft, other rows", () => {
    for (const key of [
      "recent:web-remote:@@@",
      "session:web-remote:",
      `session:${base64(["remote-peer:bad id", REMOTE])}`,
      `recent:${base64(["local", REMOTE])}`,
      `session:${base64([HOST, "__proto__"])}`,
      `session:${base64([HOST, "draft-4"])}`,
      `session:${base64({ hostId: HOST, threadId: REMOTE })}`,
      "session:web-remote:draft-3",
      "session:draft-19",
      "recent:draft-19",
      "workspace:remote-workspace:abc",
      `linked:workspace-key:${LOCAL}`,
      "empty:host-scope",
      "overflow:flat",
    ]) {
      document.body.innerHTML = `<div data-row-key="${key}" role="treeitem" aria-current="page"></div>`;
      expect(rowSession(document.querySelector("[data-row-key]")), key).toBeUndefined();
      expect(currentWebThread(document), key).not.toBeTypeOf("string");
    }
  });

  it("tells the open conversation and its host, from the selected row or the right panel", () => {
    document.body.innerHTML = `
      <div data-row-key="session:${LOCAL}" role="treeitem"></div>
      <div data-row-key="recent:${remoteKey(REMOTE)}" role="treeitem" aria-current="page"></div>`;
    expect(currentWebSession(document)).toEqual({ threadId: REMOTE, hostId: HOST });
    expect(currentWebThread(document)).toBe(REMOTE);
    document.body.innerHTML = `<div data-row-key="session:${LOCAL}" role="treeitem"></div><div data-sidebar-right-session="${remoteKey(REMOTE)}"></div>`;
    const panel = document.querySelector<HTMLElement>("[data-sidebar-right-session]")!;
    panel.getClientRects = () => [{ width: 10, height: 10 }] as unknown as DOMRectList;
    expect(currentWebSession(document)).toEqual({ threadId: REMOTE, hostId: HOST });
    // When the user selects a draft, an old right panel may still be visible for a render.
    const selected = document.querySelector("[role=treeitem]")!;
    selected.setAttribute("data-row-key", "session:draft-19");
    selected.setAttribute("aria-current", "page");
    expect(currentWebSession(document)).toBeNull();
    selected.removeAttribute("aria-current");
    // A draft open in the right panel is no conversation.
    panel.setAttribute("data-sidebar-right-session", "draft-19");
    expect(currentWebSession(document)).toBeNull();
  });

  it("opens one by its row, else by codexhost Web's own link for it; a local one as before", () => {
    document.body.innerHTML = `<div data-row-key="session:${remoteKey(REMOTE)}" role="treeitem"></div>`;
    const clicked = vi.fn();
    document.querySelector("[data-row-key]")!.addEventListener("click", clicked);
    openWebThread(document, REMOTE, HOST);
    expect(clicked).toHaveBeenCalledOnce();
    // No row for it: codexhost Web's `?session=` link, with its `web-remote:` session id.
    const assign = vi.fn();
    const page = { querySelectorAll: () => [], defaultView: { location: { href: "http://127.0.0.1:8080/?tab=1", assign } } } as unknown as Document;
    openWebThread(page, REMOTE, HOST);
    const url = new URL(assign.mock.calls[0]![0] as string);
    expect(url.searchParams.get("session")).toBe(remoteKey(REMOTE));
    expect(url.searchParams.get("tab")).toBe("1");
    openWebThread(page, LOCAL);
    expect(new URL(assign.mock.calls[1]![0] as string).searchParams.get("session")).toBe(LOCAL);
  });

  it("reports the delegation links and the hosts of the remote rows its sidebar shows", () => {
    document.body.innerHTML = `
      <div data-row-key="session:${remoteKey(REMOTE)}" role="treeitem"></div>
      <div data-row-key="session:${remoteKey(CHILD)}" role="treeitem" data-thread-parent="${remoteKey(REMOTE)}"></div>
      <div data-row-key="session:${LOCAL}" role="treeitem"></div>`;
    expect(webRows(document)).toEqual({ parents: { [CHILD]: REMOTE }, hosts: { [REMOTE]: HOST, [CHILD]: HOST } });
  });

  it("knows a remote row's host from the row and from the snapshot, names it for the open conversation, and opens such conversations by it", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <aside data-cx-region="sidebar">
        <div data-row-key="recent:${remoteKey(REMOTE)}" role="treeitem" aria-current="page"><span class="title">远程</span></div>
        <div data-row-key="session:${LOCAL}" role="treeitem"><span class="title">本机</span></div>
      </aside>`;
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
    const seen: Array<string | null> = [];
    const stop = adapter.watchCurrentThread((threadId) => seen.push(threadId));
    try {
      expect(seen).toEqual([REMOTE]);
      expect(adapter.hostOf?.(REMOTE)).toBe(HOST);
      expect(adapter.hostOf?.(LOCAL)).toBeUndefined();
      // The sidebar's remote rows go to the backend with their hosts.
      expect(invoke).toHaveBeenCalledWith("reportTree", { surface: "web", nodes: {}, parents: {}, hosts: { [REMOTE]: HOST } });
      const title = document.querySelector('[data-row-key^="recent:"] .title')!;
      expect(adapter.rowAt?.(title)).toEqual({ element: title.parentElement, threadId: REMOTE, hostId: HOST });
      expect(adapter.rowAt?.(document.querySelector('[data-row-key^="session:"] .title'))).toEqual({ element: document.querySelector('[data-row-key^="session:"]'), threadId: LOCAL });
      expect(adapter.rowsFor?.(REMOTE)).toEqual([title.parentElement]);
      // A child the snapshot names, not in the sidebar: opened by its host, through the overview's request too.
      adapter.onData?.({ state: sampleSnapshot().state!, info: {}, settings: DEFAULT_SETTINGS, version: "v", alerts: [], parents: {}, hosts: { [CHILD]: HOST, "draft-3": HOST, [LOCAL]: "local" } }, REMOTE);
      expect(adapter.hostOf?.(CHILD)).toBe(HOST);
      expect(adapter.hostOf?.("draft-3")).toBeUndefined();
      expect(adapter.hostOf?.(LOCAL)).toBeUndefined();
      document.body.insertAdjacentHTML("beforeend", `<div data-row-key="session:${remoteKey(CHILD)}" role="treeitem"></div>`);
      const clicked = vi.fn();
      document.querySelector(`[data-row-key="session:${remoteKey(CHILD)}"]`)!.addEventListener("click", clicked);
      const detail: { threadId: string; handled?: boolean } = { threadId: CHILD };
      window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail }));
      expect(detail.handled).toBe(true);
      expect(clicked).toHaveBeenCalledOnce();
    } finally {
      stop();
      adapter.dispose?.();
      vi.useRealTimers();
    }
  });
});

function box(element: Element, left: number, top: number, width: number, height: number) {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }),
  });
}

describe("header band", () => {
  it("finds the widest empty stretch between the title and the controls", () => {
    document.body.innerHTML = `<header id="bar"><button id="title">Title</button><button id="icon">i</button></header>`;
    box(document.getElementById("bar")!, 300, 0, 1100, 48);
    box(document.getElementById("title")!, 320, 12, 220, 24);
    box(document.getElementById("icon")!, 1350, 12, 24, 24);
    expect(freeBand(document.getElementById("bar"))).toEqual({ left: 540, right: 1350, top: 0, height: 48 });
    box(document.getElementById("bar")!, 0, 0, 1100, 20);
    expect(freeBand(document.getElementById("bar"))).toBeNull();
  });

  it("sits inside the band, shortening itself to fit, and goes below the header when the gap is tiny", () => {
    let band = { left: 500, right: 900, top: 0, height: 48 };
    const capsule = makeCapsule({ anchor: () => ({ x: 700, top: 60, band }) });
    const pill = shadowOf(capsule).querySelector<HTMLElement>(".capsule")!;
    // jsdom has no layout: the pill is 600px wide unless a max width holds it back.
    Object.defineProperty(pill, "offsetWidth", { configurable: true, get: () => (pill.style.maxWidth ? parseInt(pill.style.maxWidth, 10) : 600) });
    capsule.update(model(sampleView(T.main)));
    expect(pill.style.maxWidth).toBe("380px");
    expect(capsule.host.style.top).toBe("9px");
    band = { left: 500, right: 700, top: 0, height: 48 };
    capsule.reposition();
    expect(pill.style.maxWidth).toBe("");
    expect(capsule.host.style.top).toBe("60px");
  });
});

describe("capsule", () => {
  function setup(view: ConversationView | null = sampleView(T.main), extra: Partial<CapsuleModel> = {}) {
    const mutate = vi.fn<(params: MutateV2Params) => Promise<void>>(async () => undefined);
    const spawn = vi.fn<(spinoffId: string) => Promise<void>>(async () => undefined);
    const openThread = vi.fn<(threadId: string) => void>();
    const calls: Array<[string, unknown]> = [];
    const capsule = makeCapsule({
      mutate,
      spawn,
      openThread,
      call: async (method, params) => {
        calls.push([method, params]);
        return method === "search" ? sampleSearchResults() : [];
      },
      storage: localStorage,
    });
    capsule.update(model(view, extra));
    return { capsule, mutate, spawn, openThread, calls, root: shadowOf(capsule) };
  }

  it("names the conversation, its current milestone, the task in progress and the progress", () => {
    const { root } = setup();
    expect(text(root, ".capsule .goal")).toBe("修复结算页在窄屏下错位");
    expect(text(root, ".capsule .milestone")).toBe("● 维护者审查");
    expect(text(root, ".capsule .doing")).toBe("▸ 回复 review 意见");
    expect(text(root, ".capsule .count")).toBe("◆ 2/4");
    // An open spin-off waits for a decision.
    expect(root.querySelector(".capsule")!.hasAttribute("data-drift")).toBe(true);
    expect(root.querySelector(".capsule")!.getAttribute("title")).toContain("#shop-web #结算页 #bugfix #PR #42");
  });

  it("stays hidden until the view arrives, and shows a draft as a draft", () => {
    const { capsule, root } = setup(null);
    expect(root.querySelector(".root")!.hasAttribute("hidden")).toBe(true);
    capsule.update(model(sampleView(T.old)));
    expect(root.querySelector(".root")!.hasAttribute("hidden")).toBe(false);
    expect(root.querySelector(".capsule")!.hasAttribute("data-empty")).toBe(true);
    expect(text(root, ".capsule .label")).toBe("未凝练");
    expect(text(root, ".capsule .goal")).toBe("登录页样式检查");
  });

  it("opens into the milestone timeline with the current stage's tasks", () => {
    const { capsule, root, mutate, openThread } = setup();
    toggle(capsule);
    const card = root.querySelector(".card")!;
    expect([...card.querySelectorAll(".chip")].map((chip) => chip.textContent)).toEqual(["#shop-web", "#结算页", "#bugfix", "#PR #42"]);
    expect([...card.querySelectorAll(".milestone")].map((node) => node.getAttribute("data-state"))).toEqual(["done", "done", "current", "planned"]);
    const current = card.querySelector('.milestone[data-state="current"]')!;
    expect(current.querySelector(".row.task[data-doing]")?.textContent).toContain("回复 review 意见");
    expect(current.textContent).toContain("子对话「修复手机端菜单图标和标题重叠」");
    current.querySelector<HTMLButtonElement>(".buttons .btn.primary")!.click();
    expect(mutate).toHaveBeenCalledWith({ op: "milestoneReach", threadId: T.main, milestoneId: "m3" });
    press(current.querySelector<HTMLInputElement>("input.add")!, "补一条回归测试");
    expect(mutate).toHaveBeenCalledWith({ op: "taskAdd", threadId: T.main, text: "补一条回归测试", milestoneId: "m3" });
    // Finished stages fold their tasks away until asked.
    const first = card.querySelector('.milestone[data-state="done"]')!;
    expect(first.querySelector(".row.task")).toBeNull();
    first.querySelector<HTMLButtonElement>(".task-toggle")!.click();
    expect(root.querySelector('.milestone[data-state="done"]')!.textContent).toContain("读 CheckoutForm 的样式断点");
    const children = [...root.querySelectorAll<HTMLElement>(".card .section")].find((section) => section.querySelector(".section-title")?.textContent === "子对话")!;
    children.querySelector<HTMLElement>(".row[data-clickable]")!.click();
    expect(openThread).toHaveBeenCalledWith(T.child);
  });

  it("folds a long run of reached milestones, keeping the last two in sight", () => {
    const view = sampleView(T.main);
    const reached = view.milestones[0]!;
    view.milestones.unshift(...["需求", "设计", "原型", "评审"].map((title, i) => ({ ...reached, id: `e${i}`, title, tasks: [] })));
    const { capsule, root } = setup(view);
    toggle(capsule);
    const titles = () => [...root.querySelectorAll(".card .milestone .milestone-title")].map((node) => node.textContent);
    expect(titles()).toEqual(["定位原因：窄屏断点漏了结算页", "提交 PR #42", "维护者审查", "合并后验证"]);
    const more = root.querySelector<HTMLButtonElement>(".card .section .task-toggle")!;
    expect(more.textContent).toBe("还有 4 个更早的里程碑");
    more.click();
    expect(titles()).toHaveLength(8);
  });

  it("asks for a second click before opening a child conversation for a spin-off", () => {
    const { capsule, root, spawn, mutate } = setup();
    toggle(capsule);
    const spinoff = root.querySelector(".spinoff")!;
    expect(spinoff.textContent).toContain("商品页的视频点开没反应");
    const [spawnButton, keep, dismiss] = [...spinoff.querySelectorAll<HTMLButtonElement>("button")];
    spawnButton!.click();
    expect(spawn).not.toHaveBeenCalled();
    expect(spawnButton!.textContent).toBe("再点一次确认");
    spawnButton!.click();
    expect(spawn).toHaveBeenCalledWith("s2");
    keep!.click();
    expect(mutate).toHaveBeenCalledWith({ op: "spinoffKeep", threadId: T.main, spinoffId: "s2" });
    // Dismissing cannot be undone: the first click only arms the button.
    dismiss!.click();
    expect(mutate).not.toHaveBeenCalledWith({ op: "spinoffDismiss", threadId: T.main, spinoffId: "s2" });
    expect(dismiss!.textContent).toBe("再点一次确认");
    dismiss!.click();
    expect(mutate).toHaveBeenCalledWith({ op: "spinoffDismiss", threadId: T.main, spinoffId: "s2" });
    // The spin-off that already became a child conversation links to it.
    expect(root.querySelector(".card")!.textContent).toContain("已开子对话：手机端菜单图标和标题重叠");
  });

  it("edits the title and the tags in place", () => {
    const { capsule, root, mutate } = setup();
    toggle(capsule);
    root.querySelector<HTMLButtonElement>(".goal-line button")!.click();
    const title = root.querySelector<HTMLInputElement>(".goal-line input")!;
    press(title, "修复结算页只在窄屏下错位");
    title.blur();
    expect(mutate).toHaveBeenCalledWith({ op: "title", threadId: T.main, title: "修复结算页只在窄屏下错位" });
    root.querySelector<HTMLButtonElement>(".tags button.link")!.click();
    press(root.querySelector<HTMLInputElement>(".tags input")!, "shop-web， 结算页、, 断点");
    expect(mutate).toHaveBeenCalledWith({ op: "tags", threadId: T.main, tags: ["shop-web", "结算页", "断点"] });
  });

  it("turns a draft into a mainline with its title, tags and planned milestones", () => {
    const { capsule, root, mutate } = setup(sampleView(T.old));
    toggle(capsule);
    const [title, tags, plan] = [...root.querySelectorAll<HTMLInputElement>(".draft-form input")];
    expect(title!.value).toBe("登录页样式检查");
    expect(tags!.value).toBe("shop, widgets, Issue #3");
    plan!.value = "列出错位的按钮 | 重排 | 定稿";
    root.querySelector<HTMLButtonElement>(".draft-form .btn.primary")!.click();
    expect(mutate).toHaveBeenCalledWith({
      op: "create",
      threadId: T.old,
      title: "登录页样式检查",
      tags: ["shop", "widgets", "Issue #3"],
      milestones: ["列出错位的按钮", "重排", "定稿"],
    });
    expect(root.querySelector(".card")!.textContent).toContain("起因：把登录页的样式再检查一遍，错位的列出来");
  });

  it("shows GitHub news in any conversation and jumps to where the PR came from", () => {
    const { capsule, root, calls, openThread } = setup(sampleView(T.old), { alerts: [ref42] });
    expect(text(root, ".capsule .alert")).toBe("#42 有新动态");
    toggle(capsule);
    const news = root.querySelector(".row.news")!;
    expect(news.textContent).toContain("当时的问题：手机上打开结算页，按钮压住了表单");
    news.querySelector<HTMLButtonElement>("button.btn")!.click();
    expect(openThread).toHaveBeenCalledWith(T.main);
    expect(calls).toContainEqual(["refs.seen", { key: ref42.key }]);
    expect(capsule.isOpen).toBe(false);
  });

  it("finds conversations by any clue from the card", async () => {
    vi.useFakeTimers();
    const { capsule, root, calls, openThread } = setup(sampleView(T.old));
    toggle(capsule);
    root.querySelector<HTMLButtonElement>('.head button[aria-label="找对话"]')!.click();
    const input = root.querySelector<HTMLInputElement>("input.search-input")!;
    input.value = "1081";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(300);
    expect(calls).toContainEqual(["search", { query: "1081" }]);
    const results = root.querySelector(".search .results")!;
    expect(results.textContent).toContain("PR/Issue：PR #42");
    // The draft found is the conversation already open, so it has no jump button.
    const rows = [...results.querySelectorAll(".row")];
    expect(rows[1]!.textContent).toContain("就在本对话");
    rows[0]!.querySelector<HTMLButtonElement>("button.btn")!.click();
    expect(openThread).toHaveBeenCalledWith(T.main);
  });

  it("flashes open, closes by itself, and remembers where it was dragged", () => {
    vi.useFakeTimers();
    const { capsule, root } = setup();
    capsule.flash(3000);
    expect(capsule.isOpen).toBe(true);
    vi.advanceTimersByTime(3100);
    expect(capsule.isOpen).toBe(false);
    const pill = root.querySelector(".capsule")!;
    pointer(pill, "pointerdown", { clientX: 100, clientY: 100 });
    pointer(pill, "pointermove", { clientX: 160, clientY: 140 });
    pointer(pill, "pointerup", { clientX: 160, clientY: 140 });
    expect(capsule.isOpen).toBe(false);
    expect(JSON.parse(localStorage.getItem("codexhost-mainline:position-v2:web") ?? "{}")).toHaveProperty("y");
  });
});

describe("controller", () => {
  function adapterWith(invoke: SurfaceAdapter["invoke"], start: string = T.main) {
    let listener: (threadId: string | null) => void = () => undefined;
    const adapter: SurfaceAdapter = {
      surface: "desktop",
      doc: document,
      invoke,
      watchCurrentThread: (onChange) => {
        listener = onChange;
        onChange(start);
        return () => undefined;
      },
      openThread: () => undefined,
      anchor: () => null,
      mount: (host) => document.body.append(host),
    };
    return { adapter, switchTo: (threadId: string) => listener(threadId) };
  }

  const shadow = () => document.querySelector("[data-codexhost-mainline]")!.shadowRoot!;

  it("loads the open conversation's view, follows switches and flashes the new one", async () => {
    vi.useFakeTimers();
    const calls: Array<[string, unknown]> = [];
    const { adapter, switchTo } = adapterWith(async (method, params) => {
      calls.push([method, params]);
      if (method === "conversation") return sampleView((params as { threadId: string }).threadId);
      const snapshot: SnapshotResultV2 = sampleSnapshot();
      return (params as { version?: string } | undefined)?.version === snapshot.version ? { version: snapshot.version } : snapshot;
    });
    const controller = startController(adapter);
    const versions: string[] = [];
    controller.subscribe((version) => versions.push(version));
    await vi.advanceTimersByTimeAsync(10);
    expect(text(shadow(), ".capsule .goal")).toBe("修复结算页在窄屏下错位");
    expect(text(shadow(), ".capsule .alert")).toBe("#42 有新动态");
    expect(versions).toEqual(["v2-sample"]);
    expect(calls.filter(([method]) => method === "conversation")).toEqual([["conversation", { threadId: T.main }]]);
    // The first poll says which conversation is open in this window, which it names by an id of its own.
    expect(calls[0]).toEqual(["snapshot", { client: expect.stringMatching(/^[A-Za-z0-9-]{8,64}$/u), focus: { threadId: T.main, surface: "desktop" }, locale: "zh-CN", localeSource: "surface" }]);
    const client = (calls[0]![1] as { client: string }).client;
    switchTo(T.child);
    await vi.advanceTimersByTimeAsync(10);
    expect(text(shadow(), ".capsule .goal")).toBe("修复手机端菜单图标和标题重叠");
    expect(shadow().querySelector(".root")!.hasAttribute("data-open")).toBe(true);
    // The same id in every poll of this window, a different one in another window.
    const snapshots = calls.filter(([method]) => method === "snapshot").map(([, params]) => (params as { client?: string }).client);
    expect(snapshots.length).toBeGreaterThan(1);
    expect(new Set(snapshots)).toEqual(new Set([client]));
    const asked: unknown[] = [];
    const other = startController(
      adapterWith(async (method, params) => {
        if (method === "snapshot") asked.push(params);
        return method === "conversation" ? sampleView(T.main) : sampleSnapshot();
      }).adapter,
    );
    await vi.advanceTimersByTimeAsync(10);
    other.dispose();
    expect((asked[0] as { client?: string }).client).toMatch(/^[A-Za-z0-9-]{8,64}$/u);
    expect((asked[0] as { client?: string }).client).not.toBe(client);
    controller.dispose();
    expect(document.querySelector("[data-codexhost-mainline]")).toBeNull();
  });

  it("names itself by a made-up id where the page cannot make a random UUID (plain http)", () => {
    expect(clientId({ crypto: {} } as unknown as Window)).toMatch(/^[A-Za-z0-9-]{8,64}$/u);
    expect(clientId(null)).toMatch(/^[A-Za-z0-9-]{8,64}$/u);
  });

  it("puts the capsule on the page only while the showCapsule setting is on, and keeps polling either way", async () => {
    vi.useFakeTimers();
    let showCapsule = false;
    let version = 1;
    const { adapter } = adapterWith(async (method, params) => {
      if (method === "conversation") return sampleView((params as { threadId: string }).threadId);
      if ((params as { version?: string } | undefined)?.version === `v${version}`) return { version: `v${version}` };
      const snapshot = sampleSnapshot();
      return { ...snapshot, version: `v${version}`, settings: { ...snapshot.settings!, showCapsule } };
    });
    const controller = startController(adapter);
    const versions: string[] = [];
    controller.subscribe((next) => versions.push(next));
    await vi.advanceTimersByTimeAsync(10);
    expect(document.querySelector("[data-codexhost-mainline]")).toBeNull();
    expect(versions).toEqual(["v1"]);
    showCapsule = true;
    version = 2;
    await vi.advanceTimersByTimeAsync(2100);
    expect(text(shadow(), ".capsule .goal")).toBe("修复结算页在窄屏下错位");
    showCapsule = false;
    version = 3;
    await vi.advanceTimersByTimeAsync(2100);
    expect(document.querySelector("[data-codexhost-mainline]")).toBeNull();
    expect(versions).toEqual(["v1", "v2", "v3"]);
    controller.dispose();
  });

  it("goes grey while the backend is unreachable", async () => {
    vi.useFakeTimers();
    let fail = false;
    const { adapter } = adapterWith(async (method, params) => {
      if (fail) throw new Error("down");
      if (method === "conversation") return sampleView((params as { threadId: string }).threadId);
      return sampleSnapshot();
    });
    const controller = startController(adapter);
    await vi.advanceTimersByTimeAsync(10);
    expect(shadow().querySelector(".dot")!.getAttribute("data-tone")).toBe("drift");
    fail = true;
    await vi.advanceTimersByTimeAsync(2100);
    expect(shadow().querySelector(".dot")!.getAttribute("data-tone")).toBe("muted");
    controller.dispose();
  });
});
