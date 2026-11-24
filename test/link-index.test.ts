import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiTurn, ExternalApi, ListedThread } from "../src/backend/external-api.js";
import { activate } from "../src/backend/index.js";
import { Scanner } from "../src/backend/scanner.js";
import { addMention, extractLinks, folderName } from "../src/core/refs.js";
import { readIndex, refsPaths, updateIndex } from "../src/node/refs-store.js";
import { fileSignature } from "../src/node/store.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "mainline-index-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const silent = { info: () => undefined, error: () => undefined };

const turn = (turnNumber: number, user: string, agent = ""): ApiTurn => ({
  turnNumber,
  status: "completed",
  messages: [{ role: "user", text: user }, ...(agent ? [{ role: "agent" as const, text: agent }] : [])],
});

/** codexhost's listing (one page) and its conversations. */
function fakeApi(listing: { threads: ListedThread[] }, conversations: Record<string, ApiTurn[]>) {
  return {
    async listThreads() {
      return { threads: listing.threads, nextCursor: null };
    },
    async readTurns(threadId: string, range?: { from: number; to: number }) {
      const turns = conversations[threadId] ?? [];
      if (range) return { totalTurns: turns.length, turns: turns.filter((item) => item.turnNumber >= range.from && item.turnNumber <= range.to) };
      return { totalTurns: turns.length, turns: turns.slice(-10).reverse() };
    },
  } as unknown as ExternalApi;
}

describe("the link index", () => {
  it("keeps only the last folder of a conversation's working folder", async () => {
    expect([folderName("/Users/me/work/site"), folderName("/Users/me/work/site/"), folderName("C:\\work\\app"), folderName("site"), folderName("/")]).toEqual([
      "site",
      "site",
      "app",
      "site",
      "",
    ]);
    const listing = { threads: [{ threadId: "t", updatedAt: "v1", title: "T", cwd: "/Users/me/work/site" }] };
    const paths = refsPaths(dir);
    const scanner = new Scanner(fakeApi(listing, { t: [turn(1, "hi")] }), paths, silent, { recentEveryMs: () => 60_000, pauseMs: 0 });
    for (let i = 0; i < 3; i += 1) await scanner.tick();
    expect((await readIndex(paths)).threads.t).toMatchObject({ cwd: "site", turns: 1 });
    expect(await readFile(paths.file, "utf8")).not.toContain("/Users/me");
  });

  it("keeps the agent codexhost lists for each conversation, also for records read before", async () => {
    const paths = refsPaths(dir);
    await updateIndex(paths, (index) => {
      index.threads.old = { turns: 1, updatedAt: "v1", scannedAt: 1, title: "Old" };
    });
    const listing = {
      threads: [
        { threadId: "t", updatedAt: "v1", title: "T", harnessId: "pi" },
        { threadId: "old", updatedAt: "v1", title: "Old", harnessId: "claude-code" },
      ],
    };
    const scanner = new Scanner(fakeApi(listing, { t: [turn(1, "hi")], old: [turn(1, "hi")] }), paths, silent, { recentEveryMs: () => 60_000, pauseMs: 0 });
    for (let i = 0; i < 4; i += 1) await scanner.tick();
    const index = await readIndex(paths);
    expect(index.threads.t).toMatchObject({ harnessId: "pi", turns: 1 });
    // Not read again (unchanged), yet the listing filled in its agent.
    expect(index.threads.old).toMatchObject({ harnessId: "claude-code", scannedAt: 1 });
  });

  it("writes a read that found nothing new together with the others once the round is over", async () => {
    const listing = { threads: [{ threadId: "t", updatedAt: "v1", title: "T" }] };
    const conversations = { t: [turn(1, "hi")] };
    const paths = refsPaths(dir);
    let now = 1000;
    const scanner = new Scanner(fakeApi(listing, conversations), paths, silent, { recentEveryMs: () => 0, pauseMs: 0, now: () => now });
    for (let i = 0; i < 3; i += 1) await scanner.tick();
    expect((await readIndex(paths)).threads.t?.turns).toBe(1);

    // Two more turns, no link: only how far it was read moved. The file is not touched for that...
    conversations.t = [turn(1, "hi"), turn(2, "more"), turn(3, "and more")];
    listing.threads = [{ threadId: "t", updatedAt: "v2", title: "T" }];
    now = 2000;
    const before = await fileSignature(paths.file);
    await scanner.tick(); // lists the recent ones
    await scanner.tick(); // reads t
    expect(await fileSignature(paths.file)).toBe(before);
    // ...nor read again while it waits.
    await scanner.tick();
    // The round is over: written with the next step.
    expect((await readIndex(paths)).threads.t).toMatchObject({ turns: 3, updatedAt: "v2", scannedAt: 2000 });

    // A new link is written at once.
    conversations.t = [...conversations.t, turn(4, "ship it", "https://github.com/o/r/pull/12")];
    listing.threads = [{ threadId: "t", updatedAt: "v3", title: "T" }];
    now = 3000;
    await scanner.tick();
    await scanner.tick();
    const index = await readIndex(paths);
    expect(index.refs["o/r#12"]?.mentions).toMatchObject([{ threadId: "t", turn: 4 }]);
    expect(index.threads.t?.turns).toBe(4);

    // Held records are written when the scanner stops.
    conversations.t = [...conversations.t, turn(5, "thanks")];
    listing.threads = [{ threadId: "t", updatedAt: "v4", title: "T" }];
    await scanner.tick();
    await scanner.tick();
    expect((await readIndex(paths)).threads.t?.turns).toBe(4);
    await scanner.stop();
    expect((await readIndex(paths)).threads.t?.turns).toBe(5);
  });

  it("forgets conversations a complete listing no longer has, unless a PR names them or the backend keeps them", async () => {
    const paths = refsPaths(dir);
    await updateIndex(paths, (index) => {
      for (const threadId of ["here", "gone", "named", "kept"]) index.threads[threadId] = { turns: 1, updatedAt: "v1", scannedAt: 1, title: threadId, cwd: "site" };
      const [link] = extractLinks("https://github.com/o/r/issues/3");
      addMention(index, link!, { threadId: "named", turn: 1, at: 1, role: "user" });
      index.crawl.listed = 4;
    });
    const listing = { threads: [{ threadId: "here", updatedAt: "v1" }, { threadId: "new", updatedAt: "v1" }] };
    const scanner = new Scanner(fakeApi(listing, { new: [turn(1, "x")] }), paths, silent, { recentEveryMs: () => 60_000, pauseMs: 0, keep: async () => ["kept"] });
    await scanner.tick();
    expect(Object.keys((await readIndex(paths)).threads).sort()).toEqual(["here", "kept", "named"]);

    // A listing far shorter than the last one may have missed a whole source: nothing goes on its word.
    await updateIndex(paths, (index) => {
      for (const threadId of ["a", "b", "c", "d", "e"]) index.threads[threadId] = { turns: 1, updatedAt: "v1", scannedAt: 1 };
      index.crawl.listed = 12;
    });
    listing.threads = [{ threadId: "here", updatedAt: "v1" }];
    const next = new Scanner(fakeApi(listing, {}), paths, silent, { recentEveryMs: () => 60_000, pauseMs: 0 });
    await next.tick();
    expect(Object.keys((await readIndex(paths)).threads)).toHaveLength(8);
  });
});

