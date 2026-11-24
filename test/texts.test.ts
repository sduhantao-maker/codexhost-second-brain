// @vitest-environment jsdom
/**
 * What the extension says: English has no Chinese punctuation (in the string tables, and in the
 * overview, the capsule and the hover card as drawn), backend errors are said by what caused them,
 * and the command line tells an agent what it can do next.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Integrations } from "../src/backend/integrations.js";
import { Uploads } from "../src/backend/uploads.js";
import { errorText, run } from "../src/cli/main.js";
import { ATTACH_MAX_FILE_BYTES, ATTACH_MAX_TOTAL_BYTES, formatSize } from "../src/core/attachments.js";
import { emptyStateV2 } from "../src/core/conversation.js";
import { addMilestone, createConversation, reachMilestone, setTitle } from "../src/core/conversation-ops.js";
import { addFavorite } from "../src/core/favorites.js";
import { DEFAULT_SETTINGS, ERROR_CODES, MainlineError } from "../src/core/model.js";
import { wordsV2 } from "../src/core/protocol-v2.js";
import type { PageApi } from "../src/host/types.js";
import { favoritesPaths, updateFavorites } from "../src/node/favorites-store.js";
import { updateState, storePaths, writeJsonFile } from "../src/node/store.js";
import { mount } from "../src/page/index.js";
import { pageStrings } from "../src/page/strings.js";
import { Capsule } from "../src/ui/capsule.js";
import { builder } from "../src/ui/dom.js";
import { failureReason, favoriteStrings } from "../src/ui/favorites/index.js";
import { cardNodes, COMPOSE_IDLE, type CardActions, type CardContext } from "../src/ui/hover/card.js";
import { hoverStrings } from "../src/ui/hover/strings.js";
import { strings } from "../src/ui/i18n.js";
import { NOW, ref42, refWidgets, sampleSearchResults, sampleSnapshot, sampleView, T } from "./fixtures/v2.js";

/** Punctuation that belongs to Chinese text only. */
const CHINESE_PUNCTUATION = /[：，（）、。「」]/u;
const HAN = /\p{Script=Han}/u;
const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/u;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "mainline-texts-"));
  document.body.replaceChildren();
  localStorage.clear();
});
afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});
const disposers: Array<() => void> = [];

// ---------------------------------------------------------------------------------------------
// Helpers

/** The same data in English: every string with Chinese in it becomes "Text N". Ids stay. */
function english<V>(value: V): V {
  const names = new Map<string, string>();
  const walk = (item: unknown): unknown => {
    if (typeof item === "string") {
      if (!CJK.test(item)) return item;
      if (!names.has(item)) names.set(item, `Text ${names.size + 1}`);
      return names.get(item);
    }
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, inner]) => [key, walk(inner)]));
    return item;
  };
  return walk(value) as V;
}

/** The text a surface shows and says: text nodes (not styles), titles, labels and placeholders. */
function shown(root: ParentNode): string[] {
  const out: string[] = [];
  const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.parentElement?.tagName !== "STYLE" && node.textContent?.trim()) out.push(node.textContent);
  for (const element of root.querySelectorAll("*"))
    for (const name of ["title", "aria-label", "placeholder"]) {
      const value = element.getAttribute(name);
      if (value) out.push(value);
    }
  return out;
}

const offending = (texts: readonly string[], pattern: RegExp) => texts.filter((text) => pattern.test(text));

const CODES = [undefined, ...ERROR_CODES, "ERROR"];
const MESSAGES = [
  "[X] At most 30 milestones",
  "[X] favorites.json is full",
  "[X] The mainline state is full; finish or delete old mainlines",
  "[X] refs.json is full",
  "[X] title is empty",
  "[X] That milestone exists already",
  "[X] There is no current milestone to reach",
  "[X] Something else went wrong",
];
const REASONS = ["comment", "review", "approved", "changes_requested", "merged", "review_requested", "mention", "author", "state_change", "assign", "ci_activity", "manual", "subscribed", "team_mention", "other"];
/** Arguments the tables' functions are called with: counts, times, titles, lists, error codes. */
const ARGS: unknown[][] = [
  [],
  [0],
  [1],
  [3, 5, 1, 2, 4],
  [NOW - 3 * 60_000, NOW],
  [NOW - 30 * 86_400_000, NOW],
  ["A title", "Some text", "More", "Last"],
  ["A title", ["a", "b"], "paused"],
  [["the title"]],
  [["the title", "the tags", "2 milestones"]],
  ["clip.mov", "1 GB"],
  [true, NOW - 60_000, undefined, NOW, 2],
  [true, undefined, undefined, NOW, 0],
  [true, undefined, "gh: not logged in", NOW, 1],
  [false, undefined, undefined, NOW, 0],
  [40, 100, false, 2, 3],
  [40, 100, true, 2, 0],
  ...REASONS.map((reason) => [reason]),
  ...CODES.flatMap((code) => MESSAGES.map((message) => [code, message])),
];

