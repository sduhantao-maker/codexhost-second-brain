/**
 * The page each README image is taken from. Only the host around the extension is mocked here (a
 * plain codexhost-like window: a sidebar of conversations, a conversation, a selection toolbar);
 * everything the extension draws is its real code, fed from the demo data through demoBackend():
 * the overview page (`mount`), and on the "web" surface the sidebar hover card (`startHover`) and
 * the ★ Save button (`startFavorites`), driven by the real controller and web adapter.
 *
 * The "summary" scene is not for the README: it shows "🔔 N" (news whose conversation has no row in
 * sight) at the top of a mock codexhost Web sidebar and of a mock Codex Desktop sidebar, through the
 * real Web and Desktop adapters, so that one can check by eye that it covers none of the host's text
 * or buttons.
 *
 * scripts/screenshots/run.mjs bundles this file, opens it in headless Chrome with a scene in
 * `window.__SCENE__`, and calls `__finish()` once the scene is ready to learn what to capture.
 */
import type { Locale } from "../../src/core/model.js";
import { createDesktopAdapter } from "../../src/desktop/adapter.js";
import type { DesktopApi, DesktopSidebarRow, PageApi, StorageApi, WebApi } from "../../src/host/types.js";
import { mount } from "../../src/page/index.js";
import { startController } from "../../src/ui/controller.js";
import { startFavorites } from "../../src/ui/favorites/index.js";
import { startHover } from "../../src/ui/hover/index.js";
import { createWebAdapter } from "../../src/web/adapter.js";
import { demoBackend } from "./backend.js";
import { demo, IDS, type Demo } from "./demo.js";

export interface Scene {
  scene: "hover" | "save" | "overview" | "summary";
  locale: Locale;
  scheme: "light" | "dark";
  /** The overview's tab. */
  tab?: "conversations" | "favorites" | "refs";
  /** The summary scene: whose sidebar is mocked, and whether the summary's list is open. */
  surface?: "web" | "desktop";
  list?: boolean;
  /** The time the demo data is relative to. */
  now: number;
  /** The extension's icon, as a data URL, for the overview page's tab. */
  icon?: string;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

declare global {
  interface Window {
    __SCENE__: Scene;
    __state?: "ready" | "failed";
    __error?: string;
    /** Where the pointer rests, for the runner to move the mouse there. */
    __target?: () => { x: number; y: number };
    /** Lays the scene out for the capture and says what to capture. */
    __finish?: () => Promise<Rect>;
  }
}

const SVG = "http://www.w3.org/2000/svg";
const scene = window.__SCENE__;
const data: Demo = demo(scene.locale, scene.now);
const invoke = demoBackend(data);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: Array<Node | string | null>): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  for (const child of children) if (child !== null) node.append(child);
  return node;
}

