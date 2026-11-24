/**
 * 0.10 renamed the extension from Mainline (`mainline`) to Second Brain (`second-brain`), and
 * codexhost gives the new id an empty data folder. The backend's first start copies the old
 * folder's data over, once: never into a folder that has data, never touching the old folder, never
 * leaving half a copy that looks finished, and with the settings carried over through codexhost.
 */
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activate } from "../src/backend/index.js";
import {
  MIGRATION_MARKER,
  MIGRATION_STAGING,
  migrateFromMainline,
  type MigrationRecord,
  type SettingsAccess,
} from "../src/backend/migrate-from-mainline.js";
import { emptyStateV2 } from "../src/core/conversation.js";
import { createConversation } from "../src/core/conversation-ops.js";
import { DEFAULT_SETTINGS } from "../src/core/model.js";
import type { SnapshotResultV2 } from "../src/core/rpc.js";
import { readFavorites, favoritesPaths } from "../src/node/favorites-store.js";
import { readState, storePaths } from "../src/node/store.js";

const NOW = Date.parse("2026-11-24T08:00:00Z");
const UPLOAD_A = "0b6f2a5e-1111-4222-8333-444455556666";
const UPLOAD_B = "7c1d9e3a-aaaa-4bbb-8ccc-dddddddddddd";

let root: string;
let oldDir: string;
let newDir: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "second-brain-migrate-"));
  oldDir = path.join(root, "host-extension-data", "mainline");
  newDir = path.join(root, "host-extension-data", "second-brain");
});
afterEach(async () => {
  vi.useRealTimers();
  // Undo what a test made unreadable, so the folder can go.
  await chmod(path.join(oldDir, "refs.json"), 0o600).catch(() => undefined);
  await chmod(path.join(oldDir, "attachments", UPLOAD_B, "notes.txt"), 0o600).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

const put = async (file: string, text: string | Buffer) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, { mode: 0o600 });
};

function stateWith(title: string): string {
  const state = emptyStateV2();
  createConversation(state, "t1", { title, tags: ["shop"], milestones: ["Find the cause", "Open the PR"] }, { now: NOW });
  return JSON.stringify(state);
}

