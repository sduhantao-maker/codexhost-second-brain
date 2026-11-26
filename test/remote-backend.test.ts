/**
 * The backend with conversations on another computer (a remote host paired with codexhost Web): every
 * read, list, summary and child of one names its host, never one of a local conversation; a host
 * that cannot be reached holds up nothing local; drafts are never read. Made-up ids and names only.
 */
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activate } from "../src/backend/index.js";
import type { ApiThread, ApiTurn, ExternalApi, ListedThread } from "../src/backend/external-api.js";
import { Scanner } from "../src/backend/scanner.js";
import { Summarizer } from "../src/backend/summarizer.js";
import { ThreadInfoService } from "../src/backend/threads.js";
import type { ConversationView } from "../src/core/conversation-view.js";
import { DEFAULT_SETTINGS } from "../src/core/model.js";
import { emptyIndex } from "../src/core/refs.js";
import type { SnapshotResultV2 } from "../src/core/rpc.js";
import { readIndex, refsPaths } from "../src/node/refs-store.js";
import { readState, storePaths } from "../src/node/store.js";

const HOST = "remote-peer:0d1e2f3a-aaaa-4bbb-8ccc-000000000001";
const HOST_NAME = "测试主机";
const REMOTE = "019b0001-aaaa-7bbb-8ccc-00000000000a";
const LOCAL = "019b0002-aaaa-7bbb-8ccc-00000000000b";
const CHILD = "019b0003-aaaa-7bbb-8ccc-00000000000c";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "mainline-remote-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const noGh = async (): Promise<string> => {
  throw new Error("no gh in tests");
};
const summary = {
  title: "整理远程主机上的部署脚本",
  tags: ["deploy"],
  milestones: [{ title: "读脚本", state: "current" }],
  finished: false,
};
const turnsOf = (who: string): ApiTurn[] => [
  { turnNumber: 2, status: "completed", messages: [{ role: "user", text: `${who}：接着整理` }, { role: "agent", text: "好的" }] },
  { turnNumber: 1, status: "completed", messages: [{ role: "user", text: `${who}：整理部署脚本` }, { role: "agent", text: "开始" }] },
];

