import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiThread, ApiTurn, ListedThread } from "../src/backend/external-api.js";
import { activate } from "../src/backend/index.js";
import { ModelNotSentError, type Engine, type ModelAnswer, type ModelRequest } from "../src/backend/models.js";
import { applyMutationV2 } from "../src/backend/mutate-v2.js";
import { run } from "../src/cli/main.js";
import { DAILY_LIMIT, Summarizer } from "../src/backend/summarizer.js";
import { createConversation, deleteConversation, isExcluded, recordPromptV2 } from "../src/core/conversation-ops.js";
import { EXCLUDED_KEPT, emptyStateV2, normalizeStateV2 } from "../src/core/conversation.js";
import { DEFAULT_SETTINGS, MainlineError, summaryEngineFor, type Settings } from "../src/core/model.js";
import { emptyIndex, type RefIndex } from "../src/core/refs.js";
import { readState, storePaths, updateState } from "../src/node/store.js";
import { dayKey, dayOf, emptyDay, readSummaryCounts, summaryCountsPaths } from "../src/node/summary-counts.js";

const NOW = Date.parse("2026-11-23T10:00:00Z");
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const SAID = "帮我修结算页在窄屏下的错位";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "mainline-controls-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const turnsOf = (count = 3, first = SAID): ApiTurn[] =>
  Array.from({ length: count }, (_, i) => ({
    turnNumber: i + 1,
    status: "completed",
    messages: [
      { role: "user" as const, text: i === 0 ? first : `第 ${i + 1} 个请求` },
      { role: "agent" as const, text: `第 ${i + 1} 轮的回复` },
    ],
  }));

const SUMMARY = { title: "修复结算页「窄屏错位」", tags: ["shop-web"], milestones: [{ title: "定位原因", state: "current" }], finished: false };

/** A model call the test lets finish when it wants. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

interface Options {
  threads?: Record<string, ApiThread>;
  listed?: ListedThread[];
  index?: RefIndex;
  settings?: Partial<Settings>;
  firstMessage?: string;
  /** Calls wait for this before they answer. */
  hold?: Promise<void>;
  fail?: Error;
}

function setup(options: Options = {}) {
  const paths = storePaths(dir);
  const calls: Array<{ engine: Engine; request: ModelRequest; threadTitle: string }> = [];
  const lines: string[] = [];
  const reads: string[] = [];
  let settings: Settings = { ...DEFAULT_SETTINGS, ...options.settings };
  const threads = options.threads ?? {};
  const make = () =>
    new Summarizer({
      api: {
        readThread: async (threadId) => {
          reads.push(threadId);
          return threads[threadId];
        },
        readTurns: async () => ({ totalTurns: 3, turns: turnsOf(3, options.firstMessage) }),
        listThreads: async () => ({ threads: options.listed ?? [], nextCursor: null }),
      },
      runModel: async (engine, request): Promise<ModelAnswer> => {
        calls.push({ engine, request, threadTitle: /对话标题：(.*)/u.exec(request.prompt)?.[1] ?? "" });
        await options.hold;
        if (options.fail) throw options.fail;
        return { model: `${engine}-test`, value: SUMMARY };
      },
      paths,
      log: {
        info: (message) => lines.push(message),
        error: (message, error) => lines.push(`ERROR ${message}${error === undefined ? "" : `: ${error instanceof Error ? error.message : String(error)}`}`),
      },
      state: () => readState(paths),
      index: async () => options.index ?? emptyIndex(),
      settings: async () => settings,
      changed: () => undefined,
      now: () => NOW,
    });
  const summarizer = make();
  const settle = async (which = summarizer) => {
    for (let i = 0; i < 500 && (which.status().running || which.status().queued); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  };
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 500 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(check()).toBe(true);
  };
  return {
    summarizer,
    make,
    paths,
    calls,
    lines,
    reads,
    settle,
    until,
    set: (patch: Partial<Settings>) => {
      settings = { ...settings, ...patch };
    },
  };
}

/** Conversations the scanner has read, all with something said and long quiet. */
function indexOf(ids: readonly string[]): RefIndex {
  const index = emptyIndex();
  ids.forEach((id, i) => {
    index.threads[id] = { turns: 3, updatedAt: iso(60 * 24 * (10 + i)), scannedAt: NOW };
  });
  return index;
}

