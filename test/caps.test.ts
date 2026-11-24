import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMutationV2, parseMutationV2 } from "../src/backend/mutate-v2.js";
import { run } from "../src/cli/main.js";
import * as ops from "../src/core/conversation-ops.js";
import { emptyStateV2, migrateV1, normalizeStateV2, V2_LIMITS, type Conversation, type StateV2 } from "../src/core/conversation.js";
import { normalizeState } from "../src/core/model.js";
import { readState, storePaths, updateState } from "../src/node/store.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "mainline-caps-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-24T10:00:00Z");
const id = (i: number) => `t${String(i).padStart(5, "0")}`;

function record(threadId: string, extra: Partial<Conversation> = {}): Conversation {
  return { threadId, title: `Work ${threadId}`, tags: [], status: "done", milestones: [], spinoffs: [], createdAt: 1, updatedAt: 1, ...extra };
}

/** A state at the cap: `make(i)` is the i-th record. */
function full(make: (i: number) => Partial<Conversation>): StateV2 {
  const state = emptyStateV2();
  for (let i = 0; i < ops.MAX_CONVERSATIONS; i += 1) state.conversations[id(i)] = record(id(i), make(i));
  return state;
}

/** Edited by hand, or with work still open: one of each kind the cap keeps. */
const KEPT: Array<Partial<Conversation>> = [
  { pinned: { title: true } },
  { pinned: { status: true } },
  { removedMilestones: ["dropped by the user"] },
  { now: { text: "in progress", at: 1 } },
  { milestones: [{ id: "m1", title: "Added by the user", state: "done", tasks: [], pinned: true }] },
  { milestones: [{ id: "m1", title: "Stage", state: "current", tasks: [{ id: "k1", text: "open task", done: false, at: 1 }] }] },
];