describe("a conversation on another computer, through the backend", () => {
  let server: Server;
  let requests: Array<{ url: string; body: Record<string, unknown> }>;
  let started: Array<Record<string, unknown>>;

  beforeEach(async () => {
    requests = [];
    started = [];
    server = createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => (raw += chunk));
      request.on("end", () => {
        const body = JSON.parse(raw || "{}") as Record<string, unknown>;
        requests.push({ url: request.url ?? "", body });
        response.setHeader("content-type", "application/json");
        const remote = body.threadId === REMOTE || body.threadId === CHILD;
        if (request.url === "/v1/host/list")
          return response.end(JSON.stringify({ hosts: [{ hostId: HOST, displayName: HOST_NAME, online: true, state: "connected", delegation: true, projects: [] }] }));
        if (request.url === "/v1/thread/read") {
          // As codexhost answers: a conversation of another computer is found only with its host.
          if (remote !== (body.hostId === HOST)) {
            response.statusCode = 400;
            return response.end(JSON.stringify({ error: { code: "INVALID_ARGUMENT", message: "Official Thread read failed: thread not loaded" } }));
          }
          const thread = remote
            ? { threadId: body.threadId, title: "远程部署脚本", status: "idle", harnessId: "claude-code", cwd: "/srv/remote/deploy", pendingQuestions: [], hostId: HOST }
            : { threadId: body.threadId, title: "本机对话", status: "idle", harnessId: "claude-code", cwd: "/work/local", pendingQuestions: [] };
          return response.end(JSON.stringify(body.view === "messages" ? { ...thread, totalTurns: 2, turns: turnsOf(remote ? "远程" : "本机") } : thread));
        }
        if (request.url === "/v1/delegate/start") {
          started.push(body);
          return response.end(JSON.stringify({ threadId: CHILD, ...(body.hostId ? { hostId: body.hostId } : {}) }));
        }
        return response.end(JSON.stringify({ threads: [], nextCursor: null, ...(body.hostId ? { hostId: body.hostId } : {}) }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    await writeFile(path.join(root, "cli-credentials.json"), JSON.stringify({ endpoint: `http://127.0.0.1:${port}`, token: "secret" }));
  });
  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  async function start() {
    const dataDir = path.join(root, "host-extension-data", "second-brain");
    const extensionDir = path.join(root, "extension");
    await mkdir(path.join(extensionDir, "bin"), { recursive: true });
    await writeFile(path.join(extensionDir, "bin", "mainline.mjs"), "// cli\n");
    const handlers = new Map<string, (params: unknown) => unknown>();
    const calls: string[] = [];
    const dispose = await activate(
      { extensionId: "second-brain", extensionDir, dataDir, readSettings: async () => ({ prAlerts: false }), writeSettings: async (values) => values, handle: (method, handler) => handlers.set(method, handler) },
      {
        runGh: noGh,
        runModel: async (_engine, request) => {
          calls.push(request.prompt);
          return { model: "claude-haiku-test", value: summary };
        },
      },
    );
    const call = async (method: string, params?: unknown) => handlers.get(method)!(params);
    /** What was asked of codexhost for a conversation: route and body, in order. */
    const asked = (threadId: string) => requests.filter(({ body }) => body.threadId === threadId).map(({ url, body }) => ({ url, body }));
    return { dataDir, call, calls, asked, dispose };
  }

  it("reads it on its host, shows which computer it is on, and reads a local conversation without a host", async () => {
    const { call, asked, dispose } = await start();
    try {
      const view = (await call("conversation", { threadId: REMOTE, hostId: HOST })) as ConversationView;
      // The card says which computer, and whether it is connected, as codexhost says.
      expect(view.host).toEqual({ id: HOST, name: HOST_NAME, state: "connected" });
      await vi.waitFor(() => expect(asked(REMOTE).length).toBeGreaterThan(0));
      expect(asked(REMOTE).every(({ body }) => body.hostId === HOST)).toBe(true);

      const local = (await call("conversation", { threadId: LOCAL })) as ConversationView;
      expect(local.host).toBeUndefined();
      await vi.waitFor(() => expect(asked(LOCAL).length).toBeGreaterThan(0));
      expect(asked(LOCAL).every(({ body }) => body.hostId === undefined)).toBe(true);

      // What is no remote host's id is ignored, never trusted: the conversation stays local.
      for (const hostId of ["local", "remote-peer:bad id", 42, { id: HOST }]) {
        const other = (await call("conversation", { threadId: "019b0004-aaaa-7bbb-8ccc-00000000000d", hostId })) as ConversationView;
        expect(other.host).toBeUndefined();
      }
      expect(asked("019b0004-aaaa-7bbb-8ccc-00000000000d").every(({ body }) => body.hostId === undefined)).toBe(true);

      // The snapshot names the open conversation's host; never a local one's.
      const snapshot = (await call("snapshot", { client: "window-remote-1", focus: { threadId: REMOTE, surface: "web", hostId: HOST } })) as SnapshotResultV2;
      expect(snapshot.hosts).toEqual({ [REMOTE]: HOST });
      const localSnapshot = (await call("snapshot", { client: "window-local-2", focus: { threadId: LOCAL, surface: "web" } })) as SnapshotResultV2;
      expect(localSnapshot.hosts?.[LOCAL]).toBeUndefined();
    } finally {
      await dispose();
    }
  });

  it("summarizes it on this machine from what its host says, and keeps the host on its mainline; the log names the host by a short id", async () => {
    const { dataDir, call, calls, asked, dispose } = await start();
    try {
      await call("summarize", { threadId: REMOTE, hostId: HOST });
      await vi.waitFor(async () => expect((await readState(storePaths(dataDir))).conversations[REMOTE]?.title).toBe(summary.title), { timeout: 5000 });
      expect((await readState(storePaths(dataDir))).conversations[REMOTE]?.hostId).toBe(HOST);
      // Read on its host only: the thread and its turns.
      expect(asked(REMOTE).map(({ body }) => body.hostId)).not.toContain(undefined);
      expect(asked(REMOTE).some(({ body }) => body.view === "messages")).toBe(true);
      expect(calls[0]).toContain("远程：整理部署脚本");
      const log = await readFile(path.join(dataDir, "backend.log"), "utf8");
      expect(log).toMatch(/model call: claude manual 019b0001 \(remote host 0d1e2f3a\) [\d.]+s ok/u);
      expect(log).not.toContain(HOST_NAME);
      expect(log).not.toContain(HOST);
      expect(log).not.toContain("整理部署脚本");

      // A local conversation's summary names no host.
      await call("summarize", { threadId: LOCAL });
      await vi.waitFor(async () => expect((await readState(storePaths(dataDir))).conversations[LOCAL]).toBeDefined(), { timeout: 5000 });
      expect(asked(LOCAL).every(({ body }) => body.hostId === undefined)).toBe(true);
      expect((await readState(storePaths(dataDir))).conversations[LOCAL]?.hostId).toBeUndefined();
    } finally {
      await dispose();
    }
  });

  it("opens a child of it on the same computer, in the parent's folder there, with no watch and no files", async () => {
    const { dataDir, call, dispose } = await start();
    try {
      // Files cannot go along: that computer cannot read them. The upload goes as well.
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
      const { id } = (await call("attach.begin", { name: "截图.png", size: png.length })) as { id: string };
      await call("attach.chunk", { id, offset: 0, data: png.toString("base64") });
      await expect(call("spawn", { threadId: REMOTE, hostId: HOST, text: "脚本在新机器上跑不起来", attachments: [id] })).rejects.toThrow(/^\[REMOTE_ATTACHMENTS\]/u);
      expect(started).toEqual([]);
      expect(await readdir(path.join(dataDir, "attachments", ".incoming"))).toEqual([]);

      expect(await call("spawn", { threadId: REMOTE, hostId: HOST, text: "脚本在新机器上跑不起来" })).toEqual({ childThreadId: CHILD, hostId: HOST });
      expect(started).toHaveLength(1);
      expect(started[0]).toMatchObject({ hostId: HOST, harnessId: "claude-code", cwd: "/srv/remote/deploy", parentThreadId: REMOTE, taskName: "脚本在新机器上跑不起来" });
      expect(started[0]).not.toHaveProperty("watchTimeoutMs");
      expect(started[0]).not.toHaveProperty("watch");
      expect(String(started[0]!.task)).not.toContain("# Files mentioned by the user");
      const state = await readState(storePaths(dataDir));
      expect(state.conversations[REMOTE]?.hostId).toBe(HOST);
      expect(state.conversations[CHILD]).toMatchObject({ parentId: REMOTE, hostId: HOST });
      // The child is known to be there: its card reads it on that host, and the parent's card links it with its host.
      expect(((await call("conversation", { threadId: CHILD })) as ConversationView).host).toMatchObject({ id: HOST });
      expect(((await call("conversation", { threadId: REMOTE })) as ConversationView).children).toEqual([expect.objectContaining({ threadId: CHILD, hostId: HOST })]);
    } finally {
      await dispose();
    }
  });

  it("opens a child of a local conversation with no host", async () => {
    const { call, dispose } = await start();
    try {
      await call("spawn", { threadId: LOCAL, text: "本机的新问题" });
      expect(started).toHaveLength(1);
      expect(started[0]).not.toHaveProperty("hostId");
      expect(started[0]).toMatchObject({ cwd: "/work/local", parentThreadId: LOCAL });
    } finally {
      await dispose();
    }
  });

  it("never reads a draft: a new conversation not sent yet", async () => {
    const { call, dispose } = await start();
    try {
      for (const threadId of ["draft-19", "client-new-thread:5f0c9a1e-0000-4000-8000-000000000001"])
        for (const [method, params] of [
          ["conversation", { threadId }],
          ["summarize", { threadId }],
          ["spawn", { threadId, text: "x" }],
          ["refs.seenForThread", { threadId }],
          ["favorites.add", { threadId, text: "一段话" }],
        ] as const)
          await expect(call(method, params), `${method} ${threadId}`).rejects.toThrow(/^\[INVALID_ARGUMENT\]/u);
      // A surface open on a draft is open on no conversation.
      await call("snapshot", { client: "window-draft-1", focus: { threadId: "draft-19", surface: "web" } });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(requests.filter(({ body }) => String(body.threadId ?? "").includes("draft") || String(body.threadId ?? "").includes("client-new-thread"))).toEqual([]);
    } finally {
      await dispose();
    }
  });
});

it("looks up the remote parent's children even while the local Desktop tree is fresh", async () => {
  const listChildren = vi.fn(async () => [{ threadId: CHILD, status: "idle" }]);
  const note = vi.fn();
  const service = new ThreadInfoService({ listChildren } as unknown as ExternalApi, { info: vi.fn(), error: vi.fn() }, Date.now, {
    hosts: { hostOf: (threadId) => threadId === REMOTE ? HOST : undefined, down: () => false, note },
  });
  service.reportTree({ nodes: {}, parents: {} });
  expect(await service.lookupChildren(LOCAL)).toBe(false);
  expect(await service.lookupChildren(REMOTE)).toBe(true);
  expect(listChildren.mock.calls).toEqual([[REMOTE, HOST]]);
  expect(note).toHaveBeenCalledWith(CHILD, HOST);
});

describe("a remote host that cannot be reached", () => {
  it("holds up no read of this machine: its conversations are read in a queue of their own, one at a time, and not at all while it is down", async () => {
    let now = 1_000_000;
    const reads: string[] = [];
    const waiting: Array<() => void> = [];
    const api = {
      listThreads: async () => ({ threads: [], nextCursor: null }),
      readThread: async (threadId: string, hostId?: string): Promise<ApiThread> => {
        reads.push(`${threadId}${hostId ? `@${hostId}` : ""}`);
        // The remote host answers only when told to.
        if (hostId) await new Promise<void>((resolve) => waiting.push(resolve));
        return { threadId, status: "idle", title: threadId };
      },
      listChildren: async () => [],
    } as unknown as ExternalApi;
    let down = false;
    const hosts = { hostOf: (threadId: string) => (threadId.startsWith("r") ? "remote-peer:abc" : undefined), down: () => down };
    const threads = new ThreadInfoService(api, { info: () => undefined, error: () => undefined }, () => now, { hosts });
    const refreshing = threads.refresh(["r1", "r2", "l1", "l2", "l3"]);
    // Local reads all finish while the remote host keeps them waiting; only one remote read is under way.
    await vi.waitFor(() => expect(reads.filter((read) => !read.includes("@"))).toEqual(["l1", "l2", "l3"]));
    expect(threads.get("l3")?.title).toBe("l3");
    expect(reads.filter((read) => read.includes("@"))).toEqual(["r1@remote-peer:abc"]);
    waiting.shift()!();
    await vi.waitFor(() => expect(reads.filter((read) => read.includes("@"))).toHaveLength(2));
    waiting.shift()!();
    await refreshing;
    // Down: nothing more goes its way.
    down = true;
    now += 10 * 60_000;
    await threads.refresh(["r1", "r2"], ["r1"]);
    expect(reads.filter((read) => read.includes("@"))).toHaveLength(2);
  });

  it("holds up no summary of this machine: at most one worker is on another computer's conversation, and a host that is down is not read", { timeout: 20_000 }, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mainline-remote-summary-"));
    try {
      const paths = storePaths(dir);
      const NOW = Date.parse("2026-11-26T10:00:00Z");
      const updated = new Date(NOW - 5 * 60_000).toISOString();
      const reads: string[] = [];
      const release: Array<() => void> = [];
      let down = false;
      const remoteListed: ListedThread[] = [
        { threadId: "ra", updatedAt: updated, status: "idle", harnessId: "claude-code", hostId: "remote-peer:abc" },
        { threadId: "rb", updatedAt: updated, status: "idle", harnessId: "claude-code", hostId: "remote-peer:abc" },
      ];
      const summarizer = new Summarizer({
        api: {
          readThread: async (threadId, hostId) => {
            reads.push(`${threadId}${hostId ? `@${hostId}` : ""}`);
            if (hostId) await new Promise<void>((resolve) => release.push(resolve));
            return { threadId, title: threadId, status: "idle", harnessId: "claude-code" };
          },
          readTurns: async () => ({ totalTurns: 2, turns: turnsOf("x") }),
          listThreads: async () => ({ threads: [{ threadId: "la", updatedAt: updated, status: "idle", harnessId: "claude-code" }, { threadId: "lb", updatedAt: updated, status: "idle", harnessId: "claude-code" }], nextCursor: null }),
        },
        runModel: async () => ({ model: "claude-haiku-test", value: summary }),
        paths,
        log: { info: () => undefined, error: () => undefined },
        state: () => readState(paths),
        index: async () => emptyIndex(),
        settings: async () => ({ ...DEFAULT_SETTINGS }),
        changed: () => undefined,
        remote: { hostOf: (threadId) => (threadId.startsWith("r") ? "remote-peer:abc" : undefined), down: () => down, listed: () => (down ? [] : remoteListed) },
        now: () => NOW,
      });
      await summarizer.tick();
      // Both local conversations are summarized while the remote host keeps the first remote one waiting.
      await vi.waitFor(async () => expect(Object.keys((await readState(paths)).conversations).sort()).toEqual(["la", "lb"]), { timeout: 5000 });
      expect(reads.filter((read) => read.includes("@"))).toEqual(["ra@remote-peer:abc"]);
      release.shift()!();
      await vi.waitFor(() => expect(reads.filter((read) => read.includes("@"))).toHaveLength(2), { timeout: 5000 });
      release.shift()!();
      await vi.waitFor(async () => expect((await readState(paths)).conversations.rb?.hostId).toBe("remote-peer:abc"), { timeout: 5000 });
      // Asked for while its host is down: nothing is read, and the summary fails without sending anything.
      down = true;
      const before = reads.length;
      await summarizer.request("rc");
      await vi.waitFor(() => expect(summarizer.status().lastError).toMatch(/\(remote host abc\) is not connected/u), { timeout: 5000 });
      expect(reads.length).toBe(before);
      await summarizer.stop();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is left out of the PR scan while it is down; while it can be reached, its conversations are read on it and their records name it", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mainline-remote-scan-"));
    try {
      const refs = refsPaths(dir);
      const reads: string[] = [];
      let down = false;
      const remoteListed: ListedThread[] = [{ threadId: "r1", updatedAt: "2026-11-26T09:00:00Z", status: "idle", harnessId: "codex", hostId: "remote-peer:abc", title: "远程" }];
      const api = {
        listThreads: async (options: { hostId?: string } = {}) => ({ threads: options.hostId ? remoteListed : [], nextCursor: null }),
        readTurns: async (threadId: string, _range?: unknown, hostId?: string) => {
          reads.push(`${threadId}${hostId ? `@${hostId}` : ""}`);
          return { totalTurns: 1, turns: [{ turnNumber: 1, status: "completed", messages: [{ role: "agent", text: "见 https://github.com/acme/widgets/pull/42" }] }] };
        },
      } as unknown as ExternalApi;
      let now = Date.now();
      const scanner = new Scanner(api, refs, { info: () => undefined, error: () => undefined }, {
        recentEveryMs: () => 60_000,
        now: () => now,
        pauseMs: 0,
        // This conversation is older than the most recent page on its host.
        remote: { hosts: () => ["remote-peer:abc"], down: () => down, listed: () => [] },
      });
      down = true;
      // The full pass: this machine's list, and no host that is down.
      for (let i = 0; i < 6; i += 1) await scanner.tick();
      expect(reads).toEqual([]);
      down = false;
      // A previously unavailable host is paged in full on the first regular poll, without restarting.
      now += 60_000;
      for (let i = 0; i < 6; i += 1) await scanner.tick();
      expect(reads).toEqual(["r1@remote-peer:abc"]);
      const index = await readIndex(refs);
      expect(index.threads.r1).toMatchObject({ hostId: "remote-peer:abc", turns: 1 });
      expect(index.refs["acme/widgets#42"]?.mentions[0]?.threadId).toBe("r1");
      await scanner.stop();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
