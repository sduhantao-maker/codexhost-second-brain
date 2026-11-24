// @vitest-environment jsdom
/**
 * The overview, the capsule, the hover card and the ★ button without a mouse: what keys do, where
 * the focus goes, what screen readers hear, and text that stays readable in both schemes.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMutationV2 } from "../src/backend/mutate-v2.js";
import { DEFAULT_SETTINGS } from "../src/core/model.js";
import type { MutateV2Params, SnapshotResultV2 } from "../src/core/rpc.js";
import type { PageApi } from "../src/host/types.js";
import { mount } from "../src/page/index.js";
import { Capsule } from "../src/ui/capsule.js";
import type { ControllerHandle, LiveData, SurfaceAdapter } from "../src/ui/controller.js";
import { builder } from "../src/ui/dom.js";
import { HOST_ATTRIBUTE, SETTLE_MS, startFavorites } from "../src/ui/favorites/index.js";
import { cardNodes, COMPOSE_IDLE, type CardActions } from "../src/ui/hover/card.js";
import { HOVER_CSS } from "../src/ui/hover/styles.js";
import { hoverStrings } from "../src/ui/hover/strings.js";
import { NOW, sampleSearchResults, sampleSnapshot, sampleView, T } from "./fixtures/v2.js";

const disposers: Array<() => void> = [];
beforeEach(() => {
  document.body.replaceChildren();
  document.documentElement.lang = "zh-CN";
  localStorage.clear();
});
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.useRealTimers();
});

/** A key as a browser handles it: keydown on the element; Enter or Space on a button then clicks it. */
function press(element: Element, key: string): void {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  element.dispatchEvent(event);
  if (!event.defaultPrevented && element.tagName === "BUTTON" && (key === "Enter" || key === " ")) (element as HTMLButtonElement).click();
}

async function flush(): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    else await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function buttonIn(scope: ParentNode, name: string): HTMLButtonElement {
  const button = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === name || item.getAttribute("aria-label") === name);
  if (!button) throw new Error(`No button "${name}"`);
  return button;
}

// ---------------------------------------------------------------------------------------------
// The overview

/**
 * The overview against a stand-in backend that applies edits to its state, so what an action
 * does shows on the page. `extra` adds conversations.
 */
async function overview(options: { extra?: (snapshot: SnapshotResultV2) => void } = {}) {
  const snapshot = sampleSnapshot();
  options.extra?.(snapshot);
  let version = 0;
  const mutations: MutateV2Params[] = [];
  const invoke = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
    switch (method) {
      case "snapshot":
        return { ...snapshot, version: `v${version}` };
      case "conversation":
        return sampleView((params as { threadId: string }).threadId);
      case "search":
        return sampleSearchResults();
      case "refs.list":
        return { status: { conversations: { scanned: 1, listed: 1, done: true, unreadable: 0 }, refs: 0, github: { enabled: true } }, refs: [] };
      case "integration.status":
        return [];
      case "mutate":
        mutations.push(params as MutateV2Params);
        applyMutationV2(snapshot.state!, params as MutateV2Params, { now: Date.now() });
        version += 1;
        return { ok: true };
      default:
        return { ok: true };
    }
  });
  const set = vi.fn(async (values: Record<string, unknown>) => values);
  const api: PageApi = {
    id: "second-brain",
    apiVersion: 1,
    hostTarget: "desktop",
    locale: "zh-CN",
    onLocaleChange: () => () => undefined,
    colorScheme: "light",
    onColorSchemeChange: () => () => undefined,
    signal: new AbortController().signal,
    storage: { get: async () => ({}), set, onChange: () => () => undefined },
    backend: { invoke },
  };
  const root = document.createElement("div");
  document.body.append(root);
  disposers.push(await mount(root, api));
  await flush();
  return { root, invoke, mutations, set };
}

