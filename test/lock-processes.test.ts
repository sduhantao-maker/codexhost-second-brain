import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConversation } from "../src/core/conversation-ops.js";
import { storePaths, updateState } from "../src/node/store.js";

// Separate from lock.test.ts so the two run side by side: each round waits out a stale lock.

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "mainline-lock-proc-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The lock of a process that holds it now: fresh, with its owner. */
async function plantLock(lock: string, owner: string): Promise<void> {
  await mkdir(lock);
  await writeFile(path.join(lock, "owner"), owner);
}

/** Its holder is gone (the hook killed at its timeout, an agent's Ctrl-C): the lock only ages. */
async function age(lock: string): Promise<void> {
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
}

describe("the lock across processes", () => {
  it("lets exactly one of many waiting processes take over a lock whose holder died, so no update is lost", async () => {
    // A small writer, as the command line is: one process, one update.
    const entry = path.join(dir, "writer.ts");
    const writer = path.join(dir, "writer.mjs");
    const source = (file: string) => JSON.stringify(path.resolve(file));
    await writeFile(
      entry,
      [
        `import { addTask } from ${source("src/core/conversation-ops.ts")};`,
        `import { storePaths, updateState } from ${source("src/node/store.ts")};`,
        "const [data, threadId, text] = process.argv.slice(2);",
        "await updateState(storePaths(data), (draft, ctx) => addTask(draft, threadId, text, ctx), { timeoutMs: 20_000 });",
      ].join("\n"),
    );
    await build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", outfile: writer, logLevel: "silent" });
    const data = path.join(dir, "data");
    const paths = storePaths(data);
    const run = (threadId: string, text: string) =>
      new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [writer, data, threadId, text], { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stderr }));
      });
    const writers = 8;
    for (let round = 0; round < 2; round += 1) {
      const threadId = `proc-${round}`;
      await updateState(paths, (draft, ctx) => createConversation(draft, threadId, { title: `Round ${round}` }, ctx));
      // The writers start and queue behind a held lock; then its holder dies, and all of them find it stale at once.
      await plantLock(paths.lock, "4242-deadbeef");
      const running = Promise.all(Array.from({ length: writers }, (_, i) => run(threadId, `task ${i}`)));
      await sleep(600);
      await age(paths.lock);
      const results = await running;
      expect(results.map(({ code, stderr }) => (code === 0 ? "ok" : stderr))).toEqual(Array.from({ length: writers }, () => "ok"));
      const state = JSON.parse(await readFile(paths.state, "utf8")) as { conversations: Record<string, { milestones: Array<{ tasks: Array<{ text: string }> }> }> };
      const written = state.conversations[threadId]!.milestones.flatMap((milestone) => milestone.tasks.map((task) => task.text));
      expect(written.sort()).toEqual(Array.from({ length: writers }, (_, i) => `task ${i}`).sort());
    }
  }, 90_000);
});
