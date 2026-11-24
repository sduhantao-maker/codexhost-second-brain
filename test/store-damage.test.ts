import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/cli/main.js";
import { createConversation } from "../src/core/conversation-ops.js";
import { addFavorite } from "../src/core/favorites.js";
import { setNote, extractLinks } from "../src/core/refs.js";
import { ownersPaths, readOwners, updateOwners } from "../src/node/attachment-owners.js";
import { contextFile, readSeen, writeSeen } from "../src/node/context-record.js";
import { favoritesPaths, readFavorites, updateFavorites } from "../src/node/favorites-store.js";
import { readIndex, refsPaths, updateIndex } from "../src/node/refs-store.js";
import { readState, setAside, storePaths, updateState } from "../src/node/store.js";
import { countSummaryCall, dayKey, dayOf, readSummaryCounts, summaryCountsPaths, uncountSummaryCall } from "../src/node/summary-counts.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "mainline-damage-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A file cut short, as a crash right after writing can leave it (nothing is synced to disk). */
async function cutShort(file: string, text: string): Promise<void> {
  await writeFile(file, text.slice(0, text.length - 5));
}

const copiesOf = async (folder: string, base: string) => (await readdir(folder)).filter((name) => name.startsWith(`${base}.corrupt-`)).sort();
const UPLOAD = "5f0c9a1e-0000-4000-8000-000000000001";
const NOW = new Date(2026, 10, 24, 15, 0).getTime();

function cli() {
  let out = "";
  let err = "";
  const io = {
    env: { MAINLINE_DATA_DIR: dir, LANG: "en_US.UTF-8", CODEXHOST_THREAD_ID: "t1" },
    stdout: (text: string) => void (out += text),
    stderr: (text: string) => void (err += text),
    runGh: async () => Promise.reject(new Error("no gh in tests")),
    turns: { readTurns: async () => ({ totalTurns: 0, turns: [] }) },
  };
  return async (...argv: string[]) => {
    out = "";
    err = "";
    const code = await run(argv, io as unknown as Parameters<typeof run>[1]);
    return { code, out, err };
  };
}