/** A small line icon of the mock host: a speech bubble, a folder, a plus, an arrow, codexhost Web's "add to chat", and a few sidebar tools. */
function glyph(name: "chat" | "folder" | "plus" | "send" | "addToChat" | "search" | "sidebar" | "filter" | "chevronDown" | "chevronRight", className: string): SVGSVGElement {
  const paths = {
    chat: ["M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7.5L4.5 14v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z"],
    folder: ["M2 4.5a1 1 0 0 1 1-1h3.2l1.4 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"],
    plus: ["M8 3.5v9", "M3.5 8h9"],
    send: ["M8 13V3.5", "M4 7.5 8 3.5l4 4"],
    addToChat: ["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z", "M12 7v6", "M9 10h6"],
    search: ["M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9z", "M10.3 10.3 14 14"],
    sidebar: ["M2.5 3.5h11v9h-11z", "M6 3.5v9"],
    filter: ["M2.5 4h11", "M4.5 8h7", "M6.5 12h3"],
    chevronDown: ["M4.5 6.5 8 10l3.5-3.5"],
    chevronRight: ["M6.5 4.5 10 8l-3.5 3.5"],
  }[name];
  const big = name === "addToChat";
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", big ? "0 0 24 24" : "0 0 16 16");
  svg.setAttribute("class", className);
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", big ? "2" : "1.4");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  for (const d of paths) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/** The arrow of the mouse pointer, which headless Chrome does not draw itself. */
function pointer(x: number, y: number): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 20 24");
  svg.setAttribute("class", "pointer");
  svg.style.left = `${x}px`;
  svg.style.top = `${y}px`;
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", "M1.5 1.5v17.2l4.3-4.1 2.9 6.6 3-1.3-2.9-6.5h6z");
  path.setAttribute("fill", "#111");
  path.setAttribute("stroke", "#fff");
  path.setAttribute("stroke-width", "1.5");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

const storage: StorageApi = { get: async () => ({}), set: async (values) => values, onChange: () => () => undefined };

/** The host's sidebar: workspaces with their conversations, the open one selected. */
function sidebar(selected: string): HTMLElement {
  const groups = data.sidebar.map((group) =>
    el(
      "div",
      { class: "ws" },
      el("div", { class: "ws-head" }, glyph("folder", "ws-icon"), el("span", {}, group.workspace)),
      ...group.rows.map((row) =>
        el(
          "div",
          {
            class: "row",
            role: "treeitem",
            "data-row-key": `session:${row.threadId}`,
            ...(row.threadId === selected ? { "aria-current": "page", "aria-selected": "true" } : {}),
          },
          glyph("chat", "row-icon"),
          el("span", { class: "row-title" }, row.title),
        ),
      ),
    ),
  );
  return el(
    "aside",
    { class: "sidebar", "data-cx-region": "sidebar" },
    el("div", { class: "new-chat" }, glyph("plus", "new-icon"), el("span", {}, data.host.newChat)),
    el("div", { class: "side-list" }, ...groups),
  );
}

/**
 * The host's conversation: a header, the user's message, the agent's reply and the composer. Behind
 * the hover card the messages are only sketched (no `messages`), so no sentence is cut off by the card.
 */
function conversation(title: string, messages?: { user: string; reply: readonly string[] }): HTMLElement {
  const sketch = !messages;
  const bars = (widths: readonly number[]) => widths.map((width) => el("div", { class: "bar", style: `width: ${width}%` }));
  return el(
    "main",
    { class: "main", "data-cx-region": "conversation" },
    el("header", { class: "topbar", "data-cx-region": "topbar" }, el("span", { class: "topbar-title" }, title)),
    el(
      "div",
      { class: sketch ? "thread sketch" : "thread" },
      messages
        ? el("div", { class: "msg user", "data-chat-flow-kind": "user" }, el("div", { class: "bubble" }, messages.user))
        : el("div", { class: "msg user" }, el("div", { class: "bubble" }, ...bars([100]))),
      messages
        ? el("div", { class: "msg agent", "data-chat-flow-kind": "assistant" }, ...messages.reply.map((text) => el("p", {}, text)))
        : el("div", { class: "msg agent" }, el("div", { class: "para" }, ...bars([96, 88, 64])), el("div", { class: "para" }, ...bars([92, 40]))),
    ),
    el("div", { class: "composer" }, el("span", { class: "composer-hint" }, data.host.composer), el("span", { class: "send" }, glyph("send", "send-icon"))),
  );
}

function webApi(): WebApi {
  return {
    id: "second-brain",
    apiVersion: 1,
    signal: new AbortController().signal,
    dom: { mount: () => undefined },
    track: () => undefined,
    assets: { url: (path) => path },
    storage,
    backend: { invoke },
  };
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(test: () => boolean, what: string, ms = 5000): Promise<void> {
  const started = performance.now();
  while (!test()) {
    if (performance.now() - started > ms) throw new Error(`Timed out waiting for ${what}`);
    await sleep(25);
  }
}

function rectOf(element: Element): Rect {
  const box = element.getBoundingClientRect();
  return { x: Math.round(box.left), y: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) };
}

function canvas(): HTMLElement {
  const root = el("div", { class: "canvas", "data-scheme": scene.scheme, "data-scene": scene.scene });
  document.body.append(root);
  return root;
}

// ---------------------------------------------------------------------------------------------
// The sidebar hover card

async function hoverScene(): Promise<void> {
  const root = canvas();
  const frame = el("div", { class: "window" }, sidebar(data.open.threadId), conversation(data.open.title));
  root.append(frame);
  const adapter = createWebAdapter(webApi(), document);
  const controller = startController(adapter);
  startHover(adapter, controller);
  await controller.refresh();
  const row = document.querySelector<HTMLElement>(`[data-row-key="session:${IDS.login}"]`)!;
  // The bell of the conversation whose PR was merged, beside its row.
  await until(() => Boolean(hoverRoot()?.querySelector(".news-marker:not([hidden])")), "the news bell");
  // Where the mouse goes: on the row's title.
  window.__target = () => {
    const box = row.getBoundingClientRect();
    return { x: Math.round(box.left + 80), y: Math.round(box.top + box.height / 2) };
  };
  window.__finish = async () => {
    const card = () => hoverRoot()?.querySelector<HTMLElement>(".card:not([hidden])");
    const badge = () => hoverRoot()?.querySelector<HTMLElement>(".badge:not([hidden])");
    await until(() => Boolean(card()?.querySelector(".head")), "the hover card");
    await until(() => Boolean(badge()), "the progress badge");
    // The window reaches below the card, as a real window would.
    const bottom = card()!.getBoundingClientRect().bottom;
    const top = frame.getBoundingClientRect().top;
    frame.style.height = `${Math.ceil(bottom - top + 18)}px`;
    await nextFrame();
    // Headless Chrome draws no mouse pointer: one is drawn resting after the row's title, clear of
    // its text and of the progress badge.
    const words = document.createRange();
    words.selectNodeContents(row.querySelector(".row-title")!);
    const end = words.getBoundingClientRect().right;
    const box = row.getBoundingClientRect();
    const tip = Math.min(end + 10, badge()!.getBoundingClientRect().left - 17);
    root.append(pointer(Math.round(tip) - 2, Math.round(box.top + box.height / 2)));
    await nextFrame();
    return rectOf(root);
  };
}

const hoverRoot = () => document.querySelector("[data-codexhost-mainline-hover]")?.shadowRoot ?? null;

// ---------------------------------------------------------------------------------------------
// Saving a passage of a reply

async function saveScene(): Promise<void> {
  const root = canvas();
  const view = conversation(data.save.title, data.save);
  // codexhost Web's own bar over selected text in a reply: "添加到对话 | 添加批注" ("Add to chat | Add comment").
  const toolbar = el(
    "div",
    { class: "selection-toolbar" },
    el("button", { type: "button" }, glyph("addToChat", "toolbar-icon"), el("span", {}, data.host.addToChat)),
    el("button", { type: "button" }, el("span", {}, data.host.annotate)),
  );
  toolbar.hidden = true;
  document.body.append(toolbar);
  const frame = el("div", { class: "window" }, sidebar(data.save.threadId), view);
  root.append(frame);
  const adapter = createWebAdapter(webApi(), document);
  const controller = startController(adapter);
  startFavorites(adapter, controller);
  await controller.refresh();
  await until(() => controller.current() === data.save.threadId, "the open conversation");

  // The passage, as the user would select it in the reply.
  const paragraph = [...view.querySelectorAll<HTMLElement>(".msg.agent p")].find((p) => p.textContent === data.save.passage)!;
  const text = paragraph.firstChild as Text;
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, text.data.length);
  // Where codexhost Web puts its bar: 8 px above the selection's last line, ending where that line ends.
  const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 || rect.height > 0);
  const last = rects[rects.length - 1]!;
  toolbar.hidden = false;
  const bar = toolbar.getBoundingClientRect();
  toolbar.style.left = `${Math.round(Math.max(8, last.right - bar.width))}px`;
  toolbar.style.top = `${Math.round(last.top - 8 - bar.height)}px`;
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  window.__finish = async () => {
    const button = () => document.querySelector("[data-codexhost-mainline-favorites]")?.shadowRoot?.querySelector<HTMLElement>(".fav:not([hidden])");
    await until(() => Boolean(button()), "the ★ Save button");
    // Placed again once the host's toolbar is there (120 and 360 ms after showing).
    await sleep(500);
    return rectOf(root);
  };
}

