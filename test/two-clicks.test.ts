// @vitest-environment jsdom
/**
 * What cannot be undone takes two clicks, on the overview and in the capsule: dismissing a
 * spin-off, deleting a task, a milestone (with tasks or without), a mainline or a saved passage,
 * and clearing attachments. The first click only arms the button and says so to screen readers; the
 * second, within three seconds, acts. What can be undone takes one: a status (finishing included),
 * reaching a milestone, handling a spin-off here, a summary, marking PR news seen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/core/model.js";
import type { MutateV2Params } from "../src/core/rpc.js";
import type { PageApi } from "../src/host/types.js";
import { mount } from "../src/page/index.js";
import { Capsule } from "../src/ui/capsule.js";
import { NOW, ref42, refWidgets, sampleSnapshot, sampleView, T } from "./fixtures/v2.js";

const MB = 1024 * 1024;
const disposers: Array<() => void> = [];

beforeEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.useFakeTimers();
});
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.useRealTimers();
});

async function flush(): Promise<void> {
  for (let round = 0; round < 4; round += 1) await vi.advanceTimersByTimeAsync(0);
}

function named(scope: ParentNode, name: string): HTMLButtonElement {
  const button = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === name || item.getAttribute("aria-label") === name);
  if (!button) throw new Error(`No button "${name}"`);
  return button;
}

// ---------------------------------------------------------------------------------------------
// The overview

async function overview() {
  const invoke = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
    switch (method) {
      case "snapshot":
        return sampleSnapshot();
      case "conversation":
        return sampleView((params as { threadId: string }).threadId);
      case "refs.list":
        return { status: { conversations: { scanned: 2, listed: 2, done: true, unreadable: 0 }, refs: 2, github: { enabled: true, lastPollAt: NOW } }, refs: [ref42, refWidgets] };
      case "favorites.list":
        return { items: [{ id: "fav1", threadId: T.main, text: "发布前先跑 npm run check。", role: "agent", turn: 2, source: "select", createdAt: NOW }], titles: {}, total: 1 };
      case "attachments.usage":
        return { all: { files: 4, bytes: 40 * MB }, done: { files: 1, bytes: 10 * MB }, unknown: { files: 0, bytes: 0 } };
      case "attachments.clear":
        return { cleared: { files: 1, bytes: 10 * MB }, usage: { all: { files: 3, bytes: 30 * MB }, done: { files: 0, bytes: 0 }, unknown: { files: 0, bytes: 0 } } };
      case "integration.status":
        return [];
      default:
        return { ok: true };
    }
  });
  const api: PageApi = {
    id: "second-brain",
    apiVersion: 1,
    hostTarget: "desktop",
    locale: "zh-CN",
    onLocaleChange: () => () => undefined,
    colorScheme: "light",
    onColorSchemeChange: () => () => undefined,
    signal: new AbortController().signal,
    storage: { get: async () => ({}), set: async (values) => values, onChange: () => () => undefined },
    backend: { invoke },
  };
  const root = document.createElement("div");
  document.body.append(root);
  disposers.push(await mount(root, api));
  await flush();
  const called = (method: string) => invoke.mock.calls.filter(([name]) => name === method).map(([, params]) => params);
  const live = () => root.querySelector('.mlp-sr-only[role="status"]')!.textContent;
  const tab = async (name: string) => {
    root.querySelector<HTMLButtonElement>(`.mlp-tab[data-tab="${name}"]`)!.click();
    await flush();
  };
  const detail = async () => {
    if (!root.querySelector(`.mlp-node[data-thread-id="${T.main}"] > .mlp-detail`)) {
      root.querySelector<HTMLElement>(`.mlp-node[data-thread-id="${T.main}"] > .mlp-row`)!.click();
      await flush();
    }
    return root.querySelector<HTMLElement>(`.mlp-node[data-thread-id="${T.main}"] > .mlp-detail`)!;
  };
  return { root, called, live, tab, detail };
}

type Overview = Awaited<ReturnType<typeof overview>>;

interface Deletion {
  what: string;
  /** The button, on the tab it is on. */
  button(page: Overview): Promise<HTMLButtonElement>;
  label: string;
  call: [method: string, params: unknown];
}

