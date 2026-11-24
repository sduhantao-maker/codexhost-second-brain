import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExternalApi } from "../src/backend/external-api.js";
import { LIST_EVERY_MS, READS_AT_ONCE, ThreadInfoService } from "../src/backend/threads.js";

/** A stand-in for codexhost's local API that counts what it is asked. */
interface Host {
  /** Listed among the recently updated, most recent first: id, state ("running" or "completed"). */
  listed: Array<{ threadId: string; status: string }>;
  /** What a read says beyond the list: these wait for the user's answer. */
  waiting: Set<string>;
  /** Reads of these fail: 500, or 400 (no Thread at all). */
  failing: Map<string, number>;
  /** How long a read takes. */
  readMs: number;
  asked: { list: number; children: number; reads: string[] };
  mostReadsAtOnce: number;
}

let root: string;
let server: Server;
let host: Host;
let api: ExternalApi;
let now: number;
const errors: string[] = [];
const log = { info: () => undefined, error: (message: string) => void errors.push(message) };

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "mainline-threads-"));
  host = { listed: [], waiting: new Set(), failing: new Map(), readMs: 0, asked: { list: 0, children: 0, reads: [] }, mostReadsAtOnce: 0 };
  errors.length = 0;
  now = 1_000_000;
  let reading = 0;
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const asked = JSON.parse(body) as { threadId?: string; parentThreadId?: string; limit?: number };
      response.setHeader("content-type", "application/json");
      if (request.url === "/v1/thread/list" && asked.parentThreadId) {
        host.asked.children += 1;
        response.end(JSON.stringify({ threads: [], nextCursor: null }));
      } else if (request.url === "/v1/thread/list") {
        host.asked.list += 1;
        const threads = host.listed.slice(0, asked.limit).map(({ threadId, status }) => ({
          threadId,
          harnessId: "claude-code",
          deepLink: `codex://threads/${threadId}`,
          status,
          cwd: "/work/site",
          title: `Title ${threadId}`,
          createdAt: "2026-11-20T00:00:00.000Z",
          updatedAt: "2026-11-24T00:00:00.000Z",
          recencyAt: "2026-11-24T00:00:00.000Z",
        }));
        response.end(JSON.stringify({ threads, nextCursor: null }));
      } else if (request.url === "/v1/thread/read") {
        const threadId = asked.threadId!;
        host.asked.reads.push(threadId);
        reading += 1;
        host.mostReadsAtOnce = Math.max(host.mostReadsAtOnce, reading);
        setTimeout(() => {
          reading -= 1;
          const failure = host.failing.get(threadId);
          if (failure) {
            response.statusCode = failure;
            return response.end("{}");
          }
          const running = host.listed.find((thread) => thread.threadId === threadId)?.status === "running";
          response.end(
            JSON.stringify({
              threadId,
              harnessId: "claude-code",
              title: `Title ${threadId}`,
              status: running ? "running" : "completed",
              pendingQuestions: host.waiting.has(threadId) ? [{ interactionId: "q" }] : [],
            }),
          );
        }, host.readMs);
      } else response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const credentials = path.join(root, "cli-credentials.json");
  await writeFile(credentials, JSON.stringify({ endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: "secret" }));
  api = new ExternalApi(credentials);
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

