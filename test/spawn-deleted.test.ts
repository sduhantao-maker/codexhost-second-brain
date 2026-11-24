/**
 * Correctness audit, finding 9: opening a child from the hover card on a conversation whose
 * mainline the user deleted brought the mainline back and cleared the "deleted" mark, even when
 * the child never opened. Now nothing is written unless the child opens; then the parent gets a
 * mainline to hold the link, still left alone by model summaries until the user asks.
 */
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activate } from "../src/backend/index.js";
import { isExcluded } from "../src/core/conversation-ops.js";
import type { SummarizerStatus } from "../src/core/rpc.js";
import { readState, storePaths } from "../src/node/store.js";

let root: string;
let server: Server | undefined;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "mainline-spawn-deleted-"));
});
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  await rm(root, { recursive: true, force: true });
});

/** A stand-in codexhost that opens every child it is asked for. */
async function codexhost(started: unknown[]): Promise<void> {
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/v1/thread/read")
        response.end(JSON.stringify({ threadId: "t1", title: "整理发布说明", status: "idle", harnessId: "claude-code", pendingQuestions: [] }));
      else if (request.url === "/v1/delegate/start") {
        started.push(JSON.parse(body));
        response.end(JSON.stringify({ threadId: `child-${started.length}` }));
      } else response.end(JSON.stringify({ threads: [], nextCursor: null }));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  await writeFile(path.join(root, "cli-credentials.json"), JSON.stringify({ endpoint: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, token: "secret" }));
}

async function start() {
  const dataDir = path.join(root, "host-extension-data", "second-brain");
  const extensionDir = path.join(root, "extension");
  await mkdir(path.join(extensionDir, "bin"), { recursive: true });
  await writeFile(path.join(extensionDir, "bin", "mainline.mjs"), "// cli\n");
  const handlers = new Map<string, (params: unknown) => unknown>();
  const dispose = await activate(
    { extensionId: "second-brain", extensionDir, dataDir, readSettings: async () => ({}), writeSettings: async (values) => values, handle: (method, handler) => handlers.set(method, handler) },
    {
      runGh: async () => Promise.reject(new Error("no gh in tests")),
      runModel: async () => Promise.reject(new Error("no model in tests")),
    },
  );
  const call = async (method: string, params?: unknown) => handlers.get(method)!(params);
  return { dataDir, call, dispose, state: () => readState(storePaths(dataDir)) };
}

describe("opening a child on a conversation whose mainline the user deleted", () => {
  it("brings nothing back when the child does not open", async () => {
    const { call, dispose, state } = await start();
    try {
      await call("mutate", { op: "create", threadId: "t1", title: "Old mainline" });
      await call("mutate", { op: "delete", threadId: "t1" });
      // No codexhost to ask: the child never opens.
      await expect(call("spawn", { threadId: "t1", text: "a new problem" })).rejects.toThrow();
      const after = await state();
      expect(after.conversations.t1).toBeUndefined();
      expect(isExcluded(after, "t1")).toBe(true);
    } finally {
      await dispose();
    }
  });

  it("gives the parent a mainline to hold the link once the child opens, still left out of model summaries until the user asks", async () => {
    const started: unknown[] = [];
    await codexhost(started);
    const { call, dispose, state } = await start();
    try {
      await call("mutate", { op: "create", threadId: "t1", title: "Old mainline" });
      await call("mutate", { op: "delete", threadId: "t1" });
      expect(await call("spawn", { threadId: "t1", text: "a new problem" })).toEqual({ childThreadId: "child-1" });
      expect(started).toHaveLength(1);
      const after = await state();
      expect(after.conversations.t1).toMatchObject({ title: "整理发布说明", spinoffs: [{ text: "a new problem", state: "spawned", childThreadId: "child-1" }] });
      expect(after.conversations["child-1"]).toMatchObject({ parentId: "t1" });
      expect(isExcluded(after, "t1")).toBe(true);
      // The backfill counts it out, as every deleted mainline.
      const status = (await call("summarize.cancel")) as SummarizerStatus;
      expect(status.toBackfill ?? 0).toBe(0);
      // Asking for a summary is asking for the mainline: the mark goes.
      expect(await call("summarize", { threadId: "t1" })).toEqual({ queued: true });
      expect(isExcluded(await state(), "t1")).toBe(false);
    } finally {
      await dispose();
    }
  });
});