const deletions: Deletion[] = [
  {
    what: "dismissing a spin-off",
    button: async (page) => named((await page.detail()).querySelector('[data-spinoff-id="s2"]')!, "忽略"),
    label: "忽略",
    call: ["mutate", { op: "spinoffDismiss", threadId: T.main, spinoffId: "s2" }],
  },
  {
    what: "deleting a task",
    button: async (page) => named((await page.detail()).querySelector('[data-task-id="t3"]')!, "删除"),
    label: "删除",
    call: ["mutate", { op: "taskRemove", threadId: T.main, taskId: "t3" }],
  },
  {
    what: "deleting a milestone without tasks",
    button: async (page) => named((await page.detail()).querySelector('[data-milestone-id="m4"]')!, "删除里程碑"),
    label: "删除里程碑",
    call: ["mutate", { op: "milestoneRemove", threadId: T.main, milestoneId: "m4" }],
  },
  {
    what: "deleting a milestone with tasks",
    button: async (page) => named((await page.detail()).querySelector('[data-milestone-id="m1"] .mlp-ms-head')!, "删除里程碑"),
    label: "删除里程碑",
    call: ["mutate", { op: "milestoneRemove", threadId: T.main, milestoneId: "m1" }],
  },
  {
    what: "deleting a mainline",
    button: async (page) => named(await page.detail(), "删除主线"),
    label: "删除主线",
    call: ["mutate", { op: "delete", threadId: T.main }],
  },
  {
    what: "deleting a saved passage",
    button: async (page) => {
      await page.tab("favorites");
      return named(page.root.querySelector(".mlp-favorites-section")!, "删除");
    },
    label: "删除",
    call: ["favorites.remove", { id: "fav1" }],
  },
  {
    what: "clearing the attachments of finished child conversations",
    button: async (page) => {
      await page.tab("settings");
      return named(page.root.querySelector(".mlp-attachments")!, "清理已完成子对话的附件（释放 10 MB）");
    },
    label: "清理已完成子对话的附件（释放 10 MB）",
    call: ["attachments.clear", { scope: "done" }],
  },
  {
    what: "clearing all attachments",
    button: async (page) => {
      await page.tab("settings");
      return named(page.root.querySelector(".mlp-attachments")!, "全部清理（释放 40 MB）");
    },
    label: "全部清理（释放 40 MB）",
    call: ["attachments.clear", { scope: "all" }],
  },
];

describe("the overview asks for a second click before what cannot be undone", () => {
  for (const deletion of deletions)
    it(deletion.what, async () => {
      const page = await overview();
      const [method, params] = deletion.call;
      (await deletion.button(page)).click();
      await flush();
      // The first click only arms the button, and says what it waits for.
      expect(page.called(method)).not.toContainEqual(params);
      expect(page.live()).toBe(`${deletion.label}：3 秒内再点一次确认`);
      const armed = page.root.querySelectorAll<HTMLButtonElement>("[data-confirm]");
      expect([...armed].map((button) => button.textContent)).toEqual(["再点一次确认"]);
      // The second, within three seconds, acts.
      await vi.advanceTimersByTimeAsync(2500);
      armed[0]!.click();
      await flush();
      expect(page.called(method)).toContainEqual(params);
      expect(page.live()).toBe("");
    });

  it("lets a button calm down after three seconds, and a click then only arms it again", async () => {
    const page = await overview();
    const task = async () => named((await page.detail()).querySelector('[data-task-id="t3"]')!, "删除");
    (await task()).click();
    await flush();
    await vi.advanceTimersByTimeAsync(3100);
    expect(page.root.querySelector("[data-confirm]")).toBeNull();
    expect(page.live()).toBe("");
    (await task()).click();
    await flush();
    expect(page.called("mutate")).toEqual([]);
    expect(page.live()).toBe("删除：3 秒内再点一次确认");
  });
});