describe("the cap on mainlines", () => {
  it("is 2000, and makes room by the oldest finished mainline nobody edited and with no open work", async () => {
    expect(ops.MAX_CONVERSATIONS).toBe(2000);
    const paths = storePaths(dir);
    // The oldest ones are edited by hand or have open work, and are finished: the old cap removed exactly these.
    const state = full((i) => (i < KEPT.length ? { ...KEPT[i], updatedAt: i } : { updatedAt: 1000 + i, status: i % 2 ? "active" : "done" }));
    await writeFile(paths.state, JSON.stringify(state));
    await updateState(paths, (draft, ctx) => ops.createConversation(draft, "new-1", { title: "New work" }, ctx), { now: NOW });
    const after = await readState(paths);
    expect(Object.keys(after.conversations)).toHaveLength(ops.MAX_CONVERSATIONS);
    for (let i = 0; i < KEPT.length; i += 1) expect(after.conversations[id(i)], `kept ${JSON.stringify(KEPT[i])}`).toBeDefined();
    // The oldest finished one that may go went: the first done record after the kept ones.
    const gone = Object.keys(state.conversations).filter((threadId) => !after.conversations[threadId]);
    expect(gone).toEqual([id(KEPT.length % 2 ? KEPT.length + 1 : KEPT.length)]);
    expect(after.conversations["new-1"]?.title).toBe("New work");
  });

  it("refuses a new mainline when none can make room, and changes nothing", async () => {
    const paths = storePaths(dir);
    await writeFile(paths.state, JSON.stringify(full((i) => KEPT[i % KEPT.length]!)));
    const before = await readFile(paths.state, "utf8");
    await expect(
      updateState(paths, (draft, ctx) => ops.createConversation(draft, "new-1", { title: "New work" }, ctx), { now: NOW }),
    ).rejects.toMatchObject({ code: "STATE_FULL", message: expect.stringContaining("2000") });
    // A spin-off's child, a summary of a conversation without a mainline: the same.
    await expect(
      updateState(paths, (draft, ctx) =>
        ops.applySummary(draft, "new-2", { title: "Old work", tags: [], milestones: [], finished: true }, { at: NOW, model: "m" }, { ...ctx, activityAt: NOW - DAY }),
      ),
    ).rejects.toMatchObject({ code: "STATE_FULL" });
    expect(await readFile(paths.state, "utf8")).toBe(before);
    // Changes to existing mainlines still go through.
    await updateState(paths, (draft, ctx) => ops.setTitle(draft, id(0), "Renamed", ctx));
    expect((await readState(paths)).conversations[id(0)]?.title).toBe("Renamed");
  });

  it("refuses a new mainline that would itself be the first to go, instead of putting a newer one out", async () => {
    const paths = storePaths(dir);
    await writeFile(paths.state, JSON.stringify(full((i) => ({ status: "done", updatedAt: NOW - DAY + i }))));
    // A summary of a conversation finished long ago: older than every finished mainline kept.
    await expect(
      updateState(paths, (draft, ctx) =>
        ops.applySummary(draft, "old-1", { title: "Old work", tags: [], milestones: [], finished: true }, { at: NOW, model: "m" }, { ...ctx, activityAt: NOW - 30 * DAY }),
      ),
    ).rejects.toMatchObject({ code: "STATE_FULL" });
    // Recent work does get in, in place of the oldest finished mainline.
    await updateState(paths, (draft, ctx) =>
      ops.applySummary(draft, "recent-1", { title: "Recent work", tags: [], milestones: [], finished: false }, { at: NOW, model: "m" }, { ...ctx, activityAt: NOW }),
    );
    const after = await readState(paths);
    expect(after.conversations["recent-1"]).toBeDefined();
    expect(after.conversations[id(0)]).toBeUndefined();
    expect(after.conversations["old-1"]).toBeUndefined();
  });

  it("still links a child conversation that opened when no mainline can make room for it", async () => {
    const paths = storePaths(dir);
    const state = full((i) => KEPT[i % KEPT.length]!);
    state.conversations[id(0)]!.spinoffs = [{ id: "s1", text: "side problem", at: 1, state: "open" }];
    await writeFile(paths.state, JSON.stringify(state));
    expect(ops.hasRoomForMainline(state)).toBe(false);
    await updateState(paths, (draft, ctx) => ops.linkSpinoff(draft, id(0), "s1", "child-1", ctx));
    const after = await readState(paths);
    expect(after.conversations[id(0)]?.spinoffs[0]).toMatchObject({ state: "spawned", childThreadId: "child-1" });
    expect(after.conversations["child-1"]).toBeUndefined();
    // With room, the child gets its mainline right away, as before.
    delete after.conversations[id(1)];
    expect(ops.hasRoomForMainline(after)).toBe(true);
    after.conversations[id(0)]!.spinoffs.push({ id: "s2", text: "another problem", at: 2, state: "open" });
    ops.linkSpinoff(after, id(0), "s2", "child-2", { now: NOW });
    expect(after.conversations["child-2"]).toMatchObject({ title: "another problem", parentId: id(0) });
  });

  it("never removes a kept mainline, also when the state holds more than the cap", () => {
    const state = full((i) => KEPT[i % KEPT.length]!);
    state.conversations.extra = record("extra", { pinned: { tags: true } });
    ops.pruneV2(state, { now: NOW });
    expect(Object.keys(state.conversations)).toHaveLength(ops.MAX_CONVERSATIONS + 1);
  });
});