const node = (root: ParentNode, threadId: string) => root.querySelector<HTMLElement>(`.mlp-node[data-thread-id="${threadId}"]`);
const toggleOf = (root: ParentNode, threadId: string) => node(root, threadId)!.querySelector<HTMLButtonElement>(":scope > .mlp-row > .mlp-row-toggle")!;
const detailOf = (root: ParentNode, threadId: string) => node(root, threadId)?.querySelector<HTMLElement>(":scope > .mlp-detail") ?? null;
const milestoneOf = (root: ParentNode, id: string) => root.querySelector<HTMLElement>(`[data-milestone-id="${id}"]`)!;
const taskOf = (root: ParentNode, id: string) => root.querySelector<HTMLElement>(`[data-task-id="${id}"]`);

async function expand(root: HTMLElement, threadId: string): Promise<HTMLElement> {
  toggleOf(root, threadId).click();
  await flush();
  return detailOf(root, threadId)!;
}

/** One more active conversation, alone in its tree and older than the sample's. */
function withOther(snapshot: SnapshotResultV2): void {
  snapshot.state!.conversations[T.other] = {
    threadId: T.other,
    title: "整理发布流程",
    tags: [],
    status: "active",
    milestones: [],
    spinoffs: [],
    createdAt: NOW - 5000 * 60_000,
    updatedAt: NOW - 4000 * 60_000,
  };
}

describe("overview lines", () => {
  it("open from their title, a button of its own beside Go, and keep the focus", async () => {
    const { root } = await overview();
    // No button inside another one, nor inside anything acting as one.
    expect(root.querySelectorAll("button button, [role='button'] button")).toHaveLength(0);
    const toggle = toggleOf(root, T.main);
    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle.tabIndex).toBe(0);
    // Its name is the title, not the whole line.
    expect(toggle.textContent).toBe("修复结算页在窄屏下错位");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const go = buttonIn(node(root, T.main)!.querySelector(":scope > .mlp-row")!, "跳转");
    expect(toggle.contains(go)).toBe(false);

    toggle.focus();
    press(toggle, "Enter");
    await flush();
    expect(detailOf(root, T.main)).not.toBeNull();
    expect(document.activeElement).toBe(toggleOf(root, T.main));
    expect(toggleOf(root, T.main).getAttribute("aria-expanded")).toBe("true");
    expect(toggleOf(root, T.main).getAttribute("aria-controls")).toBe(detailOf(root, T.main)!.id);
    press(toggleOf(root, T.main), " ");
    await flush();
    expect(detailOf(root, T.main)).toBeNull();
    expect(document.activeElement).toBe(toggleOf(root, T.main));
    // A conversation without a mainline says so inside its button.
    root.querySelector<HTMLButtonElement>('[data-status-tab="others"]')!.click();
    await flush();
    expect(toggleOf(root, T.old).textContent).toBe("登录页样式检查未凝练");
  });
});