/** Every text a string table gives: its strings, and what its functions return for the arguments above. */
function tableTexts(table: unknown, seen = new Set<unknown>()): string[] {
  if (typeof table === "string") return [table];
  if (typeof table === "function")
    return ARGS.flatMap((args) => {
      try {
        const out: unknown = (table as (...args: unknown[]) => unknown)(...args);
        return typeof out === "string" ? [out] : [];
      } catch {
        return [];
      }
    });
  if (table && typeof table === "object" && !seen.has(table)) {
    seen.add(table);
    return Object.values(table).flatMap((value) => tableTexts(value, seen));
  }
  return [];
}

// ---------------------------------------------------------------------------------------------

describe("English has no Chinese punctuation", () => {
  it("in any English string table", () => {
    const tables = {
      overview: pageStrings("en"),
      capsule: strings("en"),
      hover: hoverStrings("en"),
      favorites: favoriteStrings("en"),
      agentRules: wordsV2("en"),
    };
    for (const [name, table] of Object.entries(tables)) {
      const texts = tableTexts(table);
      expect(texts.length, name).toBeGreaterThan(20);
      expect(offending(texts, CHINESE_PUNCTUATION), name).toEqual([]);
      expect(offending(texts, HAN), name).toEqual([]);
    }
  });

  it("on the overview as drawn", async () => {
    const snapshot = english(sampleSnapshot());
    snapshot.state!.conversations[T.main]!.pinned = { title: true, tags: true };
    const summarizer = {
      running: 1,
      queued: 2,
      today: { count: 3, limit: 200, calls: { claude: { auto: 2, manual: 1, backfill: 4 }, codex: { auto: 1, manual: 0, backfill: 0 } } },
      backfill: { done: 4, total: 10, failed: 1, skipped: 2 },
      lastError: "claude exited with code 1: a network problem",
    };
    const respond = (method: string, params: unknown): unknown => {
      switch (method) {
        case "snapshot":
          return { ...snapshot, summarizer, favorites: 1 };
        case "conversation":
          return english(sampleView((params as { threadId: string }).threadId));
        case "search":
          return english(sampleSearchResults());
        case "refs.list":
          return english({ status: { conversations: { scanned: 40, listed: 100, done: true, unreadable: 2 }, refs: 2, github: { enabled: true } }, refs: [ref42, refWidgets] });
        case "favorites.list":
          return english({ items: [{ id: "f1", threadId: T.main, text: "Run npm run check before a release.", role: "agent", turn: 2, source: "select", createdAt: NOW - 60_000, note: "release" }], titles: {}, total: 1 });
        case "integration.status":
          return [
            { agent: "claude", file: "/home/.claude/settings.json", state: "installed" },
            { agent: "codex", file: "/home/.codex/AGENTS.md", state: "missing" },
          ];
        case "integration.preview":
          return { agent: "codex", file: "/home/.codex/AGENTS.md", action: "add", snippet: "## Second Brain (codexhost)" };
        case "attachments.usage":
          return { all: { files: 3, bytes: 3_000_000 }, done: { files: 1, bytes: 1_000_000 }, unknown: { files: 0, bytes: 0 } };
        case "mutate":
          return Promise.reject(new Error("[MILESTONE_LIMIT] At most 30 milestones"));
        default:
          return { ok: true };
      }
    };
    const { root } = await mountPage("en-US", respond);
    const texts: string[] = [];
    const take = () => texts.push(...shown(root));
    take();
    // A conversation opened, a two-click button armed, an edit that failed.
    root.querySelector<HTMLElement>(`.mlp-node[data-thread-id="${T.main}"] > .mlp-row`)!.click();
    await flush();
    take();
    buttonNamed(root, "Delete mainline").click();
    buttonNamed(root, "Mark reached").click();
    await flush();
    take();
    // A conversation without a mainline.
    root.querySelector<HTMLButtonElement>('[data-status-tab="others"]')!.click();
    await flush();
    root.querySelector<HTMLElement>(`.mlp-node[data-thread-id="${T.old}"] > .mlp-row`)!.click();
    await flush();
    take();
    // Search results.
    const find = root.querySelector<HTMLInputElement>(".mlp-find-input")!;
    find.value = "1081";
    find.dispatchEvent(new Event("input", { bubbles: true }));
    find.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    expect(root.querySelectorAll(".mlp-hit")).toHaveLength(2);
    take();
    for (const tab of ["favorites", "refs", "settings"]) {
      root.querySelector<HTMLButtonElement>(`.mlp-tab[data-tab="${tab}"]`)!.click();
      await flush();
      take();
    }
    buttonNamed(root, "Install").click();
    await flush();
    take();
    expect(texts.join("\n")).toContain("You changed the title and the tags by hand; the model leaves them alone.");
    expect(offending(texts, CHINESE_PUNCTUATION)).toEqual([]);
  });

  it("on the capsule and its card as drawn", async () => {
    const opened: string[] = [];
    const capsule = new Capsule({
      doc: document,
      locale: "en",
      surface: "desktop",
      mutate: async () => {
        throw new Error("[INVALID_ARGUMENT] That milestone exists already");
      },
      spawn: async () => undefined,
      openThread: (threadId) => opened.push(threadId),
      call: async (method) => (method === "search" ? english(sampleSearchResults()) : []),
      anchor: () => ({ x: 400, top: 60 }),
    });
    document.body.append(capsule.host);
    disposers.push(() => capsule.destroy());
    const root = capsule.host.shadowRoot!;
    const texts: string[] = [];
    const take = () => texts.push(...shown(root));
    capsule.update({ threadId: T.main, view: english(sampleView(T.main)), settings: DEFAULT_SETTINGS, offline: false, now: NOW, alerts: [english(ref42)] });
    take();
    open(root);
    take();
    // A two-click button armed, an edit that failed, a search.
    [...root.querySelectorAll<HTMLButtonElement>(".spinoff button")][0]!.click();
    root.querySelector<HTMLButtonElement>('.milestone[data-state="current"] .btn.primary')!.click();
    await flush();
    take();
    root.querySelector<HTMLButtonElement>('.head button[aria-label="Find a conversation"]')!.click();
    const input = root.querySelector<HTMLInputElement>("input.search-input")!;
    input.value = "1081";
    input.dispatchEvent(new Event("input"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    take();
    // The card waits while the search field has the focus.
    input.blur();
    await flush();
    // Several PRs with news, offline, then a conversation without a mainline.
    capsule.update({ threadId: T.main, view: english(sampleView(T.main)), settings: DEFAULT_SETTINGS, offline: true, now: NOW, alerts: english([ref42, refWidgets]) });
    take();
    capsule.update({ threadId: T.old, view: english(sampleView(T.old)), settings: DEFAULT_SETTINGS, offline: false, now: NOW, alerts: [] });
    if (!root.querySelector(".root")!.hasAttribute("data-open")) open(root);
    take();
    expect(root.querySelector(".draft-form")).not.toBeNull();
    expect(texts.join("\n")).toContain("Milestones (2/4)");
    expect(offending(texts, CHINESE_PUNCTUATION)).toEqual([]);
  });

  it("on the hover card as drawn", () => {
    const h = builder(document);
    const t = hoverStrings("en");
    const actions: CardActions = {
      open: () => undefined,
      expand: () => undefined,
      followed: () => undefined,
      compose: () => undefined,
      type: () => undefined,
      attach: () => undefined,
      detach: () => undefined,
      spawn: () => undefined,
      seen: () => undefined,
      summarize: () => undefined,
    };
    const ctx = (extra: Partial<CardContext> = {}): CardContext => ({ h, t, now: NOW, expanded: new Set(), actions, compose: COMPOSE_IDLE, ...extra });
    const files = [{ id: "a", name: "screen.png", size: 120_000, kind: "image" as const }, { id: "b", name: "clip.mov", size: 40_000_000, kind: "video" as const }];
    const contexts: Array<[Parameters<typeof cardNodes>[0], CardContext]> = [
      [{ kind: "view", view: english(sampleView(T.main)) }, ctx({ summaryRefused: true })],
      [{ kind: "view", view: english(sampleView(T.child)) }, ctx({ summarizing: true, compose: { ...COMPOSE_IDLE, result: { ok: true, childThreadId: T.child, title: "Video does not open" } } })],
      [
        { kind: "view", view: english(sampleView(T.old)) },
        ctx({ compose: { open: true, text: "Video does not open", files, armed: "new", busy: false, notice: t.tooLarge("huge.mov", "500 MB"), result: { ok: false, message: "codexhost did not answer" } } }),
      ],
      [{ kind: "view", view: english(sampleView(T.old)) }, ctx({ compose: { open: true, text: "x", files, armed: "new", busy: true, uploading: 40 } })],
      [{ kind: "loading" }, ctx()],
      [{ kind: "error", message: "codexhost did not answer" }, ctx()],
    ];
    const texts: string[] = [];
    for (const [content, context] of contexts) {
      const card = document.createElement("div");
      card.append(...cardNodes(content, context));
      texts.push(...shown(card));
    }
    expect(texts.join("\n")).toContain("Could not open it: codexhost did not answer");
    expect(offending(texts, CHINESE_PUNCTUATION)).toEqual([]);
    // Sizes as the card says them: "1 GB", not "1.0 GB" (formatSize drops the ".0").
    expect(t.tooMuch(formatSize(ATTACH_MAX_TOTAL_BYTES))).toBe("Attachments may add up to 1 GB at most");
    expect(hoverStrings("zh-CN").tooMuch(formatSize(ATTACH_MAX_TOTAL_BYTES))).toBe("附件合计不能超过 1 GB");
  });

  it("in what the command line prints", async () => {
    const say = cli("en_US.UTF-8");
    const outputs = [
      await say("--help"),
      await say("new", "Fix the sidebar", "--tags", "web,sidebar", "--plan", "Find the cause|Open the PR"),
      await say("doing", "Read the paging code"),
      await say("done"),
      await say("task", "Write a test"),
      await say("spinoff", "The video does not open"),
      await say("reach", "nosuch"),
      await say("plan"),
      await say("link", "not-a-link"),
      await say("fav", "remove", "nope"),
      await say("list"),
      await say("finish"),
      await say("list"),
      await say("summarize", "--all"),
      await say("bogus"),
    ];
    const texts = outputs.flatMap(({ out, err }) => [out, err]).filter(Boolean);
    expect(texts.length).toBeGreaterThan(10);
    expect(offending(texts, CHINESE_PUNCTUATION)).toEqual([]);
  });
});

describe("one word for each thing", () => {
  it("calls tasks 支线任务 and the PR and issue sections PR 与 Issue, and keeps 线索 for searching", async () => {
    const texts = [pageStrings("zh-CN"), strings("zh-CN"), hoverStrings("zh-CN"), favoriteStrings("zh-CN"), wordsV2("zh-CN")].flatMap((table) => tableTexts(table));
    // And what the command line tells an agent: the full text, the status line after it, a task.
    const say = cli("zh_CN.UTF-8");
    await say("new", "修侧栏", "--plan", "定位原因|提交 PR");
    await say("doing", "读样式断点");
    for (const printed of [await say("show"), await say("task", "补一个测试"), await say("show"), await say("show", "--full"), await say("--help")]) texts.push(printed.out, printed.err);
    expect(texts.join("\n")).toContain("当前阶段「定位原因」的支线任务：");
    expect(texts.join("\n")).toContain("完整内容（里程碑、支线任务和约定）：mainline show --full");
    expect(offending(texts, /支线(?!任务)/u)).toEqual([]);
    expect(offending(texts, /线索/u).filter((text) => !/找|查/u.test(text))).toEqual([]);
    const sections = (locale: "zh-CN" | "en") => [pageStrings(locale).refsSection, pageStrings(locale).refs, pageStrings(locale).tabRefs(2).replace(/\s*2$/u, ""), hoverStrings(locale).refs];
    expect(sections("zh-CN")).toEqual(["PR 与 Issue", "PR 与 Issue", "PR 与 Issue", "PR 与 Issue"]);
    expect(sections("en")).toEqual(["PRs and issues", "PRs and issues", "PRs and issues", "PRs and issues"]);
    expect([strings("zh-CN").news, hoverStrings("zh-CN").news, strings("en").news, hoverStrings("en").news]).toEqual(["PR 与 Issue 新动态", "PR 与 Issue 新动态", "PR and issue news", "PR and issue news"]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("backend errors, said by what caused them", () => {
  /** An error as it reaches a surface: its code, and "[CODE] message". */
  const wire = (error: unknown): [string, string] => {
    if (!(error instanceof MainlineError)) throw error;
    return [error.code, `[${error.code}] ${error.message}`];
  };
  const thrown = (fn: () => unknown): [string, string] => {
    try {
      fn();
    } catch (error) {
      return wire(error);
    }
    throw new Error("it did not fail");
  };
  const rejected = async (fn: () => Promise<unknown>): Promise<[string, string]> => {
    try {
      await fn();
    } catch (error) {
      return wire(error);
    }
    throw new Error("it did not fail");
  };

  // It fills a state file past its 8 MB cap and favorites.json past its 16 MB: allow for a busy machine.
  it("tells the causes apart by the codes the code really throws", { timeout: 20_000 }, async () => {
    const ctx = { now: NOW };
    const full = emptyStateV2();
    createConversation(full, "t", { title: "Thirty stages", milestones: Array.from({ length: 30 }, (_, i) => `Stage ${i + 1}`) }, ctx);
    const limit = thrown(() => addMilestone(full, "t", "One more", ctx));
    const bare = emptyStateV2();
    createConversation(bare, "b", { title: "No stages yet" }, ctx);
    addMilestone(bare, "b", "Only stage", ctx);
    const exists = thrown(() => addMilestone(bare, "b", "Only stage", ctx));
    const empty = thrown(() => setTitle(bare, "b", "   ", ctx));
    const none = emptyStateV2();
    createConversation(none, "n", { title: "Nothing current" }, ctx);
    const noCurrent = thrown(() => reachMilestone(none, "n", ctx));
    const file = await rejected(() => writeJsonFile(path.join(dir, "refs.json"), { items: ["x".repeat(64)] }, 16));
    const upload = await rejected(() => new Uploads(dir).begin({ name: "At most 3 milestones.mov", size: ATTACH_MAX_FILE_BYTES + 1 }));
    // A state over its cap: as many last messages as it takes.
    const paths = storePaths(dir);
    const prompts = Object.fromEntries(Array.from({ length: 30_000 }, (_, i) => [`thread-${i}`, { text: "x".repeat(300), at: NOW }]));
    await writeFile(paths.state, JSON.stringify({ ...emptyStateV2(), prompts }));
    const stateFull = await rejected(() => updateState(paths, (draft) => void (draft.prompts.more = { text: "one more", at: NOW }), { now: NOW }));
    // favorites.json over its cap: as many long passages as it takes.
    const saved = favoritesPaths(dir);
    const items = Array.from({ length: 840 }, (_, i) => ({ id: `f${i}`, threadId: "t", text: `${i} ${"x".repeat(19_990)}`, source: "select", createdAt: NOW }));
    await writeFile(saved.file, JSON.stringify({ version: 1, rev: 1, items }));
    const favoritesFull = await rejected(() => updateFavorites(saved, (data) => addFavorite(data, { threadId: "t", text: "one more", source: "select" }, NOW)));
    const unavailable = await rejected(() => new Integrations({ home: path.join(dir, "nobody"), dataDir: dir, command: "/bin/mainline" }).install("codex"));

    expect(limit[0]).toBe("MILESTONE_LIMIT");
    expect(exists[0]).toBe("MILESTONE_EXISTS");
    expect(empty[0]).toBe("EMPTY_TEXT");
    expect(noCurrent[0]).toBe("NO_CURRENT_MILESTONE");
    expect(file[0]).toBe("FILE_FULL");
    expect(stateFull[0]).toBe("STATE_FULL");
    expect(favoritesFull[0]).toBe("FAVORITES_FULL");
    // A file name is no milestone limit.
    expect(upload[0]).toBe("ATTACHMENT_TOO_LARGE");
    expect(unavailable[0]).toBe("UNAVAILABLE");

    const page = pageStrings("zh-CN");
    const pageEn = pageStrings("en");
    const capsule = strings("zh-CN");
    const capsuleEn = strings("en");
    expect(page.error(...limit)).toBe("一条主线最多 30 个里程碑，请先删掉不用的里程碑");
    expect(pageEn.error(...limit)).toBe("A mainline has at most 30 milestones; delete one you no longer need first");
    expect(page.error(...stateFull)).toBe("主线数据已满，请删除不用的主线");
    expect(capsuleEn.error(...stateFull)).toBe("The mainline data is full; delete mainlines you no longer need in the overview");
    expect(page.error(...favoritesFull)).toBe("收藏已满，请删除不用的收藏");
    expect(page.error(...file)).toBe("数据文件已满，这次没有保存（refs.json is full）");
    expect(page.error(...upload)).toBe("单个附件不能超过 500 MB");
    expect(capsule.error(...empty)).toBe("没有改成：内容为空");
    expect(capsule.error(...exists)).toBe("没有改成：这个里程碑已经有了");
    expect(capsuleEn.error(...exists)).toBe("Not changed: that milestone exists already");
    expect(capsule.error(...noCurrent)).toBe("没有当前里程碑可以达成");
    expect(page.error(...noCurrent)).toBe("没有当前里程碑可以标记达成");
    expect(page.error(...unavailable)).toBe("改不了 Agent 协作：Codex is not set up (~/.codex is missing)");
    expect(errorText("zh-CN", ...limit, true)).toBe("一条主线最多 30 个里程碑，这次没有加上。");
    expect(errorText("en", ...stateFull, true)).toBe("The mainline data is full; delete mainlines you no longer need in the overview.");
  });

  it("names every code in both languages, on the overview, the capsule and the hover card, and in the command line", () => {
    const surfaces: Array<[string, (code: string, message: string) => string, (code: string, message: string) => string, string]> = [
      ["overview", pageStrings("zh-CN").error, pageStrings("en").error, pageStrings("zh-CN").error(undefined, "x")],
      // The hover card says the capsule's words.
      ["capsule", strings("zh-CN").error, strings("en").error, strings("zh-CN").error(undefined, "x")],
      ["command line", (code, message) => errorText("zh-CN", code, message, true), (code, message) => errorText("en", code, message, true), "x"],
    ];
    for (const code of ERROR_CODES)
      for (const [surface, zh, en, fallback] of surfaces) {
        const wired = `[${code}] Something went wrong`;
        const [inZh, inEn] = [zh(code, wired), en(code, wired)];
        expect(inZh, `${surface} ${code}`).not.toBe(fallback);
        expect(inEn, `${surface} ${code}`).not.toMatch(/^That did not work/u);
        // The command line passes its own argument errors on as they are.
        if (!(surface === "command line" && code === "INVALID_ARGUMENT")) expect(HAN.test(inZh), `${surface} ${code}: ${inZh}`).toBe(true);
        expect(offending([inEn], CHINESE_PUNCTUATION), `${surface} ${code}`).toEqual([]);
        expect(HAN.test(inEn), `${surface} ${code}: ${inEn}`).toBe(false);
      }
  });

  it("show what they do not know as it is", () => {
    const cases: Array<[string | undefined, string, string, string]> = [
      ["NO_MAINLINE", "This conversation has no mainline yet", "这个对话还没有主线，或者主线已经删除", "This conversation has no mainline, or it was deleted"],
      ["UNKNOWN_ITEM", 'No milestone "x"', "这一项已经不存在了", "That item no longer exists"],
      ["NO_THREAD", "No current conversation", "找不到这个对话", "That conversation cannot be found"],
      ["LOCKED", "The mainline state is busy; try again in a moment", "主线数据正在写入，请稍后再试", "The mainline data is being written; try again in a moment"],
      ["INVALID_ARGUMENT", "agent must be claude or codex", "内容不符合要求：agent must be claude or codex", "Not accepted: agent must be claude or codex"],
      ["PENDING", "No answer from codexhost yet", "codexhost 没有及时答复，子对话可能还在打开：开好后会出现在本对话下方，先不要再点", "No answer from codexhost yet; the child may still open under this conversation"],
      ["NEWER_VERSION", "state.json was written by a newer version", "数据文件是更新版本的第二大脑插件写的，这里没有改动它；请更新插件", "A data file was written by a newer version of Second Brain and was left as it is; update the extension"],
      [undefined, "Extension backend is not active", "操作没有成功：Extension backend is not active", "That did not work: Extension backend is not active"],
      ["SOMETHING_NEW", "A code from a later version", "操作没有成功：A code from a later version", "That did not work: A code from a later version"],
    ];
    for (const [code, message, zh, en] of cases) {
      const wired = code ? `[${code}] ${message}` : message;
      expect(pageStrings("zh-CN").error(code, wired)).toBe(zh);
      expect(pageStrings("en").error(code, wired)).toBe(en);
    }
    expect(pageStrings("zh-CN").error("NO_SUMMARIZER", "[NO_SUMMARIZER] x")).toContain("「其他 Agent（如 pi、DeepSeek、Grok）的对话」选的是「不凝练，不发给任何模型」");
    expect(pageStrings("en").error("NO_SUMMARIZER", "[NO_SUMMARIZER] x")).toContain("“Conversations of other agents (pi, DeepSeek, Grok, …)” is “Do not summarize; send them to no model”");
    expect(strings("zh-CN").error("LOCKED", "[LOCKED] busy")).toBe("主线数据正在写入，请稍后再试");
    expect(strings("zh-CN").error("UNKNOWN_ITEM", "[UNKNOWN_ITEM] No task t9")).toBe("这一项已经不存在了");
    expect(errorText("zh-CN", "NEWER_VERSION", "x", true)).toBe("主线的数据文件是更新版本的插件写的，这个版本不读也不改它。请把第二大脑插件更新到最新版本。");
    expect(errorText("en", "ERROR", "Something else", true)).toBe("Something else");
  });

  it("say why an agent's configuration and a model's tool are missing in the page's language", () => {
    const zh = pageStrings("zh-CN");
    const en = pageStrings("en");
    expect(zh.integrationProblem("claude", "NOT_SET_UP")).toBe("没有找到 Claude Code 的配置（~/.claude 不存在）");
    expect(en.integrationProblem("codex", "NOT_SET_UP")).toBe("Codex is not set up (~/.codex is missing)");
    expect(zh.integrationProblem("claude", "FILE_UNREADABLE", "EACCES")).toBe("读不了 settings.json（EACCES），请先修好它");
    expect(zh.integrationProblem("codex", "FILE_UNREADABLE", "EACCES")).toBe("读不了 AGENTS.md（EACCES），请先修好它");
    expect(zh.integrationProblem("claude", "NOT_JSON")).toBe("settings.json 不是有效的 JSON，请先修好它");
    expect(en.integrationProblem("claude", "NOT_JSON")).toBe("settings.json is not valid JSON; fix it first");
    expect(zh.summaryProblem.CLAUDE_MISSING).toBe("没有找到 Claude Code（claude 命令）：请安装，或在设置里改用 Codex 凝练");
    expect(zh.summaryProblem.CODEX_MISSING).toBe("没有找到 Codex（codex 命令）：请安装，或在设置里改用 Claude Haiku 凝练");
  });

  it("are shown on the overview in the page's language", async () => {
    const { root } = await mountPage("zh-CN", (method) => (method === "mutate" ? Promise.reject(new Error("[MILESTONE_LIMIT] At most 30 milestones")) : undefined));
    root.querySelector<HTMLElement>(`.mlp-node[data-thread-id="${T.main}"] > .mlp-row`)!.click();
    await flush();
    buttonNamed(root, "标记达成").click();
    await vi.waitFor(() => expect(root.querySelector(".mlp-error")?.textContent).toContain("一条主线最多 30 个里程碑，请先删掉不用的里程碑"));
  });

  it("say on the ★ button why saving failed", () => {
    const zh = favoriteStrings("zh-CN");
    expect(failureReason(zh, new Error("[FAVORITES_FULL] favorites.json is full"))).toBe("收藏已满，请在总览页删除不用的收藏");
    // Any other cause the backend names in the capsule's words, an unknown one as it is.
    expect(failureReason(zh, new Error("[NEWER_VERSION] favorites.json was written by a newer version"))).toBe("数据文件是更新版本的第二大脑插件写的，这里没有改动它；请更新插件");
    expect(failureReason(zh, new Error("Extension backend is not active"))).toBe("Extension backend is not active");
    expect(failureReason(zh, new Error("[LOCKED] The favorites are busy"))).toBe("正在写入，请稍后再试");
    expect(failureReason(favoriteStrings("en"), new Error(`[INVALID_ARGUMENT] ${"long reason ".repeat(20)}`))).toHaveLength(80);
    expect(zh.failed("收藏已满")).toBe("收藏失败：收藏已满");
  });
});

// ---------------------------------------------------------------------------------------------

describe("the overview's texts", () => {
  it("list what was changed by hand the language's own way", async () => {
    const pinned = (locale: string) => {
      const snapshot = sampleSnapshot();
      snapshot.state!.conversations[T.main]!.pinned = { title: true, tags: true };
      return mountPage(locale, (method) => (method === "snapshot" ? snapshot : undefined));
    };
    for (const [locale, expected] of [
      ["zh-CN", "你手动改过标题、标签，模型不会覆盖。"],
      ["en-US", "You changed the title and the tags by hand; the model leaves them alone."],
    ] as const) {
      const { root } = await pinned(locale);
      root.querySelector<HTMLElement>(`.mlp-node[data-thread-id="${T.main}"] > .mlp-row`)!.click();
      await flush();
      expect(root.querySelector(".mlp-pinned span")?.textContent).toBe(expected);
      document.body.replaceChildren();
    }
    const en = pageStrings("en");
    expect(en.pinnedNote(["the title"])).toBe("You changed the title by hand; the model leaves it alone.");
    expect(en.pinnedNote(["the title", "the tags", "2 milestones"])).toBe("You changed the title, the tags and 2 milestones by hand; the model leaves them alone.");
  });

  it("say when GitHub checking starts", () => {
    const zh = pageStrings("zh-CN");
    expect(zh.githubStatus(true, undefined, undefined, NOW, 0)).toBe("GitHub 回复提醒已开启，有 PR 或 issue 后开始检查");
    expect(zh.githubStatus(true, undefined, undefined, NOW, 3)).toBe("GitHub 回复提醒即将开始");
    expect(pageStrings("en").githubStatus(true, undefined, undefined, NOW, 0)).toBe("GitHub reply alerts on; checking starts once a PR or issue shows up");
  });

  it("show the way to the overview that the capsule's surface has", () => {
    expect(strings("zh-CN").overviewHint.desktop).toBe("完整总览与 Agent 协作：设置 → 插件页面 → 第二大脑");
    expect(strings("zh-CN").overviewHint.web).toBe("完整总览与 Agent 协作：左侧「插件」→「第二大脑」");
    const capsule = new Capsule({ doc: document, locale: "zh-CN", surface: "web", mutate: async () => undefined, openThread: () => undefined, anchor: () => null });
    document.body.append(capsule.host);
    disposers.push(() => capsule.destroy());
    capsule.update({ threadId: T.main, view: sampleView(T.main), settings: DEFAULT_SETTINGS, offline: false, now: NOW });
    open(capsule.host.shadowRoot!);
    expect(capsule.host.shadowRoot!.querySelector(".hint")?.textContent).toBe("完整总览与 Agent 协作：左侧「插件」→「第二大脑」");
  });
});

describe("the command line's texts", () => {
  it("says where to find what an unknown item could have been", async () => {
    const zh = cli("zh_CN.UTF-8");
    await zh("new", "修侧栏", "--plan", "定位|修复");
    const milestone = await zh("reach", "nosuch");
    expect(milestone.code).toBe(1);
    expect(milestone.err).toBe('mainline: 找不到这一项：里程碑 "nosuch"。里程碑和引申问题的名称与编号见 mainline show --full，收藏的编号见 mainline fav list。\n');
    expect((await zh("fav", "remove", "nope")).err).toContain("找不到这一项：收藏 nope。");
    const en = await cli("en_US.UTF-8")("reach", "nosuch");
    expect(en.err).toBe('mainline: No milestone "nosuch". See mainline show --full for milestones and spin-off ids, mainline fav list for saved passages.\n');
  });

  it("says a mainline is at its milestone limit", async () => {
    const zh = cli("zh_CN.UTF-8");
    await zh("new", "三十个阶段", "--plan", Array.from({ length: 30 }, (_, i) => `阶段${i + 1}`).join("|"));
    expect((await zh("plan", "再加一个")).err).toBe("mainline: 一条主线最多 30 个里程碑，这次没有加上。\n");
    expect((await cli("en_US.UTF-8")("plan", "one more")).err).toBe("mainline: A mainline has at most 30 milestones; this one was not added.\n");
  });

  it("lists active and paused mainlines, and says so when there are none", async () => {
    const zh = cli("zh_CN.UTF-8");
    await zh("new", "做完的事");
    await zh("finish");
    expect((await zh("list")).out).toBe("没有进行中或暂停的主线。\n");
    expect((await cli("en_US.UTF-8")("list")).out).toBe("No active or paused mainlines.\n");
  });

  it("leaves opening a child conversation to the user's word", async () => {
    const zh = cli("zh_CN.UTF-8");
    await zh("new", "修侧栏");
    const noted = await zh("spinoff", "视频点不开");
    const id = /编号 (\S+?)）/u.exec(noted.out)?.[1] ?? "";
    expect(noted.out).toBe(`✓ 记下引申问题：视频点不开（编号 ${id}）。用户同意开子对话时运行 mainline spawn ${id}。\n`);
    const en = await cli("en_US.UTF-8")("spinoff", "Typo in the header");
    expect(en.out).toMatch(/^✓ Spin-off noted: Typo in the header \(id \S+\)\. If the user wants a child conversation: mainline spawn \S+\n$/u);
  });

  it("says in its help that link takes GitHub PRs and issues only", async () => {
    const { out } = await cli("en_US.UTF-8")("--help");
    expect(out).toContain('mainline link <GitHub PR or issue URL> ["<note>"]');
    expect(out).toContain("Record a GitHub PR or issue and what it is for");
    expect(out).toContain("(other agents' only if a model is set for them)");
    expect(wordsV2("zh-CN").refs).toBe('- 提交 GitHub PR 或 issue 后 mainline link <链接> "用途"；不清楚来历的编号或事情用 mainline find <线索> 查。');
    expect(wordsV2("en").childRule).toBe("- This is a child conversation started from its parent: focus on its task, and sum up the result in a sentence or two when done.");
  });
});

// ---------------------------------------------------------------------------------------------
// Harnesses

function cli(lang: string, thread = "t1") {
  let out = "";
  let err = "";
  const io = {
    env: { MAINLINE_DATA_DIR: dir, LANG: lang, CODEXHOST_THREAD_ID: thread },
    stdout: (text: string) => void (out += text),
    stderr: (text: string) => void (err += text),
    now: () => NOW,
    runGh: async (): Promise<string> => {
      throw new Error("no gh in tests");
    },
  };
  return async (...argv: string[]) => {
    out = "";
    err = "";
    const code = await run(argv, io);
    return { code, out, err };
  };
}

async function mountPage(locale: string, respond: (method: string, params: unknown) => unknown) {
  const invoke = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
    const custom = respond(method, params);
    if (custom !== undefined) return custom;
    switch (method) {
      case "snapshot":
        return sampleSnapshot();
      case "conversation":
        return sampleView((params as { threadId: string }).threadId);
      case "search":
        return sampleSearchResults();
      case "refs.list":
        return { status: { conversations: { scanned: 1, listed: 1, done: true, unreadable: 0 }, refs: 0, github: { enabled: true } }, refs: [] };
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
    locale,
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
  return { root, invoke };
}

async function flush(): Promise<void> {
  for (let round = 0; round < 4; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function buttonNamed(scope: ParentNode, name: string): HTMLButtonElement {
  const button = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === name || item.getAttribute("aria-label") === name);
  if (!button) throw new Error(`No button "${name}"`);
  return button;
}

/** Opens the capsule's card as a click on the pill does. */
function open(root: ShadowRoot): void {
  const pill = root.querySelector(".capsule")!;
  const Pointer = (window.PointerEvent ?? window.MouseEvent) as typeof MouseEvent;
  pill.dispatchEvent(new Pointer("pointerdown", { bubbles: true, composed: true, button: 0 }));
  pill.dispatchEvent(new Pointer("pointerup", { bubbles: true, composed: true, button: 0 }));
}
