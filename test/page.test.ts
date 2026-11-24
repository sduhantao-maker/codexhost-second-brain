// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MutateV2Params, SearchParams } from "../src/core/rpc.js";
import type { PageApi } from "../src/host/types.js";
import { mount as mountPage } from "../src/page/index.js";
import { NOW, ref42, refWidgets, sampleSearchResults, sampleSnapshot, sampleView, T } from "./fixtures/v2.js";

const CHILD_OPENED = "55555555-eeee-4eee-8eee-555555555555";
const COMMAND = sampleSnapshot().command!;

type Respond = (method: string, params: unknown) => unknown;

interface Harness {
  root: HTMLElement;
  invoke: ReturnType<typeof vi.fn<(method: string, params?: unknown) => Promise<unknown>>>;
  set: ReturnType<typeof vi.fn<(values: Record<string, unknown>) => Promise<Record<string, unknown>>>>;
  setLocale(locale: string): void;
  dispose(): void;
}

function refsList() {
  return {
    status: { conversations: { scanned: 40, listed: 100, done: false, unreadable: 0 }, refs: 2, github: { enabled: true, lastPollAt: Date.now() } },
    refs: [ref42, refWidgets],
  };
}

const disposers: Array<() => void> = [];

/** Mounts the page against a fake backend that answers with the shared v2 samples. */
async function setup(options: { locale?: string; respond?: Respond } = {}): Promise<Harness> {
  const invoke = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
    const custom = options.respond?.(method, params);
    if (custom !== undefined) return custom;
    switch (method) {
      case "snapshot":
        return sampleSnapshot();
      case "conversation":
        return sampleView((params as { threadId: string }).threadId);
      case "search":
        return sampleSearchResults();
      case "refs.list":
        return refsList();
      case "integration.status":
        return [
          { agent: "claude", file: "/home/.claude/settings.json", state: "missing" },
          { agent: "codex", file: "/home/.codex/AGENTS.md", state: "unavailable", detail: "Codex is not set up (~/.codex is missing)", problem: "NOT_SET_UP" },
        ];
      case "integration.preview":
        return { agent: "claude", file: "/home/.claude/settings.json", action: "add", snippet: '{"hooks":{}}' };
      case "spawn":
        return { childThreadId: CHILD_OPENED };
      default:
        return { ok: true };
    }
  });
  const set = vi.fn(async (values: Record<string, unknown>) => values);
  const localeListeners: Array<(locale: string) => void> = [];
  const api: PageApi = {
    id: "second-brain",
    apiVersion: 1,
    hostTarget: "desktop",
    locale: options.locale ?? "zh-CN",
    onLocaleChange: (listener) => {
      localeListeners.push(listener);
      return () => undefined;
    },
    colorScheme: "light",
    onColorSchemeChange: () => () => undefined,
    signal: new AbortController().signal,
    storage: { get: async () => ({}), set, onChange: () => () => undefined },
    backend: { invoke },
  };
  const root = document.createElement("div");
  document.body.append(root);
  const dispose = await mountPage(root, api);
  disposers.push(dispose);
  return { root, invoke, set, dispose, setLocale: (locale) => localeListeners.forEach((listener) => listener(locale)) };
}

/** Lets the fake backend answer and the page redraw. */
async function flush(): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    else await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const buttonsIn = (scope: ParentNode, text: string) => [...scope.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.textContent === text);

function buttonIn(scope: ParentNode, text: string): HTMLButtonElement {
  const [button] = buttonsIn(scope, text);
  if (!button) throw new Error(`No button "${text}"`);
  return button;
}

function labelled(scope: ParentNode, label: string): HTMLButtonElement {
  const button = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.getAttribute("aria-label") === label);
  if (!button) throw new Error(`No button labelled "${label}"`);
  return button;
}

function nodeOf(root: ParentNode, threadId: string): HTMLElement {
  const node = [...root.querySelectorAll<HTMLElement>(".mlp-node")].find((element) => element.dataset.threadId === threadId);
  if (!node) throw new Error(`No row for ${threadId}`);
  return node;
}

/** The row itself, without the rows of its children. */
const lineOf = (root: ParentNode, threadId: string) => nodeOf(root, threadId).querySelector<HTMLElement>(":scope > .mlp-row")!;
const detailOf = (root: ParentNode, threadId: string) => nodeOf(root, threadId).querySelector<HTMLElement>(":scope > .mlp-detail");
const milestoneOf = (root: ParentNode, id: string) => root.querySelector<HTMLElement>(`[data-milestone-id="${id}"]`)!;
const taskOf = (root: ParentNode, id: string) => root.querySelector<HTMLElement>(`[data-task-id="${id}"]`)!;
const spinoffOf = (root: ParentNode, id: string) => root.querySelector<HTMLElement>(`[data-spinoff-id="${id}"]`)!;

