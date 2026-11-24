/**
 * The agent integrations never mistake an unreadable file for a missing one, keep few private
 * backups, and offer the shorter Codex section to those who have the old one.
 */
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CODEX_END, CODEX_START, Integrations } from "../src/backend/integrations.js";

const COMMAND = "/Users/someone/.codexhost/host-extension-data/second-brain/bin/mainline";
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-24T08:00:00Z");

let root: string;
let home: string;
let data: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "mainline-integrations-"));
  home = path.join(root, "home");
  data = path.join(root, "data");
  await mkdir(path.join(home, ".claude"), { recursive: true });
  await mkdir(path.join(home, ".codex"), { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const stampOf = (at: number) => new Date(at).toISOString().replace(/[:.]/gu, "-");

describe("files that cannot be read", () => {
  it("are unavailable, not missing, and nothing is installed over them", async () => {
    // A folder where the file should be cannot be read as one.
    await mkdir(path.join(home, ".claude", "settings.json"));
    await mkdir(path.join(home, ".codex", "AGENTS.md"));
    const integrations = new Integrations({ home, dataDir: data, command: COMMAND });
    for (const agent of ["claude", "codex"] as const) {
      const status = await integrations.statusOf(agent);
      expect(status.state).toBe("unavailable");
      expect(status.detail).toContain("cannot be read (EISDIR)");
      expect(status).toMatchObject({ problem: "FILE_UNREADABLE", cause: "EISDIR" });
      expect(await integrations.preview(agent)).toMatchObject({ action: "none", problem: "FILE_UNREADABLE", cause: "EISDIR" });
      await expect(integrations.install(agent)).rejects.toMatchObject({ code: "UNAVAILABLE", message: expect.stringContaining("cannot be read (EISDIR)") });
      await expect(integrations.uninstall(agent)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    }
    expect((await stat(path.join(home, ".claude", "settings.json"))).isDirectory()).toBe(true);
  });

  it("reads a configuration folder that is a file as unavailable", async () => {
    await rm(path.join(home, ".claude"), { recursive: true });
    await writeFile(path.join(home, ".claude"), "not a folder");
    const status = await new Integrations({ home, dataDir: data, command: COMMAND }).statusOf("claude");
    expect(status).toMatchObject({ state: "unavailable", detail: "~/.claude is not a folder" });
  });
});

describe("backups", () => {
  it("are private, at most three per file, and none older than 30 days", async () => {
    const settings = path.join(home, ".claude", "settings.json");
    await writeFile(settings, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "secret" } }, null, 2), { mode: 0o644 });
    const backups = path.join(data, "backups");
    await mkdir(backups, { recursive: true });
    // Left by an earlier version: a recent copy readable by others, and one from long ago.
    const recent = `claude-settings.json.${stampOf(NOW - DAY)}.bak`;
    const ancient = `codex-AGENTS.md.${stampOf(NOW - 40 * DAY)}.bak`;
    await writeFile(path.join(backups, recent), "{}", { mode: 0o644 });
    await chmod(path.join(backups, recent), 0o644);
    await writeFile(path.join(backups, ancient), "old", { mode: 0o644 });
    let now = NOW;
    const integrations = new Integrations({ home, dataDir: data, command: COMMAND, now: () => now });
    await integrations.install("claude");
    let entries = (await readdir(backups)).sort();
    expect(entries).toEqual([recent, `claude-settings.json.${stampOf(NOW)}.bak`]);
    for (const entry of entries) expect((await stat(path.join(backups, entry))).mode & 0o777).toBe(0o600);
    expect(await readFile(path.join(backups, entries[1]!), "utf8")).toContain("secret");
    for (let step = 1; step <= 4; step += 1) {
      now = NOW + step * 1000;
      await (step % 2 ? integrations.uninstall("claude") : integrations.install("claude"));
    }
    entries = (await readdir(backups)).sort();
    expect(entries).toHaveLength(3);
    expect(entries.at(-1)).toBe(`claude-settings.json.${stampOf(NOW + 4000)}.bak`);
    // A month and more later, the next backup clears the old ones out.
    now = NOW + 31 * DAY;
    await integrations.install("claude");
    expect(await readdir(backups)).toEqual([`claude-settings.json.${stampOf(now)}.bak`]);
  });
});

