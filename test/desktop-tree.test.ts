// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopAdapter, REPORT_AGAIN_MS } from "../src/desktop/adapter.js";
import type { DesktopApi, ThreadTreeSnapshot } from "../src/host/types.js";

let visibility: DocumentVisibilityState = "visible";
Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });

afterEach(() => {
  vi.useRealTimers();
  visibility = "visible";
});

describe("Desktop's thread tree", () => {
  it("is told again while unchanged, so the backend keeps it as its source, but not while hidden", async () => {
    vi.useFakeTimers();
    const reports: number[] = [];
    let emit: (tree: ThreadTreeSnapshot) => void = () => undefined;
    const api: DesktopApi = {
      id: "second-brain",
      apiVersion: 1,
      signal: new AbortController().signal,
      sidebar: { observeRows: () => () => undefined },
      threads: {
        watchTree: (listener) => {
          emit = listener;
          return () => undefined;
        },
      },
      navigate: { openThread: async () => undefined },
      dom: { mount: () => undefined, mark: () => undefined, unmark: () => undefined },
      storage: { get: async () => ({}), set: async (values) => values, onChange: () => () => undefined },
      backend: {
        invoke: async (method) => {
          if (method === "reportTree") reports.push(Date.now());
          return { ok: true };
        },
      },
      track: () => undefined,
    };
    const start = Date.now();
    const adapter = createDesktopAdapter(api, document);
    emit({ revision: 1, parents: { c: "p" }, nodes: { c: { harnessId: "codex", status: "running", archived: false }, p: { harnessId: "codex", status: "idle", archived: false } }, truncated: false });
    await vi.advanceTimersByTimeAsync(30_000);
    const times = reports.map((at) => at - start);
    expect(times[0]).toBe(2000);
    // Never longer apart than the backend keeps a report (20 seconds), and not much more often than needed.
    for (let i = 1; i < times.length; i += 1) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(REPORT_AGAIN_MS);
    for (let i = 1; i < times.length; i += 1) expect(times[i]! - times[i - 1]!).toBeLessThan(20_000);
    expect(times.length).toBe(3);
    visibility = "hidden";
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reports).toHaveLength(3);
    adapter.dispose?.();
  });
});