describe("the overview acts on one click for what can be undone", () => {
  it("sets a status, reaches a milestone, handles a spin-off here, summarizes again and marks PR news seen", async () => {
    const page = await overview();
    const detail = await page.detail();
    const segment = (label: string) => [...detail.querySelectorAll<HTMLButtonElement>(".mlp-seg")].find((button) => button.textContent === label)!;
    segment("暂停").click();
    await flush();
    expect(page.called("mutate")).toContainEqual({ op: "status", threadId: T.main, status: "paused" });
    segment("完成").click();
    await flush();
    expect(page.called("mutate")).toContainEqual({ op: "status", threadId: T.main, status: "done" });
    named(await page.detail(), "标记达成").click();
    await flush();
    expect(page.called("mutate")).toContainEqual({ op: "milestoneReach", threadId: T.main, milestoneId: "m3" });
    named((await page.detail()).querySelector('[data-spinoff-id="s2"]')!, "本对话处理").click();
    await flush();
    expect(page.called("mutate")).toContainEqual({ op: "spinoffKeep", threadId: T.main, spinoffId: "s2" });
    named(await page.detail(), "重新凝练").click();
    await flush();
    expect(page.called("summarize")).toEqual([{ threadId: T.main }]);
    expect(page.root.querySelector("[data-confirm]")).toBeNull();

    await page.tab("refs");
    window.addEventListener("codexhost-mainline:open-thread", (event) => ((event as CustomEvent<{ handled?: boolean }>).detail.handled = true), { once: true });
    named(page.root.querySelector(".mlp-ref[data-unseen]")!, "跳转").click();
    await flush();
    expect(page.called("refs.seen")).toEqual([{ key: ref42.key }]);
    expect(page.live()).toBe("");
  });
});

// ---------------------------------------------------------------------------------------------
// The capsule

function capsule() {
  const mutate = vi.fn<(params: MutateV2Params) => Promise<void>>(async () => undefined);
  const spawn = vi.fn<(spinoffId: string) => Promise<void>>(async () => undefined);
  const calls: Array<[string, unknown]> = [];
  const instance = new Capsule({
    doc: document,
    locale: "zh-CN",
    surface: "web",
    mutate,
    spawn,
    openThread: () => undefined,
    call: async (method, params) => {
      calls.push([method, params]);
      return [];
    },
    anchor: () => ({ x: 400, top: 60 }),
  });
  document.body.append(instance.host);
  disposers.push(() => instance.destroy());
  const show = () => instance.update({ threadId: T.main, view: sampleView(T.main), settings: DEFAULT_SETTINGS, offline: false, now: NOW, alerts: [ref42] });
  show();
  const root = instance.host.shadowRoot!;
  const pill = root.querySelector(".capsule")!;
  const Pointer = (window.PointerEvent ?? window.MouseEvent) as typeof MouseEvent;
  pill.dispatchEvent(new Pointer("pointerdown", { bubbles: true, composed: true, button: 0 }));
  pill.dispatchEvent(new Pointer("pointerup", { bubbles: true, composed: true, button: 0 }));
  const live = () => root.querySelector('.sr-only[role="status"]')!.textContent;
  return { root, mutate, spawn, calls, live, redraw: show };
}

/** A task row of the current milestone, by its text. */
const taskRow = (root: ShadowRoot, text: string) => [...root.querySelectorAll<HTMLElement>('.milestone[data-state="current"] .row.task')].find((row) => row.textContent?.includes(text))!;