// ---------------------------------------------------------------------------------------------
// The overview page

/**
 * Ends the window at `bottom` (a viewport y), fading out what goes on below, so a long page makes
 * an image of a sensible height.
 */
function cut(frame: HTMLElement, bottom: number): void {
  const top = frame.getBoundingClientRect().top;
  frame.style.height = `${Math.ceil(bottom - top)}px`;
  frame.classList.add("cut");
}

async function overviewScene(): Promise<void> {
  const root = canvas();
  const page = el("div", { class: "page-root" });
  // The host shows the page under a tab of its own; the page's own heading is for screen readers.
  const tabs = el("div", { class: "host-tabs" }, el("div", { class: "host-tab" }, scene.icon ? el("img", { class: "host-tab-icon", src: scene.icon, alt: "" }) : null, el("span", {}, data.host.page)));
  const frame = el("div", { class: "window page-window" }, tabs, page);
  root.append(frame);
  const api: PageApi = {
    id: "second-brain",
    apiVersion: 1,
    hostTarget: "web",
    locale: scene.locale,
    onLocaleChange: () => () => undefined,
    colorScheme: scene.scheme,
    onColorSchemeChange: () => () => undefined,
    signal: new AbortController().signal,
    storage,
    backend: { invoke },
  };
  await mount(page, api);
  const tab = scene.tab ?? "conversations";
  if (tab === "conversations") {
    // The last conversation in the list, opened: the groups by time above it stay in sight.
    const line = () => document.querySelector<HTMLElement>(`.mlp-node[data-thread-id="${IDS.docs}"] > .mlp-row`);
    await until(() => Boolean(line()), "the conversation list");
    line()!.click();
    await until(() => Boolean(document.querySelector(`.mlp-node[data-thread-id="${IDS.docs}"] > .mlp-detail`)), "the opened conversation");
  } else {
    await until(() => Boolean(document.querySelector(`[data-tab="${tab}"]`)), "the tabs");
    document.querySelector<HTMLElement>(`[data-tab="${tab}"]`)!.click();
    const item = tab === "favorites" ? ".mlp-favorite" : ".mlp-ref";
    await until(() => document.querySelectorAll(item).length > 0, `the ${tab} tab`);
  }
  // No control has the focus: nothing is drawn as focused.
  (document.activeElement as HTMLElement | null)?.blur();
  window.__finish = async () => {
    await sleep(300);
    // Down to what the image is about, the rest fading out.
    const bottomOf = (selector: string, index: number) => [...document.querySelectorAll(selector)][index]?.getBoundingClientRect().bottom;
    const end =
      tab === "conversations"
        ? bottomOf(`.mlp-node[data-thread-id="${IDS.docs}"] .mlp-ms[data-state="planned"]`, 0)
        : tab === "favorites"
          ? bottomOf(".mlp-favorite", 1)
          : bottomOf(".mlp-ref", 2);
    if (end !== undefined) cut(frame, end + (tab === "conversations" ? 30 : tab === "favorites" ? 64 : 54));
    await nextFrame();
    return rectOf(root);
  };
}