const claudeThreads = (ids: readonly string[]): Record<string, ApiThread> =>
  Object.fromEntries(ids.map((id) => [id, { threadId: id, title: `对话 ${id}`, status: "idle" as const, harnessId: "claude-code" }]));

describe("stopping the backfill", () => {
  it("drops what waits and clears the request; a call already running finishes and is kept", async () => {
    const ids = ["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8"];
    const hold = gate();
    const env = setup({ index: indexOf(ids), threads: claudeThreads(ids), hold: hold.opened });
    await env.summarizer.tick();
    expect(env.summarizer.status().toBackfill).toBe(8);

    await env.summarizer.startBackfill();
    await env.until(() => env.calls.length === 2);
    expect(env.summarizer.status()).toMatchObject({ running: 2, queued: 4, backfill: { done: 0, total: 8 } });
    expect((await readState(env.paths)).jobs?.backfill).toBeDefined();

    await env.summarizer.cancelBackfill();
    expect((await readState(env.paths)).jobs).toBeUndefined();
    expect(env.summarizer.status()).toMatchObject({ running: 2, queued: 0 });
    expect(env.summarizer.status().backfill).toBeUndefined();

    hold.open();
    await env.settle();
    await env.summarizer.tick();
    await env.settle();
    await env.summarizer.stop();
    // The two calls that were running finished and were kept; nothing else was sent.
    expect(env.calls).toHaveLength(2);
    expect(Object.keys((await readState(env.paths)).conversations)).toHaveLength(2);
    expect(env.summarizer.status().toBackfill).toBe(6);
    expect(env.lines).toContain("backfill started from the overview page: up to 8 conversations to summarize");
    expect(env.lines).toContain("backfill stopped from the overview page after 0 of 8: 4 waiting dropped, 2 running call(s) finish");
  });

  it("shows no backfill under way once a round that overlapped this one finished it", async () => {
    const index = indexOf(["c1"]);
    const paths = storePaths(dir);
    // Done already: its summary is of the conversation as the index has it. Only the request is left.
    await updateState(paths, (draft, ctx) => {
      createConversation(draft, "c1", { title: "凝练过的主线" }, ctx);
      draft.conversations.c1!.summary = { at: NOW, model: "m", threadUpdatedAt: index.threads.c1!.updatedAt, finished: false };
      draft.jobs = { backfill: { requestedAt: NOW - 1000 } };
    });
    const held = gate();
    let holdNext = true;
    let waiting = false;
    const summarizer = new Summarizer({
      api: {
        readThread: async () => undefined,
        readTurns: async () => ({ totalTurns: 0, turns: [] }),
        listThreads: async () => ({ threads: [], nextCursor: null }),
      },
      runModel: async () => {
        throw new Error("no call expected");
      },
      paths,
      log: { info: () => undefined, error: () => undefined },
      state: () => readState(paths),
      // The first round waits here, having read the state while the request still stood.
      index: async () => {
        if (holdNext) {
          holdNext = false;
          waiting = true;
          await held.opened;
        }
        return index;
      },
      settings: async () => DEFAULT_SETTINGS,
      changed: () => undefined,
      now: () => NOW,
    });
    const slow = summarizer.tick();
    for (let i = 0; i < 500 && !waiting; i++) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(waiting).toBe(true);
    // A second round finishes the backfill meanwhile.
    await summarizer.tick();
    expect((await readState(paths)).jobs).toBeUndefined();
    held.open();
    await slow;
    await summarizer.stop();
    expect(summarizer.status().backfill).toBeUndefined();
  });

  it("notes in the log a backfill asked for from the command line, and its end", async () => {
    const env = setup({ index: indexOf(["c1"]), threads: claudeThreads(["c1"]) });
    // `mainline summarize --all` writes the request into the state; the backend finds it.
    await updateState(env.paths, (draft) => {
      draft.jobs = { backfill: { requestedAt: NOW + 1000 } };
    });
    await env.summarizer.tick();
    await env.settle();
    await env.summarizer.tick();
    await env.summarizer.stop();
    expect(env.calls).toHaveLength(1);
    expect(env.lines).toContain("backfill started with mainline summarize --all: up to 1 conversations to summarize");
    expect(env.lines).toContain("backfill finished: 1 conversations summarized, 0 could not be, 0 of other agents left out");
    expect((await readState(env.paths)).jobs).toBeUndefined();
  });
});