describe("overview tabs", () => {
  it("are one tab stop; the arrows, Home and End move between them, and each names the panel it shows", async () => {
    const { root } = await overview();
    const tabs = () => [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const tab = (key: string) => root.querySelector<HTMLButtonElement>(`[role="tab"][data-tab="${key}"]`)!;
    const selected = () => tabs().find((item) => item.getAttribute("aria-selected") === "true")?.dataset.tab;
    const panel = () => root.querySelector<HTMLElement>('[role="tabpanel"]')!;
    expect(root.querySelector('[role="tablist"]')!.getAttribute("aria-label")).toBe("第二大脑");
    expect(tabs().map((item) => item.tabIndex)).toEqual([0, -1, -1, -1]);
    for (const item of tabs()) expect(item.getAttribute("aria-controls")).toBe(panel().id);
    expect(panel().getAttribute("aria-labelledby")).toBe(tab("conversations").id);

    tab("conversations").focus();
    press(tab("conversations"), "ArrowRight");
    await flush();
    expect(selected()).toBe("favorites");
    expect(document.activeElement).toBe(tab("favorites"));
    expect(tabs().map((item) => item.tabIndex)).toEqual([-1, 0, -1, -1]);
    press(tab("favorites"), "End");
    await flush();
    expect(selected()).toBe("settings");
    expect(document.activeElement).toBe(tab("settings"));
    expect(panel().getAttribute("aria-labelledby")).toBe(tab("settings").id);
    press(tab("settings"), "ArrowRight");
    await flush();
    expect(selected()).toBe("conversations");
    press(tab("conversations"), "ArrowLeft");
    await flush();
    expect(selected()).toBe("settings");
    press(tab("settings"), "Home");
    await flush();
    expect(selected()).toBe("conversations");
    expect(document.activeElement).toBe(tab("conversations"));
    // Other keys do nothing.
    press(tab("conversations"), "a");
    await flush();
    expect(selected()).toBe("conversations");
  });

  it("name the grouping, group the policy choices, and keep each setting on a row of its own", async () => {
    const { root, set } = await overview();
    expect(root.querySelector(".mlp-grouping")!.getAttribute("aria-label")).toBe("分组方式");
    root.querySelector<HTMLButtonElement>('[role="tab"][data-tab="settings"]')!.click();
    await flush();
    const group = root.querySelector("fieldset.mlp-fieldset")!;
    expect(group.querySelector("legend")?.textContent).toBe("同一对话里出现新问题时");
    expect(group.querySelectorAll('input[type="radio"]')).toHaveLength(3);
    for (const checkbox of root.querySelectorAll('.mlp-settings input[type="checkbox"]')) expect(checkbox.closest(".mlp-field")).not.toBeNull();
    // Choosing keeps the focus on the choice, though the page is drawn again.
    const note = root.querySelector<HTMLInputElement>('input[type="radio"][value="note"]')!;
    note.focus();
    note.checked = true;
    note.dispatchEvent(new Event("change"));
    await flush();
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ driftPolicy: "note" }));
    expect(document.activeElement).toBe(root.querySelector('input[type="radio"][value="note"]'));
  });
});

