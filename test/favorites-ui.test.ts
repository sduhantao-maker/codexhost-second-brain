// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Reveal } from "../src/core/rpc.js";
import type { ControllerHandle, LiveData, SurfaceAdapter } from "../src/ui/controller.js";
import { findPassage, messageOf, roleOf } from "../src/ui/favorites/find.js";
import { buttonSpot, HOST_ATTRIBUTE, hostToolbar, SETTLE_MS, startFavorites } from "../src/ui/favorites/index.js";
import { sampleSnapshot } from "./fixtures/v2.js";

// A conversation as codexhost Web draws it: flow items for the user's message and the reply, the
// reply rendered from Markdown, and the composer below.
const PAGE = `
  <div data-cx-region="conversation">
    <div data-chat-flow-kind="user-message"><p>铃铛压在标题上了</p></div>
    <div data-chat-flow-kind="assistant-step" data-chat-group-part="response">
      <p><strong>原因</strong>：铃铛本来要放在行右侧按钮的左边。</p>
      <ol><li>找行内按钮时，超过 8 个字的文字不再当成按钮</li><li>悬停时的 ◆ 进度也更稳了</li></ol>
      <div class="code"><div class="code-head">ts<button>复制</button></div><pre><code>const gutter = 40;</code></pre></div>
      <p>详见 <a href="https://example.com/docs">codexhost 文档</a> 里的说明。</p>
    </div>
  </div>
  <textarea id="composer">发消息</textarea>`;

/** The same reply as `mainline fav last` saves it: its Markdown source. */
const REPLY_MARKDOWN = [
  "**原因**：铃铛本来要放在行右侧按钮的左边。",
  "",
  "1. 找行内按钮时，超过 8 个字的文字不再当成按钮",
  "2. 悬停时的 ◆ 进度也更稳了",
  "",
  "```ts",
  "const gutter = 40;",
  "```",
  "",
  "详见 [codexhost 文档](https://example.com/docs) 里的说明。",
].join("\n");

beforeEach(() => {
  document.documentElement.lang = "zh-CN";
  document.body.innerHTML = PAGE;
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
  document.getSelection()?.removeAllRanges();
});

describe("finding a passage on screen", () => {
  it("finds a reply saved as Markdown, across list numbers, code labels and links", () => {
    const range = findPassage(document, REPLY_MARKDOWN);
    expect(range).not.toBeNull();
    const shown = range!.toString();
    expect(shown.startsWith("原因")).toBe(true);
    expect(shown.endsWith("里的说明")).toBe(true);
  });

  it("finds a selection saved as shown, and nothing that is not there", () => {
    expect(findPassage(document, "找行内按钮时，超过 8 个字的文字不再当成按钮")?.toString()).toBe("找行内按钮时，超过 8 个字的文字不再当成按钮");
    expect(findPassage(document, "这句话不在对话里出现过")).toBeNull();
    // Text in the composer is not part of the conversation.
    expect(findPassage(document, "发消息")).toBeNull();
  });

  it("tells messages, the composer and who wrote what apart", () => {
    const reply = document.querySelector("li")!.firstChild!;
    expect(messageOf(reply)).toBe(document.querySelector('[data-chat-flow-kind="assistant-step"]'));
    expect(roleOf(reply)).toBe("agent");
    expect(roleOf(document.querySelector('[data-chat-flow-kind="user-message"] p'))).toBe("user");
    expect(messageOf(document.querySelector("#composer"))).toBeNull();
  });
});