describe("automatic summaries turned off", () => {
  it("drops the automatic jobs waiting and starts none; asked-for ones and a backfill the user started still run", async () => {
    const quiet = ["q1", "q2", "q3"];
    const hold = gate();
    const env = setup({
      threads: { ...claudeThreads(quiet), ...claudeThreads(["asked", "old"]) },
      listed: quiet.map((threadId) => ({ threadId, updatedAt: iso(2) })),
      index: indexOf(["old"]),
      hold: hold.opened,
    });
    await env.summarizer.tick();
    await env.until(() => env.calls.length === 2);
    expect(env.summarizer.status()).toMatchObject({ running: 2, queued: 1 });

    env.set({ autoSummarize: false });
    await env.summarizer.tick();
    expect(env.summarizer.status()).toMatchObject({ running: 2, queued: 0 });
    hold.open();
    await env.settle();
    // An automatic job put in line by hand does not start either: its turn checks the setting again.
    env.summarizer.enqueue({ threadId: "q3", reason: "auto" });
    await env.settle();
    expect(env.calls.map(({ threadTitle }) => threadTitle).sort()).toEqual(["对话 q1", "对话 q2"]);

    await env.summarizer.request("asked");
    await env.settle();
    await env.summarizer.startBackfill();
    await env.settle();
    await env.summarizer.stop();
    expect(env.calls.slice(2).map(({ threadTitle }) => threadTitle)).toEqual(["对话 asked", "对话 old"]);
  });
});

describe("which model summarizes which conversation", () => {
  it("follows the agent for Claude Code and Codex, and sends other agents' conversations only where the settings say", () => {
    const follow = { summarizeModel: "follow", summarizeOthers: "none" } as const;
    expect(summaryEngineFor(follow, "claude-code")).toBe("claude");
    expect(summaryEngineFor(follow, "codex")).toBe("codex");
    for (const other of ["pi", "deepseek-harness", "grok", "omp", "antigravity", "constructor", "__proto__", undefined]) expect(summaryEngineFor(follow, other)).toBeUndefined();
    expect(summaryEngineFor({ summarizeModel: "claude", summarizeOthers: "none" }, "codex")).toBe("claude");
    expect(summaryEngineFor({ summarizeModel: "codex", summarizeOthers: "none" }, "pi")).toBeUndefined();
    expect(summaryEngineFor({ summarizeModel: "codex", summarizeOthers: "claude" }, "pi")).toBe("claude");
    expect(summaryEngineFor({ summarizeModel: "follow", summarizeOthers: "codex" }, undefined)).toBe("codex");
  });

  it("leaves other agents' conversations unsummarized, and refuses a manual summary naming the setting", async () => {
    const env = setup({
      threads: {
        cc: { threadId: "cc", status: "idle", harnessId: "claude-code" },
        cx: { threadId: "cx", status: "idle", harnessId: "codex" },
        pi: { threadId: "pi", status: "idle", harnessId: "pi" },
        anon: { threadId: "anon", status: "idle" },
      },
      listed: ["cc", "pi", "anon"].map((threadId) => ({ threadId, updatedAt: iso(2) })),
      index: indexOf(["cx", "pi"]),
    });
    await env.summarizer.tick();
    await env.settle();
    expect(env.calls.map(({ engine }) => engine)).toEqual(["claude"]);
    // Once its agent is known, the next round does not even read it again.
    const readsOfPi = env.reads.filter((id) => id === "pi").length;
    await env.summarizer.tick();
    await env.settle();
    expect(env.reads.filter((id) => id === "pi")).toHaveLength(readsOfPi);

    await env.summarizer.startBackfill();
    await env.settle();
    await env.summarizer.tick();
    // The call that ends a backfill starts one more round, and either round may be the one that
    // finds nothing left and finishes it: wait for the line, not only for this tick.
    await env.until(() => env.lines.includes("backfill finished: 1 conversations summarized, 0 could not be, 1 of other agents left out"));
    expect(env.calls.map(({ engine }) => engine)).toEqual(["claude", "codex"]);

    const refused = await env.summarizer.request("pi").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(MainlineError);
    expect(refused).toMatchObject({ code: "NO_SUMMARIZER" });
    expect((refused as Error).message).toContain('"pi"');
    expect((refused as Error).message).toContain("summarizeOthers");
    await expect(env.summarizer.request("anon")).rejects.toMatchObject({ code: "NO_SUMMARIZER" });
    expect(env.calls).toHaveLength(2);
    expect((await readState(env.paths)).conversations.pi).toBeUndefined();

    env.set({ summarizeOthers: "codex", summarizeModel: "claude" });
    await env.summarizer.request("pi");
    await env.settle();
    await env.summarizer.request("cx");
    await env.settle();
    await env.summarizer.stop();
    expect(env.calls.map(({ engine }) => engine)).toEqual(["claude", "codex", "codex", "claude"]);
  });
});