function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function press(input: HTMLInputElement, key: string): void {
  input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

function field(scope: ParentNode, placeholder: string): HTMLInputElement {
  const input = [...scope.querySelectorAll<HTMLInputElement>("input")].find((item) => item.placeholder === placeholder);
  if (!input) throw new Error(`No field "${placeholder}"`);
  return input;
}

const calls = (harness: Harness, method: string) => harness.invoke.mock.calls.filter(([name]) => name === method).map(([, params]) => params);

async function expectMutation(harness: Harness, params: MutateV2Params): Promise<void> {
  await vi.waitFor(() => expect(harness.invoke).toHaveBeenCalledWith("mutate", params));
  await flush();
}

async function expand(harness: Harness, threadId: string): Promise<HTMLElement> {
  lineOf(harness.root, threadId).click();
  await flush();
  const detail = detailOf(harness.root, threadId);
  if (!detail) throw new Error(`Row ${threadId} did not expand`);
  return detail;
}

/** Unfolds a conversation's child conversations. */
async function openChildren(harness: Harness, threadId: string): Promise<void> {
  nodeOf(harness.root, threadId).querySelector<HTMLButtonElement>(":scope > .mlp-children-toggle")!.click();
  await flush();
}

async function showTab(harness: Harness, tab: "conversations" | "favorites" | "refs" | "settings"): Promise<void> {
  harness.root.querySelector<HTMLButtonElement>(`.mlp-tab[data-tab="${tab}"]`)!.click();
  await flush();
}

async function showStatus(harness: Harness, status: "active" | "paused" | "done" | "others"): Promise<void> {
  harness.root.querySelector<HTMLButtonElement>(`[data-status-tab="${status}"]`)!.click();
  await flush();
}

function listenForOpen(): ReturnType<typeof vi.fn<(event: Event) => void>> {
  const open = vi.fn((event: Event) => {
    (event as CustomEvent<{ handled?: boolean }>).detail.handled = true;
  });
  window.addEventListener("codexhost-mainline:open-thread", open);
  disposers.push(() => window.removeEventListener("codexhost-mainline:open-thread", open));
  return open;
}

const openedThread = (open: ReturnType<typeof listenForOpen>) => (open.mock.calls.at(-1)?.[0] as CustomEvent<{ threadId: string }> | undefined)?.detail.threadId;

beforeEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.useRealTimers();
});

describe("overview page: conversation tree", () => {
  it("lists one line per conversation, with its children folded under a count", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const harness = await setup();
    const { root } = harness;
    expect(root.querySelector("h1")?.textContent).toBe("第二大脑");
    expect(calls(harness, "snapshot")[0]).toEqual({ locale: "zh-CN", localeSource: "page" });
    await vi.waitFor(() => expect([...root.querySelectorAll(".mlp-tab")].map((tab) => tab.textContent)).toEqual(["对话 2", "收藏 0", "PR 与 Issue 2", "设置"]));
    expect([...root.querySelectorAll("[data-status-tab]")].map((button) => button.textContent)).toEqual(["进行中2", "暂停0", "已完成0", "没有主线1"]);
    expect(root.querySelector('[data-status-tab="active"]')?.getAttribute("aria-pressed")).toBe("true");
    // Grouped by when the work last moved.
    expect([...root.querySelectorAll(".mlp-bucket-title")].map((title) => title.textContent)).toEqual(["今天1"]);

    const line = lineOf(root, T.main);
    expect(line.querySelector(".mlp-row-title")?.textContent).toBe("修复结算页在窄屏下错位");
    expect(line.querySelector(".mlp-row-current")?.textContent).toBe("维护者审查");
    expect(line.querySelector(".mlp-row-progress")?.textContent).toBe("◆ 2/4");
    expect(line.querySelector(".mlp-status")?.getAttribute("data-status")).toBe("running");
    // One line only: tags and the last request wait in the details.
    expect(line.querySelector(".mlp-tag")).toBeNull();
    expect(line.textContent).not.toContain("最近请求");

    // Child conversations stay folded under a count until asked for.
    expect(() => nodeOf(root, T.child)).toThrow();
    const toggle = nodeOf(root, T.main).querySelector<HTMLButtonElement>(":scope > .mlp-children-toggle")!;
    expect(toggle.textContent).toBe("1 个子对话");
    await openChildren(harness, T.main);
    const main = nodeOf(root, T.main);
    const child = nodeOf(root, T.child);
    expect(child.dataset.depth).toBe("1");
    expect(child.parentElement?.classList.contains("mlp-children")).toBe(true);
    expect(child.parentElement?.closest(".mlp-node")).toBe(main);
    const childLine = lineOf(root, T.child);
    expect(childLine.querySelector(".mlp-row-title")?.textContent).toBe("修复手机端菜单图标和标题重叠");
    expect(childLine.querySelector(".mlp-row-progress")?.textContent).toBe("◆ 0/1");
    expect(childLine.querySelector(".mlp-status")?.getAttribute("data-status")).toBe("waiting");

    // The open button jumps there; it does not unfold the details.
    const open = listenForOpen();
    labelled(childLine, "跳转").click();
    expect(openedThread(open)).toBe(T.child);
    expect(detailOf(root, T.child)).toBeNull();
  });

  it("groups the list by project when asked", async () => {
    const harness = await setup({ respond: (method) => (method === "snapshot" ? { ...sampleSnapshot(), workspaces: { [T.main]: "shop-web" } } : undefined) });
    const { root } = harness;
    await flush();
    root.querySelector<HTMLButtonElement>('[data-grouping="project"]')!.click();
    await flush();
    expect([...root.querySelectorAll(".mlp-bucket-title")].map((title) => title.textContent)).toEqual(["shop-web1"]);
    expect(lineOf(root, T.main)).toBeTruthy();
  });

  it("lists conversations without a mainline under their own tab, as drafts", async () => {
    const harness = await setup();
    const { root } = harness;
    expect(() => nodeOf(root, T.old)).toThrow();
    await showStatus(harness, "others");
    const line = lineOf(root, T.old);
    expect(line.textContent).toContain("登录页样式检查");
    expect(line.querySelector(".mlp-draft")?.textContent).toBe("未凝练");

    // Expanding asks the backend for the draft, then a mainline can be made from it.
    const detail = await expand(harness, T.old);
    expect(calls(harness, "conversation")).toContainEqual({ threadId: T.old });
    await vi.waitFor(() => expect(detailOf(root, T.old)?.textContent).toContain("起因：把登录页的样式再检查一遍，错位的列出来"));
    expect(detailOf(root, T.old)?.textContent).toContain("最近请求：把登录页的样式再检查一遍");
    expect([...detailOf(root, T.old)!.querySelectorAll(".mlp-tag")].map((tag) => tag.textContent)).toEqual(["shop", "widgets", "Issue #3"]);
    expect(detail).toBeTruthy();
    buttonIn(detailOf(root, T.old)!, "建立主线").click();
    await flush();
    const editor = detailOf(root, T.old)!.querySelector<HTMLInputElement>(".mlp-editor")!;
    expect(editor.value).toBe("登录页样式检查");
    press(editor, "Enter");
    await expectMutation(harness, { op: "create", threadId: T.old, title: "登录页样式检查", tags: ["shop", "widgets", "Issue #3"] });
  });

  it("expands a conversation to show milestones, tasks, spin-offs and clues", async () => {
    const harness = await setup();
    const { root } = harness;
    await expand(harness, T.main);
    expect(calls(harness, "conversation")).toContainEqual({ threadId: T.main });
    // Clues come only from the backend's view.
    await vi.waitFor(() => expect(detailOf(root, T.main)?.querySelector(".mlp-clue")?.textContent).toContain("PR #42 fix(checkout): 窄屏下结算按钮不再压住表单"));
    const detail = detailOf(root, T.main)!;
    expect([...detail.querySelectorAll(".mlp-ms")].map((item) => item.getAttribute("data-state"))).toEqual(["done", "done", "current", "planned"]);
    expect(milestoneOf(detail, "m1").textContent).toContain("定位原因：窄屏断点漏了结算页");
    expect(milestoneOf(detail, "m1").querySelectorAll(".mlp-task")).toHaveLength(2);
    expect(taskOf(detail, "t1").hasAttribute("data-done")).toBe(true);
    expect(taskOf(detail, "t4").hasAttribute("data-done")).toBe(false);
    expect(taskOf(detail, "t5").textContent).toContain("由子对话「修复手机端菜单图标和标题重叠」处理");
    expect(milestoneOf(detail, "m3").textContent).toContain("正在做：回复 review 意见");
    expect(detail.textContent).toContain("引申问题 · 1 个待处理");
    expect(spinoffOf(detail, "s1").textContent).toContain("已开子对话「修复手机端菜单图标和标题重叠」");
    expect(buttonsIn(spinoffOf(detail, "s2"), "开子对话")).toHaveLength(1);
    expect(buttonsIn(spinoffOf(detail, "s2"), "本对话处理")).toHaveLength(1);
    expect(buttonsIn(spinoffOf(detail, "s2"), "忽略")).toHaveLength(1);
    // The open spin-off comes first.
    expect([...detail.querySelectorAll(".mlp-spin")].map((item) => item.getAttribute("data-spinoff-id"))).toEqual(["s2", "s1"]);

    const open = listenForOpen();
    buttonIn(spinoffOf(detail, "s1"), "已开子对话「修复手机端菜单图标和标题重叠」").click();
    expect(openedThread(open)).toBe(T.child);

    await openChildren(harness, T.main);
    const childDetail = await expand(harness, T.child);
    expect(childDetail.textContent).toContain("父对话：修复结算页在窄屏下错位");

    // Collapsing hides it again.
    lineOf(root, T.main).click();
    await flush();
    expect(detailOf(root, T.main)).toBeNull();
  });
});

