// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationView, MilestoneView } from "../src/core/conversation-view.js";
import type { ControllerHandle, LiveData, SurfaceAdapter } from "../src/ui/controller.js";
import { HIDE_DELAY_MS, HOST_ATTRIBUTE, PREFETCH_DELAY_MS, REBIND_MS, SHOW_DELAY_MS, startHover } from "../src/ui/hover/index.js";
import { badgeSpot, cardSpot, type Box } from "../src/ui/hover/layout.js";
import { NOW, T, ref42, sampleSnapshot, sampleView } from "./fixtures/v2.js";

// ---------------------------------------------------------------------------------------------
// A fake surface: a sidebar of rows like Desktop's (title on the left, pin and archive buttons on
// the right), an adapter that reads them, and a controller whose version the test sets.

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function box(element: Element, { left, top, width, height }: Rect) {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }),
  });
}

const SIDEBAR_WIDTH = 260;
const ROW_TOP = 100;
const ROW_HEIGHT = 32;
const PIN_LEFT = 200;
const IDS = [T.main, T.child, T.old, T.other];

function makeSidebar(ids: readonly string[]) {
  const sidebar = document.createElement("nav");
  sidebar.setAttribute("data-test-sidebar", "");
  box(sidebar, { left: 0, top: 0, width: SIDEBAR_WIDTH, height: 800 });
  const section = document.createElement("div");
  section.className = "section-header";
  section.textContent = "Threads";
  box(section, { left: 0, top: 60, width: SIDEBAR_WIDTH, height: 30 });
  sidebar.append(section);
  const rows: Record<string, HTMLElement> = {};
  ids.forEach((id, index) => {
    const top = ROW_TOP + index * ROW_HEIGHT;
    const row = document.createElement("div");
    row.setAttribute("data-thread", id);
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = `Row ${index}`;
    box(title, { left: 12, top: top + 7, width: 170, height: 18 });
    const pin = document.createElement("button");
    pin.className = "pin";
    pin.setAttribute("aria-label", "Pin");
    box(pin, { left: PIN_LEFT, top: top + 6, width: 20, height: 20 });
    const archive = document.createElement("button");
    archive.className = "archive";
    archive.setAttribute("aria-label", "Archive");
    box(archive, { left: PIN_LEFT + 26, top: top + 6, width: 20, height: 20 });
    row.append(title, pin, archive);
    box(row, { left: 0, top, width: SIDEBAR_WIDTH, height: ROW_HEIGHT });
    rows[id] = row;
    sidebar.append(row);
  });
  return { sidebar, rows, section };
}

const copy = <V>(value: V): V => JSON.parse(JSON.stringify(value)) as V;

/** Snapshot data as the controller hands it on, without GitHub news unless a test adds some. */
function sampleLive(): LiveData {
  const snapshot = sampleSnapshot();
  return { state: snapshot.state!, info: snapshot.info!, settings: snapshot.settings!, version: snapshot.version, alerts: [], parents: snapshot.parents! };
}

function setup() {
  const content = document.createElement("main");
  content.textContent = "conversation";
  const { sidebar, rows, section } = makeSidebar(IDS);
  document.body.append(sidebar, content);
  const views: Record<string, ConversationView> = { [T.main]: sampleView(T.main), [T.child]: sampleView(T.child), [T.old]: sampleView(T.old) };
  const failing = new Set<string>();
  const spawned: unknown[] = [];
  const uploads: Array<{ name: string; size: number; type?: string }> = [];
  const chunks: Array<{ id: string; offset: number; data: string }> = [];
  const invoke = vi.fn(async (method: string, params?: unknown) => {
    if (method === "spawn") {
      spawned.push(params);
      return { childThreadId: "kid-1" };
    }
    if (method === "attach.begin") {
      uploads.push(params as (typeof uploads)[number]);
      return { id: `up-${uploads.length}`, chunkBytes: 512 * 1024 };
    }
    if (method === "attach.chunk") {
      chunks.push(params as (typeof chunks)[number]);
      return { received: 1, done: true };
    }
    if (method === "refs.seen" || method === "summarize") return { ok: true };
    if (method !== "conversation") throw new Error(`unexpected method ${method}`);
    const { threadId } = params as { threadId: string };
    if (failing.has(threadId)) throw new Error("[INTERNAL] backend exploded\n    at somewhere (backend.mjs:1:1)");
    const view = views[threadId];
    if (!view) throw new Error(`[NO_THREAD] No such conversation: ${threadId}`);
    return copy(view);
  });
  const openThread = vi.fn();
  const listeners = new Set<(version: string, data: LiveData) => void>();
  const refresh = vi.fn(async () => undefined);
  const controller: ControllerHandle = {
    dispose: () => undefined,
    refresh,
    current: () => null,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const adapter: SurfaceAdapter = {
    surface: "desktop",
    doc: document,
    invoke,
    watchCurrentThread: () => () => undefined,
    openThread,
    anchor: () => null,
    mount: () => undefined,
    sidebar: () => document.querySelector("[data-test-sidebar]"),
    rowAt(target) {
      const row = target instanceof Element ? target.closest<HTMLElement>("[data-thread]") : null;
      const threadId = row?.getAttribute("data-thread");
      return row && threadId ? { element: row, threadId } : null;
    },
    rowsFor: (threadId) => (rows[threadId] ? [rows[threadId]!] : []),
  };
  const stop = startHover(adapter, controller);
  const publish = (version: string, data?: Partial<LiveData>) => {
    for (const listener of [...listeners]) listener(version, { ...sampleLive(), ...data });
  };
  const calls = (threadId: string) => invoke.mock.calls.filter(([, params]) => (params as { threadId?: string }).threadId === threadId).length;
  const titleOf = (threadId: string) => rows[threadId]!.querySelector(".title")!;
  return { sidebar, rows, section, content, views, failing, invoke, openThread, listeners, stop, publish, calls, titleOf, spawned, uploads, chunks, refresh };
}

/** An event carrying files, as a paste or a drop from the system brings them. */
function withFiles(type: string, files: File[], key: "clipboardData" | "dataTransfer") {
  const event = new Event(type, { bubbles: true, composed: true, cancelable: true });
  Object.defineProperty(event, key, { value: { files, types: ["Files"], dropEffect: "none" } });
  return event;
}

// ---------------------------------------------------------------------------------------------
// The pointer, with the boundary events a browser sends when it moves from one element to another.

function pointer(target: Element, type: string, relatedTarget: Element | null, pointerType = "mouse") {
  const bubbles = type !== "pointerenter" && type !== "pointerleave";
  target.dispatchEvent(new PointerEvent(type, { bubbles, composed: true, cancelable: bubbles, relatedTarget, pointerType }));
}

/** Ancestors in the composed tree, the element first. */
function chain(element: Element | null): Element[] {
  const list: Element[] = [];
  for (let node: Node | null = element; node && node !== document; node = node instanceof ShadowRoot ? node.host : node.parentNode)
    if (node instanceof Element) list.push(node);
  return list;
}

function move(from: Element | null, to: Element | null, pointerType = "mouse") {
  const left = chain(from);
  const entered = chain(to);
  if (from) pointer(from, "pointerout", to, pointerType);
  for (const node of left) {
    if (entered.includes(node)) break;
    pointer(node, "pointerleave", to, pointerType);
  }
  if (to) pointer(to, "pointerover", from, pointerType);
  const entering: Element[] = [];
  for (const node of entered) {
    if (left.includes(node)) break;
    entering.push(node);
  }
  for (const node of entering.reverse()) pointer(node, "pointerenter", from, pointerType);
}

const host = () => document.querySelector<HTMLElement>(`[${HOST_ATTRIBUTE}]`);
const card = () => host()?.shadowRoot?.querySelector<HTMLElement>(".card") ?? null;
const badge = () => host()?.shadowRoot?.querySelector<HTMLElement>(".badge") ?? null;
const cardShown = () => Boolean(card() && !card()!.hidden);
const text = (root: ParentNode | null | undefined, selector: string) => root?.querySelector(selector)?.textContent ?? "";
const texts = (root: ParentNode | null | undefined, selector: string) => [...(root?.querySelectorAll(selector) ?? [])].map((node) => node.textContent ?? "");
const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms);

