/**
 * Release audit, finding 4: codexhost gives a call 10 seconds and stopping 1 second, and a backend
 * that overruns is killed until the extension is turned on again. Calls that wait on codexhost
 * answer within their budget (the work goes on in the background), a second click on a child still
 * opening joins it, and stopping returns within a second without half-written files.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HANDLER_BUDGET_MS } from "../src/backend/deadline.js";
import { activate } from "../src/backend/index.js";
import { addMention, extractLinks } from "../src/core/refs.js";
import type { SnapshotResultV2 } from "../src/core/rpc.js";
import { refsPaths, updateIndex } from "../src/node/refs-store.js";
import { readState, storePaths } from "../src/node/store.js";

let root: string;
let server: Server;
/** How the stand-in codexhost answers each route; by default at once. */
let route: (url: string, body: unknown, response: ServerResponse, request: IncomingMessage) => void;
let started: unknown[];

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "mainline-deadlines-"));
  started = [];
  route = (url, body, response) => answer(url, body, response);
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      route(request.url ?? "", body ? JSON.parse(body) : {}, response, request);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  await writeFile(path.join(root, "cli-credentials.json"), JSON.stringify({ endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: "secret" }));
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

function answer(url: string, body: unknown, response: ServerResponse): void {
  if (url === "/v1/thread/read") response.end(JSON.stringify({ threadId: "t1", title: "Release work", status: "idle", harnessId: "claude-code", pendingQuestions: [] }));
  else if (url === "/v1/delegate/start") {
    started.push(body);
    response.end(JSON.stringify({ threadId: `child-${started.length}` }));
  } else response.end(JSON.stringify({ threads: [], nextCursor: null }));
}

const later = (ms: number, then: () => void) => setTimeout(then, ms);

