/**
 * Correctness audit, finding 8: two failed summaries stopped automatic summaries of a conversation
 * until the backend restarted. A failed conversation is tried again after 30 minutes, then twice as
 * long each time up to 8 hours; at once when it has a new turn or the user asks. Failed calls that
 * were sent still count for the day.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiThread, ApiTurn, ListedThread } from "../src/backend/external-api.js";
import { Summarizer } from "../src/backend/summarizer.js";
import { DEFAULT_SETTINGS } from "../src/core/model.js";
import { emptyIndex } from "../src/core/refs.js";
import { readState, storePaths } from "../src/node/store.js";
import { dayOf, readSummaryCounts, summaryCountsPaths } from "../src/node/summary-counts.js";

const MINUTE = 60_000;
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "mainline-summary-retry-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function setup(start: number) {
  const clock = { now: start, updatedAt: new Date(start - 5 * MINUTE).toISOString(), failing: true };
  let calls = 0;
  const paths = storePaths(dir);
  const listed = (): ListedThread[] => [{ threadId: "t1", updatedAt: clock.updatedAt, status: "idle", harnessId: "claude-code" }];
  const turns: ApiTurn[] = [{ turnNumber: 1, status: "completed", messages: [{ role: "user", text: "fix the sidebar" }, { role: "agent", text: "done" }] }];
  const summarizer = new Summarizer({
    api: {
      readThread: async (): Promise<ApiThread> => ({ threadId: "t1", status: "idle", harnessId: "claude-code" }),
      readTurns: async () => ({ totalTurns: 1, turns }),
      listThreads: async () => ({ threads: listed(), nextCursor: null }),
    },
    runModel: async () => {
      calls += 1;
      if (clock.failing) throw new Error("claude exited with code 1: a rate or usage limit was reached");
      return { model: "claude-haiku-test", value: { title: "Fix the sidebar", tags: [], milestones: [], finished: false } };
    },
    paths,
    log: { info: () => undefined, error: () => undefined },
    state: () => readState(paths),
    index: async () => emptyIndex(),
    settings: async () => ({ ...DEFAULT_SETTINGS }),
    changed: () => undefined,
    now: () => clock.now,
  });
  const settle = async () => {
    for (let i = 0; i < 300 && (summarizer.status().running || summarizer.status().queued); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  };
  /** One round at `clock.now`, and whatever it started. */
  const round = async () => {
    await summarizer.tick();
    await settle();
  };
  return { clock, summarizer, round, calls: () => calls, paths };
}

describe("a conversation whose summary failed", () => {
  it("is summarized once the conversation has new turns, without waiting for a restart", async () => {
    const env = setup(Date.parse("2026-11-24T10:00:00Z"));
    // A usage limit: the first try fails, and the next round (a minute later) does not hammer it.
    await env.round();
    env.clock.now += MINUTE;
    await env.round();
    expect(env.calls()).toBe(1);
    // The limit is over; hours later the conversation has new turns.
    env.clock.failing = false;
    for (let hour = 0; hour < 3; hour++) {
      env.clock.now += 60 * MINUTE;
      env.clock.updatedAt = new Date(env.clock.now - 2 * MINUTE).toISOString();
      await env.round();
    }
    await env.summarizer.stop();
    expect((await readState(env.paths)).conversations.t1?.title).toBe("Fix the sidebar");
    // The failed call was sent, so it counts for the day like any other.
    expect(dayOf(await readSummaryCounts(summaryCountsPaths(dir)), env.clock.now).claude.auto).toBe(env.calls());
  });

  it("without new turns is tried again after 30 minutes, then twice as long each time, up to 8 hours", async () => {
    const start = Date.parse("2026-11-24T00:30:00Z");
    const env = setup(start);
    // The conversation changed a few minutes ago and then stayed quiet.
    const at = (minutes: number) => {
      env.clock.now = start + minutes * MINUTE;
    };
    const tries: number[] = [];
    const roundAt = async (minutes: number) => {
      at(minutes);
      const before = env.calls();
      await env.round();
      if (env.calls() > before) tries.push(minutes);
    };
    for (const minutes of [0, 10, 29, 31, 60, 90, 92, 150, 211, 213, 330, 452, 454, 700, 933, 935, 1414, 1416, 1900]) await roundAt(minutes);
    await env.summarizer.stop();
    // 0 failed: next at 30; 31 failed: next at 91; 92 failed: next at 212; 213 failed: next at 453;
    // 454 failed: next at 934; 935 failed: next at 1415, 8 hours (the cap) and not 16. By 1900 the
    // conversation is quiet for over 24 hours: it is the backfill's, not the automatic summaries'.
    expect(tries).toEqual([0, 31, 92, 213, 454, 935, 1416]);
    expect(env.calls()).toBe(7);
  });

  it("is tried at once when the user asks, whatever its back-off", async () => {
    const env = setup(Date.parse("2026-11-24T10:00:00Z"));
    await env.round();
    expect(env.calls()).toBe(1);
    env.clock.now += MINUTE;
    env.clock.failing = false;
    await env.round();
    expect(env.calls()).toBe(1);
    await env.summarizer.request("t1");
    for (let i = 0; i < 300 && (env.summarizer.status().running || env.summarizer.status().queued); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    await env.summarizer.stop();
    expect(env.calls()).toBe(2);
    expect((await readState(env.paths)).conversations.t1?.title).toBe("Fix the sidebar");
  });
});