let env: ReturnType<typeof setup>;

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  document.body.replaceChildren();
  document.documentElement.lang = "zh-CN";
  env = setup();
});

afterEach(() => {
  env.stop();
  vi.useRealTimers();
  Reflect.deleteProperty(document, "visibilityState");
});

// ---------------------------------------------------------------------------------------------

describe("sidebar hover card", () => {
  it("shows after the pointer rests on a row for 400 ms, beside the sidebar and level with the row", async () => {
    move(null, env.titleOf(T.main));
    await wait(SHOW_DELAY_MS - 1);
    expect(cardShown()).toBe(false);
    await wait(1);
    expect(cardShown()).toBe(true);
    expect(card()!.getAttribute("data-thread")).toBe(T.main);
    expect(card()!.style.left).toBe(`${SIDEBAR_WIDTH + 8}px`);
    expect(card()!.style.top).toBe(`${ROW_TOP}px`);
    // Fetched once, while the pointer rested (not again when the card opened).
    expect(env.invoke).toHaveBeenCalledWith("conversation", { threadId: T.main });
    expect(env.calls(T.main)).toBe(1);
  });

  it("does nothing for rows the pointer only passes over", async () => {
    move(null, env.titleOf(T.main));
    await wait(PREFETCH_DELAY_MS / 2);
    move(env.titleOf(T.main), env.titleOf(T.child));
    await wait(PREFETCH_DELAY_MS / 2);
    move(env.titleOf(T.child), env.content);
    await wait(1000);
    expect(cardShown()).toBe(false);
    expect(env.invoke).not.toHaveBeenCalled();
  });

  it("shows the mainline: title, tags, state, milestones, the current milestone's tasks, children and PRs", async () => {
    move(null, env.titleOf(T.main));
    await wait(SHOW_DELAY_MS);
    const root = card()!;
    expect(text(root, ".title-text")).toBe("修复结算页在窄屏下错位");
    expect(root.querySelector(".chip.draft")).toBeNull();
    expect(texts(root, ".tags .chip")).toEqual(["shop-web", "结算页", "bugfix", "PR #42"]);
    expect(text(root, ".meta .state")).toBe("进行中");
    expect(text(root, ".meta .live")).toBe("运行中");
    expect(root.querySelector(".meta .live .dot")!.getAttribute("data-status")).toBe("running");

    // Timeline: ✓ reached with their time, ● current, ○ planned.
    expect(text(root, '[data-section="milestones"] .count')).toBe("2/4");
    const milestones = [...root.querySelectorAll(".ms")].map((item) => [
      item.getAttribute("data-state"),
      text(item, ".mark"),
      text(item, ".ms-title"),
      text(item, ".ms-head > .when"),
    ]);
    expect(milestones).toEqual([
      ["done", "✓", "定位原因：窄屏断点漏了结算页", "5 小时前"],
      ["done", "✓", "提交 PR #42", "3 小时前"],
      ["current", "●", "维护者审查", ""],
      ["planned", "○", "合并后验证", ""],
    ]);

    // Under the current milestone: the task in progress, and the one a child conversation carries.
    const tasks = [...root.querySelectorAll('.ms[data-state="current"] .task')].map((item) => [
      item.getAttribute("data-kind"),
      text(item, ".mark"),
      text(item, ".task-text"),
    ]);
    expect(tasks).toEqual([
      ["now", "▸", "回复 review 意见"],
      ["child", "↳", "修手机端菜单图标重叠"],
    ]);
    expect(text(root, '.task[data-kind="now"] .now-label')).toBe("正在做");
    expect(text(root, ".task-child")).toBe("子对话「修复手机端菜单图标和标题重叠」");
    // Reached milestones keep their tasks to themselves.
    expect(root.querySelectorAll('.ms[data-state="done"] .task')).toHaveLength(0);

    // Child conversations: title, live state, the milestone each is at.
    const children = root.querySelectorAll('[data-section="children"] button.child');
    expect(children).toHaveLength(1);
    expect(text(root, '[data-section="children"] .section-title')).toBe("子对话（1）");
    expect(children[0]!.getAttribute("data-thread")).toBe(T.child);
    expect(text(children[0], ".child-title")).toBe("修复手机端菜单图标和标题重叠");
    expect(text(children[0], ".child-meta")).toBe("定位样式来源 · 0/1");
    expect(children[0]!.querySelector(".dot")!.getAttribute("data-status")).toBe("waiting");

    // PRs and issues: number, title, state; a plain link out.
    const ref = root.querySelector<HTMLAnchorElement>('[data-section="refs"] a.ref')!;
    expect(text(ref, ".ref-number")).toBe("PR #42");
    expect(text(ref, ".ref-title")).toBe("fix(checkout): 窄屏下结算按钮不再压住表单");
    expect(text(ref, ".ref-state")).toBe("进行中");
    expect(ref.getAttribute("href")).toBe("https://github.com/acme/widgets/pull/42");
    expect(ref.getAttribute("rel")).toBe("noopener noreferrer");

    // "Doing" is recorded, so the latest request stays out; no parent either.
    expect(root.querySelector(".prompts")).toBeNull();
    expect(root.querySelector(".relations")).toBeNull();
  });

  it("marks a draft and shows what started it and the latest request", async () => {
    move(null, env.titleOf(T.old));
    await wait(SHOW_DELAY_MS);
    const root = card()!;
    expect(text(root, ".title-text")).toBe("登录页样式检查");
    // No model has summarized it yet; the chip says so and explains what is shown instead.
    expect(text(root, ".title .chip.draft")).toBe("未凝练");
    expect(root.querySelector<HTMLElement>(".title .chip.draft")!.title).toContain("一两分钟内会自动凝练");
    expect(text(root, ".resummarize")).toBe("↻ 立即凝练");
    // A draft is no mainline yet: no "active", and no milestone section.
    expect(root.querySelector(".meta .state")).toBeNull();
    expect(text(root, ".meta .live")).toBe("空闲");
    expect(texts(root, ".tags .chip")).toEqual(["shop", "widgets", "Issue #3"]);
    expect(text(root, '[data-role="origin"]')).toBe("起因：把登录页的样式再检查一遍，错位的列出来");
    expect(text(root, '[data-role="last"]')).toBe("最近请求：把登录页的样式再检查一遍2 天前");
    expect(root.querySelector('[data-section="milestones"]')).toBeNull();
    expect(texts(root, '[data-section="refs"] .ref-number')).toEqual(["Issue #3"]);
    expect(text(root, '[data-section="refs"] .ref-title')).toBe("登录页按钮错位");
  });

  it("shows where a child came from; clicking the parent opens it and hides the card", async () => {
    move(null, env.titleOf(T.child));
    await wait(SHOW_DELAY_MS);
    const parent = card()!.querySelector<HTMLButtonElement>('.relations button[data-role="parent"]')!;
    expect(text(parent, ".rel-label")).toBe("来自：");
    expect(text(parent, ".rel-title")).toBe("修复结算页在窄屏下错位");
    move(env.titleOf(T.child), parent);
    parent.click();
    expect(env.openThread).toHaveBeenCalledWith(T.main);
    expect(cardShown()).toBe(false);
  });

  it("opens a child conversation from the children list or from the task it carries", async () => {
    move(null, env.titleOf(T.main));
    await wait(SHOW_DELAY_MS);
    move(env.titleOf(T.main), card());
    card()!.querySelector<HTMLButtonElement>('[data-section="children"] button.child')!.click();
    expect(env.openThread).toHaveBeenLastCalledWith(T.child);
    expect(cardShown()).toBe(false);

    move(card(), env.titleOf(T.main));
    await wait(SHOW_DELAY_MS);
    card()!.querySelector<HTMLButtonElement>(".task-child")!.click();
    expect(env.openThread).toHaveBeenLastCalledWith(T.child);
    expect(env.openThread).toHaveBeenCalledTimes(2);
    expect(cardShown()).toBe(false);
  });

  it("switches at once to another row while the card is open", async () => {
    move(null, env.titleOf(T.main));
    await wait(SHOW_DELAY_MS);
    move(env.titleOf(T.main), env.titleOf(T.child));
    // No new 400 ms wait: the card follows the pointer straight away…
    expect(cardShown()).toBe(true);
    expect(card()!.getAttribute("data-thread")).toBe(T.child);
    expect(card()!.style.top).toBe(`${ROW_TOP + ROW_HEIGHT}px`);
    // …and fills in as soon as the backend answers.
    await wait(0);
    expect(text(card(), ".title-text")).toBe("修复手机端菜单图标和标题重叠");
    expect(text(card(), '.ms[data-state="current"] .ms-title')).toBe("定位样式来源");
  });

  it("hides 150 ms after the pointer leaves the row, and stays while the pointer is on the card", async () => {
    move(null, env.titleOf(T.main));
    await wait(SHOW_DELAY_MS);
    move(env.titleOf(T.main), env.content);
    await wait(HIDE_DELAY_MS - 1);
    expect(cardShown()).toBe(true);
    await wait(1);
    expect(cardShown()).toBe(false);

    move(env.content, env.titleOf(T.main));
    await wait(SHOW_DELAY_MS);
    expect(cardShown()).toBe(true);
    // Over to the card, across the gap.
    move(env.titleOf(T.main), card());
    await wait(2000);
    expect(cardShown()).toBe(true);
    move(card(), env.content);
    await wait(HIDE_DELAY_MS);
    expect(cardShown()).toBe(false);
  });

  it("moves beside a preview the host shows for the row, and stays while the pointer crosses it", async () => {
    move(null, env.titleOf(T.main));
    await wait(SHOW_DELAY_MS);
    expect(card()!.style.left).toBe(`${SIDEBAR_WIDTH + 8}px`);
    // codexhost Web shows its own preview of the row at the sidebar's edge, a moment later.
    const preview = document.createElement("div");
    preview.style.position = "fixed";
    box(preview, { left: SIDEBAR_WIDTH - 4, top: ROW_TOP, width: 244, height: 196 });
    document.body.append(preview);
    await wait(0);
    expect(card()!.style.left).toBe(`${SIDEBAR_WIDTH - 4 + 244 + 8}px`);
    // On the way from the row to the card the pointer crosses the preview.
    move(env.titleOf(T.main), preview);
    await wait(HIDE_DELAY_MS * 2);
    expect(cardShown()).toBe(true);
    move(preview, card());
    await wait(HIDE_DELAY_MS * 2);
    expect(cardShown()).toBe(true);
    // The preview goes away while the pointer is on the card, and the card rebuilds: it does not jump.
    preview.remove();
    await wait(0);
    card()!.querySelector<HTMLButtonElement>(".compose-open")!.click();
    expect(card()!.style.left).toBe(`${SIDEBAR_WIDTH - 4 + 244 + 8}px`);
    card()!.querySelector<HTMLButtonElement>(".compose .btn:not(.spawn)")!.click();
    move(card(), env.content);
    await wait(HIDE_DELAY_MS);
    expect(cardShown()).toBe(false);
    // Another row with no preview beside it: back to the sidebar's edge.
    move(null, env.titleOf(T.child));
    await wait(SHOW_DELAY_MS);
    expect(card()!.style.left).toBe(`${SIDEBAR_WIDTH + 8}px`);
  });

  it("goes under Codex Desktop's popover preview, and stays put once the pointer is on the card", async () => {
    // Desktop opens its preview as a top-layer popover 0.24 s after the pointer arrives; it may live anywhere in the DOM.
    const preview = document.createElement("div");
    preview.setAttribute("popover", "auto");
    box(preview, { left: SIDEBAR_WIDTH - 18, top: ROW_TOP, width: 320, height: 57 });
    env.sidebar.append(preview);
    let open = false;
    const query = document.querySelectorAll.bind(document);
    // jsdom has no Popover API; stand in for :popover-open.
    const spy = vi
      .spyOn(document, "querySelectorAll")
      .mockImplementation(((selector: string) => (selector === ":popover-open" ? (open ? [preview] : []) : query(selector))) as typeof document.querySelectorAll);
    try {
      move(null, env.titleOf(T.main));
      await wait(240);
      open = true;
      preview.dispatchEvent(new Event("toggle"));
      await wait(SHOW_DELAY_MS - 240);
      expect(cardShown()).toBe(true);
      expect([card()!.style.left, card()!.style.top]).toEqual([`${SIDEBAR_WIDTH - 18}px`, `${ROW_TOP + 57 + 8}px`]);
      // Crossing the preview keeps the card; once on the card, the preview closing does not move it.
      move(env.titleOf(T.main), preview);
      await wait(HIDE_DELAY_MS * 2);
      move(preview, card());
      open = false;
      preview.dispatchEvent(new Event("toggle"));
      await wait(HIDE_DELAY_MS * 2);
      expect(cardShown()).toBe(true);
      expect(card()!.style.top).toBe(`${ROW_TOP + 57 + 8}px`);
    } finally {
      spy.mockRestore();
    }
  });

  it("opens a child conversation for a new problem after a confirming click, and stays while the user types", async () => {
    move(null, env.titleOf(T.main));
    await wait(SHOW_DELAY_MS);
    card()!.querySelector<HTMLButtonElement>(".compose-open")!.click();
    const field = () => card()!.querySelector<HTMLInputElement>("input.compose-input")!;
    expect(host()!.shadowRoot!.activeElement).toBe(field());
    field().value = "Web 端视频点不开";
    field().dispatchEvent(new Event("input"));
    // The pointer wanders off, over another row too: the card stays with its conversation while the user types.
    move(env.titleOf(T.main), env.titleOf(T.child));
    move(env.titleOf(T.child), env.content);
    await wait(HIDE_DELAY_MS * 3);
    expect(cardShown()).toBe(true);
    expect(card()!.getAttribute("data-thread")).toBe(T.main);
    // A new version arriving while typing does not take the field away.
    env.publish("v-next");
    await wait(10);
    expect(field().value).toBe("Web 端视频点不开");
    expect(host()!.shadowRoot!.activeElement).toBe(field());
    // Enter arms the button; the second click opens the child.
    field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const button = () => card()!.querySelector<HTMLButtonElement>('[data-spawn="new"]')!;
    expect(button().textContent).toBe("再点一次确认");
    expect(env.spawned).toEqual([]);
    button().click();
    await wait(10);
    expect(env.spawned).toEqual([{ threadId: T.main, text: "Web 端视频点不开" }]);
    expect(env.refresh).toHaveBeenCalled();
    expect(text(card(), ".compose-result")).toContain("已开子对话「Web 端视频点不开」");
    card()!.querySelector<HTMLButtonElement>(".compose-result .btn")!.click();
    expect(env.openThread).toHaveBeenCalledWith("kid-1");
  });

  it("sends photos, videos and files along: picked, pasted or dropped, and keeps the card meanwhile", async () => {
    move(null, env.titleOf(T.main));
    await wait(SHOW_DELAY_MS);
    card()!.querySelector<HTMLButtonElement>(".compose-open")!.click();
    const field = () => card()!.querySelector<HTMLInputElement>("input.compose-input")!;
    field().value = "录屏里视频点不开";
    field().dispatchEvent(new Event("input"));
    // 📎 opens the picker; the window loses the focus to it and the pointer wanders: the card stays.
    const picker = host()!.shadowRoot!.querySelector<HTMLInputElement>("input.picker")!;
    const opened = vi.fn();
    picker.addEventListener("click", opened);
    const attach = card()!.querySelector<HTMLButtonElement>("button.attach")!;
    expect(attach.title).toBe("添加照片、文件或视频；也可以粘贴截图，或把文件拖进卡片");
    attach.focus();
    attach.click();
    expect(opened).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("blur"));
    move(env.titleOf(T.main), env.content);
    await wait(HIDE_DELAY_MS * 3);
    expect(cardShown()).toBe(true);
    const video = new File([new Uint8Array(1500)], "录屏.mov", { type: "video/quicktime" });
    const notes = new File(["hello"], "notes.txt", { type: "text/plain" });
    Object.defineProperty(picker, "files", { configurable: true, value: [video, notes] });
    picker.dispatchEvent(new Event("change"));
    window.dispatchEvent(new Event("focus"));
    await wait(2000);
    expect(texts(card(), ".attachment-name")).toEqual(["录屏.mov", "notes.txt"]);
    expect(texts(card(), ".attachment-size")).toEqual(["1 KB", "5 B"]);
    expect(texts(card(), ".attachment-icon")).toEqual(["🎬", "📄"]);
    // With files attached, the card no longer goes when the window or the pointer leaves.
    window.dispatchEvent(new Event("blur"));
    move(env.content, env.titleOf(T.child));
    await wait(SHOW_DELAY_MS + HIDE_DELAY_MS);
    expect(card()!.getAttribute("data-thread")).toBe(T.main);
    // A screenshot pasted into the field gets a name of its own.
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const paste = withFiles("paste", [new File([png], "image.png", { type: "image/png" })], "clipboardData");
    field().dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(true);
    // Files dragged over the card can be dropped anywhere on it.
    const over = withFiles("dragover", [], "dataTransfer");
    card()!.querySelector(".head")!.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    expect(card()!.getAttribute("data-dragging")).toBe("松开即可添加附件");
    card()!.querySelector(".head")!.dispatchEvent(withFiles("drop", [new File(["a,b"], "data.csv", { type: "text/csv" })], "dataTransfer"));
    expect(card()!.hasAttribute("data-dragging")).toBe(false);
    expect(texts(card(), ".attachment-name")).toEqual(["录屏.mov", "notes.txt", "pasted-1.png", "data.csv"]);
    // Too large or too many: left out, with a word why.
    const huge = new File(["x"], "huge.mov", { type: "video/mp4" });
    Object.defineProperty(huge, "size", { value: 501 * 1024 * 1024 });
    Object.defineProperty(picker, "files", { configurable: true, value: [huge] });
    picker.dispatchEvent(new Event("change"));
    expect(text(card(), ".compose-notice")).toBe("「huge.mov」超过 500 MB，没有加上");
    const row = [...card()!.querySelectorAll(".attachment")].find((item) => item.textContent?.includes("notes.txt"))!;
    row.querySelector<HTMLButtonElement>(".attachment-remove")!.click();
    expect(texts(card(), ".attachment-name")).toEqual(["录屏.mov", "pasted-1.png", "data.csv"]);
    expect(card()!.querySelector(".compose-notice")).toBeNull();
    // The second click sends the files, then opens the child with them.
    field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    card()!.querySelector<HTMLButtonElement>('[data-spawn="new"]')!.click();
    await wait(10);
    expect(env.uploads).toEqual([
      { name: "录屏.mov", size: 1500, type: "video/quicktime" },
      { name: "pasted-1.png", size: 8, type: "image/png" },
      { name: "data.csv", size: 3, type: "text/csv" },
    ]);
    expect(env.chunks.find(({ id }) => id === "up-2")).toEqual({ id: "up-2", offset: 0, data: Buffer.from(png).toString("base64") });
    expect(env.spawned).toEqual([{ threadId: T.main, text: "录屏里视频点不开", attachments: ["up-1", "up-2", "up-3"] }]);
    expect(text(card(), ".compose-result")).toContain("已开子对话「录屏里视频点不开」");
    expect(card()!.querySelector(".attachment")).toBeNull();
    // Nothing is attached any more: the card goes with the pointer again.
    move(env.titleOf(T.child), env.content);
    await wait(HIDE_DELAY_MS * 2);
    expect(cardShown()).toBe(false);
  });

  it("sends the files again when the child did not open, since the backend keeps none of a failed try", async () => {
    const answer = env.invoke.getMockImplementation()!;
    let refuse = true;
    env.invoke.mockImplementation(async (method, params) => {
      if (method !== "spawn" || !refuse) return answer(method, params);
      refuse = false;
      throw new Error("[INTERNAL] /v1/delegate/start answered HTTP 500");
    });
    move(null, env.titleOf(T.main));
    await wait(SHOW_DELAY_MS);
    card()!.querySelector<HTMLButtonElement>(".compose-open")!.click();
    const field = () => card()!.querySelector<HTMLInputElement>("input.compose-input")!;
    field().value = "表格读不出来";
    field().dispatchEvent(new Event("input"));
    card()!.dispatchEvent(withFiles("drop", [new File(["a,b"], "data.csv", { type: "text/csv" })], "dataTransfer"));
    const open = async () => {
      field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      card()!.querySelector<HTMLButtonElement>('[data-spawn="new"]')!.click();
      await wait(10);
    };
    await open();
    expect(text(card(), ".compose-result")).toBe("没有开成：/v1/delegate/start answered HTTP 500");
    expect(texts(card(), ".attachment-name")).toEqual(["data.csv"]);
    await open();
    expect(env.uploads.map(({ name }) => name)).toEqual(["data.csv", "data.csv"]);
    expect(env.spawned).toEqual([{ threadId: T.main, text: "表格读不出来", attachments: ["up-2"] }]);
    expect(text(card(), ".compose-result")).toContain("已开子对话「表格读不出来」");
  });

  it("says calmly that a child is still opening when codexhost has not answered, and keeps what was typed and attached until it shows up", async () => {
    const answer = env.invoke.getMockImplementation()!;
    env.invoke.mockImplementation(async (method, params) => {
      if (method === "spawn") throw new Error("[PENDING] No answer from codexhost yet; the child may still open under this conversation");
      return answer(method, params);
    });
    move(null, env.titleOf(T.main));
    await wait(SHOW_DELAY_MS);
    card()!.querySelector<HTMLButtonElement>(".compose-open")!.click();
    const field = () => card()!.querySelector<HTMLInputElement>("input.compose-input")!;
    field().value = "表格  读不出来";
    field().dispatchEvent(new Event("input"));
    card()!.dispatchEvent(withFiles("drop", [new File(["a,b"], "data.csv", { type: "text/csv" })], "dataTransfer"));
    field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    card()!.querySelector<HTMLButtonElement>('[data-spawn="new"]')!.click();
    await wait(10);
    const notice = card()!.querySelector(".compose-result")!;
    expect(notice.textContent).toBe("正在打开子对话：codexhost 还没答复，开好后会出现在本对话下方，先不要再点");
    expect(notice.textContent).not.toContain("没有开成");
    expect(notice.getAttribute("role")).toBeNull();
    expect(host()!.shadowRoot!.querySelector(".root > [aria-live]")?.textContent).toBe(notice.textContent);
    expect(field().value).toBe("表格  读不出来");
    expect(texts(card(), ".attachment-name")).toEqual(["data.csv"]);
    // The child opens in the background: the next version links it, and the card says so and lets go of the text and files.
    const view = env.views[T.main]!;
    env.views[T.main] = { ...view, spinoffs: [...view.spinoffs, { id: "s9", text: "表格 读不出来", at: NOW, state: "spawned", childThreadId: "kid-9" }] };
    field().blur();
    env.publish("v-linked");
    await wait(10);
    expect(text(card(), ".compose-result")).toContain("已开子对话「表格  读不出来」");
    expect(card()!.querySelector("input.compose-input")).toBeNull();
    expect(texts(card(), ".attachment-name")).toEqual([]);
    card()!.querySelector<HTMLButtonElement>(".compose-result .btn")!.click();
    expect(env.openThread).toHaveBeenCalledWith("kid-9");
  });

  it("says that a button waits for its second click from a status line that rebuilding the card leaves in place", async () => {
    move(null, env.titleOf(T.main));
    await wait(SHOW_DELAY_MS);
    const live = host()!.shadowRoot!.querySelector(".root > [aria-live]")!;
    expect(live.getAttribute("role")).toBe("status");
    expect(card()!.querySelector("[aria-live]")).toBeNull();
    card()!.querySelector<HTMLButtonElement>(".compose-open")!.click();
    const field = () => card()!.querySelector<HTMLInputElement>("input.compose-input")!;
    field().value = "视频点不开";
    field().dispatchEvent(new Event("input"));
    field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(live.textContent).toBe("开子对话：3 秒内再点一次确认");
    // A new version rebuilds the card; the line stays the same node, and is not said again.
    field().blur();
    env.views[T.main] = { ...env.views[T.main]!, title: "修复结算页：已合并" };
    env.publish("v-again");
    await wait(10);
    expect(host()!.shadowRoot!.querySelector(".root > [aria-live]")).toBe(live);
    expect(live.textContent).toBe("开子对话：3 秒内再点一次确认");
    // The button calms down, and so does the line.
    await wait(4000);
    expect(live.textContent).toBe("");
  });

  it("drops the files and stops sending them when the card closes", async () => {
    move(null, env.titleOf(T.main));
    await wait(SHOW_DELAY_MS);
    card()!.querySelector<HTMLButtonElement>(".compose-open")!.click();
    const field = () => card()!.querySelector<HTMLInputElement>("input.compose-input")!;
    field().value = "看看这个录屏";
    field().dispatchEvent(new Event("input"));
    card()!.dispatchEvent(withFiles("drop", [new File([new Uint8Array(3 * 512 * 1024)], "big.mov", { type: "video/mp4" })], "dataTransfer"));
    let release: () => void = () => undefined;
    env.invoke.mockImplementationOnce(async () => ({ id: "up-x", chunkBytes: 512 * 1024 }));
    env.invoke.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve({ received: 1, done: false }))));
    field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    card()!.querySelector<HTMLButtonElement>('[data-spawn="new"]')!.click();
    await wait(10);
    // Three pieces go at once; the first is held back, the other two arrived.
    expect(text(card(), '[data-spawn="new"]')).toBe("正在上传附件 66%");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(cardShown()).toBe(false);
    release();
    await wait(10);
    expect(env.spawned).toEqual([]);
  });

  it("opens a child for a spin-off already noted, and the armed button calms down after a while", async () => {
    move(null, env.titleOf(T.main));
    await wait(SHOW_DELAY_MS);
    const spinoff = () => card()!.querySelector<HTMLButtonElement>('[data-spawn="s2"]')!;
    expect(text(card(), '.spinoff[data-spinoff="s2"] .spinoff-text')).toBe("商品页的视频点开没反应");
    spinoff().click();
    expect(spinoff().textContent).toBe("再点一次确认");
    await wait(3100);
    expect(spinoff().textContent).toBe("开子对话");
    spinoff().click();
    spinoff().click();
    await wait(10);
    expect(env.spawned).toEqual([{ threadId: T.main, spinoffId: "s2" }]);
  });

  it("asks the model to summarize the conversation again, and says so until the new summary arrives", async () => {
    move(null, env.titleOf(T.main));
    await wait(SHOW_DELAY_MS);
    const button = () => card()!.querySelector<HTMLButtonElement>(".resummarize")!;
    expect(button().textContent).toBe("↻ 重新凝练");
    button().click();
    await wait(10);
    expect(env.invoke).toHaveBeenCalledWith("summarize", { threadId: T.main });
    expect(button().textContent).toBe("凝练中…");
    expect(button().disabled).toBe(true);
    // The new summary comes with the next version.
    env.views[T.main] = { ...env.views[T.main]!, summary: { at: Date.now() + 1000, model: "claude-haiku" } };
    env.publish("v-summary");
    await wait(10);
    expect(button().textContent).toBe("↻ 重新凝练");
    expect(text(card(), ".meta .summarized")).toBe("模型凝练 · 刚刚");
  });

  it("says why a summary was refused when no model is set for the conversation's agent", async () => {
    const answer = env.invoke.getMockImplementation()!;
    env.invoke.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "summarize") throw new Error('[NO_SUMMARIZER] This conversation runs on the agent "pi", not Claude Code or Codex');
      return answer(method, params);
    });
    move(null, env.titleOf(T.main));
    await wait(SHOW_DELAY_MS);
    const button = () => card()!.querySelector<HTMLButtonElement>(".resummarize")!;
    button().click();
    await wait(10);
    expect(button().textContent).toBe("↻ 重新凝练");
    expect(button().disabled).toBe(false);
    const note = card()!.querySelector('.summary-refused[role="alert"]');
    expect(note?.textContent).toContain("Claude Code 和 Codex 以外的 Agent 的对话不发给模型");
    expect(note?.textContent).toContain("总览页「设置」");
    // Another cause the backend names is said in the card's language too.
    env.invoke.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "summarize") throw new Error("[STATE_FULL] The mainline state is full; delete mainlines you no longer need in the overview");
      return answer(method, params);
    });
    button().click();
    await wait(10);
    expect(card()!.querySelector('.summary-refused[role="alert"]')?.textContent).toBe("主线数据已满，请在总览页删除不用的主线");
    // A failure without a known code only puts the button back, as before.
    env.invoke.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "summarize") throw new Error("[INTERNAL] backend exploded");
      return answer(method, params);
    });
    button().click();
    await wait(10);
    expect(card()!.querySelector(".summary-refused")).toBeNull();
    expect(button().textContent).toBe("↻ 重新凝练");
    // Closing the card forgets the note.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(cardShown()).toBe(false);
  });

  it("opens the rest of a long list of PRs and child conversations on request", async () => {
    const base = env.views[T.main]!;
    const ref = base.refs[0]!;
    const { activity: _news, ...quiet } = ref;
    const refs = [1044, 1046, 1051, 1081, 1090].map((number) => ({ ...quiet, key: `acme/widgets#${number}`, number }));
    const child = base.children[0]!;
    const children = Array.from({ length: 8 }, (_, i) => ({ ...child, threadId: `kid-${i}`, title: `子对话 ${i + 1}` }));
    env.views[T.main] = { ...base, refs, children };
    move(null, env.titleOf(T.main));
    await wait(SHOW_DELAY_MS);
    const section = (role: string) => card()!.querySelector(`[data-section="${role}"]`)!;
    expect(section("refs").querySelectorAll(".ref")).toHaveLength(3);
    const moreRefs = section("refs").querySelector<HTMLButtonElement>("button.more")!;
    expect(moreRefs.textContent).toBe("还有 2 个");
    moreRefs.click();
    expect(section("refs").querySelectorAll(".ref")).toHaveLength(5);
    expect(section("refs").querySelector("button.more")).toBeNull();
    expect(section("children").querySelectorAll(".child")).toHaveLength(6);
    section("children").querySelector<HTMLButtonElement>("button.more")!.click();
    expect(section("children").querySelectorAll(".child")).toHaveLength(8);
  });

  it("puts GitHub news first and lets the user mark it seen", async () => {
    move(null, env.titleOf(T.main));
    await wait(SHOW_DELAY_MS);
    const first = card()!.querySelector(".section");
    expect(first?.getAttribute("data-section")).toBe("news");
    expect(first!.textContent).toContain("#42");
    expect(first!.textContent).toContain("有新评论");
    first!.querySelector<HTMLButtonElement>(".news-meta .btn")!.click();
    await wait(10);
    expect(env.invoke).toHaveBeenCalledWith("refs.seen", { key: "acme/widgets#42" });
    expect(env.refresh).toHaveBeenCalled();
  });

  it("rings a bell on the row of a conversation with unseen GitHub news, until it is seen", async () => {
    const marker = () => host()?.shadowRoot?.querySelector<HTMLElement>(`.news-marker[data-thread="${T.main}"]`) ?? null;
    // The row's own icon, indented, with an empty strip before it (rows inside a project).
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    box(icon, { left: 40, top: ROW_TOP + 8, width: 16, height: 16 });
    env.rows[T.main]!.prepend(icon);
    env.publish("v-news", { alerts: [ref42] });
    await wait(0);
    expect(marker()?.hidden).toBe(false);
    expect(marker()!.textContent).toBe("🔔");
    // Centered in the strip left of the icon, level with the row: clear of the icon, the title and the buttons.
    expect([marker()!.style.left, marker()!.style.top]).toEqual([`${(0 + 40 - 4) / 2}px`, `${ROW_TOP + ROW_HEIGHT / 2}px`]);
    // With no room before the icon, it goes on the icon's corner.
    box(icon, { left: 4, top: ROW_TOP + 8, width: 16, height: 16 });
    env.publish("v-news-2", { alerts: [ref42] });
    await wait(0);
    expect([marker()!.style.left, marker()!.style.top]).toEqual([`${4 + 16 - 3}px`, `${ROW_TOP + 8 + 2}px`]);
    // The hovered row shows its card (news first) instead of the bell.
    move(null, env.titleOf(T.main));
    await wait(SHOW_DELAY_MS);
    expect(marker()!.hidden).toBe(true);
    move(env.titleOf(T.main), env.content);
    await wait(HIDE_DELAY_MS);
    expect(marker()!.hidden).toBe(false);
    env.publish("v-seen", { alerts: [] });
    await wait(0);
    expect(marker()).toBeNull();
  });

  it("hides when the pointer moves onto sidebar space that is no conversation", async () => {
    move(null, env.titleOf(T.main));
    await wait(SHOW_DELAY_MS);
    move(env.titleOf(T.main), env.section);
    await wait(HIDE_DELAY_MS);
    expect(cardShown()).toBe(false);
  });

  it("hides on Escape, on a click in the sidebar and when the page goes to the background", async () => {
    move(null, env.titleOf(T.main));
    await wait(SHOW_DELAY_MS);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(cardShown()).toBe(false);
    // Still on the same row: the card stays away until the pointer moves to another one.
    move(env.titleOf(T.main), env.rows[T.main]!.querySelector(".pin"));
    await wait(1000);
    expect(cardShown()).toBe(false);

    move(env.rows[T.main]!.querySelector(".pin"), env.titleOf(T.child));
    await wait(SHOW_DELAY_MS);
    expect(card()!.getAttribute("data-thread")).toBe(T.child);
    pointer(env.titleOf(T.child), "pointerdown", null);
    expect(cardShown()).toBe(false);

    move(env.titleOf(T.child), env.titleOf(T.old));
    await wait(SHOW_DELAY_MS);
    expect(cardShown()).toBe(true);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(cardShown()).toBe(false);
  });

  it("ignores touch, which has no hover", async () => {
    move(null, env.titleOf(T.main), "touch");
    await wait(1000);
    expect(cardShown()).toBe(false);
    expect(env.invoke).not.toHaveBeenCalled();
  });

  it("shows one short line when the backend fails, without throwing", async () => {
    env.failing.add(T.main);
    move(null, env.titleOf(T.main));
    await wait(SHOW_DELAY_MS);
    expect(texts(card(), ".note.error")).toEqual(["读取失败：backend exploded"]);
    // A conversation the backend does not know.
    move(env.titleOf(T.main), env.titleOf(T.other));
    await wait(0);
    expect(texts(card(), ".note.error")).toEqual(["读取失败：找不到这个对话"]);
    // Tried again on the next visit.
    env.failing.delete(T.main);
    move(env.titleOf(T.other), env.titleOf(T.main));
    await wait(0);
    expect(text(card(), ".title-text")).toBe("修复结算页在窄屏下错位");
  });

  it("caches each conversation until the snapshot version changes, then fetches the open card again", async () => {
    env.publish("v1");
    move(null, env.titleOf(T.main));
    await wait(SHOW_DELAY_MS);
    move(env.titleOf(T.main), env.titleOf(T.child));
    await wait(0);
    move(env.titleOf(T.child), env.titleOf(T.main));
    await wait(0);
    expect(env.calls(T.main)).toBe(1);
    expect(env.calls(T.child)).toBe(1);

    // The same version again changes nothing.
    env.publish("v1");
    await wait(0);
    expect(env.calls(T.main)).toBe(1);

    env.views[T.main] = { ...env.views[T.main]!, title: "修复结算页：已合并，待验证" };
    env.publish("v2");
    await wait(0);
    expect(env.calls(T.main)).toBe(2);
    expect(text(card(), ".title-text")).toBe("修复结算页：已合并，待验证");

    // The child's view is from v1: visiting it fetches it again.
    move(env.titleOf(T.main), env.titleOf(T.child));
    await wait(0);
    expect(env.calls(T.child)).toBe(2);
  });

  it("keeps the card's nodes when a new version brings the same view, so clicks are not lost", async () => {
    env.publish("v1");
    move(null, env.titleOf(T.main));
    await wait(SHOW_DELAY_MS);
    const child = card()!.querySelector('[data-section="children"] button.child');
    env.publish("v2");
    await wait(0);
    expect(env.calls(T.main)).toBe(2);
    expect(card()!.querySelector('[data-section="children"] button.child')).toBe(child);
  });

  it("folds long runs of reached milestones and done tasks, and unfolds them on request", async () => {
    const view = env.views[T.main]!;
    const reached: MilestoneView[] = Array.from({ length: 6 }, (_, index) => ({
      id: `d${index}`,
      title: `阶段 ${index + 1}`,
      state: "done",
      doneAt: NOW - (10 - index) * 3_600_000,
      tasks: [],
    }));
    const current = view.milestones.find((milestone) => milestone.state === "current")!;
    current.tasks = [
      ...Array.from({ length: 5 }, (_, index) => ({ id: `x${index}`, text: `做完的事 ${index + 1}`, done: true, at: NOW - 600_000 })),
      ...current.tasks,
    ];
    env.views[T.main] = { ...view, milestones: [...reached, current], progress: { done: 6, total: 7 } };
    move(null, env.titleOf(T.main));
    await wait(SHOW_DELAY_MS);
    expect(text(card(), 'button.more[data-expand="milestones"]')).toBe("还有 3 个更早的里程碑");
    expect(texts(card(), ".ms-title")).toEqual(["阶段 4", "阶段 5", "阶段 6", "维护者审查"]);
    expect(text(card(), 'button.more[data-expand="tasks"]')).toBe("还有 2 项已完成");
    expect(texts(card(), '.task[data-kind="done"] .task-text')).toEqual(["做完的事 3", "做完的事 4", "做完的事 5"]);

    card()!.querySelector<HTMLButtonElement>('button.more[data-expand="milestones"]')!.click();
    expect(card()!.querySelectorAll(".ms")).toHaveLength(7);
    card()!.querySelector<HTMLButtonElement>('button.more[data-expand="tasks"]')!.click();
    expect(card()!.querySelectorAll('.task[data-kind="done"]')).toHaveLength(5);
    expect(cardShown()).toBe(true);
  });

  it("keeps the card by its row when the host redraws the row while the pointer rests", async () => {
    move(null, env.titleOf(T.main));
    await wait(SHOW_DELAY_MS / 2);
    const redrawn = env.rows[T.main]!.cloneNode(true) as HTMLElement;
    env.rows[T.main]!.replaceWith(redrawn);
    await wait(SHOW_DELAY_MS / 2);
    expect(cardShown()).toBe(true);
    expect(card()!.style.left).toBe(`${SIDEBAR_WIDTH + 8}px`);
    expect(card()!.style.top).toBe(`${ROW_TOP}px`);
  });

  it("follows a sidebar the host draws anew", async () => {
    const fresh = makeSidebar(IDS);
    env.sidebar.replaceWith(fresh.sidebar);
    move(null, fresh.rows[T.main]!.querySelector(".title"));
    await wait(SHOW_DELAY_MS);
    expect(cardShown()).toBe(false);
    await wait(REBIND_MS);
    move(env.content, fresh.rows[T.main]!.querySelector(".title"));
    await wait(SHOW_DELAY_MS);
    expect(cardShown()).toBe(true);
    expect(card()!.getAttribute("data-thread")).toBe(T.main);
  });

  it("speaks English on an English page", async () => {
    document.documentElement.lang = "en";
    move(null, env.titleOf(T.old));
    await wait(SHOW_DELAY_MS);
    expect(text(card(), ".chip.draft")).toBe("Not summarized");
    expect(text(card(), '[data-role="origin"] .label')).toBe("Started with:");
    move(env.titleOf(T.old), env.titleOf(T.main));
    await wait(0);
    expect(text(card(), ".meta .state")).toBe("Active");
    expect(text(card(), '.task[data-kind="now"] .now-label')).toBe("Doing");
    expect(text(card(), '[data-section="children"] .section-title')).toBe("Child conversations (1)");
  });

  it("leaves nothing behind when stopped", async () => {
    move(null, env.titleOf(T.main));
    await wait(SHOW_DELAY_MS);
    env.stop();
    expect(host()).toBeNull();
    expect(env.listeners.size).toBe(0);
    move(env.titleOf(T.main), env.titleOf(T.child));
    await wait(SHOW_DELAY_MS);
    expect(host()).toBeNull();
    expect(env.calls(T.child)).toBe(0);
  });
});

