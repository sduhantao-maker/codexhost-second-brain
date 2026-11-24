import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiThread, ApiTurn, ListedThread } from "../src/backend/external-api.js";
import type { Engine, ModelRequest } from "../src/backend/models.js";
import { DAILY_LIMIT, Summarizer } from "../src/backend/summarizer.js";
import { createConversation } from "../src/core/conversation-ops.js";
import { DEFAULT_SETTINGS, type Settings } from "../src/core/model.js";
import { emptyIndex, type RefIndex } from "../src/core/refs.js";
import { readSummary, summaryPrompt } from "../src/core/summary-prompt.js";
import { readState, storePaths, updateState } from "../src/node/store.js";

const NOW = Date.parse("2026-11-23T10:00:00Z");
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "mainline-summary-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const turns = (count: number): ApiTurn[] =>
  Array.from({ length: count }, (_, i) => ({
    turnNumber: i + 1,
    status: "completed",
    messages: [
      { role: "user" as const, text: i === 0 ? "帮我修结算页在窄屏下的错位" : `第 ${i + 1} 个请求` },
      { role: "agent" as const, text: `第 ${i + 1} 轮的回复` },
    ],
  }));

function setup(options: { threads?: Record<string, ApiThread>; listed?: ListedThread[]; index?: RefIndex; settings?: Partial<Settings> } = {}) {
  const paths = storePaths(dir);
  const calls: Array<{ engine: Engine; request: ModelRequest }> = [];
  const read: string[] = [];
  let changed = 0;
  const threads = options.threads ?? { t1: { threadId: "t1", title: "当前 web 端使用还是有问题", status: "idle", harnessId: "claude-code" } };
  const summarizer = new Summarizer({
    api: {
      readThread: async (threadId) => threads[threadId],
      readTurns: async (threadId, range) => {
        read.push(`${threadId}:${range ? `${range.from}-${range.to}` : "latest"}`);
        const all = turns(threadId === "long" ? 60 : 3);
        const picked = range ? all.filter((turn) => turn.turnNumber >= range.from && turn.turnNumber <= range.to) : all.slice(-10);
        return { totalTurns: all.length, turns: [...picked].reverse() };
      },
      listThreads: async () => ({ threads: options.listed ?? [], nextCursor: null }),
    },
    runModel: async (engine, request) => {
      calls.push({ engine, request });
      return {
        model: engine === "claude" ? "claude-haiku-test" : "gpt-6-luna",
        value: {
          title: "修复结算页「窄屏错位」",
          tags: ["shop-web", "结算页", "PR #42"],
          milestones: [
            { title: "定位原因", state: "done" },
            { title: "提交 PR", state: "current" },
          ],
          finished: false,
        },
      };
    },
    paths,
    log: { info: () => undefined, error: () => undefined },
    state: () => readState(paths),
    index: async () => options.index ?? emptyIndex(),
    settings: async () => ({ ...DEFAULT_SETTINGS, ...options.settings }),
    changed: () => {
      changed += 1;
    },
    now: () => NOW,
  });
  const settle = async () => {
    // Model calls are stand-ins, but the store writes are real: allow for a busy machine.
    for (let i = 0; i < 500 && (summarizer.status().running || summarizer.status().queued); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  };
  return { summarizer, paths, calls, read, settle, changed: () => changed };
}

describe("summary prompt", () => {
  it("shows the current mainline, the first request and the latest turns, oldest dropped first", () => {
    const prompt = summaryPrompt({
      threadTitle: "当前 web 端使用还是有问题",
      current: { title: "修结算页", tags: ["shop-web"], milestones: [{ id: "m1", title: "定位原因", state: "done", tasks: [] }], now: { text: "写测试", at: 1 } },
      firstPrompt: "帮我修结算页在窄屏下的错位",
      totalTurns: 60,
      turns: turns(60)
        .slice(20)
        .map((turn) => ({ turn: turn.turnNumber, user: turn.messages[0]!.text, agent: "很长的回复".repeat(200) })),
    });
    expect(prompt).toContain('"milestones":[{"title":"定位原因","state":"done"}]');
    expect(prompt).toContain('"doing":"写测试"');
    expect(prompt).toContain("对话开头的请求：帮我修结算页在窄屏下的错位");
    expect(prompt).toContain("[第 60 轮]");
    expect(prompt.length).toBeLessThan(26_000);
    expect(readSummary({ title: " ", tags: [], milestones: [], finished: false })).toBeUndefined();
    expect(readSummary({ title: "x", tags: ["a", 3], milestones: [{ title: "m", state: "maybe" }, { title: "n", state: "done" }], finished: true })).toEqual({
      title: "x",
      tags: ["a"],
      milestones: [{ title: "n", state: "done" }],
      finished: true,
    });
  });
});

describe("summarizer", () => {
  it("summarizes a conversation when asked, with the model of the conversation's own kind", async () => {
    const env = setup({
      threads: {
        t1: { threadId: "t1", title: "当前 web 端使用还是有问题", status: "idle", harnessId: "claude-code" },
        long: { threadId: "long", title: "很长的 Codex 对话", status: "waiting", harnessId: "codex" },
      },
    });
    await env.summarizer.request("t1");
    await env.summarizer.request("long");
    await env.settle();
    // Each with the model of its own kind; the two run side by side, so in either order.
    const byTitle = env.calls.map(({ engine, request }) => [/对话标题：(.*)/u.exec(request.prompt)?.[1], engine]);
    expect(Object.fromEntries(byTitle)).toEqual({ "当前 web 端使用还是有问题": "claude", "很长的 Codex 对话": "codex" });
    // A long conversation: its latest 40 turns, 20 at a time so no single read takes too long.
    expect(env.read).toEqual(expect.arrayContaining(["long:41-60", "long:21-40"]));
    expect(env.read).not.toContain("long:1-20");
    const state = await readState(env.paths);
    expect(state.conversations.t1).toMatchObject({
      title: "修复结算页「窄屏错位」",
      tags: ["shop-web", "结算页", "PR #42"],
      summary: { model: "claude-haiku-test", turns: 3 },
    });
    expect(state.conversations.t1!.milestones.map(({ title, state: s }) => [title, s])).toEqual([
      ["定位原因", "done"],
      ["提交 PR", "current"],
    ]);
    expect(state.conversations.long!.summary?.model).toBe("gpt-6-luna");
    expect(env.changed()).toBe(2);
  });

  it("picks up conversations whose turn ended a minute ago and changed since their last summary", async () => {
    const env = setup({
      threads: {
        quiet: { threadId: "quiet", status: "idle", harnessId: "claude-code" },
        busy: { threadId: "busy", status: "running", harnessId: "claude-code" },
        fresh: { threadId: "fresh", status: "idle" },
        same: { threadId: "same", status: "idle" },
      },
      listed: [
        { threadId: "quiet", updatedAt: iso(2) },
        { threadId: "busy", updatedAt: iso(3) },
        { threadId: "fresh", updatedAt: iso(0.2) },
        { threadId: "same", updatedAt: iso(30) },
        { threadId: "old", updatedAt: iso(3 * 24 * 60) },
      ],
    });
    await updateState(env.paths, (draft, ctx) => {
      createConversation(draft, "same", { title: "已经凝练过" }, ctx);
      draft.conversations.same!.summary = { at: NOW - 3_600_000, model: "m", threadUpdatedAt: iso(30) };
    });
    await env.summarizer.tick();
    await env.settle();
    await env.summarizer.stop();
    // Only the quiet one: busy is mid-turn, fresh changed seconds ago, same has not changed, old is the backfill's.
    expect(env.calls).toHaveLength(1);
    expect((await readState(env.paths)).conversations.quiet?.summary?.threadUpdatedAt).toBe(iso(2));
    expect(env.summarizer.status().today).toMatchObject({ count: 1, limit: DAILY_LIMIT, calls: { claude: { auto: 1 } } });
  });

  it("does nothing automatic when automatic summaries are off", async () => {
    const env = setup({ settings: { autoSummarize: false }, listed: [{ threadId: "t1", updatedAt: iso(2) }] });
    await env.summarizer.tick();
    await env.settle();
    await env.summarizer.stop();
    expect(env.calls).toHaveLength(0);
  });

  it("works through every older conversation once, then clears the job", async () => {
    const index = emptyIndex();
    for (const [id, minutes] of [["a", 60 * 24 * 40], ["b", 60 * 24 * 10], ["gone", 60], ["empty", 60]] as const)
      index.threads[id] = { turns: id === "empty" ? 0 : 3, updatedAt: iso(minutes), scannedAt: NOW, ...(id === "gone" ? { unreadable: true } : {}) };
    const env = setup({
      index,
      // A conversation mid-turn keeps being looked at; that must not hold the backfill open.
      threads: {
        a: { threadId: "a", status: "idle", harnessId: "claude-code" },
        b: { threadId: "b", status: "idle", harnessId: "codex" },
        busy: { threadId: "busy", status: "running", harnessId: "claude-code" },
      },
      listed: [{ threadId: "busy", updatedAt: iso(2) }],
    });
    await env.summarizer.startBackfill();
    await env.settle();
    await env.summarizer.tick();
    await env.summarizer.stop();
    const state = await readState(env.paths);
    expect(Object.keys(state.conversations).sort()).toEqual(["a", "b"]);
    // Old conversations are dated by their own activity and not left "in progress".
    expect(state.conversations.a).toMatchObject({ status: "paused", updatedAt: Date.parse(iso(60 * 24 * 40)) });
    expect(state.jobs).toBeUndefined();
    expect(env.summarizer.status().backfill).toBeUndefined();
  });
});
