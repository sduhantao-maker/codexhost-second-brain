/**
 * Correctness audit, finding 1: a backfill over more conversations than the state keeps never
 * ended, sent conversations again and again, and pushed user-edited mainlines out. It must end,
 * send every conversation at most once (also across a restart), and give no conversation a new
 * mainline once the state is full; "at most N" must be what it really sends.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiThread } from "../src/backend/external-api.js";
import { Summarizer } from "../src/backend/summarizer.js";
import { DEFAULT_SETTINGS } from "../src/core/model.js";
import { emptyIndex, type RefIndex } from "../src/core/refs.js";
import { readState, storePaths, updateState } from "../src/node/store.js";

const NOW = Date.parse("2026-11-24T10:00:00Z");
const DAY = 86_400_000;
/** What pruneV2 keeps (MAX_CONVERSATIONS in core/conversation-ops.ts). */
const CAP = 2000;
const id = (i: number) => `t${String(i).padStart(5, "0")}`;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "mainline-backfill-bounds-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface World {
  /** Conversations codexhost lists (all read by the scanner, all with something said). */
  listed: number;
  /** Of those, how many already have a mainline with an up-to-date summary; the last ten are the user's own (pinned). */
  summarized: number;
  /** Of those, how many have a mainline whose summary is older than the conversation (they can be redone without a new mainline). */
  outdated?: number;
}

/** A state file and an index as a heavy user's would be, written directly. */
async function world({ listed, summarized, outdated = 0 }: World): Promise<RefIndex> {
  const index = emptyIndex();
  for (let i = 0; i < listed; i++)
    index.threads[id(i)] = { turns: 3, updatedAt: new Date(NOW - (i + 10) * DAY).toISOString(), scannedAt: NOW, harnessId: "claude-code" };
  const conversations: Record<string, unknown> = {};
  for (let i = 0; i < summarized + outdated; i++) {
    const updatedAt = index.threads[id(i)]!.updatedAt;
    const pinned = i >= summarized - 10 && i < summarized;
    conversations[id(i)] = {
      threadId: id(i),
      title: pinned ? `USER EDITED ${i}` : `done ${i}`,
      ...(pinned ? { pinned: { title: true } } : {}),
      tags: [],
      status: "done",
      milestones: [],
      spinoffs: [],
      createdAt: Date.parse(updatedAt),
      updatedAt: Date.parse(updatedAt),
      summary: { at: NOW - DAY, model: "m", threadUpdatedAt: i < summarized ? updatedAt : "older", turns: 3, finished: true },
    };
  }
  await writeFile(storePaths(dir).state, JSON.stringify({ version: 2, rev: 1, conversations, prompts: {} }));
  return index;
}

function summarizer(index: RefIndex, options: { finished: boolean; sent: Map<string, number>; fail?: (threadId: string) => boolean; changed?: () => void; lines?: string[] }) {
  const paths = storePaths(dir);
  return new Summarizer({
    api: {
      readThread: async (threadId): Promise<ApiThread> => ({ threadId, status: "idle", harnessId: "claude-code" }),
      readTurns: async (threadId) => ({
        totalTurns: 3,
        turns: [{ turnNumber: 3, status: "completed", messages: [{ role: "user", text: `old work of ${threadId}` }, { role: "agent", text: "done" }] }],
      }),
      listThreads: async () => ({ threads: [], nextCursor: null }),
    },
    runModel: async (_engine, request) => {
      const threadId = /old work of (\S+)/u.exec(request.prompt)?.[1] ?? "?";
      options.sent.set(threadId, (options.sent.get(threadId) ?? 0) + 1);
      if (options.fail?.(threadId)) throw new Error("claude exited with code 1: a network problem");
      return { model: "claude-haiku-test", value: { title: `Summary of ${threadId}`, tags: [], milestones: [{ title: "Shipped", state: "done" }], finished: options.finished } };
    },
    paths,
    log: { info: (line) => options.lines?.push(line), error: (line) => options.lines?.push(`ERROR ${line}`) },
    state: () => readState(paths),
    index: async () => index,
    settings: async () => ({ ...DEFAULT_SETTINGS, autoSummarize: false }),
    changed: () => options.changed?.(),
    now: () => NOW,
  });
}

