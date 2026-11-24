/** Machine-written files are compact JSON, and their size caps apply to the compact text. */
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addFavorite } from "../src/core/favorites.js";
import { createConversation } from "../src/core/conversation-ops.js";
import { ownersPaths, updateOwners } from "../src/node/attachment-owners.js";
import { favoritesPaths, updateFavorites } from "../src/node/favorites-store.js";
import { refsPaths, updateIndex } from "../src/node/refs-store.js";
import { storePaths, updateState, writeJsonFile } from "../src/node/store.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "mainline-compact-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** One line of JSON and a final newline: no indentation anywhere. */
const expectCompact = (text: string) => {
  expect(text.endsWith("}\n")).toBe(true);
  expect(text.slice(0, -1)).not.toContain("\n");
  expect(text).not.toMatch(/[{[,]\s/u);
};

describe("compact JSON", () => {
  it("writes the state without indentation", async () => {
    const paths = storePaths(dir);
    await updateState(paths, (draft, ctx) => createConversation(draft, "t1", { title: "整理发布流程", tags: "a,b", milestones: ["合并", "发布"] }, ctx));
    const text = await readFile(paths.state, "utf8");
    expectCompact(text);
    expect(JSON.parse(text)).toMatchObject({ version: 2, conversations: { t1: { title: "整理发布流程" } } });
  });

  it("writes the link index, the favorites and the attachment owners compact too", async () => {
    await updateIndex(refsPaths(dir), (index) => {
      index.threads.t1 = { turns: 1, updatedAt: "2026-11-24T08:00:00Z", scannedAt: 1, title: "x" };
    });
    expectCompact(await readFile(refsPaths(dir).file, "utf8"));
    await updateFavorites(favoritesPaths(dir), (file) => addFavorite(file, { threadId: "t1", text: "先打 tag，再跑 release 脚本。", source: "chat" }, 1));
    expectCompact(await readFile(favoritesPaths(dir).file, "utf8"));
    const attachments = path.join(dir, "attachments");
    await mkdir(attachments);
    await updateOwners(ownersPaths(attachments), (owners) => {
      owners["0123abcd-0000-4000-8000-0123456789ab"] = { child: "c1", parent: "p1", at: 1 };
    });
    const owners = await readFile(ownersPaths(attachments).file, "utf8");
    expectCompact(owners);
  });

  it("checks the size cap against the compact text, and indents only when asked", async () => {
    const value = { items: Array.from({ length: 50 }, (_, index) => ({ id: index, text: "x" })) };
    const compact = Buffer.byteLength(`${JSON.stringify(value)}\n`);
    const file = path.join(dir, "value.json");
    await writeJsonFile(file, value, compact);
    expectCompact(await readFile(file, "utf8"));
    await expect(writeJsonFile(file, value, compact, 2)).rejects.toMatchObject({ code: "FILE_FULL" });
    await writeJsonFile(file, value, 10 * compact, 2);
    expect(await readFile(file, "utf8")).toContain('\n  "items"');
  });
});
