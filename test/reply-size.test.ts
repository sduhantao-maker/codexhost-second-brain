/**
 * Release audit, finding 3: codexhost refuses a backend message over 2 MiB, and the snapshot (the
 * whole state), the favorites list (every passage in full) and the PR list grew past it. No answer
 * may be over 1.5 MiB however much is saved; the sizes measured here are reported with the fix.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activate } from "../src/backend/index.js";
import { byteSize, clean, REPLY_LIMIT_BYTES } from "../src/backend/reply-size.js";
import { normalizeStateV2, type StateV2 } from "../src/core/conversation.js";
import type { ConversationView } from "../src/core/conversation-view.js";
import { addMention, emptyIndex, extractLinks } from "../src/core/refs.js";
import type { FavoriteGot, FavoritesList, RefsList, SearchResult, SnapshotResultV2 } from "../src/core/rpc.js";
import { filler, largeState, threadIdOf } from "./fixtures/large.js";

const NOW = Date.now();
/** What codexhost sends for an answer: the value inside `{ id, ok, value }`. */
const sent = (value: unknown) => byteSize({ id: 1, ok: true, value });

let root: string;
let dataDir: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "mainline-reply-size-"));
  dataDir = path.join(root, "host-extension-data", "second-brain");
  await mkdir(dataDir, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function start() {
  const extensionDir = path.join(root, "extension");
  await mkdir(path.join(extensionDir, "bin"), { recursive: true });
  await writeFile(path.join(extensionDir, "bin", "mainline.mjs"), "// cli\n");
  const handlers = new Map<string, (params: unknown) => unknown>();
  const dispose = await activate(
    {
      extensionId: "second-brain",
      extensionDir,
      dataDir,
      readSettings: async () => ({ prAlerts: false, autoSummarize: false }),
      writeSettings: async (values) => values,
      handle: (method, handler) => handlers.set(method, handler),
    },
    { runGh: async () => Promise.reject(new Error("no gh in tests")), runModel: async () => Promise.reject(new Error("no model in tests")) },
  );
  const call = async (method: string, params?: unknown) => handlers.get(method)!(params);
  return { call, dispose };
}

const writeState = (state: StateV2) => writeFile(path.join(dataDir, "state.json"), JSON.stringify(state));

describe("the snapshot", () => {
  it("at 2,000 heavy conversations is an outline of the least needed ones, under the limit, every conversation still listed", async () => {
    const state = largeState({ count: 2000, now: NOW, prompts: 300 });
    await writeState(state);
    const fileBytes = byteSize(state);
    const { call, dispose } = await start();
    try {
      const t0 = performance.now();
      const reply = (await call("snapshot", {})) as SnapshotResultV2;
      const ms = performance.now() - t0;
      const bytes = sent(reply);
      console.info(`snapshot at 2000 conversations: state ${(fileBytes / 1048576).toFixed(2)} MiB, answer ${(bytes / 1048576).toFixed(2)} MiB, ${Math.round(ms)} ms, ${Object.keys(reply.outline ?? {}).length} outlined`);
      expect(fileBytes).toBeGreaterThan(7 * 1048576);
      expect(bytes).toBeLessThanOrEqual(REPLY_LIMIT_BYTES);
      expect(reply.omitted).toBeUndefined();
      expect(Object.keys(reply.state!.conversations)).toHaveLength(2000);
      const outline = reply.outline!;
      // Finished ones first: every finished conversation is an outline before any active one is.
      const statusOf = (threadId: string) => state.conversations[threadId]!.status;
      const outlined = Object.keys(outline);
      expect(outlined.filter((threadId) => statusOf(threadId) === "done")).toHaveLength(1400);
      // The newest conversation in progress goes in full, tasks and all.
      const newestActive = Object.values(state.conversations).find((conversation) => conversation.status === "active")!;
      expect(reply.state!.conversations[newestActive.threadId]).toEqual(newestActive);
      // An outline keeps what the list shows: title, status, last change, the current milestone, and
      // the progress beside it. Read as a state (as every page reads it), the rest is empty.
      const old = Object.values(state.conversations)
        .filter((conversation) => conversation.status === "done")
        .sort((a, b) => a.updatedAt - b.updatedAt)[0]!;
      const read = normalizeStateV2(reply.state).conversations[old.threadId]!;
      expect(read).toMatchObject({ title: old.title, status: "done", updatedAt: old.updatedAt, tags: [], spinoffs: [] });
      expect(read.milestones.map(({ title, state: s, tasks }) => [title, s, tasks.length])).toEqual([[old.milestones[2]!.title, "current", 0]]);
      expect(outline[old.threadId]).toEqual([2, 4]);
      // Unchanged, it is not sent again.
      expect(await call("snapshot", { version: reply.version })).toEqual({ version: reply.version });
    } finally {
      await dispose();
    }
  }, 30_000);

  it("is the whole state, as before, when it fits", async () => {
    // The audit's live data: about 1 KB a conversation.
    const state = largeState({ count: 357, now: NOW, milestones: 3, tasks: 1, taskChars: 40, prompts: 20 });
    await writeState(state);
    const { call, dispose } = await start();
    try {
      const reply = (await call("snapshot", {})) as SnapshotResultV2;
      expect(reply.outline).toBeUndefined();
      expect(reply.state!.conversations).toEqual(state.conversations);
      expect(reply.state!.prompts).toEqual(state.prompts);
    } finally {
      await dispose();
    }
  });

  it("still arrives when even outlines are too much, leaving out the oldest and saying how many", async () => {
    // As long as anything can be: titles and milestones of 120 characters, a long request for each.
    const state = largeState({ count: 2000, now: NOW, titleChars: 120, milestoneChars: 120, milestones: 2, tasks: 0, prompts: 2000, promptChars: 300 });
    await writeState(state);
    const { call, dispose } = await start();
    try {
      const reply = (await call("snapshot", {})) as SnapshotResultV2;
      const bytes = sent(reply);
      console.info(`worst-case snapshot: answer ${(bytes / 1048576).toFixed(2)} MiB, ${reply.omitted} left out`);
      expect(bytes).toBeLessThanOrEqual(REPLY_LIMIT_BYTES);
      expect(reply.omitted).toBeGreaterThan(0);
      // The newest are kept.
      expect(reply.state!.conversations[threadIdOf(0)]).toBeDefined();
    } finally {
      await dispose();
    }
  }, 30_000);
});

describe("the favorites list", () => {
  async function savePassages(count: number) {
    const items = Array.from({ length: count }, (_, i) => ({
      id: `f${String(i).padStart(5, "0")}`,
      threadId: threadIdOf(i),
      text: `${filler(15_000)} needle-${i} ${filler(4_980)}`,
      role: "agent",
      source: "chat",
      createdAt: NOW - i * 1000,
    }));
    await writeFile(path.join(dataDir, "favorites.json"), JSON.stringify({ version: 1, rev: 1, items }));
  }

  it("sends excerpts a page at a time, under the limit, and the whole passage on request", async () => {
    // The audit's case: 80 passages of 20,000 characters made a 2.15 MiB answer.
    await savePassages(300);
    const { call, dispose } = await start();
    try {
      const first = (await call("favorites.list", {})) as FavoritesList;
      console.info(`favorites.list, 300 passages of 20,000 characters: first page ${(sent(first) / 1024).toFixed(0)} KiB`);
      expect(sent(first)).toBeLessThanOrEqual(REPLY_LIMIT_BYTES);
      expect(first).toMatchObject({ total: 300, matched: 300, nextOffset: 100 });
      expect(first.items).toHaveLength(100);
      expect(first.items[0]).toMatchObject({ id: "f00000", truncated: true });
      expect(Array.from(first.items[0]!.text)).toHaveLength(600);
      const most = (await call("favorites.list", { offset: 100, limit: 1000 })) as FavoritesList;
      expect(sent(most)).toBeLessThanOrEqual(REPLY_LIMIT_BYTES);
      expect(most.items[0]!.id).toBe("f00100");
      expect(most.items.length).toBeLessThanOrEqual(300);
      // The search reads every whole passage, not only what is listed of it.
      const found = (await call("favorites.list", { query: "needle-250" })) as FavoritesList;
      expect(found.items.map(({ id }) => id)).toEqual(["f00250"]);
      expect(found).toMatchObject({ matched: 1 });
      expect(found.nextOffset).toBeUndefined();
      const whole = (await call("favorites.get", { id: "f00250" })) as FavoriteGot;
      expect(whole.favorite.text).toBe(`${filler(15_000)} needle-250 ${filler(4_980)}`);
      await expect(call("favorites.get", { id: "nope" })).rejects.toThrow("[UNKNOWN_ITEM]");
    } finally {
      await dispose();
    }
  }, 30_000);
});

describe("other lists", () => {
  it("send the PRs and issues newest first as far as they fit, and say how many are left out", async () => {
    const index = emptyIndex();
    for (let i = 0; i < 2000; i++) {
      const [link] = extractLinks(`https://github.com/owner/repo-${i % 50}/pull/${i + 1}`);
      addMention(index, link!, { threadId: threadIdOf(i % 300), turn: 1, at: NOW - i * 1000, role: "user", prompt: filler(200) });
      const ref = index.refs[link!.key]!;
      ref.title = filler(200);
      ref.note = { text: filler(300), threadId: threadIdOf(i % 300), at: NOW };
    }
    await writeFile(path.join(dataDir, "refs.json"), JSON.stringify(index));
    const { call, dispose } = await start();
    try {
      const list = (await call("refs.list")) as RefsList;
      console.info(`refs.list, 2000 long PRs: ${(sent(list) / 1048576).toFixed(2)} MiB, ${list.refs.length} sent, ${list.omitted} left out`);
      expect(sent(list)).toBeLessThanOrEqual(REPLY_LIMIT_BYTES);
      expect(list.status.refs).toBe(2000);
      expect(list.refs.length + (list.omitted ?? 0)).toBe(2000);
      expect(list.omitted).toBeGreaterThan(0);
      expect(list.refs[0]!.number).toBe(1);
      const ofThread = (await call("refs.forThread", { threadId: threadIdOf(0) })) as unknown[];
      expect(sent(ofThread)).toBeLessThanOrEqual(REPLY_LIMIT_BYTES);
    } finally {
      await dispose();
    }
  }, 30_000);

  it("keep search results small however many PRs a conversation has", async () => {
    const index = emptyIndex();
    for (let i = 0; i < 500; i++) {
      const [link] = extractLinks(`https://github.com/owner/repo/pull/${i + 1}`);
      addMention(index, link!, { threadId: "t1", turn: 1, at: NOW - i, role: "user" });
    }
    index.threads.t1 = { turns: 1, updatedAt: "u", scannedAt: NOW, title: `release ${filler(400)}` };
    await writeFile(path.join(dataDir, "refs.json"), JSON.stringify(index));
    const { call, dispose } = await start();
    try {
      const [hit] = (await call("search", { query: "release" })) as SearchResult[];
      expect(hit!.refs.length).toBeLessThanOrEqual(20);
      expect(Array.from(hit!.match.text).length).toBeLessThanOrEqual(300);
    } finally {
      await dispose();
    }
  });

  it("fit a conversation's full view even at the most a mainline can hold", async () => {
    // 30 milestones of 60 tasks of 300 characters: about 1.6 MiB of text in one mainline.
    const state = largeState({ count: 1, now: NOW, milestones: 30, tasks: 60, taskChars: 300 });
    await writeState(state);
    const { call, dispose } = await start();
    try {
      const view = (await call("conversation", { threadId: threadIdOf(0) })) as ConversationView;
      expect(byteSize(state)).toBeGreaterThan(REPLY_LIMIT_BYTES);
      expect(sent(view)).toBeLessThanOrEqual(REPLY_LIMIT_BYTES);
      // What is in progress stays whole; reached milestones give up their tasks first.
      expect(view.milestones.find((milestone) => milestone.state === "current")!.tasks).toHaveLength(60);
    } finally {
      await dispose();
    }
  }, 30_000);

  it("refuse anything else over the limit with TOO_LARGE rather than send it", () => {
    expect(() => clean({ text: "x".repeat(REPLY_LIMIT_BYTES) })).toThrow(/TOO_LARGE|over/u);
    expect(clean({ a: 1, b: undefined })).toEqual({ a: 1 });
  });
});
