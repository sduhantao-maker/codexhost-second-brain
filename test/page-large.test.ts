// @vitest-environment jsdom
/**
 * Release audit, finding 3, on the overview page: with 2,000 conversations the snapshot sends most
 * of them as outlines, and the favorites list sends excerpts a page at a time. The page shows the
 * outlined rows with their progress, reads a row's milestones and tasks from the backend when it
 * opens it, pages through saved passages, and shows and copies a passage cut short in full.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fitSnapshot } from "../src/backend/reply-size.js";
import type { StateV2 } from "../src/core/conversation.js";
import { conversationView } from "../src/core/conversation-view.js";
import { DEFAULT_SETTINGS } from "../src/core/model.js";
import type { FavoriteExcerpt, FavoritesList, FavoritesListParams, SnapshotResultV2 } from "../src/core/rpc.js";
import type { PageApi } from "../src/host/types.js";
import { mount } from "../src/page/index.js";
import { largeState, threadIdOf } from "./fixtures/large.js";

const NOW = Date.now();
const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  document.body.replaceChildren();
});

function snapshotOf(state: StateV2, budget?: number): SnapshotResultV2 {
  return fitSnapshot(
    {
      version: "v1",
      state,
      info: {},
      settings: { ...DEFAULT_SETTINGS },
      command: "/x/mainline",
      alerts: [],
      parents: {},
      summarizer: { running: 0, queued: 0, today: { count: 0, limit: 200, calls: { claude: { auto: 0, manual: 0, backfill: 0 }, codex: { auto: 0, manual: 0, backfill: 0 } } } },
      workspaces: {},
      favorites: 0,
    },
    budget,
  );
}

async function page(respond: (method: string, params: unknown) => unknown) {
  const invoke = vi.fn(async (method: string, params?: unknown) => respond(method, params) ?? { ok: true });
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
  return { root, invoke };
}

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const rowOf = (root: ParentNode, threadId: string) => [...root.querySelectorAll<HTMLElement>(".mlp-node")].find((node) => node.dataset.threadId === threadId);
const calls = (invoke: ReturnType<typeof vi.fn>, method: string) => invoke.mock.calls.filter(([name]) => name === method).map(([, params]) => params);

describe("conversations sent as outlines", () => {
  it("keep the overview working at 2,000 conversations: rows with their progress, details read when opened", async () => {
    const state = largeState({ count: 2000, now: NOW, prompts: 300 });
    const snapshot = snapshotOf(state);
    expect(snapshot.outline).toBeDefined();
    const t0 = performance.now();
    const { root, invoke } = await page((method, params) => {
      if (method === "snapshot") return snapshot;
      if (method === "conversation") return conversationView((params as { threadId: string }).threadId, { state, info: {}, parents: {} });
      if (method === "favorites.list") return { items: [], titles: {}, total: 0 };
      if (method === "refs.list") return { status: { conversations: { scanned: 0, listed: 0, done: true, unreadable: 0 }, refs: 0, github: { enabled: false } }, refs: [] };
      return undefined;
    });
    await flush();
    console.info(`overview with 2000 conversations (${Object.keys(snapshot.outline!).length} outlined): mounted in ${Math.round(performance.now() - t0)} ms`);
    expect(root.querySelector('[data-status-tab="done"] .mlp-seg-count')!.textContent).toBe("1400");
    expect(root.querySelector('[data-status-tab="active"] .mlp-seg-count')!.textContent).toBe("400");
    // The oldest finished conversation is an outline: its row still shows its progress and current milestone.
    root.querySelector<HTMLButtonElement>('[data-status-tab="done"]')!.click();
    await flush();
    const oldest = threadIdOf(1996);
    expect(snapshot.outline![oldest]).toEqual([2, 4]);
    const row = rowOf(root, oldest)!.querySelector<HTMLElement>(":scope > .mlp-row")!;
    expect(row.querySelector(".mlp-row-progress")!.textContent).toBe("◆ 2/4");
    expect(row.querySelector(".mlp-row-current")!.textContent).toBe(state.conversations[oldest]!.milestones[2]!.title);
    // Opened, it shows what the outline left out, from the backend's view.
    row.click();
    await flush();
    expect(calls(invoke, "conversation")).toContainEqual({ threadId: oldest });
    await vi.waitFor(() => expect(rowOf(root, oldest)!.querySelectorAll(":scope > .mlp-detail .mlp-ms")).toHaveLength(4));
    expect(rowOf(root, oldest)!.querySelectorAll(".mlp-task")).toHaveLength(12);
    expect(rowOf(root, oldest)!.querySelector(".mlp-detail-tags")!.textContent).toContain("tag-a");
  }, 30_000);
});

describe("saved passages sent as excerpts", () => {
  const whole = (i: number) => `第 ${i} 段：${"内容".repeat(500)} 结尾-${i}。`;
  const excerpt = (i: number): FavoriteExcerpt => ({ id: `f${i}`, threadId: threadIdOf(i), text: Array.from(whole(i)).slice(0, 600).join(""), truncated: true, source: "select", createdAt: NOW - i * 1000 });

  function favorites(params: FavoritesListParams): FavoritesList {
    const query = params.query ?? "";
    // The backend searches whole passages: "结尾-7。" is only in the part the list leaves out.
    const all = Array.from({ length: 150 }, (_, i) => i).filter((i) => !query || whole(i).includes(query));
    const offset = params.offset ?? 0;
    const page = all.slice(offset, offset + (params.limit ?? 100)).map(excerpt);
    const next = offset + page.length;
    return { items: page, titles: {}, total: 150, matched: all.length, ...(next < all.length ? { nextOffset: next } : {}) };
  }

  it("page through them, and show, find and copy a passage cut short in full", async () => {
    const copied: string[] = [];
    Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => void copied.push(text) } });
    const { root, invoke } = await page((method, params) => {
      if (method === "snapshot") return snapshotOf(largeState({ count: 2, now: NOW }));
      if (method === "favorites.list") return favorites(params as FavoritesListParams);
      if (method === "favorites.get") return { favorite: { ...excerpt(Number((params as { id: string }).id.slice(1))), text: whole(Number((params as { id: string }).id.slice(1))), truncated: undefined } };
      return undefined;
    });
    root.querySelector<HTMLButtonElement>('.mlp-tab[data-tab="favorites"]')!.click();
    await flush();
    const cards = () => [...root.querySelectorAll<HTMLElement>(".mlp-favorite")];
    expect(cards()).toHaveLength(100);
    const more = [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "显示更多（还有 50 条）")!;
    more.focus();
    more.click();
    await flush();
    expect(cards()).toHaveLength(150);
    // The button went with the last page: the focus goes to the search box, not to the page's body.
    expect(document.activeElement?.getAttribute("data-key")).toBe("favorites-search");
    // The list is read again from the start, as long as it is shown now (a page in each answer at most).
    expect(calls(invoke, "favorites.list").at(-1)).toEqual({ limit: 200 });
    expect(root.textContent).not.toContain("显示更多");

    // Shown in full: the whole text is read from the backend.
    const first = () => cards().find((card) => card.dataset.favorite === "f3")!;
    expect(first().textContent).not.toContain("结尾-3");
    const unfold = [...first().querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "展开全文")!;
    unfold.focus();
    unfold.click();
    await flush();
    expect(calls(invoke, "favorites.get")).toEqual([{ id: "f3" }]);
    expect(first().textContent).toContain("结尾-3");
    // Redrawn with the whole text: the focus stays on the same control, now "收起".
    expect(document.activeElement?.textContent).toBe("收起");
    expect(first().contains(document.activeElement)).toBe(true);

    // Copied in full.
    const other = cards().find((card) => card.dataset.favorite === "f5")!;
    const copy = [...other.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "复制")!;
    copy.focus();
    copy.click();
    await flush();
    expect(copied).toEqual([whole(5)]);
    expect(document.activeElement?.getAttribute("data-key")).toBe("favorite-copy:f5");

    // Found by words the list left out: the backend's answer is shown as it is.
    const search = root.querySelector<HTMLInputElement>('input[data-key="favorites-search"]')!;
    search.value = "结尾-7。";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    expect(calls(invoke, "favorites.list").at(-1)).toMatchObject({ query: "结尾-7。" });
    await vi.waitFor(() => expect(cards().map((card) => card.dataset.favorite)).toEqual(["f7"]));
  });
});
