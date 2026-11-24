// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PageApi } from "../src/host/types.js";
import { mount as mountPage } from "../src/page/index.js";
import { ref42, refWidgets, sampleSnapshot } from "./fixtures/v2.js";

/** The overview page against a fake backend that records what it is asked. */
async function setup() {
  const asked: Array<[string, unknown]> = [];
  const invoke = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
    asked.push([method, params]);
    if (method === "snapshot") {
      const snapshot = sampleSnapshot();
      return (params as { version?: string } | undefined)?.version === snapshot.version ? { version: snapshot.version } : snapshot;
    }
    if (method === "refs.list")
      return {
        status: { conversations: { scanned: 40, listed: 100, done: true, unreadable: 0 }, refs: 2, github: { enabled: true } },
        refs: [ref42, refWidgets],
      };
    if (method === "favorites.list") return { items: [], titles: {}, total: 0 };
    if (method === "integration.status") return [];
    return { ok: true };
  });
  const api: PageApi = {
    id: "second-brain",
    apiVersion: 1,
    hostTarget: "web",
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
  disposers.push(await mountPage(root, api));
  const count = (method: string) => asked.filter(([name]) => name === method).length;
  return { root, asked, count };
}

const disposers: Array<() => void> = [];
let visibility: DocumentVisibilityState = "visible";

beforeEach(() => {
  document.body.replaceChildren();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.useRealTimers();
});

function show(state: DocumentVisibilityState) {
  visibility = state;
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("overview page polling", () => {
  it("asks the backend nothing while hidden, and catches up at once when shown again", async () => {
    vi.useFakeTimers();
    const { count } = await setup();
    await vi.advanceTimersByTimeAsync(9_100);
    // Every 3 seconds the snapshot, every 15 the PR list.
    expect([count("snapshot"), count("refs.list")]).toEqual([4, 1]);
    show("hidden");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect([count("snapshot"), count("refs.list")]).toEqual([4, 1]);
    show("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect([count("snapshot"), count("refs.list")]).toEqual([5, 2]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(count("snapshot")).toBe(6);
  });

  it("asks for fresh PR states only while the PR tab is on screen, at most once a minute", async () => {
    vi.useFakeTimers();
    const { root, asked } = await setup();
    const fresh = () => asked.filter(([method, params]) => method === "refs.list" && (params as { fresh?: boolean } | undefined)?.fresh === true).length;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(asked.filter(([method]) => method === "refs.list").length).toBe(3);
    expect(fresh()).toBe(0);
    // The PR tab comes on screen: its states are asked for with the next poll, not 15 seconds on.
    root.querySelector<HTMLButtonElement>('[data-tab="refs"]')!.click();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fresh()).toBe(1);
    // Within the minute its rounds only list them.
    await vi.advanceTimersByTimeAsync(45_000);
    expect(fresh()).toBe(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fresh()).toBe(2);
    // Another tab: no more.
    root.querySelector<HTMLButtonElement>('[data-tab="conversations"]')!.click();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fresh()).toBe(2);
  });
});