describe("overview focus after edits and actions", () => {
  it("goes back to the button that opened an editor", async () => {
    const { root, mutations } = await overview();
    await expand(root, T.main);
    const detail = () => detailOf(root, T.main)!;
    buttonIn(detail(), "修改标题").focus();
    buttonIn(detail(), "修改标题").click();
    await flush();
    const editor = () => detail().querySelector<HTMLInputElement>(".mlp-detail-title .mlp-editor")!;
    expect(document.activeElement).toBe(editor());
    press(editor(), "Escape");
    await flush();
    expect(document.activeElement).toBe(buttonIn(detail(), "修改标题"));

    buttonIn(detail(), "修改标题").click();
    await flush();
    editor().value = "修复结算页断点";
    press(editor(), "Enter");
    await vi.waitFor(() => expect(mutations).toContainEqual({ op: "title", threadId: T.main, title: "修复结算页断点" }));
    await flush();
    expect(document.activeElement).toBe(buttonIn(detail(), "修改标题"));

    buttonIn(milestoneOf(detail(), "m4"), "重命名").click();
    await flush();
    const rename = milestoneOf(detail(), "m4").querySelector<HTMLInputElement>(".mlp-editor")!;
    rename.value = "合并后在 Web 端验证";
    press(rename, "Enter");
    await vi.waitFor(() => expect(mutations).toContainEqual(expect.objectContaining({ op: "milestoneRename", milestoneId: "m4" })));
    await flush();
    expect(document.activeElement).toBe(buttonIn(milestoneOf(detail(), "m4"), "重命名"));
  });

  it("moves on to the next control once what it acted on is gone", async () => {
    const { root, mutations } = await overview({ extra: withOther });
    await expand(root, T.main);
    const detail = () => detailOf(root, T.main)!;
    // A task deleted (with its second click): the next task's delete button.
    buttonIn(taskOf(detail(), "t1")!, "删除").click();
    buttonIn(taskOf(detail(), "t1")!, "再点一次确认").click();
    await vi.waitFor(() => expect(mutations).toContainEqual({ op: "taskRemove", threadId: T.main, taskId: "t1" }));
    await flush();
    expect(taskOf(detail(), "t1")).toBeNull();
    expect(document.activeElement).toBe(buttonIn(taskOf(detail(), "t2")!, "删除"));
    // A milestone reached: the next one, now current, has the button.
    buttonIn(milestoneOf(detail(), "m3"), "标记达成").click();
    await vi.waitFor(() => expect(mutations).toContainEqual({ op: "milestoneReach", threadId: T.main, milestoneId: "m3" }));
    await flush();
    expect(document.activeElement).toBe(buttonIn(milestoneOf(detail(), "m4"), "标记达成"));

    // A conversation paused leaves the list: the line before it.
    await expand(root, T.other);
    buttonIn(detailOf(root, T.other)!, "暂停").click();
    await vi.waitFor(() => expect(mutations).toContainEqual({ op: "status", threadId: T.other, status: "paused" }));
    await flush();
    expect(node(root, T.other)).toBeNull();
    expect(document.activeElement).toBe(toggleOf(root, T.main));
  });

  it("stays in the search box when an action ends while the user types there", async () => {
    const { root, mutations } = await overview();
    await expand(root, T.main);
    buttonIn(taskOf(detailOf(root, T.main)!, "t1")!, "删除").click();
    buttonIn(taskOf(detailOf(root, T.main)!, "t1")!, "再点一次确认").click();
    const find = root.querySelector<HTMLInputElement>(".mlp-find-input")!;
    find.focus();
    await vi.waitFor(() => expect(mutations).toContainEqual({ op: "taskRemove", threadId: T.main, taskId: "t1" }));
    await flush();
    expect(taskOf(detailOf(root, T.main)!, "t1")).toBeNull();
    expect(document.activeElement).toBe(find);
  });

  it("goes to the line beside a deleted mainline, else to the status tab", async () => {
    const { root, mutations } = await overview({ extra: withOther });
    await expand(root, T.other);
    buttonIn(detailOf(root, T.other)!, "删除主线").click();
    buttonIn(detailOf(root, T.other)!, "再点一次确认").click();
    await vi.waitFor(() => expect(mutations).toContainEqual({ op: "delete", threadId: T.other }));
    await flush();
    expect(document.activeElement).toBe(toggleOf(root, T.main));
  });
});

describe("two-click buttons", () => {
  it("tell screen readers on the overview that they wait for the second click", async () => {
    vi.useFakeTimers();
    const { root } = await overview();
    await expand(root, T.main);
    const live = root.querySelector('.mlp-sr-only[role="status"]')!;
    buttonIn(detailOf(root, T.main)!, "删除主线").click();
    expect(live.textContent).toBe("删除主线：3 秒内再点一次确认");
    await vi.advanceTimersByTimeAsync(3100);
    expect(live.textContent).toBe("");
    expect(buttonIn(detailOf(root, T.main)!, "删除主线")).toBeTruthy();
  });

  it("tell screen readers in the capsule, and in the hover card", () => {
    const opened: string[] = [];
    const capsule = new Capsule({ doc: document, locale: "zh-CN", surface: "web", mutate: async () => undefined, spawn: async () => undefined, openThread: (id) => opened.push(id), anchor: () => null });
    document.body.append(capsule.host);
    disposers.push(() => capsule.destroy());
    capsule.update({ threadId: T.main, view: sampleView(T.main), settings: DEFAULT_SETTINGS, offline: false, now: NOW });
    const root = capsule.host.shadowRoot!;
    openCapsule(root);
    const live = root.querySelector('.sr-only[role="status"]')!;
    const spawn = root.querySelector<HTMLButtonElement>(".spinoff .btn.primary")!;
    spawn.click();
    expect(live.textContent).toBe("开子对话：3 秒内再点一次确认");
    spawn.click();
    expect(live.textContent).toBe("");

    // The hover card is rebuilt on every change: its status line lives beside the card, not in it,
    // so a rebuild cannot cut the sentence short (hover.test.ts follows it through a rebuild).
    const h = builder(document);
    const actions = Object.fromEntries(["open", "expand", "followed", "compose", "type", "attach", "detach", "spawn", "seen", "summarize"].map((name) => [name, () => undefined])) as unknown as CardActions;
    const element = document.createElement("div");
    element.append(...cardNodes({ kind: "view", view: sampleView(T.main) }, { h, t: hoverStrings("zh-CN"), now: NOW, expanded: new Set(), actions, compose: { ...COMPOSE_IDLE, armed: "s2" } }));
    expect(element.querySelector("[aria-live]")).toBeNull();
    expect(hoverStrings("zh-CN").armed(hoverStrings("zh-CN").spawnChild)).toBe("开子对话：3 秒内再点一次确认");
  });
});

