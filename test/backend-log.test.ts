/**
 * Release audit, finding 10: the start line said nothing of the version, Node or platform, and log
 * lines carried the home folder with the user's name. Now the start says which version runs on
 * what, and every line has `~` for the home folder and no user name.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activate } from "../src/backend/index.js";
import { createLog, logSafe } from "../src/backend/log.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "mainline-log-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("log lines", () => {
  it("write the home folder as ~ and never the user's name", async () => {
    const safe = logSafe("/Users/someone", "someone");
    expect(safe("backend started; command at /Users/someone/.codexhost/host-extension-data/second-brain/bin/mainline")).toBe(
      "backend started; command at ~/.codexhost/host-extension-data/second-brain/bin/mainline",
    );
    expect(safe("EACCES: open '/Volumes/Data/someone/work/x.json'")).toBe("EACCES: open '/Volumes/Data/<user>/work/x.json'");
    expect(logSafe("C:\\Users\\someone", "someone")("could not start C:\\Users\\someone\\AppData\\Roaming\\npm\\claude.cmd")).toBe(
      "could not start ~\\AppData\\Roaming\\npm\\claude.cmd",
    );
    // A user name of a common word, too short to tell from one, is left alone.
    expect(logSafe("/home/al", "al")("/opt/al/bin and /home/al/x")).toBe("/opt/al/bin and ~/x");

    const dir = path.join(root, "data");
    const log = createLog(dir, { home: root, user: "someone" });
    log.info(`command at ${root}/bin/mainline`);
    log.error("read settings", new Error(`ENOENT: no such file or directory, open '/Users/someone/x'`));
    await log.flush();
    const text = await readFile(path.join(dir, "backend.log"), "utf8");
    expect(text).toContain("command at ~/bin/mainline");
    expect(text).toContain("ERROR read settings: ENOENT: no such file or directory, open '/Users/<user>/x'");
    expect(text).not.toContain(root);
    expect(text).not.toContain("someone");
  });

  it("start with the extension's version, Node's and the platform", async () => {
    const dataDir = path.join(root, "host-extension-data", "second-brain");
    const extensionDir = path.join(root, "extension");
    await mkdir(path.join(extensionDir, "bin"), { recursive: true });
    await writeFile(path.join(extensionDir, "bin", "mainline.mjs"), "// cli\n");
    const dispose = await activate(
      { extensionId: "second-brain", extensionDir, dataDir, readSettings: async () => ({}), writeSettings: async (values) => values, handle: () => undefined },
      { runGh: async () => Promise.reject(new Error("no gh in tests")), runModel: async () => Promise.reject(new Error("no model in tests")) },
    );
    await dispose();
    const text = await readFile(path.join(dataDir, "backend.log"), "utf8");
    expect(text).toContain(`backend starting: second-brain dev, Node ${process.version}, ${process.platform} ${process.arch}`);
    expect(text).toContain("backend started; command at");
    expect(text).not.toContain(os.homedir());
  });
});