describe("a damaged file", () => {
  it("of favorites is set aside before the next save replaces it, with every passage it held", async () => {
    const paths = favoritesPaths(dir);
    await updateFavorites(paths, (file) => {
      for (let i = 0; i < 3; i += 1) addFavorite(file, { threadId: "t1", text: `important passage ${i}`, source: "select" }, 1000 + i);
    });
    const text = await readFile(paths.file, "utf8");
    await cutShort(paths.file, text);
    expect((await readFavorites(paths)).items).toEqual([]);
    const saved = await cli()("fav", "a new passage to keep");
    expect(saved.code).toBe(0);
    expect((await readFavorites(paths)).items.map((item) => item.text)).toEqual(["a new passage to keep"]);
    const [copy, ...more] = await copiesOf(dir, "favorites");
    expect(more).toEqual([]);
    expect(await readFile(path.join(dir, copy!), "utf8")).toBe(text.slice(0, text.length - 5));
  });

  it("of the link index is set aside before the next write, with the notes it held", async () => {
    const paths = refsPaths(dir);
    const [link] = extractLinks("https://github.com/o/r/pull/7");
    await updateIndex(paths, (index) => setNote(index, link!, "t1", "the fix for the export", 1));
    await writeFile(paths.file, "{\"version\":1,\"refs\":{\"o/r#7\":");
    expect((await readIndex(paths)).refs).toEqual({});
    await updateIndex(paths, (index) => setNote(index, link!, "t1", "written again", 2));
    const [copy] = await copiesOf(dir, "refs");
    expect(await readFile(path.join(dir, copy!), "utf8")).toContain("\"o/r#7\":");
    expect((await readIndex(paths)).refs["o/r#7"]?.note?.text).toBe("written again");
  });

  it("of attachment owners is set aside before the next write", async () => {
    const paths = ownersPaths(path.join(dir, "attachments"));
    await mkdir(paths.dir, { recursive: true });
    await writeFile(paths.file, "{\"version\":1,\"owners\":{");
    expect(await readOwners(paths)).toEqual({});
    await updateOwners(paths, (owners) => {
      owners[UPLOAD] = { child: "child-1", parent: "t1", at: 1 };
    });
    expect(await copiesOf(paths.dir, "owners")).toHaveLength(1);
    expect(Object.keys(await readOwners(paths))).toEqual([UPLOAD]);
  });

  it("of a context record is set aside before it is written again", async () => {
    const file = contextFile(dir, "t1", "hook");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{\"version\":1,");
    expect(await readSeen(dir, "t1", "hook")).toBeUndefined();
    await writeSeen(dir, "t1", "hook", { fullAt: 1, rules: "r", since: 0, status: "s" });
    expect(await copiesOf(path.dirname(file), "t1.hook")).toHaveLength(1);
    expect(await readSeen(dir, "t1", "hook")).toEqual({ fullAt: 1, rules: "r", since: 0, status: "s" });
  });

  it("of summary counts is set aside when the next call is counted, and the caller is told so", async () => {
    const paths = summaryCountsPaths(dir);
    await countSummaryCall(paths, { engine: "claude", reason: "auto", at: NOW, limit: 30 });
    await writeFile(paths.file, "{ broken");
    // Nothing to take back from a damaged file: it stays as it is.
    await uncountSummaryCall(paths, { engine: "claude", reason: "auto", at: NOW });
    expect(await readFile(paths.file, "utf8")).toBe("{ broken");
    const counted = await countSummaryCall(paths, { engine: "claude", reason: "auto", at: NOW, limit: 30 });
    expect(counted.counted).toBe(true);
    expect(counted.setAside).toMatch(/summary-counts\.corrupt-.+\.json$/u);
    expect(await readFile(counted.setAside!, "utf8")).toBe("{ broken");
    expect(dayOf(await readSummaryCounts(paths), NOW).claude.auto).toBe(1);
    // An intact file says nothing of the kind.
    expect((await countSummaryCall(paths, { engine: "claude", reason: "auto", at: NOW, limit: 30 })).setAside).toBeUndefined();
  });

  it("keeps at most three set-aside copies of a file", async () => {
    const file = path.join(dir, "favorites.json");
    for (let i = 0; i < 5; i += 1) {
      await writeFile(file, `damaged ${i}`);
      await setAside(file, NOW + i * 1000);
    }
    const copies = await copiesOf(dir, "favorites");
    expect(copies).toHaveLength(3);
    expect(await Promise.all(copies.map((name) => readFile(path.join(dir, name), "utf8")))).toEqual(["damaged 2", "damaged 3", "damaged 4"]);
  });

  it("of the state is set aside as before, the newest three copies kept", async () => {
    const paths = storePaths(dir);
    for (let i = 0; i < 4; i += 1) {
      await writeFile(paths.state, `{"version":2,"conversations":{${i}`);
      await updateState(paths, (draft, ctx) => createConversation(draft, `t${i}`, { title: "Goal" }, ctx), { now: NOW + i });
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(await copiesOf(dir, "state")).toHaveLength(3);
    expect(Object.keys((await readState(paths)).conversations)).toEqual(["t3"]);
  });
});

describe("a file a newer version wrote", () => {
  it("of the state is never renamed away or replaced, and reads and writes say why", async () => {
    const paths = storePaths(dir);
    const newer = JSON.stringify({ version: 3, rev: 9, conversations: { t1: { title: "kept by a newer version" } } });
    await writeFile(paths.state, newer);
    await expect(readState(paths)).rejects.toMatchObject({ code: "NEWER_VERSION", message: expect.stringContaining("state.json") });
    await expect(updateState(paths, (draft, ctx) => createConversation(draft, "t2", { title: "Other" }, ctx))).rejects.toMatchObject({ code: "NEWER_VERSION" });
    const shown = await cli()("doing", "write the migration");
    expect(shown.code).toBe(1);
    expect(shown.err).toBe("mainline: A data file was written by a newer version of the extension; this version neither reads nor changes it. Update the Second Brain extension.\n");
    expect(await readFile(paths.state, "utf8")).toBe(newer);
    expect(await copiesOf(dir, "state")).toEqual([]);
  });

  it("of favorites is never replaced, and reads and writes say why", async () => {
    const paths = favoritesPaths(dir);
    const newer = JSON.stringify({ version: 2, rev: 9, items: [{ id: "x1", threadId: "t1", text: "kept by a newer version", createdAt: 1 }] });
    await writeFile(paths.file, newer);
    await expect(readFavorites(paths)).rejects.toMatchObject({ code: "NEWER_VERSION" });
    const saved = await cli()("fav", "another passage");
    expect(saved.code).toBe(1);
    expect(saved.err).toContain("written by a newer version of the extension");
    expect(await readFile(paths.file, "utf8")).toBe(newer);
    expect(await copiesOf(dir, "favorites")).toEqual([]);
  });

  it("of the link index, counts, attachment owners or a context record is never replaced", async () => {
    const refs = refsPaths(dir);
    const counts = summaryCountsPaths(dir);
    const owners = ownersPaths(path.join(dir, "attachments"));
    const seen = contextFile(dir, "t1", "show");
    await mkdir(owners.dir, { recursive: true });
    await mkdir(path.dirname(seen), { recursive: true });
    const files = {
      [refs.file]: JSON.stringify({ version: 2, refs: {}, threads: {} }),
      [counts.file]: JSON.stringify({ version: 2, days: {} }),
      [owners.file]: JSON.stringify({ version: 2, owners: {} }),
      [seen]: JSON.stringify({ version: 2, fullAt: 1 }),
    };
    for (const [file, text] of Object.entries(files)) await writeFile(file, text);
    await expect(readIndex(refs)).rejects.toMatchObject({ code: "NEWER_VERSION" });
    await expect(updateIndex(refs, (index) => void (index.crawl.done = true))).rejects.toMatchObject({ code: "NEWER_VERSION" });
    await expect(readSummaryCounts(counts)).rejects.toMatchObject({ code: "NEWER_VERSION" });
    await expect(countSummaryCall(counts, { engine: "codex", reason: "manual", at: NOW })).rejects.toMatchObject({ code: "NEWER_VERSION" });
    await expect(uncountSummaryCall(counts, { engine: "codex", reason: "manual", at: NOW })).rejects.toMatchObject({ code: "NEWER_VERSION" });
    await expect(readOwners(owners)).rejects.toMatchObject({ code: "NEWER_VERSION" });
    await expect(updateOwners(owners, (draft) => void (draft[UPLOAD] = { child: "c", parent: "p", at: 1 }))).rejects.toMatchObject({ code: "NEWER_VERSION" });
    // The context record only spares the agent text it saw: a newer one counts as nothing seen.
    expect(await readSeen(dir, "t1", "show")).toBeUndefined();
    await expect(writeSeen(dir, "t1", "show", { fullAt: 2, rules: "r", since: 0, status: "s" })).rejects.toMatchObject({ code: "NEWER_VERSION" });
    for (const [file, text] of Object.entries(files)) expect(await readFile(file, "utf8")).toBe(text);
    expect(dayKey(NOW)).toBe("2026-11-24");
  });
});