describe("overview page: editing", () => {
  it("sends each edit as the right mutate and refreshes", async () => {
    const harness = await setup();
    const { root } = harness;
    await expand(harness, T.main);
    const detail = () => detailOf(root, T.main)!;
    const snapshots = calls(harness, "snapshot").length;

    buttonIn(milestoneOf(detail(), "m3"), "标记达成").click();
    await expectMutation(harness, { op: "milestoneReach", threadId: T.main, milestoneId: "m3" });
    expect(calls(harness, "snapshot").length).toBeGreaterThan(snapshots);

    buttonIn(milestoneOf(detail(), "m4"), "设为当前").click();
    await expectMutation(harness, { op: "milestoneFocus", threadId: T.main, milestoneId: "m4" });

    labelled(milestoneOf(detail(), "m4"), "重命名").click();
    await flush();
    let editor = milestoneOf(detail(), "m4").querySelector<HTMLInputElement>(".mlp-editor")!;
    expect(editor.value).toBe("合并后验证");
    expect(document.activeElement).toBe(editor);
    editor.value = "合并后在 Web 端验证";
    press(editor, "Enter");
    await expectMutation(harness, { op: "milestoneRename", threadId: T.main, milestoneId: "m4", title: "合并后在 Web 端验证" });

    // Deleting a milestone cannot be undone: it asks once more, with tasks or without.
    labelled(milestoneOf(detail(), "m4"), "删除里程碑").click();
    await flush();
    expect(calls(harness, "mutate")).not.toContainEqual({ op: "milestoneRemove", threadId: T.main, milestoneId: "m4" });
    buttonIn(milestoneOf(detail(), "m4"), "再点一次确认").click();
    await expectMutation(harness, { op: "milestoneRemove", threadId: T.main, milestoneId: "m4" });

    labelled(milestoneOf(detail(), "m1"), "删除里程碑").click();
    await flush();
    expect(calls(harness, "mutate")).not.toContainEqual({ op: "milestoneRemove", threadId: T.main, milestoneId: "m1" });
    buttonIn(milestoneOf(detail(), "m1"), "再点一次确认").click();
    await expectMutation(harness, { op: "milestoneRemove", threadId: T.main, milestoneId: "m1" });

    labelled(milestoneOf(detail(), "m4"), "在这个里程碑下添加支线任务").click();
    await flush();
    editor = milestoneOf(detail(), "m4").querySelector<HTMLInputElement>(".mlp-editor")!;
    editor.value = "在手机上点一遍";
    press(editor, "Enter");
    await expectMutation(harness, { op: "taskAdd", threadId: T.main, text: "在手机上点一遍", milestoneId: "m4" });

    const addTask = field(milestoneOf(detail(), "m3"), "添加支线任务…");
    type(addTask, "  补一张截图  ");
    press(addTask, "Enter");
    await expectMutation(harness, { op: "taskAdd", threadId: T.main, text: "补一张截图", milestoneId: "m3" });
    // The field is ready for the next task.
    expect(field(milestoneOf(detail(), "m3"), "添加支线任务…").value).toBe("");
    expect(document.activeElement).toBe(field(milestoneOf(detail(), "m3"), "添加支线任务…"));

    const addMilestone = field(detail(), "添加里程碑…");
    type(addMilestone, "发布新版本");
    press(addMilestone, "Enter");
    await expectMutation(harness, { op: "milestoneAdd", threadId: T.main, title: "发布新版本" });

    labelled(taskOf(detail(), "t4"), "完成").click();
    await expectMutation(harness, { op: "taskDone", threadId: T.main, taskId: "t4" });
    // Done tasks cannot be done again, only removed.
    expect(() => labelled(taskOf(detail(), "t3"), "完成")).toThrow();
    labelled(taskOf(detail(), "t3"), "删除").click();
    await flush();
    expect(calls(harness, "mutate")).not.toContainEqual({ op: "taskRemove", threadId: T.main, taskId: "t3" });
    buttonIn(taskOf(detail(), "t3"), "再点一次确认").click();
    await expectMutation(harness, { op: "taskRemove", threadId: T.main, taskId: "t3" });

    labelled(milestoneOf(detail(), "m3"), "清除正在做").click();
    await expectMutation(harness, { op: "doing", threadId: T.main, text: null });

    buttonIn(detail(), "修改标题").click();
    await flush();
    editor = detail().querySelector<HTMLInputElement>(".mlp-detail-title .mlp-editor")!;
    editor.value = "修复结算页的窄屏断点";
    press(editor, "Enter");
    await expectMutation(harness, { op: "title", threadId: T.main, title: "修复结算页的窄屏断点" });

    buttonIn(detail(), "修改标签").click();
    await flush();
    editor = detail().querySelector<HTMLInputElement>(".mlp-detail-tags .mlp-editor")!;
    expect(editor.value).toBe("shop-web, 结算页, bugfix, PR #42");
    editor.value = "shop-web, 结算，#bugfix, shop-web";
    press(editor, "Enter");
    await expectMutation(harness, { op: "tags", threadId: T.main, tags: ["shop-web", "结算", "bugfix"] });

    buttonIn(spinoffOf(detail(), "s2"), "本对话处理").click();
    await expectMutation(harness, { op: "spinoffKeep", threadId: T.main, spinoffId: "s2" });
    buttonIn(spinoffOf(detail(), "s2"), "忽略").click();
    await flush();
    expect(calls(harness, "mutate")).not.toContainEqual({ op: "spinoffDismiss", threadId: T.main, spinoffId: "s2" });
    buttonIn(spinoffOf(detail(), "s2"), "再点一次确认").click();
    await expectMutation(harness, { op: "spinoffDismiss", threadId: T.main, spinoffId: "s2" });

    const addSpinoff = field(detail(), "记下一个引申问题…");
    type(addSpinoff, "Web 端图片预览太慢");
    press(addSpinoff, "Enter");
    await expectMutation(harness, { op: "spinoffAdd", threadId: T.main, text: "Web 端图片预览太慢" });

    const segment = (label: string) => [...detail().querySelectorAll<HTMLButtonElement>(".mlp-seg")].find((button) => button.textContent === label)!;
    expect(segment("进行中").getAttribute("aria-pressed")).toBe("true");
    segment("暂停").click();
    await expectMutation(harness, { op: "status", threadId: T.main, status: "paused" });
    const before = calls(harness, "mutate").length;
    segment("进行中").click();
    await flush();
    expect(calls(harness, "mutate")).toHaveLength(before);

    // Deleting the mainline takes a second click.
    buttonIn(detail(), "删除主线").click();
    await flush();
    expect(calls(harness, "mutate")).not.toContainEqual({ op: "delete", threadId: T.main });
    buttonIn(detail(), "再点一次确认").click();
    await expectMutation(harness, { op: "delete", threadId: T.main });
  });

  it("cancels an edit with Escape and does not send unchanged text", async () => {
    const harness = await setup();
    const { root } = harness;
    await expand(harness, T.main);
    buttonIn(detailOf(root, T.main)!, "修改标题").click();
    await flush();
    let editor = detailOf(root, T.main)!.querySelector<HTMLInputElement>(".mlp-detail-title .mlp-editor")!;
    editor.value = "不要保存";
    press(editor, "Escape");
    await flush();
    expect(detailOf(root, T.main)!.querySelector(".mlp-editor")).toBeNull();

    buttonIn(detailOf(root, T.main)!, "修改标题").click();
    await flush();
    editor = detailOf(root, T.main)!.querySelector<HTMLInputElement>(".mlp-detail-title .mlp-editor")!;
    press(editor, "Enter");
    await flush();
    expect(calls(harness, "mutate")).toEqual([]);
  });

  it("shows why an edit failed and keeps what was typed", async () => {
    const harness = await setup({
      respond: (method) => (method === "mutate" ? Promise.reject(new Error("[LOCKED] state.json is locked")) : undefined),
    });
    const { root } = harness;
    await expand(harness, T.main);
    const addTask = field(milestoneOf(root, "m3"), "添加支线任务…");
    type(addTask, "补一张截图");
    press(addTask, "Enter");
    await vi.waitFor(() => expect(root.querySelector(".mlp-error")?.textContent).toContain("主线数据正在写入，请稍后再试"));
    await flush();
    expect(field(milestoneOf(root, "m3"), "添加支线任务…").value).toBe("补一张截图");
    labelled(root.querySelector(".mlp-error")!, "关闭").click();
    expect(root.querySelector(".mlp-error")).toBeNull();
  });
});