describe("the capsule asks for a second click before what cannot be undone", () => {
  const cases: Array<{ what: string; button: (root: ShadowRoot) => HTMLButtonElement; label: string; done: (spy: ReturnType<typeof capsule>) => void }> = [
    {
      what: "dismissing a spin-off",
      button: (root) => named(root.querySelector(".spinoff")!, "忽略"),
      label: "忽略",
      done: ({ mutate }) => expect(mutate).toHaveBeenCalledWith({ op: "spinoffDismiss", threadId: T.main, spinoffId: "s2" }),
    },
    {
      what: "deleting a milestone",
      button: (root) => named(root.querySelector('.milestone[data-state="planned"] .milestone-row')!, "删除"),
      label: "删除",
      done: ({ mutate }) => expect(mutate).toHaveBeenCalledWith({ op: "milestoneRemove", threadId: T.main, milestoneId: "m4" }),
    },
    {
      what: "deleting a task",
      button: (root) => named(taskRow(root, "回复 review 意见"), "删除"),
      label: "删除",
      done: ({ mutate }) => expect(mutate).toHaveBeenCalledWith({ op: "taskRemove", threadId: T.main, taskId: "t4" }),
    },
    {
      what: "opening a child conversation (as before)",
      button: (root) => named(root.querySelector(".spinoff")!, "开子对话"),
      label: "开子对话",
      done: ({ spawn }) => expect(spawn).toHaveBeenCalledWith("s2"),
    },
  ];
  for (const { what, button, label, done } of cases)
    it(what, () => {
      const spy = capsule();
      button(spy.root).click();
      expect(spy.mutate).not.toHaveBeenCalled();
      expect(spy.spawn).not.toHaveBeenCalled();
      expect(spy.live()).toBe(`${label}：3 秒内再点一次确认`);
      // A redraw of the card in between keeps the button armed.
      spy.redraw();
      const armed = [...spy.root.querySelectorAll<HTMLButtonElement>("[data-confirm]")];
      expect(armed.map((item) => item.textContent)).toEqual(["再点一次确认"]);
      vi.advanceTimersByTime(2500);
      armed[0]!.click();
      done(spy);
      expect(spy.live()).toBe("");
    });

  it("lets a button calm down after three seconds, and a click then only arms it again", () => {
    const spy = capsule();
    const remove = () => named(taskRow(spy.root, "回复 review 意见"), "删除");
    remove().click();
    expect(remove).toThrow();
    vi.advanceTimersByTime(3100);
    expect(spy.root.querySelector("[data-confirm]")).toBeNull();
    expect(remove().getAttribute("aria-label")).toBe("删除");
    expect(spy.live()).toBe("");
    remove().click();
    expect(spy.mutate).not.toHaveBeenCalled();
  });
});

describe("the capsule acts on one click for what can be undone", () => {
  it("finishes, pauses, reaches a milestone, handles a spin-off here and marks PR news seen", () => {
    const spy = capsule();
    named(spy.root, "完成主线").click();
    expect(spy.mutate).toHaveBeenLastCalledWith({ op: "status", threadId: T.main, status: "done" });
    named(spy.root, "暂停").click();
    expect(spy.mutate).toHaveBeenLastCalledWith({ op: "status", threadId: T.main, status: "paused" });
    named(spy.root, "达成本阶段").click();
    expect(spy.mutate).toHaveBeenLastCalledWith({ op: "milestoneReach", threadId: T.main, milestoneId: "m3" });
    named(spy.root.querySelector(".spinoff")!, "本对话处理").click();
    expect(spy.mutate).toHaveBeenLastCalledWith({ op: "spinoffKeep", threadId: T.main, spinoffId: "s2" });
    named(taskRow(spy.root, "回复 review 意见"), "完成").click();
    expect(spy.mutate).toHaveBeenLastCalledWith({ op: "taskDone", threadId: T.main, taskId: "t4" });
    spy.root.querySelector<HTMLAnchorElement>(".row.news a.ref-link")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(spy.calls).toContainEqual(["refs.seen", { key: ref42.key }]);
    expect(spy.root.querySelector("[data-confirm]")).toBeNull();
    expect(spy.live()).toBe("");
  });
});