const ids = (count: number, prefix = "t") => Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(2, "0")}`);
const service = () => new ThreadInfoService(api, log, () => now);

describe("thread facts from one shared list", () => {
  it("answers idle conversations from one list, shared by overlapping polls", async () => {
    const active = ids(30);
    host.listed = active.map((threadId) => ({ threadId, status: "completed" }));
    const threads = service();
    await Promise.all([threads.refresh(active, ["t00"]), threads.refresh(active), threads.refresh(["t05"], ["t05"])]);
    expect(host.asked).toEqual({ list: 1, children: 0, reads: [] });
    expect(threads.get("t07")).toEqual({ status: "idle", title: "Title t07", harnessId: "claude-code" });
    // Within LIST_EVERY_MS the list stands; after it, one more.
    now += LIST_EVERY_MS - 1;
    await threads.refresh(active, ["t00"]);
    expect(host.asked.list).toBe(1);
    now += 1;
    await threads.refresh(active, ["t00"]);
    expect(host.asked.list).toBe(2);
    expect(host.asked.reads).toEqual([]);
  });

  it("reads on its own only what the list cannot tell, each at its pace", async () => {
    host.listed = [
      { threadId: "busy", status: "running" },
      { threadId: "open", status: "running" },
      { threadId: "quiet", status: "completed" },
    ];
    host.waiting.add("busy");
    const threads = service();
    // "old" is not among the recently updated: read once, then not again for minutes.
    await threads.refresh(["busy", "quiet", "old"], ["open"]);
    expect(host.asked.reads.sort()).toEqual(["busy", "old", "open"]);
    // Only a read tells a running conversation that waits for the user.
    expect(threads.get("busy")?.status).toBe("waiting");
    expect(threads.get("open")?.status).toBe("running");
    host.asked.reads = [];
    // 20 seconds on: a new list, which says "running" for the waiting one too; the wait stays.
    now += 20_000;
    await threads.refresh(["busy", "quiet", "old"], ["open"]);
    expect(threads.get("busy")?.status).toBe("waiting");
    // The open conversation is read every 15 seconds, a running one every minute, any other every 5 minutes.
    expect(host.asked.reads).toEqual(["open"]);
    host.asked.reads = [];
    now += 41_000;
    await threads.refresh(["busy", "quiet", "old"], ["open"]);
    expect(host.asked.reads.sort()).toEqual(["busy", "open"]);
    host.asked.reads = [];
    now += 4 * 60_000;
    await threads.refresh(["busy", "quiet", "old"], []);
    expect(host.asked.reads.sort()).toEqual(["busy", "old"]);
    // It stopped: the list says so, and the next look reads nothing.
    host.listed[0]!.status = "completed";
    host.waiting.clear();
    host.asked.reads = [];
    now += 20_000;
    await threads.refresh(["busy", "quiet"], []);
    expect(threads.get("busy")?.status).toBe("idle");
    expect(host.asked.reads).toEqual([]);
  });

  it("queues each id once however many polls overlap, and reads two at a time", async () => {
    host.readMs = 30;
    const old = ids(8, "old");
    const threads = service();
    // A surface, the overview and the backend's own round, all at once and before any read is back.
    await Promise.all([threads.refresh(old, ["old00"]), threads.refresh(old), threads.refresh([...old].reverse()), threads.refresh(old.slice(2))]);
    expect(host.asked.reads.sort()).toEqual(old);
    expect(host.mostReadsAtOnce).toBe(READS_AT_ONCE);
  });

  it("waits a minute after a failed read, then twice as long each time, and logs it once per step", async () => {
    host.failing.set("bad", 500);
    const threads = service();
    const tries: number[] = [];
    for (let second = 0; second <= 16 * 60; second += 5) {
      now = 1_000_000 + second * 1000;
      const before = host.asked.reads.length;
      await threads.refresh(["bad"]);
      if (host.asked.reads.length > before) tries.push(second);
    }
    // 1, 2, 4 and 8 minutes apart; the next waits 15 (the cap).
    expect(tries).toEqual([0, 60, 180, 420, 900]);
    expect(errors.filter((message) => message.includes("read Thread bad"))).toHaveLength(5);
    // At the cap, a failure no longer logs.
    now += 15 * 60_000 + 1000;
    await threads.refresh(["bad"]);
    expect(host.asked.reads).toHaveLength(6);
    expect(errors.filter((message) => message.includes("read Thread bad"))).toHaveLength(5);
    // It answers again: read at the next try, and the waiting starts over.
    host.failing.clear();
    now += 15 * 60_000 + 1000;
    await threads.refresh(["bad"]);
    expect(threads.get("bad")?.status).toBe("idle");
  });

  it("takes Desktop's tree while it is fresh: no list and no reads", async () => {
    host.listed = [
      { threadId: "a", status: "running" },
      { threadId: "c", status: "completed" },
    ];
    const threads = service();
    threads.reportTree({ nodes: { a: { status: "waiting", title: "A" }, b: { status: "idle" } }, parents: {} });
    await threads.refresh(["a", "b"], ["a"]);
    expect(host.asked).toEqual({ list: 0, children: 0, reads: [] });
    expect(threads.get("a")).toEqual({ status: "waiting", title: "A" });
    // A conversation the tree does not have still gets the list, which leaves Desktop's facts alone.
    await threads.refresh(["a", "c"]);
    expect(host.asked).toEqual({ list: 1, children: 0, reads: [] });
    expect(threads.get("a")).toEqual({ status: "waiting", title: "A" });
    expect(threads.get("c")?.status).toBe("idle");
    // Desktop went quiet: the list and the reads take over; the list's "running" leaves the wait as it was until the read.
    now += 21_000;
    await threads.refresh(["a"], ["a"]);
    expect(host.asked.list).toBe(2);
    expect(host.asked.reads).toEqual(["a"]);
    expect(threads.get("a")?.status).toBe("running");
  });
});

describe("requests per minute", () => {
  /**
   * The backend's callers as they run with one window open: the surface polls every 2 seconds with
   * the open conversation, the overview every 3 seconds, the backend's own round every 30 seconds
   * (with the open conversation's children). `active` are the mainline conversations worth keeping
   * live; the counts are the requests codexhost gets in one minute.
   */
  async function oneMinute(threads: ThreadInfoService, active: string[], open: string, from: number) {
    const before = { list: host.asked.list, children: host.asked.children, reads: host.asked.reads.length };
    for (let second = 0; second < 60; second += 1) {
      now = from + second * 1000;
      const calls: Array<Promise<unknown>> = [];
      if (second % 2 === 0) calls.push(threads.refresh(active, [open]));
      if (second % 3 === 0) calls.push(threads.refresh(active, [open]));
      if (second % 30 === 0) calls.push(threads.refresh(active, [open]).then(() => threads.lookupChildren(open)));
      await Promise.all(calls);
    }
    return { list: host.asked.list - before.list, children: host.asked.children - before.children, reads: host.asked.reads.length - before.reads };
  }

  it("asks codexhost a few times a minute for one window open on 30 idle conversations", async () => {
    const active = ids(30);
    host.listed = active.map((threadId) => ({ threadId, status: "completed" }));
    const threads = service();
    // Before this change: about 30 reads every 16 seconds, some 115 a minute.
    const first = await oneMinute(threads, active, "t00", now);
    expect(first).toEqual({ list: 3, children: 1, reads: 0 });
    const next = await oneMinute(threads, active, "t00", now + 1000);
    expect(next).toEqual({ list: 3, children: 1, reads: 0 });
  });

  it("reads each conversation the list cannot tell once at startup, however many callers ask", async () => {
    host.readMs = 5;
    // Half of them are older than the recently updated: those are read, once.
    const active = ids(30);
    host.listed = active.slice(0, 15).map((threadId) => ({ threadId, status: "completed" }));
    const threads = service();
    const counts = await oneMinute(threads, active, "t00", now);
    expect(counts).toEqual({ list: 3, children: 1, reads: 15 });
    expect(new Set(host.asked.reads).size).toBe(15);
    expect(host.mostReadsAtOnce).toBeLessThanOrEqual(READS_AT_ONCE);
  });
});