describe("overview page: child conversations", () => {
  it("opens a child conversation for a spin-off only on a second click within 3 seconds", async () => {
    vi.useFakeTimers();
    const harness = await setup();
    const { root } = harness;
    await expand(harness, T.main);
    const spawnButton = () => spinoffOf(detailOf(root, T.main)!, "s2").querySelector<HTMLButtonElement>("[data-confirm-key]")!;

    expect(spawnButton().textContent).toBe("开子对话");
    spawnButton().click();
    await flush();
    expect(calls(harness, "spawn")).toEqual([]);
    expect(spawnButton().textContent).toBe("再点一次确认");
    expect(spawnButton().hasAttribute("data-confirm")).toBe(true);

    // A redraw in between keeps the button armed.
    await vi.advanceTimersByTimeAsync(1000);
    await openChildren(harness, T.main);
    expect(spawnButton().textContent).toBe("再点一次确认");
    spawnButton().click();
    await flush();
    expect(calls(harness, "spawn")).toEqual([{ threadId: T.main, spinoffId: "s2" }]);
    expect(root.querySelector(".mlp-notice")?.textContent).toContain("已为「商品页的视频点开没反应」开了子对话");
    const open = listenForOpen();
    buttonIn(root.querySelector(".mlp-notice")!, "跳转").click();
    expect(openedThread(open)).toBe(CHILD_OPENED);

    // Three seconds after the first click, the button disarms.
    spawnButton().click();
    await flush();
    expect(spawnButton().textContent).toBe("再点一次确认");
    await vi.advanceTimersByTimeAsync(3100);
    expect(spawnButton().textContent).toBe("开子对话");
    spawnButton().click();
    await flush();
    expect(calls(harness, "spawn")).toHaveLength(1);
  });
});