// ---------------------------------------------------------------------------------------------
// The capsule

function openCapsule(root: ShadowRoot): void {
  const pill = root.querySelector(".capsule")!;
  const Pointer = (window.PointerEvent ?? window.MouseEvent) as typeof MouseEvent;
  pill.dispatchEvent(new Pointer("pointerdown", { bubbles: true, composed: true, button: 0 }));
  pill.dispatchEvent(new Pointer("pointerup", { bubbles: true, composed: true, button: 0 }));
}

describe("the capsule's card", () => {
  it("is a named dialog whose lines to other conversations take Enter and Space", () => {
    const opened: string[] = [];
    const capsule = new Capsule({ doc: document, locale: "zh-CN", surface: "web", mutate: async () => undefined, openThread: (id) => opened.push(id), anchor: () => null });
    document.body.append(capsule.host);
    disposers.push(() => capsule.destroy());
    const root = capsule.host.shadowRoot!;
    capsule.update({ threadId: T.main, view: sampleView(T.main), settings: DEFAULT_SETTINGS, offline: false, now: NOW });
    openCapsule(root);
    const card = root.querySelector(".card")!;
    expect(card.getAttribute("role")).toBe("dialog");
    expect(card.getAttribute("aria-label")).toBe("主线：修复结算页在窄屏下错位");

    const childRow = [...root.querySelectorAll<HTMLElement>(".section")].find((section) => section.querySelector(".section-title")?.textContent === "子对话")!.querySelector<HTMLElement>(".row")!;
    expect(childRow.getAttribute("role")).toBe("button");
    expect(childRow.tabIndex).toBe(0);
    press(childRow, "Enter");
    const spawned = [...root.querySelectorAll<HTMLElement>(".row")].find((row) => row.textContent?.startsWith("已开子对话"))!;
    expect(spawned.tabIndex).toBe(0);
    press(spawned, " ");
    // A task carried by a child conversation: a button to it inside the task's line.
    const byChild = root.querySelector<HTMLButtonElement>(".row.task button.by-child")!;
    expect(byChild.textContent).toBe(" · 子对话「修复手机端菜单图标和标题重叠」");
    byChild.click();
    expect(opened).toEqual([T.child, T.child, T.child]);

    // The child's own card: the line to its parent.
    capsule.update({ threadId: T.child, view: sampleView(T.child), settings: DEFAULT_SETTINGS, offline: false, now: NOW });
    const parent = root.querySelector<HTMLElement>(".related")!;
    expect(parent.getAttribute("role")).toBe("button");
    press(parent, "Enter");
    expect(opened.at(-1)).toBe(T.main);
  });
});

// ---------------------------------------------------------------------------------------------
// The ★ button

