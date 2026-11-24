import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activate } from "../src/backend/index.js";
import { Uploads, WAITING_MAX_BYTES } from "../src/backend/uploads.js";
import { ATTACH_MAX_FILE_BYTES, isUploadId } from "../src/core/attachments.js";
import { ownersPaths, readOwners } from "../src/node/attachment-owners.js";
import { readState, storePaths } from "../src/node/store.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "mainline-attach-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("upload limits in the backend", () => {
  it("lets the uploads waiting at once take at most 2 GiB", async () => {
    const uploads = new Uploads(root);
    const big = await Promise.all([1, 2, 3, 4].map((n) => uploads.begin({ name: `${n}.mov`, size: ATTACH_MAX_FILE_BYTES })));
    expect(ATTACH_MAX_FILE_BYTES * 4).toBeLessThanOrEqual(WAITING_MAX_BYTES);
    await expect(uploads.begin({ name: "5.mov", size: ATTACH_MAX_FILE_BYTES })).rejects.toMatchObject({ code: "UPLOADS_BUSY", message: "uploads waiting would take over 2 GB" });
    // One dropped makes room again.
    await uploads.discard([big[0]!.id]);
    await uploads.begin({ name: "5.mov", size: ATTACH_MAX_FILE_BYTES });
  });

  it("lets the files of one child conversation take at most their total", async () => {
    const uploads = new Uploads(root, Date.now, { childBytes: 10 });
    const sent = async (name: string, size: number) => {
      const { id } = await uploads.begin({ name, size });
      await uploads.chunk({ id, offset: 0, data: Buffer.alloc(size, 1).toString("base64") });
      return id;
    };
    const a = await sent("a.bin", 6);
    const b = await sent("b.bin", 5);
    await expect(uploads.claim([a, b])).rejects.toMatchObject({ code: "CHILD_FILES_TOO_LARGE", message: expect.stringContaining("at most 10 B") });
    // Nothing moved: each still goes with a child on its own.
    expect(await uploads.claim([a])).toHaveLength(1);
    expect(await uploads.claim([b])).toHaveLength(1);
  });
});

