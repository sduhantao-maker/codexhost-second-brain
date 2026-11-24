/**
 * Promises the README and the design make that no other test held (each was found by changing
 * the code and seeing every test still pass): edits by hand survive model summaries, automatic
 * summaries keep to their limits, removing the integration leaves the user's own hooks, and last
 * messages are not kept past 14 days.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiThread, ListedThread } from "../src/backend/external-api.js";
import { Integrations } from "../src/backend/integrations.js";
import { applyMutationV2 } from "../src/backend/mutate-v2.js";
import { Summarizer } from "../src/backend/summarizer.js";
import { emptyStateV2, type StateV2 } from "../src/core/conversation.js";
import { applySummary, createConversation, pruneV2 } from "../src/core/conversation-ops.js";
import { DEFAULT_SETTINGS } from "../src/core/model.js";
import { emptyIndex } from "../src/core/refs.js";
import { readState, storePaths, updateState } from "../src/node/store.js";

const NOW = Date.parse("2026-11-24T08:00:00Z");
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * MINUTE).toISOString();

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "mainline-promises-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("edits by hand survive model summaries", () => {
  const ctx = { now: NOW };
  const record = { at: NOW, model: "claude-haiku-test" };

  function withMainline(): StateV2 {
    const state = emptyStateV2();
    createConversation(state, "t1", { title: "Fix the sidebar", tags: ["web"], milestones: ["Find the cause", "Open the PR"] }, ctx);
    return state;
  }

  it("keeps tags set in the overview", () => {
    const state = withMainline();
    applyMutationV2(state, { op: "tags", threadId: "t1", tags: ["mine", "kept"] }, ctx);
    applySummary(state, "t1", { title: "Fix the Web sidebar paging", tags: ["model", "tags"], milestones: [], finished: false }, record, ctx);
    expect(state.conversations.t1!.tags).toEqual(["mine", "kept"]);
    // What was not edited by hand follows the model.
    expect(state.conversations.t1!.title).toBe("Fix the Web sidebar paging");
  });

  it("keeps a milestone renamed in the overview, even when the model leaves it out", () => {
    const state = withMainline();
    const renamed = state.conversations.t1!.milestones[1]!;
    applyMutationV2(state, { op: "milestoneRename", threadId: "t1", milestoneId: renamed.id, title: "Open PR #42" }, ctx);
    applySummary(
      state,
      "t1",
      { title: "Fix the sidebar", tags: [], milestones: [{ title: "Find the cause", state: "done" }, { title: "Write tests", state: "current" }], finished: false },
      record,
      ctx,
    );
    const milestones = state.conversations.t1!.milestones;
    expect(milestones.map(({ title }) => title)).toContain("Open PR #42");
    expect(milestones.find(({ id }) => id === renamed.id)?.title).toBe("Open PR #42");
  });
});

describe("automatic summaries keep to their limits", () => {
  function summarizer(listed: ListedThread[], threads: Record<string, ApiThread>) {
    const paths = storePaths(dir);
    const asked: string[] = [];
    const instance = new Summarizer({
      api: {
        readThread: async (threadId) => threads[threadId],
        readTurns: async () => ({ totalTurns: 1, turns: [{ turnNumber: 1, status: "completed", messages: [{ role: "user", text: "Fix it" }, { role: "agent", text: "Done." }] }] }),
        listThreads: async () => ({ threads: listed, nextCursor: null }),
      },
      runModel: async (_engine, request) => {
        // The prompt names the conversation by its codexhost title, here its id.
        asked.push(/对话标题：(.*)/u.exec(request.prompt)?.[1] ?? "?");
        return { model: "claude-haiku-test", value: { title: "Summarized", tags: [], milestones: [], finished: false } };
      },
      paths,
      log: { info: () => undefined, error: () => undefined },
      state: () => readState(paths),
      index: async () => emptyIndex(),
      settings: async () => ({ ...DEFAULT_SETTINGS }),
      changed: () => undefined,
      now: () => NOW,
    });
    const round = async () => {
      await instance.tick();
      for (let i = 0; i < 500 && (instance.status().running || instance.status().queued); i++) await new Promise((resolve) => setTimeout(resolve, 10));
      await instance.stop();
    };
    return { round, asked, paths };
  }

  const thread = (threadId: string): ApiThread => ({ threadId, title: threadId, status: "idle", harnessId: "claude-code" });

  it("summarize the same conversation again only after 10 minutes, even when it changed", async () => {
    const env = summarizer(
      [
        { threadId: "recent", updatedAt: iso(2), harnessId: "claude-code" },
        { threadId: "due", updatedAt: iso(2), harnessId: "claude-code" },
      ],
      { recent: thread("recent"), due: thread("due") },
    );
    await updateState(env.paths, (draft, ctx) => {
      createConversation(draft, "recent", { title: "Summarized 5 minutes ago" }, ctx);
      createConversation(draft, "due", { title: "Summarized 11 minutes ago" }, ctx);
      // Both changed since: their summaries read an older version.
      draft.conversations.recent!.summary = { at: NOW - 5 * MINUTE, model: "m", threadUpdatedAt: iso(30), finished: false };
      draft.conversations.due!.summary = { at: NOW - 11 * MINUTE, model: "m", threadUpdatedAt: iso(30), finished: false };
    });
    await env.round();
    expect(env.asked).toEqual(["due"]);
  });

  it("leave conversations that last changed over 24 hours ago to the backfill", async () => {
    const env = summarizer(
      [
        { threadId: "today", updatedAt: iso(23 * 60), harnessId: "claude-code" },
        { threadId: "older", updatedAt: iso(25 * 60), harnessId: "claude-code" },
      ],
      { today: thread("today"), older: thread("older") },
    );
    await env.round();
    expect(env.asked).toEqual(["today"]);
    expect(Object.keys((await readState(env.paths)).conversations)).toEqual(["today"]);
  });
});

describe("removing the agent integration", () => {
  it("leaves the user's own hook that runs some other tool's hook claude-prompt", async () => {
    const home = path.join(dir, "home");
    await mkdir(path.join(home, ".claude"), { recursive: true });
    const file = path.join(home, ".claude", "settings.json");
    const settings = { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "/opt/tools/notes hook claude-prompt" }] }] } };
    await writeFile(file, JSON.stringify(settings, null, 2));
    const integrations = new Integrations({ home, dataDir: path.join(dir, "data"), command: "/data/host-extension-data/second-brain/bin/mainline" });
    // Someone else's hook is no installation of ours, outdated or not.
    expect((await integrations.statusOf("claude")).state).toBe("missing");
    await integrations.install("claude");
    expect((await integrations.statusOf("claude")).state).toBe("installed");
    await integrations.uninstall("claude");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(settings);
  });
});

describe("last messages", () => {
  it("are kept 14 days after their last update, no longer", () => {
    const state = emptyStateV2();
    state.prompts = {
      fresh: { text: "From 13 days ago", at: NOW - 13 * DAY },
      stale: { text: "From 15 days ago", at: NOW - 15 * DAY },
    };
    pruneV2(state, { now: NOW });
    expect(Object.keys(state.prompts)).toEqual(["fresh"]);
  });
});
