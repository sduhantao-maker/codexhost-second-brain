import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addTask, createConversation } from "../src/core/conversation-ops.js";
import { readState, storePaths, updateState, withLock, type LockLease } from "../src/node/store.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "mainline-lock-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A lock left by a process that was killed while holding it (the hook at its timeout, an agent's Ctrl-C). */
async function plantStaleLock(lock: string, owner?: string): Promise<void> {
  await mkdir(lock);
  if (owner !== undefined) await writeFile(path.join(lock, "owner"), owner);
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
}

const tasksOf = async (threadId: string) =>
  (await readState(storePaths(dir))).conversations[threadId]?.milestones.flatMap((milestone) => milestone.tasks.map((task) => task.text)) ?? [];

describe("the lock", () => {
  it("lets exactly one of many waiters take over a stale lock, so no update is lost", async () => {
    const paths = storePaths(dir);
    const writers = 12;
    for (let round = 0; round < 3; round += 1) {
      const threadId = `round-${round}`;
      await updateState(paths, (draft, ctx) => createConversation(draft, threadId, { title: `Round ${round}` }, ctx));
      const update = (i: number) => updateState(paths, (draft, ctx) => addTask(draft, threadId, `task ${i}`, ctx), { timeoutMs: 15_000 });
      if (round === 0) {
        // Found stale on arrival, with an owner that is gone.
        await plantStaleLock(paths.lock, "4242-deadbeef");
        await Promise.all(Array.from({ length: writers }, (_, i) => update(i)));
      } else {
        // Queued behind a held lock whose holder then dies (without an owner file: an older version's lock).
        await mkdir(paths.lock);
        const running = Promise.all(Array.from({ length: writers }, (_, i) => update(i)));
        await sleep(300);
        const old = new Date(Date.now() - 60_000);
        await utimes(paths.lock, old, old);
        await running;
      }
      expect((await tasksOf(threadId)).sort()).toEqual(Array.from({ length: writers }, (_, i) => `task ${i}`).sort());
    }
  }, 60_000);

  it("never frees the lock of the next holder when its own was taken over, and tells it before it writes", async () => {
    const paths = storePaths(dir);
    const events: string[] = [];
    let releaseA!: () => void;
    let leaseA: LockLease | undefined;
    const aDone = withLock(paths, async (lease) => {
      leaseA = lease;
      events.push("A in");
      await new Promise<void>((resolve) => (releaseA = resolve));
      events.push("A out");
    });
    await expect.poll(() => events.includes("A in")).toBe(true);
    // A stopped for longer than the lock lasts (a laptop asleep, a process stopped): its lock was taken over.
    await rm(paths.lock, { recursive: true, force: true });
    let releaseB!: () => void;
    const bDone = withLock(paths, async () => {
      events.push("B in");
      await new Promise<void>((resolve) => (releaseB = resolve));
      events.push("B out");
    });
    await expect.poll(() => events.includes("B in")).toBe(true);
    // A goes on and finishes: B still holds the lock, so a third writer waits for B instead of going in beside it.
    releaseA();
    await aDone;
    expect((await stat(paths.lock)).isDirectory()).toBe(true);
    await expect(withLock(paths, async () => events.push("C in"), 300)).rejects.toMatchObject({ code: "LOCKED" });
    // Had A gone on to write, its lease would have said the lock was no longer its own.
    await expect(leaseA!.check()).rejects.toMatchObject({ code: "LOCKED" });
    const cDone = withLock(paths, async () => events.push("C in"), 5_000);
    await sleep(100);
    releaseB();
    await Promise.all([bDone, cDone]);
    expect(events).toEqual(["A in", "B in", "A out", "B out", "C in"]);
  }, 20_000);

  it("keeps the lock of a slow holder that is still running, even when its age looks stale", async () => {
    const paths = storePaths(dir);
    const events: string[] = [];
    const slow = withLock(paths, async () => {
      events.push("A in");
      await sleep(2_600);
      events.push("A out");
    });
    await expect.poll(() => events.includes("A in")).toBe(true);
    // The lock's age as a waiter sees it after a clock jump, or once the holder has been working past the stale age.
    const old = new Date(Date.now() - 60_000);
    await utimes(paths.lock, old, old);
    const next = withLock(paths, async () => events.push("B in"), 10_000);
    await Promise.all([slow, next]);
    expect(events).toEqual(["A in", "A out", "B in"]);
  }, 20_000);

  it("takes over a stale lock without an owner, also past a guard a dead process left", async () => {
    const paths = storePaths(dir);
    await plantStaleLock(paths.lock);
    await plantStaleLock(`${paths.lock}.guard`);
    await expect(withLock(paths, async () => "in", 10_000)).resolves.toBe("in");
    await expect(stat(paths.lock)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(`${paths.lock}.guard`)).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);

  it("waits for a live holder and gives up with LOCKED", async () => {
    const paths = storePaths(dir);
    let release!: () => void;
    const held = withLock(paths, () => new Promise<void>((resolve) => (release = resolve)));
    await expect.poll(async () => stat(paths.lock).then(() => true, () => false)).toBe(true);
    await expect(withLock(paths, async () => "in", 200)).rejects.toMatchObject({ code: "LOCKED" });
    release();
    await held;
    await expect(withLock(paths, async () => "in", 200)).resolves.toBe("in");
  });
});