describe("overview page: a child conversation codexhost has not answered for", () => {
  it("is a calm notice that it may still open, not an error", async () => {
    const harness = await setup({
      respond: (method) => (method === "spawn" ? Promise.reject(new Error("[PENDING] No answer from codexhost yet; the child may still open under this conversation")) : undefined),
    });
    const { root } = harness;
    await expand(harness, T.main);
    const spawnButton = () => spinoffOf(detailOf(root, T.main)!, "s2").querySelector<HTMLButtonElement>("[data-confirm-key]")!;
    spawnButton().click();
    spawnButton().click();
    await vi.waitFor(() => expect(root.querySelector(".mlp-notice")?.textContent).toContain("codexhost 没有及时答复，子对话可能还在打开：开好后会出现在本对话下方，先不要再点"));
    expect(root.querySelector('.mlp-notice[role="status"]')).not.toBeNull();
    expect(root.querySelector(".mlp-error")).toBeNull();
  });
});

describe("overview page: global search", () => {
  it("waits for typing to pause, then shows why each conversation matched", async () => {
    const harness = await setup();
    const { root } = harness;
    const input = root.querySelector<HTMLInputElement>(".mlp-find-input")!;
    expect(input.placeholder).toBe("输入编号、链接或关键词找回对话，例如 42");
    for (const value of ["1", "10", "108", "1081"]) type(input, value);
    expect(calls(harness, "search")).toEqual([]);
    await vi.waitFor(() => expect(calls(harness, "search")).toEqual([{ query: "1081" }]));
    await flush();

    const hits = [...root.querySelectorAll<HTMLElement>(".mlp-hit")];
    expect(hits).toHaveLength(2);
    const [first, second] = hits as [HTMLElement, HTMLElement];
    expect(first.querySelector(".mlp-hit-title")?.textContent).toBe("修复结算页在窄屏下错位");
    expect(first.querySelector("[data-conv-status]")?.textContent).toBe("进行中");
    expect([...first.querySelectorAll(".mlp-tag")].map((tag) => tag.textContent)).toEqual(["shop-web", "结算页", "bugfix", "PR #42"]);
    expect(first.querySelector(".mlp-progress")?.textContent).toBe("◆ 2/4");
    expect(first.textContent).toContain("当前：维护者审查");
    expect(first.querySelector(".mlp-match")?.textContent).toBe("命中PR/Issue：PR #42 fix(checkout): 窄屏下结算按钮不再压住表单");
    expect(first.querySelector(".mlp-live")?.textContent).toBe("运行中");
    expect(second.querySelector(".mlp-draft")?.textContent).toBe("未凝练");
    expect(second.querySelector(".mlp-match")?.textContent).toBe("命中当时的问题：把登录页的样式再检查一遍，错位的列出来");
    expect(second.querySelector(".mlp-live")?.textContent).toBe("空闲");
    expect(second.querySelector(".mlp-progress")).toBeNull();

    const open = listenForOpen();
    buttonIn(second, "跳转").click();
    expect(openedThread(open)).toBe(T.old);

    // The title opens the conversation in the list below, even inside a folded group.
    first.querySelector<HTMLButtonElement>("button.mlp-hit-title")!.click();
    await flush();
    expect(detailOf(root, T.main)).not.toBeNull();
    root.querySelector<HTMLButtonElement>(".mlp-hit:nth-child(2) button.mlp-hit-title")!.click();
    await flush();
    expect(detailOf(root, T.old)).not.toBeNull();

    press(input, "Escape");
    expect(input.value).toBe("");
    expect(root.querySelector<HTMLElement>(".mlp-find-results")!.hidden).toBe(true);
  });

  it("says when nothing matched, and ignores answers to an older query", async () => {
    let answerSlow: (value: unknown) => void = () => undefined;
    const harness = await setup({
      respond: (method, params) => {
        if (method !== "search") return undefined;
        const { query } = params as SearchParams;
        if (query === "slow") return new Promise((resolve) => (answerSlow = resolve));
        if (query === "nothing") return [];
        return [sampleSearchResults()[1]];
      },
    });
    const { root } = harness;
    const input = root.querySelector<HTMLInputElement>(".mlp-find-input")!;
    type(input, "nothing");
    press(input, "Enter");
    await flush();
    expect(root.querySelector(".mlp-find-results")?.textContent).toContain("没找到。可以换成 PR 或 issue 编号");

    type(input, "slow");
    press(input, "Enter");
    await flush();
    expect(root.querySelector(".mlp-find-results")?.textContent).toContain("正在查找…");
    type(input, "登录页");
    press(input, "Enter");
    await flush();
    answerSlow(sampleSearchResults());
    await flush();
    expect([...root.querySelectorAll(".mlp-hit-title")].map((title) => title.textContent)).toEqual(["登录页样式检查"]);
  });
});

