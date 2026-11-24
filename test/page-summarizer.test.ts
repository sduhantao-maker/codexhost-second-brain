// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SummarizerStatus } from "../src/core/rpc.js";
import type { PageApi } from "../src/host/types.js";
import { mount } from "../src/page/index.js";
import { sampleSnapshot, T } from "./fixtures/v2.js";

const disposers: Array<() => void> = [];

beforeEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

function status(patch: Partial<SummarizerStatus> = {}): SummarizerStatus {
  return {
    running: 0,
    queued: 0,
    today: { count: 12, limit: 200, calls: { claude: { auto: 9, manual: 2, backfill: 0 }, codex: { auto: 3, manual: 0, backfill: 5 } } },
    toBackfill: 37,
    ...patch,
  };
}

/** The overview page against a fake backend whose summarizer reports `current`. */
async function setup(options: { locale?: string; current: () => SummarizerStatus; respond?: (method: string, params: unknown) => unknown }) {
  const invoke = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
    const custom = options.respond?.(method, params);
    if (custom !== undefined) return custom;
    if (method === "snapshot") return { ...sampleSnapshot(), version: JSON.stringify(options.current()), summarizer: options.current() };
    return { ok: true };
  });
  const set = vi.fn(async (values: Record<string, unknown>) => values);
  const api: PageApi = {
    id: "second-brain",
    apiVersion: 1,
    hostTarget: "desktop",
    locale: options.locale ?? "zh-CN",
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
  return { root, invoke, set };
}

