import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { addTask, createConversation } from "../src/core/conversation-ops.js";
import { readState, storePaths, updateState, withLock } from "../src/node/store.js";

// One waiter is stopped right as it removes a stale lock, and a second waiter comes along
// meanwhile: the interleaving that let two writers in at once. The stop is a wrapped `rm`.
const gate = vi.hoisted(() => ({
  lock: "",
  armed: false,
  hit: false,
  open: () => undefined as void,
  wait: Promise.resolve(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const rmGated: typeof real.rm = async (target, options) => {
    if (gate.armed && String(target) === gate.lock) {
      gate.armed = false;
      gate.hit = true;
      await gate.wait;
    }
    return real.rm(target, options);
  };
  return { ...real, default: { ...real, rm: rmGated }, rm: rmGated };
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "mainline-takeover-"));
});
afterEach(async () => {
  gate.armed = false;
  gate.open();
  await rm(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it("lets only one waiter take over a stale lock, even when the other stops right as it removes it", async () => {
  const paths = storePaths(dir);
  await updateState(paths, (draft, ctx) => createConversation(draft, "t1", { title: "Goal" }, ctx));
  // Left by a process that was killed while holding it.
  await mkdir(paths.lock);
  await writeFile(path.join(paths.lock, "owner"), "4242-deadbeef");
  const old = new Date(Date.now() - 60_000);
  await utimes(paths.lock, old, old);

  gate.lock = paths.lock;
  gate.wait = new Promise<void>((resolve) => (gate.open = resolve));
  gate.armed = true;
  let inside = 0;
  let most = 0;
  const events: string[] = [];
  // The first waiter finds the lock stale and stops as it removes it.
  const first = updateState(
    paths,
    (draft, ctx) => {
      inside += 1;
      most = Math.max(most, inside);
      events.push("first in");
      addTask(draft, "t1", "from the first waiter", ctx);
      inside -= 1;
    },
    { timeoutMs: 10_000 },
  );
  await expect.poll(() => gate.hit, { timeout: 10_000 }).toBe(true);
  // A second waiter comes along while the first is stopped, and works for a while once in.
  let leave!: () => void;
  const second = withLock(
    paths,
    async () => {
      inside += 1;
      most = Math.max(most, inside);
      events.push("second in");
      await new Promise<void>((resolve) => (leave = resolve));
      inside -= 1;
    },
    10_000,
  );
  // The first goes on once the second is in, or after a second (well short of the age at which
  // a guard counts as left behind by a dead process).
  const started = Date.now();
  while (!events.includes("second in") && Date.now() - started < 1_000) await sleep(20);
  gate.open();
  await expect.poll(() => events.length, { timeout: 15_000 }).toBe(2);
  leave();
  await Promise.all([first, second]);
  expect(most).toBe(1);
  expect((await readState(paths)).conversations.t1?.milestones.flatMap((milestone) => milestone.tasks.map((task) => task.text))).toEqual([
    "from the first waiter",
  ]);
}, 30_000);