describe("overview page: kept sections", () => {
  it("keeps PR and issue, agent integration and settings working", async () => {
    const harness = await setup();
    const { root, invoke, set } = harness;
    await showTab(harness, "refs");
    await vi.waitFor(() => expect(root.querySelector(".mlp-ref")?.textContent).toContain("#42 fix(checkout): 窄屏下结算按钮不再压住表单"));
    const firstRef = root.querySelector<HTMLElement>(".mlp-ref")!;
    expect(firstRef.hasAttribute("data-unseen")).toBe(true);
    expect(firstRef.textContent).toContain("当时的问题：手机上打开结算页，按钮压住了表单");
    expect(firstRef.textContent).toContain("有新评论");
    expect(root.textContent).toContain("正在扫描对话：已读 40 个（已列出 100 个），找到 2 个 PR/Issue");
    expect(root.textContent).toContain("GitHub 回复提醒正常");

    const refsSearch = root.querySelector<HTMLInputElement>(".mlp-refs-search")!;
    type(refsSearch, "9999");
    expect(root.querySelector(".mlp-refs")!.textContent).toContain("没找到。索引只收录在 codexhost 对话里出现过的链接。");
    type(refsSearch, "#3");
    expect([...root.querySelectorAll(".mlp-ref .mlp-ref-link")].map((link) => link.textContent)).toEqual(["#3 登录页按钮错位"]);
    type(refsSearch, "");

    const open = listenForOpen();
    buttonIn(root.querySelector(".mlp-ref")!, "跳转").click();
    expect(openedThread(open)).toBe(T.main);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("refs.seen", { key: ref42.key }));

    await showTab(harness, "settings");
    expect(root.textContent).toContain(`Agent 使用的命令：${COMMAND}`);
    // Why Codex is unavailable, in the page's language.
    expect(root.textContent).toContain("没有找到 Codex 的配置（~/.codex 不存在）");
    expect(root.textContent).not.toContain("Codex is not set up");
    buttonIn(root, "安装").click();
    await vi.waitFor(() => expect(root.querySelector(".mlp-pre")?.textContent).toBe('{"hooks":{}}'));
    expect(root.querySelector(".mlp-preview-title")?.textContent).toBe("追加内容：/home/.claude/settings.json");
    buttonIn(root, "确认修改").click();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("integration.install", { agent: "claude" }));

    const note = root.querySelector<HTMLInputElement>('input[type="radio"][value="note"]')!;
    note.checked = true;
    note.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(set).toHaveBeenCalledWith(expect.objectContaining({ driftPolicy: "note" })));
    // The capsule over the conversation is off unless asked for; the sidebar hover card is the main view.
    const capsule = root.querySelector<HTMLInputElement>('input[name="showCapsule"]')!;
    expect(capsule.checked).toBe(false);
    capsule.checked = true;
    capsule.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(set).toHaveBeenCalledWith(expect.objectContaining({ showCapsule: true, driftPolicy: "note" })));
    const alerts = root.querySelector<HTMLInputElement>('input[name="prAlerts"]')!;
    alerts.checked = false;
    alerts.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(set).toHaveBeenCalledWith(expect.objectContaining({ prAlerts: false })));
  });

  it("speaks English when the page does, and follows a language change", async () => {
    const harness = await setup({ locale: "en-US" });
    const { root } = harness;
    expect(root.querySelector("h1")?.textContent).toBe("Second Brain");
    expect(calls(harness, "snapshot")[0]).toEqual({ locale: "en", localeSource: "page" });
    await vi.waitFor(() => expect(root.querySelector(".mlp-tab")?.textContent).toBe("Conversations 2"));
    expect(root.querySelector('[data-status-tab="active"]')?.textContent).toBe("Active2");
    expect(lineOf(root, T.main).querySelector(".mlp-row-current")?.textContent).toBe("维护者审查");
    expect(labelled(lineOf(root, T.main), "Go")).toBeTruthy();
    expect(root.querySelector<HTMLInputElement>(".mlp-find-input")?.placeholder).toBe("Number, link or words, for example 42");
    await showTab(harness, "refs");
    expect(root.textContent).toContain("PRs and issues");
    await showTab(harness, "settings");
    expect(root.textContent).toContain("Agent integration");

    harness.setLocale("zh-CN");
    expect(root.querySelector("h1")?.textContent).toBe("第二大脑");
    await flush();
    await vi.waitFor(() => expect(calls(harness, "snapshot")).toContainEqual(expect.objectContaining({ locale: "zh-CN", localeSource: "page" })));
  });
});

