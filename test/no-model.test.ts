/**
 * No test may reach a model: `claude` and `codex` are installed on machines that run these tests,
 * and many tests start the real backend. The test run sets MAINLINE_NO_MODEL=1 (vitest.config.ts),
 * and with it the model runner refuses every call before it looks for a tool or starts anything.
 * Starting processes is replaced here by a stand-in that records the attempt and runs nothing.
 */
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawned = vi.hoisted(() => [] as string[]);
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: (command: string) => {
      spawned.push(command);
      throw new Error("no process may be started in this test");
    },
  };
});

const { ApiNotReachedError } = await import("../src/backend/external-api.js");
const { activate } = await import("../src/backend/index.js");
const { createModelRunner, ModelNotSentError, NO_MODEL_ENV } = await import("../src/backend/models.js");

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "mainline-no-model-"));
  spawned.length = 0;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const REQUEST = { system: "Reply with JSON.", prompt: "对话内容", schema: { type: "object" } };

describe("with MAINLINE_NO_MODEL=1", () => {
  it("is set for the whole test run", () => {
    expect(process.env[NO_MODEL_ENV]).toBe("1");
  });

  it("the model runner refuses before it looks for a tool or starts anything", async () => {
    const find = vi.fn(() => "/opt/homebrew/bin/claude");
    const runner = createModelRunner(path.join(root, "runs"), { find });
    for (const engine of ["claude", "codex"] as const) {
      const refused = await runner(engine, REQUEST).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(ModelNotSentError);
      expect((refused as Error).message).toBe("model calls are turned off (MAINLINE_NO_MODEL=1): nothing was sent");
    }
    // The tools' own default places are not even looked at.
    expect(await createModelRunner(path.join(root, "runs"))("claude", REQUEST).catch((error: unknown) => (error as Error).message)).toContain("MAINLINE_NO_MODEL");
    expect(find).not.toHaveBeenCalled();
    expect(spawned).toEqual([]);
  });

  it("a backend started without a stand-in model sends nothing anywhere when asked for a summary", async () => {
    // A codexhost that has the conversation, so the summary gets as far as the model.
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        const asked = JSON.parse(body || "{}") as { view?: string };
        if (request.url === "/v1/thread/read" && asked.view === "messages")
          response.end(JSON.stringify({ totalTurns: 1, turns: [{ turnNumber: 1, status: "completed", messages: [{ role: "user", text: "fix it" }, { role: "agent", text: "done" }] }] }));
        else if (request.url === "/v1/thread/read") response.end(JSON.stringify({ threadId: "t1", status: "idle", harnessId: "claude-code" }));
        else response.end(JSON.stringify({ threads: [], nextCursor: null }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    await writeFile(path.join(root, "cli-credentials.json"), JSON.stringify({ endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: "secret" }));
    const dataDir = path.join(root, "host-extension-data", "second-brain");
    const extensionDir = path.join(root, "extension");
    await mkdir(path.join(extensionDir, "bin"), { recursive: true });
    await writeFile(path.join(extensionDir, "bin", "mainline.mjs"), "// cli\n");
    const handlers = new Map<string, (params: unknown) => unknown>();
    // No runModel: the real runner, as codexhost starts the backend.
    const dispose = await activate(
      { extensionId: "second-brain", extensionDir, dataDir, readSettings: async () => ({}), writeSettings: async (values) => values, handle: (method, handler) => handlers.set(method, handler) },
      { runGh: async () => Promise.reject(new Error("no gh in tests")) },
    );
    try {
      expect(await handlers.get("summarize")!({ threadId: "t1" })).toEqual({ queued: true });
      // The call reached the runner, which refused it: nothing counted, and the overview says why.
      const status = async () => ((await handlers.get("snapshot")!({})) as { summarizer: { lastError?: string; today: { calls: { claude: { manual: number } } } } }).summarizer;
      await vi.waitFor(async () => expect((await status()).lastError).toBe("model calls are turned off (MAINLINE_NO_MODEL=1): nothing was sent"));
      expect((await status()).today.calls.claude.manual).toBe(0);
    } finally {
      await dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(spawned).toEqual([]);
  });
});

it("keeps the two kinds of \"not sent\" apart", () => {
  expect(new ModelNotSentError("x").name).toBe("ModelNotSentError");
  expect(new ApiNotReachedError("x").name).toBe("ApiNotReachedError");
  expect(new ModelNotSentError("x")).not.toBeInstanceOf(ApiNotReachedError);
});
