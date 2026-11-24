/**
 * Dotfiles kept in a repository and linked into ~/.claude and ~/.codex stay links: installing and
 * removing the agent integration changes the linked file, never the link.
 */
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CODEX_START, Integrations } from "../src/backend/integrations.js";

const COMMAND = "/data/host-extension-data/second-brain/bin/mainline";

let root: string;
let home: string;
let dotfiles: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "mainline-links-"));
  home = path.join(root, "home");
  dotfiles = path.join(home, "dotfiles");
  await mkdir(dotfiles, { recursive: true });
  await mkdir(path.join(home, ".claude"), { recursive: true });
  await mkdir(path.join(home, ".codex"), { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const integrationsFor = () => new Integrations({ home, dataDir: path.join(root, "data"), command: COMMAND });
const isLink = async (file: string) => (await lstat(file)).isSymbolicLink();

describe("linked configuration files", () => {
  it("stay links through install and uninstall, for Claude Code's settings and Codex's AGENTS.md", async () => {
    const agents = path.join(dotfiles, "AGENTS.md");
    const settings = path.join(dotfiles, "claude-settings.json");
    await writeFile(agents, "# my shared rules\n");
    await writeFile(settings, '{\n  "model": "opus"\n}\n', { mode: 0o640 });
    await symlink(agents, path.join(home, ".codex", "AGENTS.md"));
    // A relative link, as dotfile managers often make them.
    await symlink(path.relative(path.join(home, ".claude"), settings), path.join(home, ".claude", "settings.json"));
    const integrations = integrationsFor();
    await integrations.install("codex");
    await integrations.install("claude");
    expect(await isLink(path.join(home, ".codex", "AGENTS.md"))).toBe(true);
    expect(await isLink(path.join(home, ".claude", "settings.json"))).toBe(true);
    expect(await readFile(agents, "utf8")).toContain(CODEX_START);
    expect(await readFile(agents, "utf8")).toMatch(/^# my shared rules\n/u);
    const installed = JSON.parse(await readFile(settings, "utf8")) as { model: string; hooks: { UserPromptSubmit: unknown[] } };
    expect(installed.model).toBe("opus");
    expect(installed.hooks.UserPromptSubmit).toHaveLength(1);
    expect((await lstat(settings)).mode & 0o777).toBe(0o640);
    expect(await integrations.status()).toMatchObject([{ state: "installed" }, { state: "installed" }]);
    // Nothing is left next to either the link or the linked file.
    expect((await readdir(path.join(home, ".claude"))).sort()).toEqual(["settings.json"]);
    expect((await readdir(dotfiles)).sort()).toEqual(["AGENTS.md", "claude-settings.json"]);

    await integrations.uninstall("codex");
    await integrations.uninstall("claude");
    expect(await isLink(path.join(home, ".codex", "AGENTS.md"))).toBe(true);
    expect(await isLink(path.join(home, ".claude", "settings.json"))).toBe(true);
    expect(await readFile(agents, "utf8")).toBe("# my shared rules\n");
    expect(JSON.parse(await readFile(settings, "utf8"))).toEqual({ model: "opus" });
    expect(await integrations.status()).toMatchObject([{ state: "missing" }, { state: "missing" }]);
    // The backups are of the linked files' text.
    const backups = await readdir(path.join(root, "data", "backups"));
    expect(backups.filter((name) => name.startsWith("codex-AGENTS.md."))).toHaveLength(2);
  });

  it("write through a chain of links, and create the linked file when it does not exist yet", async () => {
    const real = path.join(dotfiles, "codex", "AGENTS.md");
    await mkdir(path.dirname(real), { recursive: true });
    await symlink(real, path.join(dotfiles, "AGENTS.md"));
    await symlink(path.join(dotfiles, "AGENTS.md"), path.join(home, ".codex", "AGENTS.md"));
    const integrations = integrationsFor();
    expect((await integrations.preview("codex")).action).toBe("create");
    await integrations.install("codex");
    expect(await readlink(path.join(home, ".codex", "AGENTS.md"))).toBe(path.join(dotfiles, "AGENTS.md"));
    expect(await isLink(path.join(dotfiles, "AGENTS.md"))).toBe(true);
    expect(await readFile(real, "utf8")).toContain(CODEX_START);
  });

  it("say where the linked file is when it cannot be written, and change nothing", async () => {
    const lockedDir = path.join(dotfiles, "locked");
    const agents = path.join(lockedDir, "AGENTS.md");
    await mkdir(lockedDir);
    await writeFile(agents, "# read only\n");
    await symlink(agents, path.join(home, ".codex", "AGENTS.md"));
    await chmod(lockedDir, 0o500);
    try {
      await expect(integrationsFor().install("codex")).rejects.toThrow(/AGENTS\.md links to .*locked.*AGENTS\.md, which cannot be written/u);
      expect(await isLink(path.join(home, ".codex", "AGENTS.md"))).toBe(true);
      expect(await readFile(agents, "utf8")).toBe("# read only\n");
    } finally {
      await chmod(lockedDir, 0o700);
    }
  });
});