describe("agents as codexhost lists them", () => {
  it("skips other agents' conversations on the list without reading them, and counts the backfill exactly", async () => {
    const index = indexOf(["old-cc", "old-pi", "old-unknown"]);
    index.threads["old-cc"]!.harnessId = "claude-code";
    index.threads["old-pi"]!.harnessId = "pi";
    const pi = (threadId: string): ApiThread => ({ threadId, status: "idle", harnessId: "pi" });
    const env = setup({
      threads: { ...claudeThreads(["new-cc", "old-cc", "old-unknown"]), "new-pi": pi("new-pi"), "old-pi": pi("old-pi") },
      listed: [
        { threadId: "new-cc", updatedAt: iso(2), harnessId: "claude-code" },
        { threadId: "new-pi", updatedAt: iso(2), harnessId: "pi" },
      ],
      index,
    });
    await env.summarizer.tick();
    await env.settle();
    expect(env.reads).not.toContain("new-pi");
    expect(env.calls.map(({ threadTitle }) => threadTitle)).toEqual(["对话 new-cc"]);
    // The index knows old-pi runs on pi; old-unknown's agent is not known yet, so it is counted in.
    expect(env.summarizer.status().toBackfill).toBe(2);

    await env.summarizer.startBackfill();
    await env.settle();
    await env.summarizer.tick();
    await env.summarizer.stop();
    expect(env.reads).not.toContain("old-pi");
    expect(env.calls.map(({ threadTitle }) => threadTitle).sort()).toEqual(["对话 new-cc", "对话 old-cc", "对话 old-unknown"]);
    expect(env.lines).toContain("backfill finished: 2 conversations summarized, 0 could not be, 1 of other agents left out");
  });
});

describe("deleted mainlines", () => {
  // Deleting 2001 mainlines one by one takes most of a second alone, longer on a busy machine.
  it("are remembered with the last request gone, bounded, and read back only when well formed", { timeout: 20_000 }, () => {
    const state = emptyStateV2();
    createConversation(state, "t1", { title: "旧主线" }, { now: 1 });
    recordPromptV2(state, "t1", "最后一条请求", { now: 1 });
    applyMutationV2(state, { op: "delete", threadId: "t1" }, { now: 5 });
    expect(state.conversations.t1).toBeUndefined();
    expect(state.prompts.t1).toBeUndefined();
    expect(state.excluded).toEqual({ t1: 5 });
    // Asking for a mainline again lifts the mark.
    createConversation(state, "t1", { title: "新主线" }, { now: 6 });
    expect(isExcluded(state, "t1")).toBe(false);
    expect(state.excluded).toBeUndefined();
    // A record made only to hold a link to a child conversation keeps it.
    deleteConversation(state, "t1", { now: 7 });
    createConversation(state, "t1", { title: "只为挂上子对话" }, { now: 8 }, { keepExcluded: true });
    expect(state.conversations.t1?.title).toBe("只为挂上子对话");
    expect(state.excluded).toEqual({ t1: 7 });

    const many = emptyStateV2();
    for (let i = 0; i <= EXCLUDED_KEPT; i++) {
      createConversation(many, `c${i}`, { title: "x" }, { now: i });
      deleteConversation(many, `c${i}`, { now: 100 + i });
    }
    expect(Object.keys(many.excluded!)).toHaveLength(EXCLUDED_KEPT);
    expect(isExcluded(many, "c0")).toBe(false);
    expect(isExcluded(many, `c${EXCLUDED_KEPT}`)).toBe(true);

    const read = normalizeStateV2({ version: 2, conversations: {}, prompts: {}, excluded: { good: 3, bad: "soon", negative: -1, "": 4 } });
    expect(read.excluded).toEqual({ good: 3 });
    expect(normalizeStateV2({ version: 2, conversations: {}, prompts: {}, excluded: [] }).excluded).toBeUndefined();
  });

  it("stay deleted through automatic summaries and the backfill until the user asks again", async () => {
    const env = setup({ threads: claudeThreads(["gone", "kept"]), listed: [{ threadId: "gone", updatedAt: iso(2) }], index: indexOf(["gone", "kept"]) });
    await updateState(env.paths, (draft, ctx) => {
      createConversation(draft, "gone", { title: "删掉的主线" }, ctx);
      deleteConversation(draft, "gone", ctx);
    });
    await env.summarizer.tick();
    expect(env.summarizer.status().toBackfill).toBe(1);
    await env.summarizer.startBackfill();
    await env.settle();
    await env.summarizer.tick();
    expect(env.calls.map(({ threadTitle }) => threadTitle)).toEqual(["对话 kept"]);
    expect((await readState(env.paths)).conversations.gone).toBeUndefined();

    // "Summarize now" lifts the mark and brings it back.
    await env.summarizer.request("gone");
    await env.settle();
    await env.summarizer.stop();
    const state = await readState(env.paths);
    expect(state.conversations.gone?.title).toBe(SUMMARY.title);
    expect(isExcluded(state, "gone")).toBe(false);
  });

  it("comes back when an agent runs `mainline new` in that conversation", async () => {
    const paths = storePaths(dir);
    await updateState(paths, (draft, ctx) => {
      createConversation(draft, "gone", { title: "删掉的主线" }, ctx);
      deleteConversation(draft, "gone", ctx);
    });
    const io = { env: { MAINLINE_DATA_DIR: dir, CODEXHOST_THREAD_ID: "gone", LANG: "zh_CN.UTF-8" }, stdout: () => undefined, stderr: () => undefined, now: () => NOW };
    expect(await run(["new", "重新开始的主线"], io)).toBe(0);
    const state = await readState(paths);
    expect(state.conversations.gone?.title).toBe("重新开始的主线");
    expect(isExcluded(state, "gone")).toBe(false);
  });

  it("stays deleted when that happens while the model is writing", async () => {
    const hold = gate();
    const env = setup({ threads: claudeThreads(["t1"]), hold: hold.opened });
    await env.summarizer.request("t1");
    await env.until(() => env.calls.length === 1);
    await updateState(env.paths, (draft, ctx) => {
      createConversation(draft, "t1", { title: "手写的主线" }, ctx);
      deleteConversation(draft, "t1", ctx);
    });
    hold.open();
    await env.settle();
    await env.summarizer.stop();
    expect((await readState(env.paths)).conversations.t1).toBeUndefined();
  });
});