describe("where the save button goes", () => {
  const view = { width: 1440, height: 900 };
  const size = { width: 64, height: 28 };
  const line = { left: 485, top: 461, right: 797, bottom: 485, width: 312, height: 24 };

  it("joins the host's selection toolbar on its right, or its left at the window's edge", () => {
    const toolbar = { left: 638, top: 429, right: 797, bottom: 456, width: 159, height: 27 };
    expect(buttonSpot([line], toolbar, size, view)).toEqual({ left: 803, top: 429, height: 27 });
    const atEdge = { left: 1300, top: 429, right: 1430, bottom: 456, width: 130, height: 27 };
    expect(buttonSpot([line], atEdge, size, view).left).toBe(1300 - 6 - 64);
  });

  it("goes above the selection without a toolbar, and below it at the top of the window", () => {
    expect(buttonSpot([line], null, size, view)).toEqual({ left: 765, top: 427, height: 28 });
    const high = { ...line, top: 10, bottom: 34 };
    expect(buttonSpot([high], null, size, view).top).toBe(40);
  });

  it("finds the host's toolbar next to the selection, not other popovers", () => {
    const toolbar = document.createElement("div");
    toolbar.className = "x9_popover";
    toolbar.innerHTML = "<button>添加到对话</button><button>添加批注</button>";
    const far = document.createElement("div");
    far.className = "menu_popover";
    far.innerHTML = "<button>别的</button>";
    document.body.append(toolbar, far);
    toolbar.getBoundingClientRect = () => DOMRect.fromRect({ x: 638, y: 429, width: 159, height: 27 });
    far.getBoundingClientRect = () => DOMRect.fromRect({ x: 600, y: 100, width: 159, height: 27 });
    const own = document.createElement("div");
    expect(hostToolbar(document, [line], own)).toMatchObject({ left: 638, top: 429, width: 159 });
    toolbar.remove();
    expect(hostToolbar(document, [line], own)).toBeNull();
  });
});

