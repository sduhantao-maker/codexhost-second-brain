// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeSettings, createDesktopAdapter, OPEN_EVENT } from "../src/desktop/adapter.js";
import type { DesktopApi } from "../src/host/types.js";

type ShellWindow = Window & { __codexhostSettingsShellV1?: { open: boolean; close: () => void } };

function fakeApi(openThread: (threadId: string) => Promise<void>): DesktopApi {
  return {
    id: "second-brain",
    apiVersion: 1,
    signal: new AbortController().signal,
    sidebar: { observeRows: () => () => undefined },
    threads: { watchTree: () => () => undefined },
    navigate: { openThread },
    dom: { mount: (node, parent) => parent.append(node), mark: () => undefined, unmark: () => undefined },
    storage: { get: async () => ({}), set: async (values) => values, onChange: () => () => undefined },
    backend: { invoke: async () => ({}) },
    track: () => undefined,
  };
}

/** Asks the surface to open a conversation, as the overview page does. */
function ask(threadId: string): { handled?: boolean; result?: Promise<void> } {
  const detail: { threadId: string; handled?: boolean; result?: Promise<void> } = { threadId };
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail }));
  return detail;
}

afterEach(() => {
  delete (window as ShellWindow).__codexhostSettingsShellV1;
});

describe("opening a conversation from the overview page on Desktop", () => {
  it("opens it, then closes codexhost's settings so the conversation shows", async () => {
    const order: string[] = [];
    const shell = { open: true, close: vi.fn(() => order.push("close settings")) };
    (window as ShellWindow).__codexhostSettingsShellV1 = shell;
    const adapter = createDesktopAdapter(fakeApi(async (threadId) => void order.push(`open ${threadId}`)));
    const detail = ask("t1");
    expect(detail.handled).toBe(true);
    await detail.result;
    expect(order).toEqual(["open t1", "close settings"]);
    adapter.dispose?.();
  });

  it("keeps the settings open when the conversation could not be opened, and says why", async () => {
    const shell = { open: true, close: vi.fn() };
    (window as ShellWindow).__codexhostSettingsShellV1 = shell;
    const adapter = createDesktopAdapter(fakeApi(async () => Promise.reject(new Error("Unknown local Desktop Thread"))));
    await expect(ask("elsewhere").result).rejects.toThrow("Unknown local Desktop Thread");
    expect(shell.close).not.toHaveBeenCalled();
    adapter.dispose?.();
  });

  it("leaves closed settings and a missing shell alone", () => {
    expect(closeSettings(window)).toBe(false);
    const shell = { open: false, close: vi.fn() };
    (window as ShellWindow).__codexhostSettingsShellV1 = shell;
    expect(closeSettings(window)).toBe(false);
    expect(shell.close).not.toHaveBeenCalled();
  });
});