/** Rounds until the backfill request is gone from the state, at most `rounds` of them. */
async function untilFinished(run: Summarizer, rounds = 60): Promise<boolean> {
  for (let i = 0; i < rounds; i++) {
    for (let j = 0; j < 200 && (run.status().running || run.status().queued); j++) await new Promise((resolve) => setTimeout(resolve, 5));
    if (!(await readState(storePaths(dir))).jobs?.backfill) return true;
    await run.tick();
  }
  return false;
}

describe("a backfill above the state's cap", () => {
  for (const finished of [true, false])
    it(`ends at once without a call when the state is full, and keeps every user-edited mainline (model says finished=${finished})`, async () => {
      // The audit's case: codexhost lists 2010 conversations, 2000 of them summarized already.
      const index = await world({ listed: 2010, summarized: CAP });
      const sent = new Map<string, number>();
      const lines: string[] = [];
      const run = summarizer(index, { finished, sent, lines });
      await run.tick();
      // What the overview's button offers ("at most N") is what a backfill would really send.
      expect(run.status().toBackfill).toBe(0);
      await run.startBackfill();
      expect(await untilFinished(run)).toBe(true);
      await run.stop();
      expect(sent.size).toBe(0);
      const state = await readState(storePaths(dir));
      expect(Object.keys(state.conversations)).toHaveLength(CAP);
      expect(Object.values(state.conversations).filter((c) => c.title.startsWith("USER EDITED"))).toHaveLength(10);
      expect(lines.some((line) => line.startsWith("backfill finished") && line.includes("10 conversations without a mainline left out: the state keeps at most 2000 mainlines"))).toBe(true);
    }, 30_000);

  for (const finished of [true, false])
    it(`sends what fits once each, redoes outdated mainlines, and stops adding mainlines at the cap (model says finished=${finished})`, async () => {
      // 1990 summarized + 5 outdated = 1995 mainlines: room for 5 more; 15 listed conversations have none.
      const index = await world({ listed: 2010, summarized: 1990, outdated: 5 });
      const sent = new Map<string, number>();
      const run = summarizer(index, { finished, sent });
      await run.tick();
      expect(run.status().toBackfill).toBe(10);
      await run.startBackfill();
      expect(await untilFinished(run)).toBe(true);
      await run.stop();
      expect(sent.size).toBe(10);
      expect([...sent.values()].every((times) => times === 1)).toBe(true);
      // The five outdated ones were redone, and the five newest conversations without a mainline got one.
      for (let i = 1990; i < 2000; i++) expect(sent.get(id(i))).toBe(1);
      const state = await readState(storePaths(dir));
      expect(Object.keys(state.conversations)).toHaveLength(CAP);
      expect(Object.values(state.conversations).filter((c) => c.title.startsWith("USER EDITED"))).toHaveLength(10);
      expect(run.status().toBackfill).toBe(0);
    }, 30_000);
});

describe("a backfill never sends a conversation twice", () => {
  it("even when what it wrote disappears, a call fails, or the backend restarts halfway", async () => {
    const index = await world({ listed: 8, summarized: 0 });
    const sent = new Map<string, number>();
    const paths = storePaths(dir);
    // Another writer drops every mainline the backfill writes (as pruning at the cap did).
    const drop = () =>
      void updateState(paths, (draft) => {
        for (const threadId of Object.keys(draft.conversations)) delete draft.conversations[threadId];
      });
    const first = summarizer(index, { finished: true, sent, fail: (threadId) => threadId === id(0), changed: drop });
    await first.startBackfill();
    for (let i = 0; i < 400 && sent.size < 4; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    await first.stop();
    // The first backend is gone once its calls under way are over.
    for (let i = 0; i < 400 && first.status().running; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sent.size).toBeGreaterThanOrEqual(4);
    expect(sent.size).toBeLessThan(8);
    // A new backend carries the same backfill on: it reads what the first one tried.
    const second = summarizer(index, { finished: true, sent, changed: drop });
    expect(await untilFinished(second)).toBe(true);
    await second.stop();
    expect(sent.size).toBe(8);
    expect([...sent.values()].every((times) => times === 1)).toBe(true);
  }, 30_000);
});