describe("the ★ button", () => {
  function surface(add: (params: unknown) => Promise<unknown>) {
    const listeners = new Set<(version: string, data: LiveData) => void>();
    const controller: ControllerHandle = {
      dispose: () => undefined,
      refresh: async () => undefined,
      current: () => "t1",
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const adapter: SurfaceAdapter = {
      surface: "web",
      doc: document,
      invoke: async (method, params) => (method === "favorites.add" ? add(params) : { ok: true }),
      watchCurrentThread: () => () => undefined,
      openThread: () => undefined,
      anchor: () => null,
      mount: (host) => {
        document.body.append(host);
        return () => host.remove();
      },
    };
    const stop = startFavorites(adapter, controller);
    disposers.push(stop);
    const shadow = () => document.querySelector(`[${HOST_ATTRIBUTE}]`)!.shadowRoot!;
    return { button: () => shadow().querySelector<HTMLButtonElement>("button.fav")!, status: () => shadow().querySelector('.sr-only[role="status"]')!.textContent };
  }

  async function selectReply(): Promise<void> {
    const text = document.querySelector("p")!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 6);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    document.dispatchEvent(new Event("pointerup"));
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 10);
  }

  beforeEach(() => {
    document.body.innerHTML = `<div data-chat-flow-kind="assistant-step"><p>先打 tag，再跑发布脚本。</p></div>`;
    Range.prototype.getClientRects = function () {
      return [DOMRect.fromRect({ x: 485, y: 461, width: 312, height: 24 })] as unknown as DOMRectList;
    };
  });

  it("is named by what it says, and screen readers hear how saving went", async () => {
    vi.useFakeTimers();
    const { button, status } = surface(async (params) => ({ added: true, favorite: { id: "f1", ...(params as object) } }));
    await selectReply();
    expect(button().hidden).toBe(false);
    expect(button().hasAttribute("aria-label")).toBe(false);
    expect(button().textContent).toBe("★收藏");
    expect(status()).toBe("");
    button().click();
    await vi.advanceTimersByTimeAsync(0);
    expect(button().textContent).toBe("★已收藏");
    expect(status()).toBe("已收藏");
  });

  it("says on itself why saving failed", async () => {
    vi.useFakeTimers();
    const { button, status } = surface(async () => Promise.reject(new Error("[FAVORITES_FULL] favorites.json is full; delete saved passages you no longer need in the overview")));
    await selectReply();
    button().click();
    await vi.advanceTimersByTimeAsync(0);
    expect(button().textContent).toBe("★收藏失败：收藏已满，请在总览页删除不用的收藏");
    expect(status()).toBe("收藏失败：收藏已满，请在总览页删除不用的收藏");
    expect(button().title).toBe("收藏失败：收藏已满，请在总览页删除不用的收藏");
  });
});

// ---------------------------------------------------------------------------------------------
// Motion and contrast

