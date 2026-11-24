/**
 * Correctness audit, finding 6: `mainline spawn <id>` opened a second child for a spin-off whose
 * child was open already, and pointed the spin-off at it. It now answers with the open child, as
 * the backend does.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { run } from "../src/cli/main.js";
import { readState, storePaths } from "../src/node/store.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "mainline-cli-spawn-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

it("answers with the child already open instead of starting another", async () => {
  const started: string[] = [];
  const delegation = {
    readThread: async () => ({ harnessId: "claude-code" }),
    threadCwd: async () => "/work",
    startDelegation: async () => {
      started.push(`child-${started.length + 1}`);
      return { threadId: started.at(-1)! };
    },
  };
  let out = "";
  const io = {
    env: { MAINLINE_DATA_DIR: dir, CODEXHOST_THREAD_ID: "p", LANG: "en_US.UTF-8" },
    stdout: (text: string) => void (out += text),
    stderr: () => undefined,
    delegation,
  };
  const mainline = async (...argv: string[]) => {
    out = "";
    return { code: await run(argv, io), out };
  };
  await mainline("new", "Fix the sidebar");
  const noted = await mainline("spinoff", "drawer border on phones");
  const id = /id (\S+?)\)/u.exec(noted.out)?.[1] ?? "";
  const first = await mainline("spawn", id);
  expect(first.out).toContain("(child-1)");
  // An agent's retry, or the card opened it meanwhile: the same child, and the same words.
  const second = await mainline("spawn", id);
  expect(second.code).toBe(0);
  expect(second.out).toBe(first.out);
  expect(started).toEqual(["child-1"]);
  const json = await mainline("spawn", id, "--json");
  expect(JSON.parse(json.out)).toEqual({ ok: true, childThreadId: "child-1" });
  expect((await readState(storePaths(dir))).conversations.p!.spinoffs[0]).toMatchObject({ state: "spawned", childThreadId: "child-1" });
});