async function start(options: { budgetMs?: number; runGh?: (args: string[]) => Promise<string> } = {}) {
  const dataDir = path.join(root, "host-extension-data", "second-brain");
  const extensionDir = path.join(root, "extension");
  await mkdir(path.join(extensionDir, "bin"), { recursive: true });
  await writeFile(path.join(extensionDir, "bin", "mainline.mjs"), "// cli\n");
  const handlers = new Map<string, (params: unknown) => unknown>();
  const dispose = await activate(
    { extensionId: "second-brain", extensionDir, dataDir, readSettings: async () => ({}), writeSettings: async (values) => values, handle: (method, handler) => handlers.set(method, handler) },
    {
      runGh: options.runGh ?? (async () => Promise.reject(new Error("no gh in tests"))),
      runModel: async () => Promise.reject(new Error("no model in tests")),
      ...(options.budgetMs ? { budgetMs: options.budgetMs } : {}),
    },
  );
  const call = async (method: string, params?: unknown) => handlers.get(method)!(params);
  /** How long a call took, and how it ended. */
  const timed = async (method: string, params?: unknown): Promise<{ ms: number; value?: unknown; error?: string }> => {
    const t0 = Date.now();
    const outcome = await call(method, params).then(
      (value) => ({ value }),
      (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
    );
    return { ms: Date.now() - t0, ...outcome };
  };
  return { dataDir, call, timed, dispose };
}

it("leaves room under codexhost's 10 seconds", () => {
  expect(HANDLER_BUDGET_MS).toBeLessThanOrEqual(8000);
});

describe("opening a child while codexhost is slow", () => {
  // It waits for codexhost's slow answer in the background (up to 4 s): allow for a busy machine.
  it("answers within the budget, opens it in the background, and a second click opens no second child", { timeout: 20_000 }, async () => {
    // codexhost takes 1.5 s to start a child; the calls may wait 300 ms.
    route = (url, body, response) => (url === "/v1/delegate/start" ? later(1500, () => answer(url, body, response)) : answer(url, body, response));
    const { dataDir, call, timed, dispose } = await start({ budgetMs: 300 });
    try {
      await call("mutate", { op: "create", threadId: "t1", title: "Release work" });
      const first = await timed("spawn", { threadId: "t1", text: "the changelog is wrong" });
      expect(first.ms).toBeLessThan(1000);
      expect(first.error).toMatch(/^\[PENDING\] No answer from codexhost yet/u);
      // A second click while the first is under way joins it.
      const second = await timed("spawn", { threadId: "t1", text: "the changelog is wrong" });
      console.info(`spawn with codexhost taking 1.5 s and a 300 ms budget: answered in ${first.ms} ms, the second click in ${second.ms} ms`);
      expect(second.ms).toBeLessThan(1000);
      expect(second.error).toMatch(/^\[PENDING\]/u);
      // The outcome shows in the next snapshot: the spin-off is linked to the child.
      await expect
        .poll(async () => ((await call("snapshot", {})) as SnapshotResultV2).state?.conversations.t1?.spinoffs.map(({ state, childThreadId }) => [state, childThreadId]), { timeout: 4000 })
        .toEqual([["spawned", "child-1"]]);
      const spinoffId = (await readState(storePaths(dataDir))).conversations.t1!.spinoffs[0]!.id;
      expect(await call("spawn", { threadId: "t1", spinoffId })).toEqual({ childThreadId: "child-1" });
      expect(await call("spawn", { threadId: "t1", text: "the changelog is wrong" })).toEqual({ childThreadId: "child-1" });
      expect(started).toHaveLength(1);
    } finally {
      await dispose();
    }
  });

  it("answers at once as before when codexhost is quick", async () => {
    const { call, dispose } = await start({ budgetMs: 300 });
    try {
      await call("mutate", { op: "create", threadId: "t1", title: "Release work" });
      expect(await call("spawn", { threadId: "t1", text: "quick problem" })).toEqual({ childThreadId: "child-1" });
    } finally {
      await dispose();
    }
  });
});

describe("summaries asked for while codexhost is slow", () => {
  it("answer within the budget", async () => {
    // Reading a conversation and listing the recent ones each take 3 s.
    route = (url, body, response) => (url === "/v1/delegate/start" ? answer(url, body, response) : later(3000, () => answer(url, body, response)));
    const { timed, dispose } = await start({ budgetMs: 400 });
    try {
      const asked = await timed("summarize", { threadId: "t1" });
      expect(asked.ms).toBeLessThan(1500);
      expect(asked.value).toEqual({ queued: true });
      const backfill = await timed("summarize.backfill");
      console.info(`with codexhost taking 3 s and a 400 ms budget: summarize answered in ${asked.ms} ms, summarize.backfill in ${backfill.ms} ms`);
      expect(backfill.ms).toBeLessThan(1500);
      expect(backfill.value).toMatchObject({ running: expect.any(Number), queued: expect.any(Number) });
    } finally {
      await dispose();
    }
  });
});

describe("stopping", () => {
  it("returns within a second while codexhost and gh never answer, and leaves no half-written file", async () => {
    // codexhost never answers anything, gh never returns.
    route = () => undefined;
    const runGh = () => new Promise<string>(() => undefined);
    const dataDir = path.join(root, "host-extension-data", "second-brain");
    await updateIndex(refsPaths(dataDir), (index) => {
      const [link] = extractLinks("https://github.com/o/r/pull/7");
      addMention(index, link!, { threadId: "t1", turn: 1, at: 1, role: "agent" });
    });
    const { call, timed, dispose } = await start({ budgetMs: 200, runGh });
    // Lookups of the PR shown, a saved passage being located, a child being opened, a summary asked for: all waiting.
    await call("conversation", { threadId: "t1" });
    await call("favorites.add", { threadId: "t1", text: "a passage to keep" });
    await call("mutate", { op: "create", threadId: "t1", title: "Release work" });
    expect((await timed("spawn", { threadId: "t1", text: "stuck problem" })).error).toMatch(/^\[PENDING\]/u);
    expect((await timed("summarize", { threadId: "t1" })).value).toEqual({ queued: true });
    const t0 = Date.now();
    await dispose();
    const took = Date.now() - t0;
    console.info(`stopping with codexhost and gh hanging: ${took} ms`);
    expect(took).toBeLessThan(1000);
    // Every file is whole: nothing temporary left, and the state and index read back.
    const files = await readdir(dataDir, { recursive: true });
    expect(files.filter((file) => file.endsWith(".tmp"))).toEqual([]);
    for (const file of ["state.json", "refs.json", "favorites.json"]) JSON.parse(await readFile(path.join(dataDir, file), "utf8"));
  }, 15_000);
});