describe("milestone badge on the row", () => {
  it("shows ◆ reached/total just left of the row's pin and archive buttons while the row is hovered", async () => {
    move(null, env.titleOf(T.main));
    await wait(PREFETCH_DELAY_MS);
    const mark = badge()!;
    expect(mark.hidden).toBe(false);
    expect(mark.textContent).toBe("◆2/4");
    expect(text(mark, ".count")).toBe("2/4");
    expect(mark.style.left).toBe(`${PIN_LEFT - 6}px`);
    expect(mark.style.top).toBe(`${ROW_TOP + ROW_HEIGHT / 2}px`);
    // The host's row itself is untouched.
    expect(env.rows[T.main]!.children).toHaveLength(3);

    move(env.titleOf(T.main), env.content);
    expect(mark.hidden).toBe(true);
  });

  it("shows only for conversations with milestones", async () => {
    move(null, env.titleOf(T.old));
    await wait(SHOW_DELAY_MS);
    expect(cardShown()).toBe(true);
    expect(badge()!.hidden).toBe(true);
    move(env.titleOf(T.old), env.titleOf(T.child));
    await wait(0);
    expect(badge()!.hidden).toBe(false);
    expect(text(badge(), ".count")).toBe("0/1");
    expect(badge()!.style.top).toBe(`${ROW_TOP + ROW_HEIGHT + ROW_HEIGHT / 2}px`);
  });
});