describe("the Codex section", () => {
  const oldBlock = [
    CODEX_START,
    "## Mainline (codexhost)",
    "",
    "In a codexhost session (when the CODEXHOST_THREAD_ID or CODEX_THREAD_ID environment variable is set), run this before acting on each user message:",
    "",
    `    ${COMMAND} show`,
    "",
    "It prints this conversation's mainline (title, tags, milestones and the current milestone's tasks) and how to keep it current. Follow those rules: keep the title and tags specific, record work with the `doing` and `done` subcommands of the same command, and use `reach` when a milestone is achieved. Ignore this section outside codexhost sessions. This section is managed by the codexhost Mainline extension; remove it from the extension's overview page.",
    CODEX_END,
  ].join("\n");

  it("is one short sentence: run show once, at the first message", () => {
    const block = new Integrations({ home, dataDir: data, command: COMMAND }).codexBlock();
    expect(block.length).toBeLessThan(350);
    expect(block).toContain(`\`${COMMAND} show\` once`);
    expect(block).toContain("first message");
    for (const stale of ["reach", "title and tags", "each user message", "CODEX_THREAD_ID"]) expect(block).not.toContain(stale);
  });

  it("shows an installed old section as outdated and replaces it with consent", async () => {
    const file = path.join(home, ".codex", "AGENTS.md");
    await writeFile(file, `# My rules\n\n- be brief\n\n${oldBlock}\n`);
    const integrations = new Integrations({ home, dataDir: data, command: COMMAND });
    expect((await integrations.statusOf("codex")).state).toBe("outdated");
    const preview = await integrations.preview("codex");
    expect(preview.action).toBe("replace");
    expect(preview.snippet).toBe(integrations.codexBlock());
    // Nothing changes until the change is applied.
    expect(await readFile(file, "utf8")).toContain("each user message");
    await integrations.install("codex");
    const text = await readFile(file, "utf8");
    expect(text).toBe(`# My rules\n\n- be brief\n\n${integrations.codexBlock()}\n`);
    expect((await integrations.statusOf("codex")).state).toBe("installed");
  });
});

describe("an install from before the rename to Second Brain", () => {
  /** Where Mainline 0.9 put the command: the data folder of its id, `mainline`. */
  const OLD_COMMAND = "/Users/someone/.codexhost/host-extension-data/mainline/bin/mainline";
  /** Exactly what 0.9 wrote. */
  const oldHook = { hooks: [{ type: "command", command: `${OLD_COMMAND} hook claude-prompt 2>/dev/null || true`, timeout: 5 }] };
  const oldSection = [
    CODEX_START,
    "## Mainline (codexhost)",
    "",
    `At the first message of a conversation, run \`${OLD_COMMAND} show\` once and follow what it prints (outside codexhost it prints nothing). Managed by the codexhost Mainline extension.`,
    CODEX_END,
  ].join("\n");
  const otherHook = { hooks: [{ type: "command", command: "node ~/.config/acme-hooks/check-style.mjs" }] };

  it("shows its hook and its section as needing an update, and one update replaces each", async () => {
    const settings = path.join(home, ".claude", "settings.json");
    const agents = path.join(home, ".codex", "AGENTS.md");
    await writeFile(settings, `${JSON.stringify({ env: { A: "1" }, hooks: { UserPromptSubmit: [otherHook, oldHook] } }, null, 2)}\n`);
    await writeFile(agents, `# My rules\n\n- be brief\n\n${oldSection}\n`);
    const integrations = new Integrations({ home, dataDir: data, command: COMMAND });
    expect(COMMAND).toContain("/second-brain/bin/mainline");

    // Recognised as this extension's own (the command keeps its name; the section its marks), not as someone else's.
    expect((await integrations.status()).map(({ agent, state }) => [agent, state])).toEqual([
      ["claude", "outdated"],
      ["codex", "outdated"],
    ]);
    expect(await integrations.preview("claude")).toMatchObject({ action: "replace" });
    expect(await integrations.preview("codex")).toMatchObject({ action: "replace", snippet: integrations.codexBlock() });

    await integrations.install("claude");
    await integrations.install("codex");
    const installed = JSON.parse(await readFile(settings, "utf8")) as { env: unknown; hooks: { UserPromptSubmit: unknown[] } };
    expect(installed.env).toEqual({ A: "1" });
    expect(installed.hooks.UserPromptSubmit).toEqual([otherHook, integrations.hookEntry()]);
    expect(JSON.stringify(installed)).not.toContain("/mainline/bin/mainline");
    const text = await readFile(agents, "utf8");
    expect(text).toBe(`# My rules\n\n- be brief\n\n${integrations.codexBlock()}\n`);
    expect(text).toContain("## Second Brain (codexhost)");
    expect(text).toContain("Managed by the codexhost Second Brain extension.");
    expect(text).not.toContain("/mainline/bin/mainline");
    expect((await integrations.status()).map(({ state }) => state)).toEqual(["installed", "installed"]);
  });
});
