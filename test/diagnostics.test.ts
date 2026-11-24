// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEBUG_KEY, startController, type ControllerHandle, type SurfaceAdapter } from "../src/ui/controller.js";
import { startFavorites } from "../src/ui/favorites/index.js";
import { sampleSnapshot } from "./fixtures/v2.js";

beforeEach(() => {
  document.body.innerHTML = `<div data-chat-flow-kind="user-message"><p>hi</p></div>`;
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

/** A surface whose backend answers every poll with the same snapshot. */
function surface() {
  const asked: string[] = [];
  const describeCalls = vi.fn(() => ({ thread: "t1" }));
  let version = 1;
  const adapter: SurfaceAdapter = {
    surface: "web",
    doc: document,
    invoke: async (method, params) => {
      asked.push(method);
      if (method !== "snapshot") return { ok: true };
      const snapshot = sampleSnapshot();
      // A new version now and then, so what the surface sees has a reason to change.
      return (params as { version?: string } | undefined)?.version === `v${version}` ? { version: `v${version}` } : { ...snapshot, version: `v${version}` };
    },
    watchCurrentThread: (onChange) => {
      onChange(null);
      return () => undefined;
    },
    openThread: () => undefined,
    anchor: () => null,
    mount: (host) => document.body.append(host),
    describe: describeCalls,
  };
  return { adapter, asked, describeCalls, bump: () => (version += 1) };
}

describe("diagnostics", () => {
  it("are off unless the surface's debug flag is set: no measuring, no reports", async () => {
    vi.useFakeTimers();
    const { adapter, asked, describeCalls, bump } = surface();
    const controller = startController(adapter);
    const stopFavorites = startFavorites(adapter, controller);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(describeCalls).not.toHaveBeenCalled();
    expect(asked.filter((method) => method === "diagnose")).toEqual([]);

    // Set in the developer console of that window.
    localStorage.setItem(DEBUG_KEY, "1");
    bump();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(describeCalls).toHaveBeenCalled();
    expect(asked).toContain("diagnose");

    localStorage.removeItem(DEBUG_KEY);
    const reports = asked.filter((method) => method === "diagnose").length;
    const measured = describeCalls.mock.calls.length;
    bump();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(describeCalls.mock.calls.length).toBe(measured);
    expect(asked.filter((method) => method === "diagnose").length).toBe(reports);
    stopFavorites();
    controller.dispose();
  });

  it("let the favorites tell which message markup the surface has, only when on", async () => {
    vi.useFakeTimers();
    const run = async () => {
      const { adapter, asked } = surface();
      const controller: ControllerHandle = { dispose: () => undefined, refresh: async () => undefined, subscribe: () => () => undefined, current: () => "t1" };
      const stop = startFavorites(adapter, controller);
      await vi.advanceTimersByTimeAsync(5_000);
      stop();
      return asked.filter((method) => method === "diagnose").length;
    };
    expect(await run()).toBe(0);
    localStorage.setItem(DEBUG_KEY, "1");
    expect(await run()).toBe(1);
  });
});