describe("saving a selection and showing a saved passage", () => {
  function surface() {
    const listeners = new Set<(version: string, data: LiveData) => void>();
    let current: string | null = "t1";
    const invoke = vi.fn(async (method: string, params?: unknown) => {
      if (method === "favorites.add") return { added: true, favorite: { id: "f1", ...(params as object) } };
      return { ok: true };
    });
    const controller: ControllerHandle = {
      dispose: () => undefined,
      refresh: async () => undefined,
      current: () => current,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const adapter: SurfaceAdapter = {
      surface: "web",
      doc: document,
      invoke,
      watchCurrentThread: () => () => undefined,
      openThread: () => undefined,
      anchor: () => null,
      mount: (host) => {
        document.body.append(host);
        return () => host.remove();
      },
    };
    const emit = (reveal?: Reveal) => {
      const snapshot = sampleSnapshot();
      const data: LiveData = {
        state: snapshot.state!,
        info: {},
        settings: snapshot.settings!,
        version: "v2",
        alerts: [],
        parents: {},
        ...(reveal ? { reveal } : {}),
      };
      for (const listener of listeners) listener("v2", data);
    };
    return { adapter, controller, invoke, emit, open: (threadId: string | null) => (current = threadId) };
  }

  const button = () => document.querySelector(`[${HOST_ATTRIBUTE}]`)!.shadowRoot!.querySelector<HTMLButtonElement>("button.fav")!;

  function select(node: Node, from: number, to: number) {
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    const range = document.createRange();
    range.setStart(node, from);
    range.setEnd(node, to);
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    document.dispatchEvent(new Event("pointerup"));
  }

  beforeEach(() => {
    // jsdom does not lay out: give ranges a box.
    Range.prototype.getClientRects = function () {
      return [DOMRect.fromRect({ x: 485, y: 461, width: 312, height: 24 })] as unknown as DOMRectList;
    };
    Element.prototype.scrollIntoView = function () {};
  });

  it("shows the button for text in a message, saves it with its conversation, then says so", async () => {
    vi.useFakeTimers();
    const { adapter, controller, invoke } = surface();
    const stop = startFavorites(adapter, controller);
    const text = document.querySelector("li")!.firstChild!;
    select(text, 0, 10);
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 10);
    expect(button().hidden).toBe(false);
    expect(button().style.top).toBe("427px");
    button().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledWith("favorites.add", { threadId: "t1", text: "找行内按钮时，超过", role: "agent" });
    expect(button().textContent).toContain("已收藏");
    await vi.advanceTimersByTimeAsync(2000);
    expect(button().hidden).toBe(true);
    stop();
    expect(document.querySelector(`[${HOST_ATTRIBUTE}]`)).toBeNull();
  });

  it("shows nothing for the composer, a single character, or with no conversation open", async () => {
    vi.useFakeTimers();
    const { adapter, controller, open } = surface();
    const stop = startFavorites(adapter, controller);
    const composer = document.querySelector<HTMLTextAreaElement>("#composer")!;
    select(composer.firstChild!, 0, 3);
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 10);
    expect(button().hidden).toBe(true);
    select(document.querySelector("li")!.firstChild!, 0, 1);
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 10);
    expect(button().hidden).toBe(true);
    open(null);
    select(document.querySelector("li")!.firstChild!, 0, 10);
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 10);
    expect(button().hidden).toBe(true);
    stop();
  });

  it("finds and marks a passage the overview asked for, once, and reports it shown", async () => {
    vi.useFakeTimers();
    const { adapter, controller, invoke, emit } = surface();
    const stop = startFavorites(adapter, controller);
    emit({ id: "f9", threadId: "elsewhere", text: REPLY_MARKDOWN });
    expect(invoke).not.toHaveBeenCalledWith("favorites.revealed", expect.anything());
    emit({ id: "f1", threadId: "t1", text: REPLY_MARKDOWN });
    // jsdom has no Highlight API: the passage is selected instead.
    expect(document.getSelection()!.toString().startsWith("原因")).toBe(true);
    expect(invoke).toHaveBeenCalledWith("favorites.revealed", { id: "f1" });
    invoke.mockClear();
    emit({ id: "f1", threadId: "t1", text: REPLY_MARKDOWN });
    expect(invoke).not.toHaveBeenCalledWith("favorites.revealed", expect.anything());
    stop();
  });

  it("waits until the conversation is shown (Desktop's settings in front) before marking the passage", async () => {
    vi.useFakeTimers();
    const { adapter, controller, invoke, emit } = surface();
    const stop = startFavorites(adapter, controller);
    const shown = Range.prototype.getClientRects;
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    emit({ id: "f4", threadId: "t1", text: "找行内按钮时，超过 8 个字的文字不再当成按钮" });
    await vi.advanceTimersByTimeAsync(3000);
    expect(invoke).not.toHaveBeenCalledWith("favorites.revealed", expect.anything());
    expect(document.getSelection()!.toString()).toBe("");
    Range.prototype.getClientRects = shown;
    await vi.advanceTimersByTimeAsync(500);
    expect(invoke).toHaveBeenCalledWith("favorites.revealed", { id: "f4" });
    expect(document.getSelection()!.toString()).toBe("找行内按钮时，超过 8 个字的文字不再当成按钮");
    stop();
  });

  it("keeps looking while the conversation loads, and gives up with a note", async () => {
    vi.useFakeTimers();
    const { adapter, controller, invoke, emit } = surface();
    const stop = startFavorites(adapter, controller);
    const conversation = document.querySelector('[data-cx-region="conversation"]')!;
    const later = conversation.innerHTML;
    conversation.innerHTML = "";
    emit({ id: "f2", threadId: "t1", text: "找行内按钮时，超过 8 个字的文字不再当成按钮" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(invoke).not.toHaveBeenCalledWith("favorites.revealed", expect.anything());
    conversation.innerHTML = later;
    await vi.advanceTimersByTimeAsync(500);
    expect(invoke).toHaveBeenCalledWith("favorites.revealed", { id: "f2" });

    emit({ id: "f3", threadId: "t1", text: "从来没说过的一句话，找不到" });
    await vi.advanceTimersByTimeAsync(17_000);
    expect(invoke).toHaveBeenCalledWith("favorites.revealed", { id: "f3" });
    const toast = document.querySelector(`[${HOST_ATTRIBUTE}]`)!.shadowRoot!.querySelector<HTMLElement>(".toast")!;
    expect(toast.textContent).toContain("没在对话里找到");
    stop();
  });
});