// ---------------------------------------------------------------------------------------------
// The summary of news whose conversation has no row in sight

/** A conversation row of the mock sidebars: an icon and the title, `attrs` saying whose it is. */
function mockRow(threadId: string, attrs: Record<string, string>, selected: boolean): HTMLElement {
  return el("div", { class: "row", ...attrs, ...(selected ? { "aria-current": "page", "aria-selected": "true" } : {}) }, glyph("chat", "row-icon"), el("span", { class: "row-title" }, data.info[threadId]?.title ?? threadId));
}

/** A small icon button of the mock host. */
function tool(name: "search" | "sidebar" | "filter" | "plus" | "folder", label: string): HTMLElement {
  return el("button", { class: "tool", type: "button", "aria-label": label, title: label }, glyph(name, "tool-icon"));
}

/**
 * codexhost Web's sidebar, as far as the summary is concerned: its name and two small buttons on
 * top, "New chat", the Recent list (where the conversation with PR #42 is), and the workspaces,
 * collapsed (their conversations, the one with PR #45 among them, are not listed).
 */
function webSidebar(selected: string): HTMLElement {
  const h = data.host;
  const recent = [IDS.login, IDS.coupon, IDS.ipad].map((id) => mockRow(id, { role: "treeitem", "data-row-key": `recent:${id}` }, id === selected));
  const workspace = (name: string) =>
    el("div", { class: "ws-head folded", role: "treeitem", "aria-expanded": "false", "data-row-key": `workspace:${name}` }, glyph("chevronRight", "ws-chevron"), glyph("folder", "ws-icon"), el("span", {}, name));
  return el(
    "aside",
    { class: "sidebar mock-side", "data-cx-region": "sidebar" },
    el("div", { class: "side-head" }, el("span", { class: "brand" }, "codexhost"), el("span", { class: "tools" }, tool("search", h.search), tool("sidebar", h.hideSidebar))),
    el("div", { class: "new-chat" }, glyph("plus", "new-icon"), el("span", {}, h.newChat)),
    el("div", { class: "side-section" }, h.recent),
    ...recent,
    el("div", { class: "side-section" }, h.workspaces),
    workspace("shop-web"),
    workspace("docs-site"),
  );
}

/**
 * Codex Desktop's sidebar: the window's close, minimize and zoom buttons and a button to hide the
 * sidebar on top, "New chat" and "Search", then the list of conversations by project, which
 * scrolls. The project holding the conversation with PR #45 is collapsed: its row is there but
 * hidden (display: none), as Desktop leaves it.
 */