describe("settings tab after the rename from Mainline", () => {
  const OLD_FOLDER = "~/.codexhost/host-extension-data/mainline/";
  const respond = (method: string) => {
    if (method === "snapshot") return { ...sampleSnapshot(), migration: { oldFolder: OLD_FOLDER } };
    // What the hook and the section an earlier install wrote look like to the new extension.
    if (method === "integration.status")
      return [
        { agent: "claude", file: "/home/.claude/settings.json", state: "outdated" },
        { agent: "codex", file: "/home/.codex/AGENTS.md", state: "outdated" },
      ];
    if (method === "integration.preview") return { agent: "codex", file: "/home/.codex/AGENTS.md", action: "replace", snippet: "## Second Brain (codexhost)" };
    return undefined;
  };

  it("says the old folder may go, and updates the agent integration of the earlier install", async () => {
    const harness = await setup({ respond });
    const { root, invoke } = harness;
    await showTab(harness, "settings");
    expect(root.querySelector(".mlp-migrated")?.textContent).toBe(
      "已从旧版「主线任务」复制数据。旧目录 ~/.codexhost/host-extension-data/mainline/ 仍在：确认无误后可以手动删除（里面的 backups/ 有你配置文件的完整备份）。0.10 以前开的子对话仍从这里读附件，删掉后它们就读不到这些文件了。",
    );
    const rows = [...root.querySelectorAll<HTMLElement>(".mlp-integration")];
    expect(rows.map((row) => row.querySelector(".mlp-badge")?.textContent)).toEqual(["需要更新", "需要更新"]);
    buttonIn(rows[1]!, "更新").click();
    await vi.waitFor(() => expect(root.querySelector(".mlp-preview-title")?.textContent).toBe("替换旧版内容：/home/.codex/AGENTS.md"));
    buttonIn(root, "确认修改").click();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("integration.install", { agent: "codex" }));
  });

  it("says it in English too, and not at all once the old folder is gone", async () => {
    const english = await setup({ locale: "en-US", respond });
    await showTab(english, "settings");
    expect(english.root.querySelector(".mlp-migrated")?.textContent).toBe(
      "Copied the data over from the earlier version, “Mainline”. The old folder ~/.codexhost/host-extension-data/mainline/ is still there: once everything looks right, you can delete it by hand (its backups/ folder holds full copies of your configuration files). Child conversations opened before 0.10 read their attachments from there; deleting it takes those files away from them.",
    );
    expect([...english.root.querySelectorAll(".mlp-integration .mlp-badge")].map((badge) => badge.textContent)).toEqual(["Needs update", "Needs update"]);
    const plain = await setup();
    await showTab(plain, "settings");
    expect(plain.root.querySelector(".mlp-migrated")).toBeNull();
  });
});

describe("settings tab: attachments", () => {
  const MB = 1024 * 1024;
  const usage = (all: [number, number], done: [number, number], unknown: [number, number] = [0, 0]) => ({
    all: { files: all[0], bytes: all[1] },
    done: { files: done[0], bytes: done[1] },
    unknown: { files: unknown[0], bytes: unknown[1] },
  });
  const block = (harness: Harness) => harness.root.querySelector<HTMLElement>(".mlp-attachments")!;
  const labels = (harness: Harness) => [...block(harness).querySelectorAll("button")].map((button) => button.textContent);

  it("counts the files sent along with child conversations when the settings open, and clears them with two clicks", async () => {
    let current = usage([12, 340 * MB], [3, 12 * MB], [2, 1024]);
    const harness = await setup({
      respond: (method, params) => {
        if (method === "attachments.usage") return current;
        if (method !== "attachments.clear") return undefined;
        const scope = (params as { scope: string }).scope;
        const cleared = scope === "done" ? current.done : current.all;
        current = scope === "done" ? usage([9, 328 * MB], [0, 0], [2, 1024]) : usage([0, 0], [0, 0]);
        return { cleared, usage: current };
      },
    });
    await flush();
    // Counting reads every folder: not with each snapshot, only when the settings tab opens.
    expect(calls(harness, "attachments.usage")).toEqual([]);
    await showTab(harness, "settings");
    expect(calls(harness, "attachments.usage")).toHaveLength(1);
    expect(block(harness).querySelector("h2")?.textContent).toBe("附件");
    expect(block(harness).textContent).toContain("开子对话时附带的文件：12 个，共 340 MB");
    expect(labels(harness)).toEqual(["清理已完成子对话的附件（释放 12 MB）", "全部清理（释放 340 MB）"]);

    buttonIn(block(harness), "清理已完成子对话的附件（释放 12 MB）").click();
    await flush();
    expect(calls(harness, "attachments.clear")).toEqual([]);
    buttonIn(block(harness), "再点一次确认").click();
    await flush();
    expect(calls(harness, "attachments.clear")).toEqual([{ scope: "done" }]);
    expect(harness.root.querySelector(".mlp-notice")?.textContent).toContain("已删除 3 个文件，释放 12 MB");
    expect(block(harness).textContent).toContain("开子对话时附带的文件：9 个，共 328 MB");
    // Nothing of done child conversations is left to free: only "clear all" stays.
    expect(labels(harness)).toEqual(["全部清理（释放 328 MB）"]);

    buttonIn(block(harness), "全部清理（释放 328 MB）").click();
    await flush();
    buttonIn(block(harness), "再点一次确认").click();
    await flush();
    expect(calls(harness, "attachments.clear")).toEqual([{ scope: "done" }, { scope: "all" }]);
    expect(block(harness).textContent).toContain("开子对话时还没有附带过文件。");
    expect(labels(harness)).toEqual([]);

    // Opening the settings again counts again.
    await showTab(harness, "conversations");
    await showTab(harness, "settings");
    expect(calls(harness, "attachments.usage")).toHaveLength(2);
  });

  it("says why clearing failed and counts what is left", async () => {
    const harness = await setup({
      respond: (method) => {
        if (method === "attachments.usage") return usage([2, 3 * MB], [0, 0], [2, 3 * MB]);
        if (method === "attachments.clear") return Promise.reject(new Error("[INTERNAL] EACCES: permission denied"));
        return undefined;
      },
    });
    await showTab(harness, "settings");
    expect(labels(harness)).toEqual(["全部清理（释放 3 MB）"]);
    buttonIn(block(harness), "全部清理（释放 3 MB）").click();
    buttonIn(block(harness), "再点一次确认").click();
    await flush();
    expect(harness.root.querySelector(".mlp-error")?.textContent).toContain("操作没有成功：EACCES: permission denied");
    expect(calls(harness, "attachments.usage")).toHaveLength(2);
    expect(labels(harness)).toEqual(["全部清理（释放 3 MB）"]);
  });

  it("speaks English when the page does", async () => {
    const harness = await setup({ locale: "en-US", respond: (method) => (method === "attachments.usage" ? usage([12, 340 * MB], [1, 12 * MB]) : undefined) });
    await showTab(harness, "settings");
    expect(block(harness).querySelector("h2")?.textContent).toBe("Attachments");
    expect(block(harness).textContent).toContain("Files sent along with child conversations: 12 files, 340 MB");
    expect(labels(harness)).toEqual(["Clear files of child conversations marked done (frees 12 MB)", "Clear all (frees 340 MB)"]);
  });
});

