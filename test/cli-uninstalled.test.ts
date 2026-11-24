/**
 * Release audit, finding 2(b): the command lives in the extension's data folder, which codexhost
 * keeps after the extension is uninstalled or turned off, and the agent integration may still run
 * it. `hook` and `show` then say nothing and write nothing; everything else works as before.
 * codexhost's layout: `<root>/host-extensions/<id>/` for each installed extension and
 * `<root>/host-extensions/enabled.json` (`{ revision, enabled: [ids] }`) for the enabled ones.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extensionOff, run } from "../src/cli/main.js";

let root: string;
let dataDir: string;
let extensions: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "mainline-uninstalled-"));
  dataDir = path.join(root, "host-extension-data", "second-brain");
  extensions = path.join(root, "host-extensions");
  await mkdir(path.join(dataDir, "bin"), { recursive: true });
  await mkdir(path.join(extensions, "second-brain", "0d6b2f6e-1111-4222-8333-444455556666"), { recursive: true });
  await writeFile(path.join(extensions, "second-brain", "active.json"), "{}");
  await writeFile(path.join(extensions, "enabled.json"), JSON.stringify({ revision: 3, enabled: ["sidebar-thread-tree", "second-brain"] }));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** The installed command, run as the agent integration runs it. */
async function mainline(argv: string[], stdin = "") {
  let out = "";
  let err = "";
  const code = await run(argv, {
    env: { CODEXHOST_THREAD_ID: "t1", LANG: "en_US.UTF-8" },
    stdout: (text) => void (out += text),
    stderr: (text) => void (err += text),
    readStdin: async () => stdin,
    scriptPath: path.join(dataDir, "bin", "mainline.mjs"),
  });
  return { code, out, err };
}

const hook = () => mainline(["hook", "claude-prompt"], JSON.stringify({ prompt: "fix the sidebar", session_id: "s1" }));

describe("the installed command", () => {
  it("serves the hook and show while the extension is installed and enabled", async () => {
    expect(await extensionOff(dataDir)).toBe(false);
    expect((await mainline(["new", "Fix the sidebar"])).code).toBe(0);
    expect((await hook()).out).toContain("hookSpecificOutput");
    expect((await mainline(["show", "--full"])).out).toContain("Fix the sidebar");
  });

  for (const [what, change] of [
    ["turned off", () => writeFile(path.join(extensions, "enabled.json"), JSON.stringify({ revision: 4, enabled: ["sidebar-thread-tree"] }))],
    ["uninstalled", () => rm(path.join(extensions, "second-brain"), { recursive: true, force: true })],
  ] as const)
    it(`says nothing and writes nothing from hook and show once the extension is ${what}`, async () => {
      expect((await mainline(["new", "Fix the sidebar"])).code).toBe(0);
      const before = (await readdir(dataDir, { recursive: true })).sort();
      const state = await readFile(path.join(dataDir, "state.json"), "utf8");
      await change();
      expect(await extensionOff(dataDir)).toBe(true);
      for (const result of [await hook(), await mainline(["show"]), await mainline(["show", "--full", "--json"])]) expect(result).toEqual({ code: 0, out: "", err: "" });
      // Nothing recorded: no last request, no record of what the agent saw.
      expect((await readdir(dataDir, { recursive: true })).sort()).toEqual(before);
      expect(await readFile(path.join(dataDir, "state.json"), "utf8")).toBe(state);
      // Everything else still works: the data is the user's.
      expect((await mainline(["list"])).out).toContain("Fix the sidebar");
    });

  it("counts what it cannot read or does not know as installed and enabled", async () => {
    await writeFile(path.join(extensions, "enabled.json"), "{ damaged");
    expect(await extensionOff(dataDir)).toBe(false);
    await writeFile(path.join(extensions, "enabled.json"), JSON.stringify({ version: 9, extensions: {} }));
    expect(await extensionOff(dataDir)).toBe(false);
    await rm(path.join(extensions, "enabled.json"));
    expect(await extensionOff(dataDir)).toBe(false);
    // No list of installed extensions at all: a layout this command does not know.
    await rm(extensions, { recursive: true, force: true });
    expect(await extensionOff(dataDir)).toBe(false);
    expect((await hook()).code).toBe(0);
    // A data folder of its own (MAINLINE_DATA_DIR, --data-dir) is never codexhost's to switch off.
    expect(await extensionOff(path.join(root, "elsewhere"))).toBe(false);
  });
});
