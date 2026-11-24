// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationView } from "../src/core/conversation-view.js";
import { DEFAULT_SETTINGS } from "../src/core/model.js";
import type { MutateV2Params, SnapshotResultV2 } from "../src/core/rpc.js";
import { ACTIVE_ROW_ATTRIBUTE, COMPOSER_ATTRIBUTE, currentDesktopThread, treeReport } from "../src/desktop/adapter.js";
import type { DesktopSidebarRow } from "../src/host/types.js";
import { freeBand } from "../src/ui/band.js";
import { Capsule, type CapsuleModel, type CapsuleOptions } from "../src/ui/capsule.js";
import { startController, type SurfaceAdapter } from "../src/ui/controller.js";
import { currentWebThread, openWebThread, webParents } from "../src/web/adapter.js";
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
    // The first poll says which conversation is open, so the backend can mark its news as seen.
    expect(calls[0]).toEqual(["snapshot", { focus: { threadId: T.main, surface: "desktop" }, locale: "zh-CN", localeSource: "surface" }]);
    switchTo(T.child);
    await vi.advanceTimersByTimeAsync(10);
    expect(text(shadow(), ".capsule .goal")).toBe("修复手机端菜单图标和标题重叠");
    expect(shadow().querySelector(".root")!.hasAttribute("data-open")).toBe(true);
    controller.dispose();
    expect(document.querySelector("[data-codexhost-mainline]")).toBeNull();
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