describe("counting calls", () => {
  it("counts every call on disk by model and reason, and keeps the daily limit across restarts", async () => {
    const counts = summaryCountsPaths(dir);
    const today = emptyDay();
    today.claude.auto = 150;
    today.codex.auto = DAILY_LIMIT - 151;
    await writeFile(counts.file, JSON.stringify({ version: 1, days: { [dayKey(NOW)]: today, "2020-01-01": emptyDay() } }));
    const env = setup({
      threads: { ...claudeThreads(["q1", "q2", "asked"]) },
      listed: ["q1", "q2"].map((threadId) => ({ threadId, updatedAt: iso(2) })),
    });
    await env.summarizer.tick();
    await env.settle();
    await env.summarizer.request("asked");
    await env.settle();
    await env.summarizer.stop();
    // One automatic call was left for today; the asked-for one does not count against the limit.
    expect(env.calls).toHaveLength(2);
    expect(env.summarizer.status().today).toEqual({
      count: DAILY_LIMIT,
      limit: DAILY_LIMIT,
      calls: { claude: { auto: 151, manual: 1, backfill: 0 }, codex: { auto: DAILY_LIMIT - 151, manual: 0, backfill: 0 } },
    });
    const onDisk = await readSummaryCounts(counts);
    expect(Object.keys(onDisk.days)).toEqual([dayKey(NOW)]);
    expect(env.lines).toContain(`automatic summaries stop for today: ${DAILY_LIMIT} were made`);

    // A restarted backend reads the same file: still no automatic call today.
    const again = env.make();
    await again.tick();
    await env.settle(again);
    await again.stop();
    expect(env.calls).toHaveLength(2);
    expect(again.status().today.count).toBe(DAILY_LIMIT);
  });

  it("does not count a call that sent nothing because the tool is missing", async () => {
    const env = setup({ threads: claudeThreads(["t1"]), fail: new ModelNotSentError("Claude Code (the claude command) was not found on this computer") });
    await env.summarizer.request("t1");
    await env.settle();
    await env.summarizer.stop();
    expect(env.calls).toHaveLength(1);
    expect(env.summarizer.status().today.calls.claude.manual).toBe(0);
    expect(dayOf(await readSummaryCounts(summaryCountsPaths(dir)), NOW).claude.manual).toBe(0);
    expect(env.summarizer.status().lastError).toBe("Claude Code (the claude command) was not found on this computer");
  });

  it("logs one line per call, without any conversation text", async () => {
    const env = setup({ threads: claudeThreads(["ok1", "bad1"]) });
    await env.summarizer.request("ok1");
    await env.settle();
    expect(env.lines.filter((line) => line.includes("model call"))).toEqual([expect.stringMatching(/^model call: claude manual ok1 \d+\.\ds ok \(claude-test\)$/u)]);

    const failing = setup({ threads: claudeThreads(["bad1"]), fail: new Error("claude exited with code 1: a network problem") });
    await failing.summarizer.request("bad1");
    await failing.settle();
    await failing.summarizer.stop();
    await env.summarizer.stop();
    expect(failing.lines).toEqual([expect.stringMatching(/^ERROR model call: claude manual bad1 \d+\.\ds failed: claude exited with code 1: a network problem$/u)]);
    expect(failing.summarizer.status().lastError).toBe("claude exited with code 1: a network problem");
    for (const line of [...env.lines, ...failing.lines]) expect(line).not.toContain("侧栏");
  });
});