/** What an install of 0.9 leaves in its data folder, with what is never copied next to what is. */
async function oldInstall(settings: unknown = { settingsRevision: 3, values: { showCapsule: true, prAlerts: false, summarizeModel: "bogus", removedLongAgo: 1 } }) {
  await put(path.join(oldDir, "state.json"), stateWith("Fix the login page"));
  await put(path.join(oldDir, "refs.json"), JSON.stringify({ version: 1, rev: 4, refs: {}, threads: {}, crawl: { done: true, listed: 3 }, github: {} }));
  await put(path.join(oldDir, "favorites.json"), JSON.stringify({ version: 1, rev: 2, items: [{ id: "f1", threadId: "t1", text: "Run the checks before a release.", source: "select", createdAt: NOW }] }));
  await put(path.join(oldDir, "summary-counts.json"), JSON.stringify({ version: 1, days: {} }));
  await put(path.join(oldDir, "github-poll.json"), JSON.stringify({ version: 1, lastPollAt: NOW }));
  await put(path.join(oldDir, "backfill-tried.json"), JSON.stringify({ version: 1, requestedAt: NOW, tried: ["t1"] }));
  await put(path.join(oldDir, "context", "t1.hook.json"), JSON.stringify({ version: 1, fullAt: NOW, rules: "r", since: 1, status: "s" }));
  await put(path.join(oldDir, "context", "t2.show.json"), JSON.stringify({ version: 1, fullAt: NOW, rules: "r", since: 0, status: "s" }));
  await put(path.join(oldDir, "attachments", "owners.json"), JSON.stringify({ version: 1, owners: { [UPLOAD_A]: { child: "c1", parent: "t1", at: NOW } } }));
  await put(path.join(oldDir, "attachments", UPLOAD_A, "screen.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  await put(path.join(oldDir, "attachments", UPLOAD_B, "notes.txt"), "owner unknown");
  if (settings !== undefined) await put(path.join(oldDir, "settings.json"), typeof settings === "string" ? settings : JSON.stringify(settings));
  // Never copied:
  await put(path.join(oldDir, "context", "t1.hook.corrupt-2026-11-20T00-00-00-000Z.json"), "{ damaged");
  await put(path.join(oldDir, "context", "t3.hook.json.1234.abcd.tmp"), "{}");
  await put(path.join(oldDir, "attachments", ".incoming", "9e8d7c6b-0000-4000-8000-000000000000", "half.mov"), "half");
  await mkdir(path.join(oldDir, "attachments", "owners.lock"), { recursive: true });
  await put(path.join(oldDir, "attachments", "not-an-upload", "x.txt"), "x");
  await put(path.join(oldDir, "backups", "claude-settings.json.2026-11-23T10-18-55-812Z.bak"), '{"env":{"TOKEN":"a credential"}}');
  await put(path.join(oldDir, "state.v1.json"), "{}");
  await put(path.join(oldDir, "state.corrupt-2026-11-20T00-00-00-000Z.json"), "{ damaged");
  await put(path.join(oldDir, "backend.log"), "log\n");
  await put(path.join(oldDir, "backend.log.1"), "older log\n");
  await put(path.join(oldDir, "bin", "mainline"), "#!/bin/sh\n");
  await put(path.join(oldDir, "model-runs", "claude-1-abc", "schema.json"), "{}");
  await mkdir(path.join(oldDir, "state.lock"), { recursive: true });
}

/** Every entry of a folder with what it holds and when it changed: the old folder must stay exactly so. */
async function fingerprint(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (current: string) => {
    for (const name of (await readdir(current)).sort()) {
      const file = path.join(current, name);
      const info = await lstat(file);
      const key = path.relative(dir, file);
      if (info.isDirectory()) {
        out[key] = `dir ${info.mode} ${info.mtimeMs}`;
        await walk(file);
      } else out[key] = `file ${info.mode} ${info.mtimeMs} ${createHash("sha256").update(await readFile(file)).digest("hex")}`;
    }
  };
  await walk(dir);
  return out;
}

/** codexhost's settings, as the backend reaches them. */
function settingsAccess(current: Record<string, unknown> = { ...DEFAULT_SETTINGS }) {
  const written: Array<Record<string, unknown>> = [];
  const access: SettingsAccess = {
    read: async () => current,
    write: async (values) => {
      written.push(values);
      return values;
    },
  };
  return { access, written };
}

const same = async (name: string) => expect(await readFile(path.join(newDir, name))).toEqual(await readFile(path.join(oldDir, name)));
const readMarker = async () => JSON.parse(await readFile(path.join(newDir, MIGRATION_MARKER), "utf8")) as MigrationRecord;

describe("copying the data of the earlier Mainline extension", () => {
  it("copies the data once, leaves the old folder as it was, and writes the marker last", async () => {
    await oldInstall();
    // What the backend writes before the copy: its log.
    await put(path.join(newDir, "backend.log"), "starting\n");
    const before = await fingerprint(oldDir);
    const { access, written } = settingsAccess();

    const outcome = await migrateFromMainline({ dataDir: newDir, settings: access, now: () => NOW });

    const expected: MigrationRecord = {
      version: 1,
      from: "mainline",
      at: NOW,
      files: ["state.json", "refs.json", "favorites.json", "summary-counts.json", "github-poll.json", "backfill-tried.json"],
      context: 2,
      attachments: { folders: 2, owners: true },
      settings: "carried",
    };
    expect(outcome).toEqual({ kind: "migrated", record: expected });
    expect(await readMarker()).toEqual(expected);
    for (const name of expected.files) await same(name);
    await same(path.join("context", "t1.hook.json"));
    await same(path.join("context", "t2.show.json"));
    await same(path.join("attachments", "owners.json"));
    await same(path.join("attachments", UPLOAD_A, "screen.png"));
    await same(path.join("attachments", UPLOAD_B, "notes.txt"));
    // Only what was asked for, and nothing of the copy under way is left.
    expect((await readdir(newDir)).sort()).toEqual(["attachments", "backend.log", "context", MIGRATION_MARKER, ...expected.files].sort());
    expect((await readdir(path.join(newDir, "context"))).sort()).toEqual(["t1.hook.json", "t2.show.json"]);
    expect((await readdir(path.join(newDir, "attachments"))).sort()).toEqual([UPLOAD_A, UPLOAD_B, "owners.json"].sort());
    expect(await readFile(path.join(newDir, "backend.log"), "utf8")).toBe("starting\n");
    // Readable by the user only.
    for (const name of ["state.json", path.join("attachments", UPLOAD_A, "screen.png"), MIGRATION_MARKER]) expect((await stat(path.join(newDir, name))).mode & 0o777).toBe(0o600);
    // The stores read it as their own.
    expect((await readState(storePaths(newDir))).conversations.t1?.title).toBe("Fix the login page");
    expect((await readFavorites(favoritesPaths(newDir))).items.map((item) => item.id)).toEqual(["f1"]);
    // The settings went through codexhost: the keys this version knows, with values it accepts.
    expect(written).toEqual([{ showCapsule: true, prAlerts: false }]);
    // The old folder is exactly as it was.
    expect(await fingerprint(oldDir)).toEqual(before);

    // Never twice: later starts copy nothing, also when the old folder changed meanwhile.
    await put(path.join(oldDir, "state.json"), stateWith("Something newer in the old folder"));
    expect(await migrateFromMainline({ dataDir: newDir, settings: access })).toEqual({ kind: "done" });
    expect((await readState(storePaths(newDir))).conversations.t1?.title).toBe("Fix the login page");
    expect(written).toHaveLength(1);
  });

  it("does nothing without an old folder, or when it holds nothing to copy", async () => {
    const { access, written } = settingsAccess();
    expect(await migrateFromMainline({ dataDir: newDir, settings: access })).toEqual({ kind: "none", reason: "nothing to copy" });
    // Logs, backups and the command are no data to copy.
    await put(path.join(oldDir, "backend.log"), "log\n");
    await put(path.join(oldDir, "backups", "codex-AGENTS.md.2026-11-23T10-18-59-340Z.bak"), "# rules\n");
    await put(path.join(oldDir, "bin", "mainline"), "#!/bin/sh\n");
    expect(await migrateFromMainline({ dataDir: newDir, settings: access })).toEqual({ kind: "none", reason: "nothing to copy" });
    expect(await stat(newDir).catch(() => undefined)).toBeUndefined();
    expect(written).toEqual([]);
    // Nor anywhere but the folder codexhost gives the extension.
    await oldInstall();
    expect(await migrateFromMainline({ dataDir: path.join(root, "elsewhere"), oldDir })).toEqual({ kind: "none", reason: "not a codexhost data folder" });
  });

  it("never copies into a folder that has data already, nor replaces any of it", async () => {
    await oldInstall();
    const mine = stateWith("Made under the new name");
    await put(path.join(newDir, "state.json"), mine);
    const { access, written } = settingsAccess();
    expect(await migrateFromMainline({ dataDir: newDir, settings: access })).toEqual({ kind: "none", reason: "data already here" });
    expect(await readFile(path.join(newDir, "state.json"), "utf8")).toBe(mine);
    expect((await readdir(newDir)).sort()).toEqual(["state.json"]);
    expect(written).toEqual([]);
    // A saved passage or an attachment counts as data too.
    await rm(path.join(newDir, "state.json"));
    await put(path.join(newDir, "attachments", UPLOAD_A, "mine.png"), "mine");
    expect(await migrateFromMainline({ dataDir: newDir, settings: access })).toEqual({ kind: "none", reason: "data already here" });
    expect(await readdir(path.join(newDir, "attachments"))).toEqual([UPLOAD_A]);
  });

  it("throws half a copy away and copies again; finishes a complete copy that was not yet in place", async () => {
    await oldInstall();
    const staging = path.join(newDir, MIGRATION_STAGING);
    // A start stopped in the middle of copying: no plan yet, and what it copied may be cut short.
    await put(path.join(staging, "state.json"), '{"version":2,"rev":1,"conver');
    const outcome = await migrateFromMainline({ dataDir: newDir, settings: settingsAccess().access, now: () => NOW });
    expect(outcome.kind).toBe("migrated");
    await same("state.json");
    expect(await stat(staging).catch(() => undefined)).toBeUndefined();

    // A start stopped after the copy was complete and part of it was in place.
    await rm(newDir, { recursive: true });
    await put(path.join(staging, "refs.json"), '{"version":1,"rev":9,"refs":{},"threads":{},"crawl":{"done":false,"listed":0},"github":{}}');
    await put(path.join(staging, "ready.json"), JSON.stringify({ version: 1, at: NOW, files: ["state.json", "refs.json"], context: 0, attachments: { folders: 0, owners: false } }));
    await put(path.join(newDir, "state.json"), stateWith("Moved before the stop"));
    const resumed = await migrateFromMainline({ dataDir: newDir, settings: settingsAccess().access });
    expect(resumed).toMatchObject({ kind: "migrated", record: { files: ["state.json", "refs.json"], context: 0 } });
    expect((await readState(storePaths(newDir))).conversations.t1?.title).toBe("Moved before the stop");
    expect(JSON.parse(await readFile(path.join(newDir, "refs.json"), "utf8")).rev).toBe(9);
    expect(await readdir(newDir)).not.toContain(MIGRATION_STAGING);
  });

  it("leaves no half copy behind when a file cannot be read, and copies it all at the next start", async () => {
    await oldInstall();
    await chmod(path.join(oldDir, "refs.json"), 0o000);
    await expect(migrateFromMainline({ dataDir: newDir, settings: settingsAccess().access })).rejects.toMatchObject({ code: "EACCES" });
    expect(await readdir(newDir).catch(() => [])).toEqual([]);
    await chmod(path.join(oldDir, "refs.json"), 0o600);
    expect((await migrateFromMainline({ dataDir: newDir, settings: settingsAccess().access })).kind).toBe("migrated");
    await same("refs.json");
  });

  it("copies attachments over the plain-copy cap only where the file system clones them", async () => {
    await oldInstall();
    const before = await fingerprint(oldDir);
    // Over the cap: cloned (APFS, Btrfs, XFS) or left in the old folder, never copied the slow way.
    const outcome = await migrateFromMainline({ dataDir: newDir, settings: settingsAccess().access, plainCopyMaxBytes: 0 });
    expect(outcome.kind).toBe("migrated");
    const { attachments } = (outcome as { record: MigrationRecord }).record;
    if (attachments.folders) {
      expect(attachments).toEqual({ folders: 2, owners: true });
      await same(path.join("attachments", UPLOAD_A, "screen.png"));
    } else {
      expect(attachments).toEqual({ folders: 0, owners: false, left: 2 });
      expect(await readdir(newDir)).not.toContain("attachments");
    }
    await same("state.json");
    expect(await fingerprint(oldDir)).toEqual(before);
  });

  it("leaves attachments it cannot copy in the old folder, where their child conversations read them", async () => {
    await oldInstall();
    await chmod(path.join(oldDir, "attachments", UPLOAD_B, "notes.txt"), 0o000);
    const outcome = await migrateFromMainline({ dataDir: newDir, settings: settingsAccess().access });
    expect(outcome).toMatchObject({ kind: "migrated", record: { attachments: { folders: 0, owners: false, left: 2 }, context: 2 } });
    await same("state.json");
    expect(await readdir(newDir)).not.toContain("attachments");
  });
});

describe("carrying the settings over", () => {
  it("leaves settings already changed under the new name alone", async () => {
    await oldInstall();
    // codexhost writes settings.json at the first change, with a revision.
    await put(path.join(newDir, "settings.json"), JSON.stringify({ settingsRevision: 2, values: { summarizeOthers: "claude" } }));
    const { access, written } = settingsAccess({ ...DEFAULT_SETTINGS, summarizeOthers: "claude" });
    expect(await migrateFromMainline({ dataDir: newDir, settings: access })).toMatchObject({ kind: "migrated", record: { settings: "kept" } });
    expect(written).toEqual([]);
    // Also when codexhost answers with values of its own, whatever the file says.
    await rm(newDir, { recursive: true });
    const changed = settingsAccess({ ...DEFAULT_SETTINGS, autoSummarize: false });
    expect(await migrateFromMainline({ dataDir: newDir, settings: changed.access })).toMatchObject({ record: { settings: "kept" } });
    expect(changed.written).toEqual([]);
  });

  it("ignores damaged old settings and copies the data all the same", async () => {
    await oldInstall("{ not json");
    const { access, written } = settingsAccess();
    expect(await migrateFromMainline({ dataDir: newDir, settings: access })).toMatchObject({ kind: "migrated", record: { settings: "unreadable", files: expect.arrayContaining(["state.json"]) } });
    expect(written).toEqual([]);
    await same("state.json");
  });

  it("writes nothing when the old settings are the defaults, and says when writing failed", async () => {
    await oldInstall({ settingsRevision: 1, values: { showCapsule: false } });
    const { access, written } = settingsAccess();
    expect(await migrateFromMainline({ dataDir: newDir, settings: access })).toMatchObject({ record: { settings: "same" } });
    expect(written).toEqual([]);
    await rm(newDir, { recursive: true });
    await oldInstall({ settingsRevision: 1, values: { driftPolicy: "note" } });
    const refused: SettingsAccess = { read: async () => ({ ...DEFAULT_SETTINGS }), write: async () => Promise.reject(new Error("Extension settings changed; refresh and try again")) };
    expect(await migrateFromMainline({ dataDir: newDir, settings: refused })).toMatchObject({ kind: "migrated", record: { settings: "failed" } });
  });
});

describe("the backend after the copy", () => {
  it("serves the copied data, logs one line without paths, and says in the settings tab that the old folder can go", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    await oldInstall();
    const extensionDir = path.join(root, "extension");
    await put(path.join(extensionDir, "bin", "mainline.mjs"), "// cli\n");
    const handlers = new Map<string, (params: unknown) => unknown>();
    const { access, written } = settingsAccess();
    const dispose = await activate(
      {
        extensionId: "second-brain",
        extensionDir,
        dataDir: newDir,
        readSettings: access.read,
        writeSettings: async (values) => {
          await access.write(values);
          return values;
        },
        handle: (method, handler) => handlers.set(method, handler),
      },
      { runGh: async () => Promise.reject(new Error("no gh in tests")), runModel: async () => Promise.reject(new Error("no model in tests")) },
    );
    try {
      const snapshot = async () => (await handlers.get("snapshot")!({})) as SnapshotResultV2;
      const first = await snapshot();
      expect(first.state?.conversations.t1?.title).toBe("Fix the login page");
      expect(first.migration).toEqual({ oldFolder: `${oldDir}${path.sep}` });
      expect(written).toEqual([{ showCapsule: true, prAlerts: false }]);
      // Once the old folder is gone, the note goes too (it is looked at every half minute).
      await rm(oldDir, { recursive: true, force: true });
      vi.setSystemTime(NOW + 31_000);
      const later = await snapshot();
      expect(later.migration).toBeUndefined();
      expect(later.version).not.toBe(first.version);
    } finally {
      await dispose();
    }
    const log = await readFile(path.join(newDir, "backend.log"), "utf8");
    const lines = log.split("\n").filter((line) => line.includes("earlier Mainline extension"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(
      "copied the data of the earlier Mainline extension: state.json, refs.json, favorites.json, summary-counts.json, github-poll.json, backfill-tried.json, 2 context records, 2 attachment folders with their owners, settings carried; the old folder was left as it was",
    );
    // Names and counts only: no path.
    expect(lines[0]).not.toMatch(/[\\/]/u);
  });
});