async function flush(): Promise<void> {
  for (let round = 0; round < 3; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function showTab(root: HTMLElement, tab: "conversations" | "settings"): Promise<void> {
  root.querySelector<HTMLButtonElement>(`.mlp-tab[data-tab="${tab}"]`)!.click();
  await flush();
}

const line = (root: HTMLElement) => root.querySelector<HTMLElement>(".mlp-settings .mlp-summarizer");
const button = (scope: ParentNode, text: string) => [...scope.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === text);
const calls = (invoke: ReturnType<typeof vi.fn>, method: string) => invoke.mock.calls.filter(([name]) => name === method);

describe("overview page: model summaries", () => {
  it("shows today's counts, and starts the backfill only on a second click, saying how many conversations it sends", async () => {
    const { root, invoke } = await setup({ current: () => status() });
    await showTab(root, "settings");
    await vi.waitFor(() => expect(line(root)?.textContent).toContain("今天自动凝练 12/200（Claude 9，Codex 3）"));
    expect(line(root)!.textContent).toContain("手动凝练 2，整理旧对话 5");
    const start = button(line(root)!, "整理旧对话：最多把 37 个对话发给模型")!;
    start.click();
    await flush();
    expect(calls(invoke, "summarize.backfill")).toEqual([]);
    button(line(root)!, "再点一次确认")!.click();
    await flush();
    expect(calls(invoke, "summarize.backfill")).toHaveLength(1);
  });

  it("stops a running backfill with one click, next to its progress", async () => {
    let current = status({ running: 1, queued: 4, backfill: { done: 3, total: 40, failed: 1, skipped: 2 } });
    delete current.toBackfill;
    const { root, invoke } = await setup({
      current: () => current,
      respond: (method) => {
        if (method !== "summarize.cancel") return undefined;
        current = status({ toBackfill: 34 });
        return current;
      },
    });
    // The conversations tab shows the progress, and the way to stop it, too.
    await vi.waitFor(() => expect(root.querySelector(".mlp-conversations .mlp-summarizer")?.textContent).toContain("模型正在整理旧对话：3/40，1 个没有成功，2 个其他 Agent 的对话按设置不发送"));
    expect(button(root.querySelector(".mlp-conversations .mlp-summarizer")!, "停止")).toBeDefined();
    await showTab(root, "settings");
    expect(button(line(root)!, "整理旧对话：最多把 37 个对话发给模型")).toBeUndefined();
    button(line(root)!, "停止")!.click();
    await vi.waitFor(() => expect(calls(invoke, "summarize.cancel")).toHaveLength(1));
    await vi.waitFor(() => expect(root.querySelector(".mlp-notice")?.textContent).toContain("已停止整理旧对话"));
    expect(button(line(root)!, "整理旧对话：最多把 34 个对话发给模型")).toBeDefined();
  });

  it("says how many conversations the backfill leaves out because the mainlines are full", async () => {
    const current = status({ running: 1, backfill: { done: 3, total: 40, failed: 0, skipped: 0, full: 12 } });
    delete current.toBackfill;
    const zh = await setup({ current: () => current });
    await vi.waitFor(() => expect(zh.root.querySelector(".mlp-conversations .mlp-summarizer")?.textContent).toContain("模型正在整理旧对话：3/40，12 个没有主线的对话因主线已满 2000 条不发送"));
    document.body.replaceChildren();
    const en = await setup({ locale: "en", current: () => current });
    await vi.waitFor(() =>
      expect(en.root.querySelector(".mlp-conversations .mlp-summarizer")?.textContent).toContain("Summarizing older conversations: 3/40, 12 without a mainline not sent: the mainlines are at their cap of 2,000"),
    );
  });

  it("says why the last summary sent nothing in the page's language", async () => {
    const current = status({ lastError: "Claude Code (the claude command) was not found on this computer: install it, or choose Codex for summaries in the settings", lastErrorCode: "CLAUDE_MISSING" });
    const { root } = await setup({ current: () => current });
    await showTab(root, "settings");
    await vi.waitFor(() => expect(line(root)?.textContent).toContain("最近一次凝练没有成功：没有找到 Claude Code（claude 命令）：请安装，或在设置里改用 Codex 凝练"));
  });

  it("sets which model, if any, summarizes other agents' conversations", async () => {
    const { root, set } = await setup({ current: () => status() });
    await showTab(root, "settings");
    const select = root.querySelector<HTMLSelectElement>('select[name="summarizeOthers"]')!;
    expect(select.value).toBe("none");
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "不凝练，不发给任何模型",
      "用 Claude Haiku 凝练：对话内容发给你的 Claude Code 所用的服务商",
      "用 Codex 凝练：对话内容发给你的 Codex 所用的服务商",
    ]);
    expect(root.querySelector(".mlp-settings")!.textContent).toContain("其他 Agent（如 pi、DeepSeek、Grok）的对话");
    select.value = "codex";
    select.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(set).toHaveBeenCalledWith(expect.objectContaining({ summarizeOthers: "codex" })));
  });

  it("says which setting keeps a conversation of another agent from being summarized", async () => {
    const { root } = await setup({
      current: () => status(),
      respond: (method) =>
        method === "summarize" ? Promise.reject(new Error('[NO_SUMMARIZER] This conversation runs on the agent "pi", not Claude Code or Codex')) : undefined,
    });
    await vi.waitFor(() => expect(root.querySelector(`.mlp-node[data-thread-id="${T.main}"] > .mlp-row`)).not.toBeNull());
    root.querySelector<HTMLElement>(`.mlp-node[data-thread-id="${T.main}"] > .mlp-row`)!.click();
    await flush();
    button(root, "重新凝练")!.click();
    await vi.waitFor(() => expect(root.querySelector(".mlp-error")?.textContent).toContain("「其他 Agent（如 pi、DeepSeek、Grok）的对话」选的是「不凝练，不发给任何模型」"));
  });

  it("speaks English when the page does", async () => {
    const { root } = await setup({ locale: "en-US", current: () => status() });
    await showTab(root, "settings");
    await vi.waitFor(() => expect(line(root)?.textContent).toContain("Automatic summaries today: 12/200 (Claude 9, Codex 3)"));
    expect(button(line(root)!, "Summarize older conversations: send up to 37 to the model")).toBeDefined();
    expect(root.querySelector('select[name="summarizeOthers"] option[value="none"]')?.textContent).toBe("Do not summarize; send them to no model");
  });
});