describe("favorites tab", () => {
  /** A conversation the snapshot does not know. */
  const UNKNOWN = "99999999-ffff-4fff-8fff-999999999999";
  const long = Array.from({ length: 9 }, (_, index) => `第 ${index + 1} 步：先备份再迁移`).join("\n");
  const favoritesList = () => ({
    items: [
      { id: "fav2", threadId: UNKNOWN, text: "发布前先跑 npm run check，退出码为 0 才发版。", role: "agent", turn: 12, source: "select", createdAt: Date.now() - 60_000, note: "发版规矩" },
      { id: "fav1", threadId: T.main, text: long, role: "agent", turn: 3, source: "chat", createdAt: Date.now() - 3 * 3_600_000 },
    ],
    titles: { [T.main]: "修复结算页窄屏错位" },
    total: 2,
  });

  it("lists saved passages, finds them, opens them where they were said, and notes or deletes them", async () => {
    const opened: string[] = [];
    const listen = (event: Event) => opened.push((event as CustomEvent<{ threadId: string }>).detail.threadId);
    window.addEventListener("codexhost-mainline:open-thread", listen);
    const harness = await setup({
      respond: (method, params) => {
        if (method === "favorites.list") return favoritesList();
        if (method === "favorites.reveal") return { threadId: (params as { id: string }).id === "fav1" ? T.main : UNKNOWN };
        return undefined;
      },
    });
    try {
      await flush();
      expect(harness.root.querySelector('.mlp-tab[data-tab="favorites"]')!.textContent).toBe("收藏 2");
      await showTab(harness, "favorites");
      const cards = () => [...harness.root.querySelectorAll<HTMLElement>(".mlp-favorite")];
      expect(cards().map((card) => card.dataset.favorite)).toEqual(["fav2", "fav1"]);
      const [first, second] = cards();
      expect(first!.textContent).toContain("第 12 轮 · 回复");
      expect(first!.textContent).toContain("备注：发版规矩");
      // A conversation without a known title shows its short id.
      expect(first!.querySelector(".mlp-favorite-title")!.textContent).toBe(`#${UNKNOWN.slice(0, 8)}`);
      expect(second!.querySelector(".mlp-favorite-title")!.textContent).toBe("修复结算页窄屏错位");
      expect(second!.querySelector(".mlp-favorite-text")!.hasAttribute("data-folded")).toBe(true);
      buttonIn(second!, "展开全文").click();
      await flush();
      expect(cards()[1]!.querySelector(".mlp-favorite-text")!.hasAttribute("data-folded")).toBe(false);

      type(field(harness.root, "搜索收藏：原文、备注或对话标题"), "发版规矩");
      expect(cards().map((card) => card.dataset.favorite)).toEqual(["fav2"]);
      type(field(harness.root, "搜索收藏：原文、备注或对话标题"), "结算页");
      expect(cards().map((card) => card.dataset.favorite)).toEqual(["fav1"]);
      type(field(harness.root, "搜索收藏：原文、备注或对话标题"), "");

      buttonIn(cards()[1]!, "跳回原文").click();
      await flush();
      expect(calls(harness, "favorites.reveal")).toEqual([{ id: "fav1" }]);
      expect(opened).toEqual([T.main]);

      buttonIn(cards()[1]!, "备注").click();
      await flush();
      const note = field(harness.root, "写一句备注，Enter 保存，Esc 取消");
      type(note, "迁移手册");
      press(note, "Enter");
      await flush();
      expect(calls(harness, "favorites.note")).toEqual([{ id: "fav1", note: "迁移手册" }]);

      buttonIn(cards()[0]!, "删除").click();
      expect(calls(harness, "favorites.remove")).toEqual([]);
      buttonIn(cards()[0]!, "再点一次确认").click();
      await flush();
      expect(calls(harness, "favorites.remove")).toEqual([{ id: "fav2" }]);
    } finally {
      window.removeEventListener("codexhost-mainline:open-thread", listen);
    }
  });

  it("says so when the surface could not open the conversation", async () => {
    const refuse = (event: Event) => {
      const detail = (event as CustomEvent<{ handled?: boolean; result?: Promise<void> }>).detail;
      detail.handled = true;
      detail.result = Promise.reject(new Error("Unknown local Desktop Thread"));
    };
    window.addEventListener("codexhost-mainline:open-thread", refuse);
    const harness = await setup({
      respond: (method) => {
        if (method === "favorites.list") return favoritesList();
        if (method === "favorites.reveal") return { threadId: T.main };
        return undefined;
      },
    });
    try {
      await flush();
      await showTab(harness, "favorites");
      buttonIn(harness.root.querySelector<HTMLElement>("[data-favorite=fav1]")!, "跳回原文").click();
      await flush();
      expect(harness.root.querySelector(".mlp-error")!.textContent).toContain("没能打开这个对话：Unknown local Desktop Thread");
    } finally {
      window.removeEventListener("codexhost-mainline:open-thread", refuse);
    }
  });

  it("says how to save something when nothing is saved", async () => {
    const harness = await setup({ respond: (method) => (method === "favorites.list" ? { items: [], titles: {}, total: 0 } : undefined) });
    await flush();
    await showTab(harness, "favorites");
    expect(harness.root.querySelector(".mlp-favorites")!.textContent).toContain("在对话里选中一段文字");
  });
});