describe("backend start", () => {
  it("cuts working folders in the index down to their last folder and deletes copies earlier versions left", async () => {
    const dataDir = path.join(dir, "host-extension-data", "second-brain");
    const extensionDir = path.join(dir, "extension");
    await mkdir(path.join(extensionDir, "bin"), { recursive: true });
    await writeFile(path.join(extensionDir, "bin", "mainline.mjs"), "// cli\n");
    const refs = refsPaths(dataDir);
    await updateIndex(refs, (index) => {
      index.threads.a = { turns: 1, updatedAt: "v1", scannedAt: 1, cwd: "/Users/me/work/site" };
      index.threads.b = { turns: 1, updatedAt: "v1", scannedAt: 1, cwd: "/" };
      index.threads.c = { turns: 1, updatedAt: "v1", scannedAt: 1, cwd: "app" };
    });
    const leftovers = ["refs.before-0.3.0.json", "state.before-0.3.0.json", "state.before-0.4.0.json"];
    for (const name of leftovers) await writeFile(path.join(dataDir, name), "{}");
    await writeFile(path.join(dataDir, "state.v1.json"), "{}");
    const dispose = await activate(
      { extensionId: "second-brain", extensionDir, dataDir, readSettings: async () => ({}), writeSettings: async (values) => values, handle: () => undefined },
      { runGh: async () => Promise.reject(new Error("no gh in tests")) },
    );
    try {
      const index = await readIndex(refs);
      expect([index.threads.a?.cwd, index.threads.b?.cwd, index.threads.c?.cwd]).toEqual(["site", undefined, "app"]);
      expect(await readFile(refs.file, "utf8")).not.toContain("/Users/me");
      const files = await readdir(dataDir);
      for (const name of leftovers) expect(files).not.toContain(name);
      expect(files).toContain("state.v1.json");
      await expect.poll(() => readFile(path.join(dataDir, "backend.log"), "utf8").catch(() => "")).toContain(
        "deleted copies earlier versions left behind: refs.before-0.3.0.json, state.before-0.3.0.json, state.before-0.4.0.json",
      );
    } finally {
      await dispose();
    }
  });
});