describe("hover layout", () => {
  const rect = (left: number, top: number, width: number, height: number): Box => ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  });
  const size = { width: 320, height: 200 };

  it("puts the card right of the sidebar, level with the row, and moves it up near the bottom", () => {
    const sidebar = rect(0, 0, 260, 800);
    expect(cardSpot(rect(0, 100, 260, 32), sidebar, size, { width: 1200, height: 800 })).toEqual({ left: 268, top: 100 });
    expect(cardSpot(rect(0, 700, 260, 32), sidebar, size, { width: 1200, height: 800 })).toEqual({ left: 268, top: 592 });
    // A sidebar on the right gets the card on its left; a window too narrow for either keeps it inside.
    expect(cardSpot(rect(900, 100, 300, 32), rect(900, 0, 300, 800), size, { width: 1200, height: 800 })).toEqual({ left: 572, top: 100 });
    expect(cardSpot(rect(0, 100, 260, 32), sidebar, size, { width: 500, height: 800 })).toEqual({ left: 172, top: 100 });
  });

  it("stacks the card under a short host preview, over it near the bottom, and beside a tall one", () => {
    const sidebar = rect(0, 0, 260, 800);
    const viewport = { width: 1200, height: 800 };
    // Codex Desktop: a 57px preview starting a little inside the sidebar's edge.
    expect(cardSpot(rect(0, 100, 260, 32), sidebar, size, viewport, rect(242, 100, 320, 57))).toEqual({ left: 242, top: 165 });
    expect(cardSpot(rect(0, 700, 260, 32), sidebar, size, viewport, rect(242, 700, 320, 57))).toEqual({ left: 242, top: 492 });
    // codexhost Web: a 196px preview; the card goes to its right.
    expect(cardSpot(rect(0, 100, 260, 32), sidebar, size, viewport, rect(256, 100, 244, 196))).toEqual({ left: 508, top: 100 });
  });

  it("finds the row's own controls, or falls back to the row's right end", () => {
    const row = document.createElement("div");
    box(row, { left: 0, top: 100, width: 260, height: 32 });
    const label = document.createElement("span");
    label.textContent = "A long conversation title";
    box(label, { left: 12, top: 107, width: 200, height: 18 });
    row.append(label);
    document.body.append(row);
    expect(badgeSpot(row, null)).toEqual({ x: 250, y: 116 });

    const time = document.createElement("span");
    time.textContent = "3h";
    box(time, { left: 230, top: 107, width: 20, height: 18 });
    row.append(time);
    expect(badgeSpot(row, null)).toEqual({ x: 224, y: 116 });

    // The end of a long title, which Codex Desktop draws as its own piece, is not a control.
    const suffix = document.createElement("span");
    suffix.textContent = "左侧虽然同步了工作区但是内部的对话";
    box(suffix, { left: 140, top: 107, width: 85, height: 18 });
    row.append(suffix);
    expect(badgeSpot(row, null)).toEqual({ x: 224, y: 116 });

    // Scrolled out of the sidebar: no badge.
    const sidebar = document.createElement("nav");
    box(sidebar, { left: 0, top: 200, width: 260, height: 400 });
    expect(badgeSpot(row, sidebar)).toBeNull();
  });
});
