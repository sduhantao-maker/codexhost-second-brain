import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { activate } from "../src/backend/index.js";
import { run } from "../src/cli/main.js";
import * as ops from "../src/core/conversation-ops.js";
import { conversationView } from "../src/core/conversation-view.js";
import { emptyStateV2, normalizeStateV2 } from "../src/core/conversation.js";
import { addFavorite, emptyFavorites } from "../src/core/favorites.js";
import { isThreadId } from "../src/core/model.js";
import { emptyIndex, normalizeIndex } from "../src/core/refs.js";
import { searchConversations } from "../src/core/search.js";

const PROTOTYPE_KEYS = ["title", "tags", "status", "updatedAt", "pinned", "text", "at", "milestones", "threadId", "createdAt", "spinoffs"];
const polluted = () => PROTOTYPE_KEYS.filter((key) => key in ({} as Record<string, unknown>));

afterEach(() => {
  for (const key of PROTOTYPE_KEYS) delete (Object.prototype as Record<string, unknown>)[key];
});

describe("conversation ids", () => {
  it("are the ids codexhost and the agents make, and nothing an object already has", () => {
    for (const id of ["t1", "src", "old-1", "child-9", "e2e-1", "codex-own", "thread-of-this-test", "draft-e0aa", "019a0001-aaaa-7bbb-8ccc-000000000001", "5F0C9A1E-0000-4000-8000-000000000001", "ses_01ab.c~d", "a".repeat(256)])
      expect(isThreadId(id), id).toBe(true);
    for (const id of ["__proto__", "constructor", "prototype", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "__defineGetter__", "", " ", "a b", " t1", "-x", "_x", ".x", "x/y", "x:y", "x\\y", "主线", "a".repeat(257), 7, null, undefined])
      expect(isThreadId(id), String(id)).toBe(false);
  });

  it("never reach Object.prototype through the state, the link index or favorites", () => {
    const state = normalizeStateV2(
      JSON.parse(
        '{"version":2,"rev":1,"conversations":{"__proto__":{"title":"x","tags":[],"milestones":[],"spinoffs":[]},"t1":{"title":"Goal","tags":[],"milestones":[],"spinoffs":[],"parentId":"__proto__"}},"prompts":{"__proto__":{"text":"hi","at":1}},"excluded":{"__proto__":5}}',
      ),
    );
    expect(Object.keys(state.conversations)).toEqual(["t1"]);
    expect(Object.getPrototypeOf(state.conversations)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(state.prompts)).toBe(Object.prototype);
    expect(state.conversations.t1?.parentId).toBeUndefined();
    expect(state.excluded).toBeUndefined();
    const index = normalizeIndex(JSON.parse('{"version":1,"rev":1,"refs":{},"threads":{"__proto__":{"turns":1,"updatedAt":"u","title":"x"},"t1":{"turns":1,"updatedAt":"u"}}}'));
    expect(Object.keys(index.threads)).toEqual(["t1"]);
    expect(Object.getPrototypeOf(index.threads)).toBe(Object.prototype);
    expect(() => addFavorite(emptyFavorites(), { threadId: "__proto__", text: "x", source: "select" }, 1)).toThrow();
    expect(polluted()).toEqual([]);
  });

  it("are checked by every edit that files a record under one, and lookups see only own records", () => {
    const state = emptyStateV2();
    const ctx = { now: 1 };
    expect(() => ops.createConversation(state, "__proto__", { title: "polluted title", tags: ["t"] }, ctx)).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    expect(() =>
      ops.applySummary(state, "__proto__", { title: "x", tags: [], milestones: [], finished: false }, { at: 1, model: "m" }, ctx),
    ).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    expect(ops.recordPromptV2(state, "__proto__", "hello", ctx)).toBe(false);
    for (const key of ["constructor", "toString", "hasOwnProperty"]) {
      expect(() => ops.requireConversation(state, key)).toThrow(expect.objectContaining({ code: "NO_MAINLINE" }));
      expect(() => ops.setTitle(state, key, "x", ctx)).toThrow(expect.objectContaining({ code: "NO_MAINLINE" }));
    }
    ops.createConversation(state, "p1", { title: "Parent" }, ctx);
    const spinoff = ops.addSpinoff(state, "p1", "side problem", ctx);
    expect(() => ops.linkSpinoff(state, "p1", spinoff.id, "__proto__", ctx)).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    expect(() => ops.relate(state, "p1", "__proto__", ctx)).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    ops.pin(state, "constructor", ["title"]);
    ops.noteParents(state, new Map([["constructor", "p1"], ["p1", "__proto__"]]));
    expect(Object.keys(state.conversations)).toEqual(["p1"]);
    expect(state.conversations.p1?.parentId).toBeUndefined();
    expect(Object.keys(state.prompts)).toEqual([]);
    expect(polluted()).toEqual([]);
  });

  it("are looked up as own records by the views and the search", () => {
    const state = emptyStateV2();
    ops.createConversation(state, "t1", { title: "Fix the sidebar" }, { now: 1 });
    const sources = { state, info: {}, parents: {} };
    for (const key of ["constructor", "toString", "hasOwnProperty"]) {
      const view = conversationView(key, sources);
      expect(view).toMatchObject({ draft: true, title: `#${key.slice(0, 8)}`, threadStatus: "unknown" });
      expect(view.lastPrompt).toBeUndefined();
      expect(view.parent).toBeUndefined();
    }
    // A conversation whose parent is named "constructor" by a surface gets no parent from Object.prototype.
    expect(conversationView("t1", { ...sources, parents: {} }).parent).toBeUndefined();
    expect(searchConversations({ sources, index: emptyIndex(), query: "sidebar" }).map(({ threadId }) => threadId)).toEqual(["t1"]);
  });

  it("from the command line are conversation ids, or none", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mainline-ids-cli-"));
    try {
      const say = async (env: Record<string, string>, ...argv: string[]) => {
        let out = "";
        let err = "";
        const code = await run(argv, { env: { MAINLINE_DATA_DIR: dir, LANG: "en_US.UTF-8", ...env }, stdout: (text) => void (out += text), stderr: (text) => void (err += text) });
        return { code, out, err };
      };
      expect(await say({}, "new", "Polluted", "--thread", "constructor")).toEqual({ code: 1, out: "", err: "mainline: --thread is not a conversation id\n" });
      // From the environment, anything else names no conversation: the hook says nothing and records nothing.
      expect(await say({ CODEXHOST_THREAD_ID: "__proto__" }, "hook", "claude-prompt")).toEqual({ code: 0, out: "", err: "" });
      expect((await say({ CODEXHOST_THREAD_ID: "constructor" }, "doing", "something")).err).toContain("No current conversation");
      expect((await say({ CODEXHOST_THREAD_ID: "t1" }, "new", "Fine")).code).toBe(0);
      expect(polluted()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keep the backend's objects clean when an edit names __proto__", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mainline-ids-"));
    try {
      const dataDir = path.join(root, "host-extension-data", "second-brain");
      const extensionDir = path.join(root, "extension");
      await mkdir(path.join(extensionDir, "bin"), { recursive: true });
      await writeFile(path.join(extensionDir, "bin", "mainline.mjs"), "// cli\n");
      const handlers = new Map<string, (params: unknown) => unknown>();
      const dispose = await activate(
        {
          extensionId: "second-brain",
          extensionDir,
          dataDir,
          readSettings: async () => ({ autoSummarize: false, prAlerts: false }),
          writeSettings: async (values) => values,
          handle: (method, handler) => handlers.set(method, handler),
        },
        { runGh: async () => Promise.reject(new Error("no gh in tests")), runModel: async () => Promise.reject(new Error("no model in tests")) },
      );
      try {
        const call = async (method: string, params?: unknown) => handlers.get(method)!(params);
        await expect(call("mutate", { op: "create", threadId: "__proto__", title: "Run this first" })).rejects.toThrow(/INVALID_ARGUMENT/u);
        await expect(call("mutate", { op: "status", threadId: "__proto__", status: "paused" })).rejects.toThrow(/INVALID_ARGUMENT/u);
        // Every call that takes a conversation id refuses what is none, before it reaches a lookup.
        for (const threadId of ["__proto__", "constructor", "toString", "../t1", ""]) {
          for (const [method, params] of [
            ["conversation", { threadId }],
            ["spawn", { threadId, text: "a problem" }],
            ["summarize", { threadId }],
            ["refs.forThread", { threadId }],
            ["favorites.add", { threadId, text: "a passage" }],
          ] as const)
            await expect(call(method, params), `${method} ${threadId}`).rejects.toThrow(/^\[INVALID_ARGUMENT\] threadId (?:is required|is not a conversation id)$/u);
        }
        // A surface's focus or delegation tree naming one is left out, and the snapshot still answers.
        const snapshot = (await call("snapshot", { focus: { surface: "desktop", threadId: "constructor" } })) as { version?: unknown };
        expect(typeof snapshot.version).toBe("string");
        await call("reportTree", { surface: "desktop", nodes: JSON.parse('{"__proto__":{"status":"running","title":"polluted title"},"t9":{"status":"idle"}}'), parents: { constructor: "t9", t9: "__proto__" } });
        await call("reportTree", { surface: "web", nodes: {}, parents: JSON.parse('{"__proto__":"t9","t9":"constructor"}') });
        const keys: string[] = [];
        for (const key in { a: 1 }) keys.push(key);
        expect(keys).toEqual(["a"]);
        expect(polluted()).toEqual([]);
      } finally {
        await dispose();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