describe("files sent with a child conversation", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  let server: Server;
  /** How the stand-in codexhost meets a request to start a child. */
  let onStart: (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => void;
  let started: number;
  let dataDir: string;
  let call: (method: string, params?: unknown) => Promise<unknown>;
  let dispose: () => Promise<void>;

  /** Called once a read was answered. */
  let afterRead: () => void;

  beforeEach(async () => {
    started = 0;
    afterRead = () => undefined;
    onStart = (_request, response) => {
      started += 1;
      response.end(JSON.stringify({ threadId: `child-${started}` }));
    };
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        if (request.url === "/v1/thread/read") {
          // Each request on a connection of its own, so a closed server refuses the next one.
          response.setHeader("connection", "close");
          response.end(JSON.stringify({ threadId: "old-1", title: "登录页样式检查", status: "idle", harnessId: "claude-code", cwd: "/work/shop", pendingQuestions: [] }));
          afterRead();
        } else if (request.url === "/v1/delegate/start") onStart(request, response);
        else {
          // The parent is among the recently updated, so the list answers for it and only the spawn reads it.
          const parent = { threadId: "old-1", harnessId: "claude-code", status: "completed", title: "登录页样式检查", updatedAt: "2026-11-24T00:00:00.000Z" };
          response.end(JSON.stringify({ threads: JSON.parse(body).parentThreadId ? [] : [parent], nextCursor: null }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    await writeFile(path.join(root, "cli-credentials.json"), JSON.stringify({ endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: "secret" }));
    dataDir = path.join(root, "host-extension-data", "second-brain");
    const extensionDir = path.join(root, "extension");
    await mkdir(path.join(extensionDir, "bin"), { recursive: true });
    await writeFile(path.join(extensionDir, "bin", "mainline.mjs"), "// cli\n");
    const handlers = new Map<string, (params: unknown) => unknown>();
    dispose = await activate(
      { extensionId: "second-brain", extensionDir, dataDir, readSettings: async () => ({}), writeSettings: async (values) => values, handle: (method, handler) => handlers.set(method, handler) },
      { runGh: async () => Promise.reject(new Error("no gh in tests")) },
    );
    call = async (method, params) => handlers.get(method)!(params);
  });
  afterEach(async () => {
    await dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const attachments = () => path.join(dataDir, "attachments");
  async function upload(name: string, bytes: Buffer): Promise<string> {
    const { id } = (await call("attach.begin", { name, size: bytes.length })) as { id: string };
    await call("attach.chunk", { id, offset: 0, data: bytes.toString("base64") });
    return id;
  }
  async function folders(): Promise<{ waiting: string[]; kept: string[] }> {
    const waiting = await readdir(path.join(attachments(), ".incoming")).catch(() => []);
    const kept = (await readdir(attachments()).catch(() => [])).filter((name) => isUploadId(name));
    return { waiting: waiting.sort(), kept: kept.sort() };
  }

  it("keeps them, owner unknown, when codexhost was asked but never answered whether the child opened", async () => {
    // The request reaches codexhost, then the connection drops before any answer.
    onStart = (request) => request.socket.destroy();
    const shot = await upload("截图.png", PNG);
    await expect(call("spawn", { threadId: "old-1", text: "登录按钮错位", attachments: [shot] })).rejects.toThrow();
    expect(await folders()).toEqual({ waiting: [], kept: [shot] });
    expect(await readOwners(ownersPaths(attachments()))).toEqual({});
    expect(await call("attachments.usage")).toMatchObject({ all: { files: 1 }, unknown: { files: 1 } });
    await expect.poll(() => readFile(path.join(dataDir, "backend.log"), "utf8").catch(() => "")).toContain("kept 1 attached files: no answer whether the child conversation of old-1 opened");
    expect((await readState(storePaths(dataDir))).conversations["old-1"]!.spinoffs).toMatchObject([{ state: "open" }]);
    // "Clear all" takes them.
    await call("attachments.clear", { scope: "all" });
    expect(await folders()).toEqual({ waiting: [], kept: [] });
  });

  it("deletes them when the request to start the child never reached codexhost", async () => {
    // codexhost answers the parent's read, then stops listening: the start is refused at the door.
    afterRead = () => server.close();
    const shot = await upload("截图.png", PNG);
    await expect(call("spawn", { threadId: "old-1", text: "登录按钮错位", attachments: [shot] })).rejects.toThrow("codexhost's local API is not running");
    expect(await folders()).toEqual({ waiting: [], kept: [] });
  });

  it("deletes them when codexhost could not be asked at all", async () => {
    server.close();
    const shot = await upload("截图.png", PNG);
    await expect(call("spawn", { threadId: "old-1", text: "登录按钮错位", attachments: [shot] })).rejects.toThrow();
    expect(await folders()).toEqual({ waiting: [], kept: [] });
  });

  it("deletes them when codexhost says no", async () => {
    onStart = (_request, response) => {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: { code: "INVALID_ARGUMENT" } }));
    };
    const shot = await upload("截图.png", PNG);
    await expect(call("spawn", { threadId: "old-1", text: "登录按钮错位", attachments: [shot] })).rejects.toThrow(/HTTP 400/u);
    expect(await folders()).toEqual({ waiting: [], kept: [] });
  });

  it("drops the files sent along at once when the spin-off was opened already", async () => {
    expect(await call("spawn", { threadId: "old-1", text: "登录按钮错位" })).toEqual({ childThreadId: "child-1" });
    const spinoffId = (await readState(storePaths(dataDir))).conversations["old-1"]!.spinoffs[0]!.id;
    const late = await upload("截图.png", PNG);
    expect(await call("spawn", { threadId: "old-1", spinoffId, attachments: [late] })).toEqual({ childThreadId: "child-1" });
    expect(await folders()).toEqual({ waiting: [], kept: [] });
    expect(started).toBe(1);
  });
});