describe("what is sent", () => {
  it("sends the request without its list of attached files, and with secrets masked", async () => {
    const message = [
      "# Files mentioned by the user:",
      "",
      "## 截图 2026-11-23.png: /Users/someone/Library/Application Support/codexhost/attachments/a/截图 2026-11-23.png",
      "Image attachment: true",
      "",
      "## My request:",
      `部署失败了，key 是 ${["sk", "proj", "4f9KxQ2mN8vR1tY6uZ0aB3cD5eF7gH9j"].join("-")}`,
    ].join("\n");
    const env = setup({ threads: claudeThreads(["t1"]), firstMessage: message });
    await env.summarizer.request("t1");
    await env.settle();
    await env.summarizer.stop();
    const prompt = env.calls[0]!.request.prompt;
    expect(prompt).toContain("[第 1 轮] 用户：部署失败了，key 是 sk-***");
    for (const leaked of ["/Users/someone", "截图 2026-11-23.png", "Files mentioned", "4f9KxQ2mN8vR"]) expect(prompt).not.toContain(leaked);
    expect(await readFile(summaryCountsPaths(dir).file, "utf8")).not.toContain("部署");
  });
});

describe("backend handlers", () => {
  it("stop a backfill asked for from the command line, and say so in the log", async () => {
    const dataDir = path.join(dir, "host-extension-data", "second-brain");
    const extensionDir = path.join(dir, "extension");
    await mkdir(path.join(extensionDir, "bin"), { recursive: true });
    await writeFile(path.join(extensionDir, "bin", "mainline.mjs"), "// cli\n");
    const handlers = new Map<string, (params: unknown) => unknown>();
    const dispose = await activate(
      { extensionId: "second-brain", extensionDir, dataDir, readSettings: async () => ({}), writeSettings: async (values) => values, handle: (method, handler) => handlers.set(method, handler) },
      {
        runGh: async () => {
          throw new Error("no gh in tests");
        },
        runModel: async () => {
          throw new Error("no model in tests");
        },
      },
    );
    try {
      const paths = storePaths(dataDir);
      // What `mainline summarize --all` writes; the backend has not picked it up yet.
      await updateState(paths, (draft, ctx) => {
        draft.jobs = { backfill: { requestedAt: ctx.now } };
      });
      const stopped = (await handlers.get("summarize.cancel")!({})) as Record<string, unknown>;
      expect(stopped).toMatchObject({ running: 0, queued: 0, today: { count: 0, limit: DAILY_LIMIT } });
      expect(stopped).not.toHaveProperty("backfill");
      expect((await readState(paths)).jobs).toBeUndefined();
      await expect.poll(() => readFile(path.join(dataDir, "backend.log"), "utf8").catch(() => ""), { timeout: 3000 }).toContain("backfill stopped from the overview page: 0 waiting dropped");
      // With nothing to summarize, a backfill started from the page ends at once.
      expect(await handlers.get("summarize.backfill")!({})).toMatchObject({ toBackfill: 0 });
      expect((await readState(paths)).jobs).toBeUndefined();
    } finally {
      await dispose();
    }
  });
});