function desktopSidebar(selected: string): { element: HTMLElement; rows: Array<{ element: HTMLElement; threadId: string }> } {
  const h = data.host;
  const rows: Array<{ element: HTMLElement; threadId: string }> = [];
  const row = (id: string) => {
    const element = mockRow(id, { "data-app-action-sidebar-thread-row": "", ...(id === selected ? { "data-app-action-sidebar-thread-active": "true" } : {}) }, id === selected);
    rows.push({ element, threadId: id });
    return element;
  };
  const project = (name: string, ids: readonly string[], open: boolean) =>
    el(
      "div",
      { class: "d-project" },
      el("div", { class: "ws-head", role: "button", "aria-expanded": String(open) }, glyph(open ? "chevronDown" : "chevronRight", "ws-chevron"), glyph("folder", "ws-icon"), el("span", {}, name)),
      el("div", { class: "d-rows", ...(open ? {} : { style: "display: none" }) }, ...ids.map(row)),
    );
  const lights = el("span", { class: "lights", "aria-hidden": "true" }, ...["#ff5f57", "#febc2e", "#28c840"].map((color) => el("button", { class: "light", type: "button", tabindex: "-1", style: `background: ${color}` })));
  const element = el(
    "aside",
    { class: "sidebar mock-side desktop-side" },
    el("div", { class: "titlebar" }, lights, tool("sidebar", h.hideSidebar)),
    el("div", { class: "nav-item", role: "button" }, glyph("plus", "new-icon"), el("span", {}, h.newChat)),
    el("div", { class: "nav-item", role: "button" }, glyph("search", "new-icon"), el("span", {}, h.search)),
    el(
      "div",
      { class: "d-scroll", "data-app-action-sidebar-scroll": "" },
      el("div", { class: "side-section with-tools" }, el("span", {}, h.threads), el("span", { class: "tools" }, tool("filter", h.filter), tool("folder", h.newProject))),
      project("shop-web", [IDS.login, IDS.ipad, IDS.coupon, IDS.search, IDS.perf, IDS.lazyload, IDS.export], true),
      project("shop-api", [IDS.payment], false),
      project("docs-site", [IDS.docs], true),
    ),
  );
  return { element, rows };
}

function desktopApi(rows: ReadonlyArray<{ element: HTMLElement; threadId: string }>): DesktopApi {
  const reported: DesktopSidebarRow[] = rows.map(({ element, threadId }) => ({ element, hostId: "local", isLocal: true, threadId, draftId: null, isConnected: () => element.isConnected }));
  return {
    id: "second-brain",
    apiVersion: 1,
    signal: new AbortController().signal,
    sidebar: {
      observeRows: (callback) => {
        callback(reported);
        return () => undefined;
      },
    },
    threads: { watchTree: () => () => undefined },
    navigate: { openThread: async () => undefined },
    dom: { mount: (node, parent) => void parent.append(node), mark: () => undefined, unmark: () => undefined },
    storage,
    backend: { invoke },
    track: () => undefined,
  };
}

async function summaryScene(): Promise<void> {
  const root = canvas();
  const desktop = scene.surface === "desktop";
  const selected = data.open.threadId;
  const mock = desktop ? desktopSidebar(selected) : { element: webSidebar(selected), rows: [] };
  const frame = el("div", { class: `window summary-window${desktop ? " desktop" : ""}` }, mock.element, conversation(data.open.title));
  root.append(frame);
  const adapter = desktop ? createDesktopAdapter(desktopApi(mock.rows), document) : createWebAdapter(webApi(), document);
  const controller = startController(adapter);
  startHover(adapter, controller);
  await controller.refresh();
  const summary = () => hoverRoot()?.querySelector<HTMLButtonElement>(".summary:not([hidden])") ?? null;
  await until(() => Boolean(summary()) && Boolean(hoverRoot()?.querySelector(".news-marker:not([hidden])")), "the summary and the bell");
  window.__finish = async () => {
    if (scene.list) {
      summary()!.click();
      await until(() => Boolean(hoverRoot()?.querySelector(".news-list:not([hidden]) .news-item")), "the list of news");
      // As after a click: nothing drawn as focused.
      (hoverRoot()?.activeElement as HTMLElement | null)?.blur();
    }
    await nextFrame();
    return rectOf(root);
  };
}

async function start(): Promise<void> {
  document.documentElement.lang = scene.locale;
  document.documentElement.dataset.scheme = scene.scheme;
  if (scene.scene === "hover") await hoverScene();
  else if (scene.scene === "save") await saveScene();
  else if (scene.scene === "summary") await summaryScene();
  else await overviewScene();
  await document.fonts.ready;
  window.__state = "ready";
}

start().catch((error: unknown) => {
  window.__error = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  window.__state = "failed";
});
