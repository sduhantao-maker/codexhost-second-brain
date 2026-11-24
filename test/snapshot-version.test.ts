import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activate } from "../src/backend/index.js";
import { addMention, extractLinks } from "../src/core/refs.js";
import type { SnapshotResultV2 } from "../src/core/rpc.js";
import { refsPaths, updateIndex } from "../src/node/refs-store.js";
import { storePaths, updateState } from "../src/node/store.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "mainline-version-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const noGh = async (): Promise<string> => {
  throw new Error("no gh in tests");
};

async function start(settings: Record<string, unknown> = {}) {
  const dataDir = path.join(root, "host-extension-data", "second-brain");
  const extensionDir = path.join(root, "extension");
  await mkdir(path.join(extensionDir, "bin"), { recursive: true });
  await writeFile(path.join(extensionDir, "bin", "mainline.mjs"), "// cli\n");
  const refs = refsPaths(dataDir);
  await updateIndex(refs, (index) => {
    const [link] = extractLinks("https://github.com/o/r/pull/7");
    addMention(index, link!, { threadId: "src", turn: 2, at: 1, role: "agent", prompt: "修导出" });
    Object.assign(index.refs["o/r#7"]!, { state: "open", title: "Fix export", checkedAt: 1 });
    index.threads.src = { turns: 2, updatedAt: "u1", scannedAt: 1, title: "导出修复", cwd: "site" };
  });
  const handlers = new Map<string, (params: unknown) => unknown>();
  const dispose = await activate(
    { extensionId: "second-brain", extensionDir, dataDir, readSettings: async () => settings, writeSettings: async (values) => values, handle: (method, handler) => handlers.set(method, handler) },
    { runGh: noGh },
  );
  const snapshot = async (params: object = {}) => (await handlers.get("snapshot")!(params)) as SnapshotResultV2;
  return { dataDir, refs, snapshot, dispose, call: (method: string, params?: unknown) => handlers.get(method)!(params) };
}

describe("snapshot version", () => {
  it("stays the same when only bookkeeping is written, and changes with what pages show", async () => {
    const { dataDir, refs, snapshot, dispose, call } = await start();
    try {
      await call("mutate", { op: "create", threadId: "src", title: "修好导出", tags: [] });
      const first = await snapshot();
      expect(first.state?.conversations.src?.title).toBe("修好导出");
      expect(first.workspaces).toEqual({ src: "site" });

      // How far a conversation was read and when, when a PR was looked up or notified about, the
      // crawl, the GitHub poll: the index is rewritten, but nothing any page shows changed.
      await updateIndex(refs, (index) => {
        Object.assign(index.threads.src!, { turns: 9, updatedAt: "u2", scannedAt: 99 });
        Object.assign(index.refs["o/r#7"]!, { checkedAt: 99, notifiedAt: 98 });
        index.crawl = { done: true, listed: 400, startedAt: 1, finishedAt: 99 };
        index.github = { baselineAt: 1, lastPollAt: 99 };
      });
      // Nor in the state: the backend's own job record.
      await updateState(storePaths(dataDir), (draft) => {
        draft.jobs = { backfill: { requestedAt: 99 } };
      });
      expect(await snapshot({ version: first.version })).toEqual({ version: first.version });

      // A PR's state is shown: a new version, with the whole snapshot.
      await updateIndex(refs, (index) => {
        index.refs["o/r#7"]!.state = "merged";
      });
      const merged = await snapshot({ version: first.version });
      expect(merged.version).not.toBe(first.version);
      expect(merged.state).toBeDefined();

      // So are a conversation's title and project.
      await updateIndex(refs, (index) => {
        index.threads.src!.cwd = "site-v2";
      });
      const moved = await snapshot({ version: merged.version });
      expect(moved.version).not.toBe(merged.version);
      expect(moved.workspaces).toEqual({ src: "site-v2" });

      // And a change to a mainline.
      await call("mutate", { op: "title", threadId: "src", title: "修好导出和打印" });
      expect((await snapshot({ version: moved.version })).version).not.toBe(moved.version);
    } finally {
      await dispose();
    }
  });

  it("changes with every setting, the model for other agents' conversations too", async () => {
    const versions: string[] = [];
    for (const settings of [{}, { summarizeOthers: "claude" }, { summarizeModel: "codex" }, {}]) {
      const { snapshot, dispose } = await start(settings);
      try {
        versions.push((await snapshot()).version);
      } finally {
        await dispose();
      }
    }
    expect(new Set(versions.slice(0, 3)).size).toBe(3);
    expect(versions[3]).toBe(versions[0]);
  });
});