describe("the cap on milestones and tasks", () => {
  const reached = (count: number, extra: (i: number) => object = () => ({})) =>
    Array.from({ length: count }, (_, i) => ({ id: `m${i}aa`, title: `Stage result ${i}`, state: "done" as const, doneAt: 100 + i, tasks: [], ...extra(i) }));

  it("keeps a task recorded when all 30 milestones are reached: the oldest reached one makes room", async () => {
    const paths = storePaths(dir);
    const state = emptyStateV2();
    state.conversations.t1 = record("t1", {
      status: "active",
      // The oldest is the user's own: the next oldest goes instead. It still had an unfinished task.
      milestones: reached(V2_LIMITS.milestones, (i) => (i === 0 ? { pinned: true } : i === 1 ? { tasks: [{ id: "k0001", text: "left open", done: false, at: 1 }] } : {})),
    });
    await writeFile(paths.state, JSON.stringify(state));
    let out = "";
    const code = await run(["doing", "write the migration"], {
      env: { MAINLINE_DATA_DIR: dir, LANG: "en_US.UTF-8", CODEXHOST_THREAD_ID: "t1" },
      stdout: (text: string) => void (out += text),
      stderr: () => undefined,
      runGh: async () => Promise.reject(new Error("no gh in tests")),
    } as unknown as Parameters<typeof run>[1]);
    expect(code).toBe(0);
    expect(out).toContain("write the migration");
    const written = JSON.parse(await readFile(paths.state, "utf8")) as StateV2;
    const milestones = written.conversations.t1!.milestones;
    expect(milestones).toHaveLength(V2_LIMITS.milestones);
    expect(milestones.map(({ title }) => title)).not.toContain("Stage result 1");
    expect(milestones[0]?.title).toBe("Stage result 0");
    const current = milestones.find(({ state: s }) => s === "current")!;
    expect(current.tasks.map(({ text }) => text)).toEqual(["left open", "write the migration"]);
    expect(current.title).not.toBe(milestones[milestones.length - 2]?.title);
    // What every reader sees is what was written.
    const read = await readState(paths);
    expect(read.conversations.t1).toEqual(written.conversations.t1);
    expect(read.conversations.t1?.now?.text).toBe("write the migration");
  });

  it("keeps the task cap when a removed milestone's tasks move on", () => {
    const state = emptyStateV2();
    const tasks = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}`, text: `${prefix} ${i}`, done: false, at: i }));
    state.conversations.t1 = record("t1", {
      status: "active",
      milestones: [
        { id: "m1", title: "Current", state: "current", tasks: tasks("c", 40) },
        { id: "m2", title: "Later", state: "planned", tasks: tasks("p", 40) },
      ],
    });
    ops.removeMilestone(state, "t1", "m2", { now: NOW });
    const written = JSON.parse(JSON.stringify(state)) as StateV2;
    expect(written.conversations.t1!.milestones[0]!.tasks).toHaveLength(V2_LIMITS.tasks);
    expect(normalizeStateV2(written)).toEqual(written);
  });

  it("migrates at most 30 reached milestones and 30 spin-offs from version 1, the latest", () => {
    const items = (prefix: string) => Array.from({ length: 40 }, (_, i) => ({ id: `${prefix}${i}`, text: `${prefix} ${i}`, at: i }));
    const v1 = normalizeState({
      version: 1,
      rev: 3,
      mainlines: { k3f9: { goal: "Old goal", status: "active", createdAt: 1, updatedAt: 2, done: items("d"), parked: items("p") } },
      threads: { main: { mainlineId: "k3f9", via: "agent", updatedAt: 2 } },
    });
    const migrated = migrateV1(v1);
    const conversation = migrated.conversations.main!;
    expect(conversation.milestones).toHaveLength(V2_LIMITS.milestones);
    expect(conversation.milestones[0]?.title).toBe("d 10");
    expect(conversation.spinoffs).toHaveLength(V2_LIMITS.spinoffs);
    expect(normalizeStateV2(JSON.parse(JSON.stringify(migrated)))).toEqual(migrated);
  });
});

// Random sequences of every writer (agent commands, edits in the interface, model summaries, the
// cap), checked after each step: what was written reads back the same, and the views' invariants hold.
describe("writers against the reader", () => {
  function rng(seed: number) {
    let x = seed >>> 0;
    return () => (x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  }
  const canon = (value: unknown): string =>
    JSON.stringify(value, (_key, item: unknown) =>
      item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : 1))) : item,
    );

  it("write only what reads back the same", () => {
    const problems: string[] = [];
    const T = "t1";
    const titles = Array.from({ length: 50 }, (_, i) => `stage ${i}`);
    for (let seed = 1; seed <= 50; seed += 1) {
      const r = rng(seed);
      const pick = <T,>(items: readonly T[]) => items[Math.floor(r() * items.length)]!;
      let state = emptyStateV2();
      let now = 1_700_000_000_000;
      for (let step = 0; step < 300 && problems.length < 5; step += 1) {
        now += 60_000;
        const ctx = { now, random: r };
        const draft = structuredClone(state);
        const conversation = draft.conversations[T];
        const milestones = conversation?.milestones ?? [];
        const anyMilestone = milestones.length ? pick(milestones).id : "zz";
        const tasks = milestones.flatMap((milestone) => milestone.tasks);
        const anyTask = tasks.length ? pick(tasks).id : "zz";
        const anySpinoff = conversation?.spinoffs.length ? pick(conversation.spinoffs).id : "zz";
        const op = pick(["create", "plan", "doing", "done", "task", "reach", "focus", "remove", "add", "summary", "summary", "spinoff", "keep", "dismiss", "taskRemove", "status", "delete", "ui"] as const);
        try {
          switch (op) {
            case "create": ops.createConversation(draft, T, { title: `goal ${step}`, milestones: [pick(titles)] }, ctx); break;
            case "plan": ops.planMilestones(draft, T, [pick(titles), pick(titles)], ctx); break;
            case "doing": ops.setDoing(draft, T, `task ${Math.floor(r() * 80)}`, ctx); break;
            case "done": ops.completeTask(draft, T, ctx, r() < 0.5 ? {} : { text: `task ${Math.floor(r() * 80)}` }); break;
            case "task": ops.addTask(draft, T, `task ${Math.floor(r() * 80)}`, ctx); break;
            case "reach": ops.reachMilestone(draft, T, ctx, r() < 0.5 ? undefined : anyMilestone); break;
            case "focus": ops.focusMilestone(draft, T, anyMilestone, ctx); break;
            case "remove": ops.removeMilestone(draft, T, anyMilestone, ctx); break;
            case "add": ops.addMilestone(draft, T, pick(titles), ctx, Math.floor(r() * 5)); break;
            case "summary": {
              const count = Math.floor(r() * 10);
              const proposed = Array.from({ length: count }, () => ({ title: pick(titles), state: pick(["done", "current", "planned"] as const) }));
              ops.applySummary(draft, T, { title: "model title", tags: ["a", "b"], finished: r() < 0.3, milestones: proposed }, { at: now, model: "m" }, { ...ctx, activityAt: now });
              break;
            }
            case "spinoff": ops.addSpinoff(draft, T, `side ${Math.floor(r() * 40)}`, ctx); break;
            case "keep": ops.keepSpinoff(draft, T, anySpinoff, ctx); break;
            case "dismiss": ops.dismissSpinoff(draft, T, anySpinoff, ctx); break;
            case "taskRemove": ops.removeTask(draft, T, anyTask, ctx); break;
            case "status": ops.setStatus(draft, T, pick(["active", "paused", "done"] as const), ctx); break;
            case "delete": if (r() < 0.1) ops.deleteConversation(draft, T, ctx); break;
            case "ui":
              applyMutationV2(
                draft,
                parseMutationV2(
                  pick([
                    { op: "milestoneRename", threadId: T, milestoneId: anyMilestone, title: pick(titles) },
                    { op: "milestoneRemove", threadId: T, milestoneId: anyMilestone },
                    { op: "taskDone", threadId: T, taskId: anyTask },
                    { op: "milestoneReach", threadId: T },
                    { op: "title", threadId: T, title: "user title" },
                  ]),
                ),
                ctx,
              );
              break;
          }
          ops.pruneV2(draft, ctx);
        } catch {
          continue; // Refused (MainlineError): the store writes nothing.
        }
        const written = JSON.parse(JSON.stringify(draft)) as StateV2;
        const read = normalizeStateV2(written);
        const w = written.conversations[T];
        const where = `seed ${seed} step ${step} ${op}`;
        if (w) {
          if (w.milestones.length > V2_LIMITS.milestones) problems.push(`${where}: ${w.milestones.length} milestones written`);
          for (const milestone of w.milestones) if (milestone.tasks.length > V2_LIMITS.tasks) problems.push(`${where}: ${milestone.tasks.length} tasks written`);
          if (w.milestones.filter((milestone) => milestone.state === "current").length > 1) problems.push(`${where}: two current milestones`);
          const ids = w.milestones.flatMap((milestone) => [milestone.id, ...milestone.tasks.map((task) => task.id)]);
          if (new Set(ids).size !== ids.length) problems.push(`${where}: duplicate ids`);
          if (w.now && !w.milestones.some((milestone) => milestone.tasks.some((task) => task.text === w.now?.text))) problems.push(`${where}: doing names no task`);
        }
        if (canon(read) !== canon(written)) problems.push(`${where}: read back differs from what was written`);
        state = read;
      }
    }
    expect(problems).toEqual([]);
  }, 60_000);
});