describe("less motion", () => {
  it("scrolls to a search result without animation when the system asks for less motion", async () => {
    const scrolled = vi.fn();
    const original = { scroll: HTMLElement.prototype.scrollIntoView, match: window.matchMedia };
    HTMLElement.prototype.scrollIntoView = scrolled;
    window.matchMedia = ((query: string) => ({ matches: query.includes("reduce"), media: query })) as unknown as typeof window.matchMedia;
    try {
      const { root } = await overview();
      const find = root.querySelector<HTMLInputElement>(".mlp-find-input")!;
      find.value = "1081";
      find.dispatchEvent(new Event("input", { bubbles: true }));
      find.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await flush();
      root.querySelector<HTMLButtonElement>("button.mlp-hit-title")!.click();
      await flush();
      expect(scrolled).toHaveBeenCalledWith({ block: "center", behavior: "auto" });
      // The located line has the focus.
      expect(document.activeElement).toBe(toggleOf(root, T.main));
    } finally {
      HTMLElement.prototype.scrollIntoView = original.scroll;
      window.matchMedia = original.match;
    }
  });

  it("stops the overview's transitions", () => {
    const css = readFileSync(path.resolve("src/page/style.css"), "utf8");
    const block = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/u.exec(css)?.[1] ?? "";
    for (const selector of [".mlp-row", ".mlp-row-chevron svg"]) expect(block).toContain(selector);
    // Every class with a transition is in that block.
    const moving = [...css.matchAll(/\n(\.[^{]+)\{[^}]*\btransition:/gu)].flatMap((match) => match[1]!.split(",").map((selector) => selector.trim()));
    for (const selector of moving) expect(block, selector).toContain(selector);
  });
});

/** WCAG contrast of two opaque colours given as #rrggbb, the first painted over the second if it has alpha. */
function contrast(foreground: string, background: string): number {
  const rgb = (hex: string) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (hex: string) => {
    const [r, g, b] = rgb(hex).map(channel) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** A tint (rgba) painted over an opaque colour. */
function over(tint: string, base: string): string {
  const [r, g, b, a] = /rgba\(([^)]+)\)/u.exec(tint)![1]!.split(",").map(Number) as [number, number, number, number];
  const below = [1, 3, 5].map((at) => parseInt(base.slice(at, at + 2), 16));
  return `#${[r, g, b].map((value, index) => Math.round(value * a + below[index]! * (1 - a)).toString(16).padStart(2, "0")).join("")}`;
}

describe("text contrast of the capsule and the hover card", () => {
  const palettes = (css: string) => {
    const read = (block: string) => Object.fromEntries([...block.matchAll(/--cxm-([\w-]+):\s*([^;]+);/gu)].map((match) => [match[1]!, match[2]!.trim()]));
    const light = read(/\.root \{([\s\S]*?)\n\}/u.exec(css)![1]!);
    return { light, dark: { ...light, ...read(/\.root\[data-scheme="dark"\] \{([\s\S]*?)\n\}/u.exec(css)![1]!) } };
  };

  it("is at least 4.5:1 for text on the card, the hover and the accent and amber tints, in both schemes", () => {
    const sheets = { capsule: readFileSync(path.resolve("src/ui/styles.css"), "utf8"), hover: HOVER_CSS };
    for (const [surface, css] of Object.entries(sheets))
      for (const [scheme, colors] of Object.entries(palettes(css))) {
        const card = colors["bg-solid"]!;
        const on = { card, hover: over(colors.hover!, card), accent: over(colors["accent-soft"]!, card), amber: over(colors["amber-soft"]!, card) };
        // Each colour of text, on the backgrounds it is drawn on.
        const pairs: Array<[string, Array<keyof typeof on>]> = [
          ["faint", ["card", "hover", "accent"]],
          ["muted", ["card", "hover", "accent", "amber"]],
          ["accent-text", ["card", "accent"]],
          ["accent", ["card", "hover", "amber"]],
          ["amber", ["card", "amber"]],
          ["ok", ["card"]],
          ["danger", ["card"]],
          ...(colors.merged ? ([["merged", ["card"]]] as Array<[string, Array<keyof typeof on>]>) : []),
        ];
        for (const [name, backgrounds] of pairs)
          for (const where of backgrounds) expect(contrast(colors[name]!, on[where]), `${surface} ${scheme}: ${name} on ${where}`).toBeGreaterThanOrEqual(4.5);
      }
  });

  it("puts dark text on the accent and danger buttons in the dark scheme", () => {
    const capsule = readFileSync(path.resolve("src/ui/styles.css"), "utf8");
    expect(capsule).toMatch(/\.root\[data-scheme="dark"\] button\.btn\.primary \{\s*color: #10141c;/u);
    expect(capsule).toMatch(/\.root\[data-scheme="dark"\] button\.btn\[data-confirm\] \{\s*color: #10141c;/u);
    expect(contrast("#10141c", "#7aa7ff")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#10141c", "#ff7b72")).toBeGreaterThanOrEqual(4.5);
    expect(HOVER_CSS).toMatch(/--cxm-on-accent: #10141c;/u);
  });
});
