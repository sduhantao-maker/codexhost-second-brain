/**
 * The summarizer and the cap on mainlines (`MAX_CONVERSATIONS`): no model call is spent on a
 * conversation without a mainline when the state has no room for one, a manual request says so
 * before anything is sent, a summary refused for room after the call waits the longest instead of
 * coming back with every turn, and a day's count file that had to be set aside is logged.
 */
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiThread, ApiTurn, ListedThread } from "../src/backend/external-api.js";
import { recordCap, RETRY_CAP_MS, Summarizer } from "../src/backend/summarizer.js";
import { emptyStateV2, type Conversation, type StateV2 } from "../src/core/conversation.js";
import { MAX_CONVERSATIONS } from "../src/core/conversation-ops.js";
import { DEFAULT_SETTINGS } from "../src/core/model.js";
import { emptyIndex } from "../src/core/refs.js";
import { readState, storePaths } from "../src/node/store.js";
import { summaryCountsPaths } from "../src/node/summary-counts.js";

const MINUTE = 60_000;
const START = Date.parse("2026-11-24T10:00:00Z");
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "mainline-summarizer-caps-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const id = (i: number) => `t${String(i).padStart(5, "0")}`;

/** A state at the cap; `make(i)` shapes the i-th mainline. */
function full(make: (i: number) => Partial<Conversation>): StateV2 {
  const state = emptyStateV2();
  for (let i = 0; i < MAX_CONVERSATIONS; i += 1)
    state.conversations[id(i)] = { threadId: id(i), title: `Work ${i}`, tags: [], status: "active", milestones: [], spinoffs: [], createdAt: 1, updatedAt: 1 + i, ...make(i) };
  return state;
}

/** A summarizer over `state`, with codexhost listing `listed` and a stand-in model answering `finished`. */
async function setup(state: StateV2, listed: string[], finished = false) {
  const paths = storePaths(dir);
  await writeFile(paths.state, JSON.stringify(state));
  const clock = { now: START, updatedAt: new Date(START - 5 * MINUTE).toISOString() };
  const sent: string[] = [];
  const lines: string[] = [];
  const turns: ApiTurn[] = [{ turnNumber: 1, status: "completed", messages: [{ role: "user", text: "fix the sidebar" }, { role: "agent", text: "done" }] }];
  const summarizer = new Summarizer({
    api: {
      readThread: async (threadId): Promise<ApiThread> => ({ threadId, status: "idle", harnessId: "claude-code" }),
      readTurns: async () => ({ totalTurns: 1, turns }),
      listThreads: async () => ({ threads: listed.map((threadId): ListedThread => ({ threadId, updatedAt: clock.updatedAt, status: "idle", harnessId: "claude-code" })), nextCursor: null }),
    },
    runModel: async (_engine, request) => {
      sent.push(request.prompt);
      return { model: "claude-haiku-test", value: { title: "Fix the sidebar", tags: [], milestones: [], finished } };
    },
    paths,
    log: { info: (line) => lines.push(line), error: (line, error) => lines.push(`ERROR ${line}: ${error instanceof Error ? error.message : String(error)}`) },
    state: () => readState(paths),
    index: async () => emptyIndex(),
    settings: async () => ({ ...DEFAULT_SETTINGS }),
    changed: () => undefined,
    now: () => clock.now,
  });
  const settle = async () => {
    for (let i = 0; i < 400 && (summarizer.status().running || summarizer.status().queued); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  };
  const round = async () => {
    await summarizer.tick();
    await settle();
  };
  return { paths, clock, summarizer, round, settle, sent, lines };
}

describe("the summarizer at the cap on mainlines", () => {
  it("takes the cap from the core", () => {
    expect(recordCap()).toBe(MAX_CONVERSATIONS);
  });

  it("spends no call on a conversation without a mainline when none can be added, and still keeps the others up to date", async () => {
    // Every mainline was edited by hand: none may go.
    const env = await setup(
      full(() => ({ pinned: { title: true } })),
      ["new-1", id(7)],
    );
    try {
      await env.round();
      expect(env.sent).toHaveLength(1);
      // The one with a mainline was summarized (its title stays the user's); the new one was left out, and the log says so once.
      const state = await readState(env.paths);
      expect(state.conversations[id(7)]?.summary?.model).toBe("claude-haiku-test");
      expect(state.conversations[id(7)]?.title).toBe("Work 7");
      expect(state.conversations["new-1"]).toBeUndefined();
      env.clock.now += 2 * MINUTE;
      await env.round();
      expect(env.sent).toHaveLength(1);
      expect(env.lines.filter((line) => line.includes("leave out conversations without a mainline"))).toHaveLength(1);
      // Asked for by hand: refused at once, before anything is read or sent.
      await expect(env.summarizer.request("new-1")).rejects.toMatchObject({ code: "STATE_FULL" });
      expect(env.sent).toHaveLength(1);
    } finally {
      await env.summarizer.stop();
    }
  });

  it("lets a summary refused for room after the call wait the longest, new turns or not", async () => {
    // Room by the rules (nobody edited these), but a finished conversation would itself be the first to go.
    const env = await setup(full(() => ({})), ["new-1"], true);
    try {
      await env.round();
      expect(env.sent).toHaveLength(1);
      expect(env.summarizer.status()).toMatchObject({ lastErrorCode: "STATE_FULL" });
      expect((await readState(env.paths)).conversations["new-1"]).toBeUndefined();
      // New turns come and go: no call until the longest wait is over.
      for (let step = 1; step <= 4; step++) {
        env.clock.now += 60 * MINUTE;
        env.clock.updatedAt = new Date(env.clock.now - 2 * MINUTE).toISOString();
        await env.round();
      }
      expect(env.sent).toHaveLength(1);
      env.clock.now = START + RETRY_CAP_MS + MINUTE;
      env.clock.updatedAt = new Date(env.clock.now - 2 * MINUTE).toISOString();
      await env.round();
      expect(env.sent).toHaveLength(2);
    } finally {
      await env.summarizer.stop();
    }
  });

  it("logs that the day's counts had to be set aside", async () => {
    const env = await setup(emptyStateV2(), ["new-1"]);
    try {
      await writeFile(summaryCountsPaths(dir).file, "{ not json");
      await env.round();
      expect(env.sent).toHaveLength(1);
      const copies = (await readdir(dir)).filter((name) => name.startsWith("summary-counts.corrupt-"));
      expect(copies).toHaveLength(1);
      expect(env.lines).toContain(`summary-counts.json could not be read and was set aside as ${copies[0]}; today's count of automatic summaries starts again from 0`);
    } finally {
      await env.summarizer.stop();
    }
  });
});
