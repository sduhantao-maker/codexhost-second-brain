/**
 * Installs and removes the agent side of Second Brain: a UserPromptSubmit hook for Claude Code
 * and a marked section in Codex's global AGENTS.md. Only this extension's own hook or section is
 * ever added or removed, and every changed file is backed up into the extension's data folder,
 * readable by the user only (Claude Code's settings can hold credentials).
 */
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { MainlineError } from "../core/model.js";
import type { AgentId, IntegrationPreview, IntegrationProblem, IntegrationStatus } from "../core/rpc.js";
import { shellQuote } from "../node/paths.js";

/**
 * The marks around the section in AGENTS.md. They keep the name the extension had before 0.10
 * (Mainline), so the section an earlier install wrote is found, shown as outdated and replaced.
 */
export const CODEX_START = "<!-- codexhost-mainline:start -->";
export const CODEX_END = "<!-- codexhost-mainline:end -->";
const HOOK_MARK = "hook claude-prompt";
/** Backups kept per file, the newest; any older than the age limit go too. */
const BACKUPS_KEPT = 3;
const BACKUP_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface IntegrationOptions {
  home: string;
  dataDir: string;
  /** Absolute path of the installed `mainline` command. */
  command: string;
  platform?: NodeJS.Platform;
  now?: () => number;
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const errorCode = (error: unknown): string =>
  typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
const reasonOf = (error: unknown): string => errorCode(error) || (error instanceof Error ? error.message : String(error));

/**
 * Why an agent's configuration cannot be changed: in English (`detail`, for the log and older
 * pages), and as a code with the system's error code (`problem`, `cause`) for the overview to say
 * in its language.
 */
type Unavailable = { kind: "unavailable"; detail: string; problem: IntegrationProblem; cause?: string };

const unavailable = (detail: string, problem: IntegrationProblem, cause?: string): Unavailable => ({
  kind: "unavailable",
  detail,
  problem,
  ...(cause ? { cause } : {}),
});

/** Unavailable unless `dir` is a folder that can be looked at. */
async function folderProblem(dir: string, label: string, missing: string): Promise<Unavailable | undefined> {
  try {
    if ((await stat(dir)).isDirectory()) return undefined;
    return unavailable(`${label} is not a folder`, "NOT_A_FOLDER");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return unavailable(missing, "NOT_SET_UP");
    return unavailable(`${label} cannot be read (${reasonOf(error)})`, "FOLDER_UNREADABLE", reasonOf(error));
  }
}

/** What the status and the preview say of an agent whose configuration cannot be changed. */
const problemOf = ({ detail, problem, cause }: Unavailable) => ({ detail, problem, ...(cause ? { cause } : {}) });

/** The text of a file; undefined only when it does not exist. Any other failure is thrown. */
async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

/** When a backup was made, from its name (`<name>.<ISO time with - for : and .>.bak`). */
function backupTime(entry: string): number | undefined {
  const match = /\.(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.bak$/u.exec(entry);
  if (!match) return undefined;
  const at = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
  return Number.isFinite(at) ? at : undefined;
}

/**
 * This extension's hook: it runs `hook claude-prompt` of a `bin/mainline` command. The command keeps
 * its name across the rename to Second Brain, so the hook of an earlier install (in the data folder
 * `…/mainline/bin/mainline`) is recognised too, and shown as outdated.
 */
export function isOwnHook(command: unknown): boolean {
  return typeof command === "string" && command.includes(HOOK_MARK) && /bin[/\\]mainline/u.test(command);
}

/** The indentation a JSON file already uses, so rewriting it keeps its look. */
function indentOf(text: string): string | number {
  return /^([ \t]+)"/mu.exec(text)?.[1] ?? 2;
}

/**
 * The file a path stands for: itself, or, when it is a symbolic link (dotfiles kept in a repository
 * and linked into place), the file at the end of the link, also when that file does not exist yet.
 */
async function linkTarget(file: string): Promise<string> {
  let current = file;
  for (let hops = 0; hops < 40; hops += 1) {
    let info: Stats;
    try {
      info = await lstat(current);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return current;
      throw error;
    }
    if (!info.isSymbolicLink()) return current;
    // A relative link is relative to the real folder it is in.
    current = path.resolve(await realpath(path.dirname(current)), await readlink(current));
  }
  throw new Error(`${path.basename(file)} is a loop of links`);
}

/**
 * Replaces a file atomically, through a symbolic link: the new text goes next to the file the link
 * points to and replaces that file, so the link stays a link. A temporary file next to the link
 * renamed over it would turn the link into a plain file, and the linked copy would stop applying.
 */
async function atomicWrite(file: string, text: string): Promise<void> {
  const target = await linkTarget(file);
  const mode = await stat(target).then((info) => info.mode & 0o777, () => 0o644);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.mainline-${process.pid}.tmp`;
  try {
    await writeFile(temporary, text, { mode });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    if (target === file) throw error;
    throw new Error(`${path.basename(file)} links to ${target}, which cannot be written (${reasonOf(error)}); change it there`);
  }
}

export class Integrations {
  readonly #platform: NodeJS.Platform;
  readonly #now: () => number;

  constructor(private readonly options: IntegrationOptions) {
    this.#platform = options.platform ?? process.platform;
    this.#now = options.now ?? Date.now;
  }

  get claudeFile(): string {
    return path.join(this.options.home, ".claude", "settings.json");
  }

  get codexFile(): string {
    return path.join(this.options.home, ".codex", "AGENTS.md");
  }

  fileOf(agent: AgentId): string {
    return agent === "claude" ? this.claudeFile : this.codexFile;
  }

  /** Never fails the user's message, even if the command is gone. */
  hookCommand(): string {
    return this.#platform === "win32"
      ? `"${this.options.command}" ${HOOK_MARK}`
      : `${shellQuote(this.options.command)} ${HOOK_MARK} 2>/dev/null || true`;
  }

  hookEntry(): Json {
    return { hooks: [{ type: "command", command: this.hookCommand(), timeout: 5 }] };
  }

  /**
   * Codex reads AGENTS.md at the start of every session, so the section stays one sentence: run
   * `show` once and follow it. `show` prints nothing in a Codex session codexhost does not know.
   */
  codexBlock(): string {
    const command = this.#platform === "win32" ? `"${this.options.command}"` : shellQuote(this.options.command);
    return [
      CODEX_START,
      "## Second Brain (codexhost)",
      "",
      `At the first message of a conversation, run \`${command} show\` once and follow what it prints (outside codexhost it prints nothing). Managed by the codexhost Second Brain extension.`,
      CODEX_END,
    ].join("\n");
  }

  // ---------------------------------------------------------------------------------------------
  // Claude Code

  async #readClaude(): Promise<Unavailable | { kind: "ok"; json: Json; text: string | undefined }> {
    const folder = await folderProblem(path.dirname(this.claudeFile), "~/.claude", "Claude Code is not set up (~/.claude is missing)");
    if (folder) return folder;
    let text: string | undefined;
    try {
      text = await readIfExists(this.claudeFile);
    } catch (error) {
      // Only a missing file may be created from scratch: anything else could lose the user's settings.
      return unavailable(`settings.json cannot be read (${reasonOf(error)}); fix it first`, "FILE_UNREADABLE", reasonOf(error));
    }
    if (text === undefined) return { kind: "ok", json: {}, text: undefined };
    try {
      const json = JSON.parse(text) as unknown;
      if (!isRecord(json)) return unavailable("settings.json is not a JSON object; fix it first", "NOT_AN_OBJECT");
      return { kind: "ok", json, text };
    } catch {
      return unavailable("settings.json is not valid JSON; fix it first", "NOT_JSON");
    }
  }

  #ownCommands(json: Json): string[] {
    const groups = isRecord(json.hooks) ? json.hooks.UserPromptSubmit : undefined;
    if (!Array.isArray(groups)) return [];
    return groups.flatMap((group) =>
      isRecord(group) && Array.isArray(group.hooks)
        ? group.hooks.flatMap((hook) => (isRecord(hook) && isOwnHook(hook.command) ? [hook.command as string] : []))
        : [],
    );
  }

  /** A copy of `json` without this extension's hook, dropping groups and keys left empty. */
  #withoutHook(json: Json): Json {
    const copy = structuredClone(json);
    if (!isRecord(copy.hooks) || !Array.isArray(copy.hooks.UserPromptSubmit)) return copy;
    const groups = copy.hooks.UserPromptSubmit.flatMap((group: unknown) => {
      if (!isRecord(group) || !Array.isArray(group.hooks)) return [group];
      const kept = group.hooks.filter((hook: unknown) => !(isRecord(hook) && isOwnHook(hook.command)));
      if (kept.length === group.hooks.length) return [group];
      return kept.length ? [{ ...group, hooks: kept }] : [];
    });
    if (groups.length) copy.hooks.UserPromptSubmit = groups;
    else delete copy.hooks.UserPromptSubmit;
    if (!Object.keys(copy.hooks).length) delete copy.hooks;
    return copy;
  }

  async #claudeStatus(): Promise<IntegrationStatus> {
    const file = this.claudeFile;
    const read = await this.#readClaude();
    if (read.kind === "unavailable") return { agent: "claude", file, state: "unavailable", ...problemOf(read) };
    const own = this.#ownCommands(read.json);
    if (!own.length) return { agent: "claude", file, state: "missing" };
    return {
      agent: "claude",
      file,
      state: own.length === 1 && own[0] === this.hookCommand() ? "installed" : "outdated",
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Codex

  async #readCodex(): Promise<Unavailable | { kind: "ok"; text: string | undefined }> {
    const folder = await folderProblem(path.dirname(this.codexFile), "~/.codex", "Codex is not set up (~/.codex is missing)");
    if (folder) return folder;
    try {
      return { kind: "ok", text: await readIfExists(this.codexFile) };
    } catch (error) {
      return unavailable(`AGENTS.md cannot be read (${reasonOf(error)}); fix it first`, "FILE_UNREADABLE", reasonOf(error));
    }
  }

  #findBlock(text: string): { start: number; end: number } | undefined {
    const start = text.indexOf(CODEX_START);
    if (start < 0) return undefined;
    const close = text.indexOf(CODEX_END, start);
    return close < 0 ? undefined : { start, end: close + CODEX_END.length };
  }

  #withoutBlock(text: string): string {
    const block = this.#findBlock(text);
    if (!block) return text;
    const before = text.slice(0, block.start).replace(/\n*$/u, "");
    const after = text.slice(block.end).replace(/^\n*/u, "");
    return before && after ? `${before}\n\n${after}` : `${before}${after}`.replace(/^\n+/u, "");
  }

  #withBlock(text: string | undefined): string {
    const base = this.#withoutBlock(text ?? "").replace(/\s*$/u, "");
    return base ? `${base}\n\n${this.codexBlock()}\n` : `${this.codexBlock()}\n`;
  }

  async #codexStatus(): Promise<IntegrationStatus> {
    const file = this.codexFile;
    const read = await this.#readCodex();
    if (read.kind === "unavailable") return { agent: "codex", file, state: "unavailable", ...problemOf(read) };
    const block = read.text === undefined ? undefined : this.#findBlock(read.text);
    if (!block || read.text === undefined) return { agent: "codex", file, state: "missing" };
    const current = read.text.slice(block.start, block.end);
    return { agent: "codex", file, state: current === this.codexBlock() ? "installed" : "outdated" };
  }

  // ---------------------------------------------------------------------------------------------

  async status(): Promise<IntegrationStatus[]> {
    return Promise.all([this.#claudeStatus(), this.#codexStatus()]);
  }

  async statusOf(agent: AgentId): Promise<IntegrationStatus> {
    return agent === "claude" ? this.#claudeStatus() : this.#codexStatus();
  }

  async preview(agent: AgentId, removing = false): Promise<IntegrationPreview> {
    const file = this.fileOf(agent);
    const status = await this.statusOf(agent);
    if (status.state === "unavailable")
      return {
        agent,
        file,
        action: "none",
        snippet: status.detail ?? "",
        ...(status.problem ? { problem: status.problem } : {}),
        ...(status.cause ? { cause: status.cause } : {}),
      };
    if (agent === "claude") {
      const snippet = JSON.stringify({ hooks: { UserPromptSubmit: [this.hookEntry()] } }, null, 2);
      if (removing) return { agent, file, action: status.state === "missing" ? "none" : "remove", snippet };
      const read = await this.#readClaude();
      const action = read.kind === "ok" && read.text === undefined ? "create" : status.state === "missing" ? "add" : "replace";
      return { agent, file, action, snippet };
    }
    const snippet = this.codexBlock();
    if (removing) return { agent, file, action: status.state === "missing" ? "none" : "remove", snippet };
    const read = await this.#readCodex();
    const action = read.kind === "ok" && read.text === undefined ? "create" : status.state === "missing" ? "add" : "replace";
    return { agent, file, action, snippet };
  }

  /**
   * Copies `file` into `<data dir>/backups/`, readable by the user only, then keeps the newest
   * three copies of it and drops every backup older than 30 days.
   */
  async #backup(file: string): Promise<void> {
    const content = await readFile(file).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    });
    if (content === undefined) return;
    const dir = path.join(this.options.dataDir, "backups");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const name = path.basename(path.dirname(file)).replace(/^\./u, "") + "-" + path.basename(file);
    const now = this.#now();
    const target = path.join(dir, `${name}.${new Date(now).toISOString().replace(/[:.]/gu, "-")}.bak`);
    await writeFile(target, content, { mode: 0o600 });
    // writeFile keeps the mode of a file that was there already.
    await chmod(target, 0o600);
    await this.#pruneBackups(dir, name, now);
  }

  async #pruneBackups(dir: string, name: string, now: number): Promise<void> {
    const entries = (await readdir(dir)).filter((entry) => entry.endsWith(".bak")).sort();
    const own = entries.filter((entry) => entry.startsWith(`${name}.`));
    const drop = new Set(own.slice(0, Math.max(0, own.length - BACKUPS_KEPT)));
    for (const entry of entries) {
      const at = backupTime(entry) ?? (await stat(path.join(dir, entry)).then((info) => info.mtimeMs, () => now));
      if (now - at > BACKUP_MAX_AGE_MS) drop.add(entry);
    }
    for (const entry of entries) {
      const target = path.join(dir, entry);
      if (drop.has(entry)) await rm(target, { force: true });
      // Copies made by earlier versions kept the original's mode, often readable by others.
      else await chmod(target, 0o600).catch(() => undefined);
    }
  }

  async install(agent: AgentId): Promise<IntegrationStatus> {
    if (agent === "claude") {
      const read = await this.#readClaude();
      if (read.kind === "unavailable") throw new MainlineError("UNAVAILABLE", read.detail);
      const json = this.#withoutHook(read.json);
      const hooks = isRecord(json.hooks) ? json.hooks : (json.hooks = {});
      const groups = Array.isArray(hooks.UserPromptSubmit) ? hooks.UserPromptSubmit : (hooks.UserPromptSubmit = []);
      groups.push(this.hookEntry());
      await this.#backup(this.claudeFile);
      await atomicWrite(this.claudeFile, `${JSON.stringify(json, null, indentOf(read.text ?? ""))}\n`);
    } else {
      const read = await this.#readCodex();
      if (read.kind === "unavailable") throw new MainlineError("UNAVAILABLE", read.detail);
      await this.#backup(this.codexFile);
      await atomicWrite(this.codexFile, this.#withBlock(read.text));
    }
    return this.statusOf(agent);
  }

  async uninstall(agent: AgentId): Promise<IntegrationStatus> {
    if (agent === "claude") {
      const read = await this.#readClaude();
      if (read.kind === "unavailable") throw new MainlineError("UNAVAILABLE", read.detail);
      if (read.text !== undefined && this.#ownCommands(read.json).length) {
        await this.#backup(this.claudeFile);
        await atomicWrite(this.claudeFile, `${JSON.stringify(this.#withoutHook(read.json), null, indentOf(read.text))}\n`);
      }
    } else {
      const read = await this.#readCodex();
      if (read.kind === "unavailable") throw new MainlineError("UNAVAILABLE", read.detail);
      if (read.text !== undefined && this.#findBlock(read.text)) {
        await this.#backup(this.codexFile);
        const text = this.#withoutBlock(read.text);
        await atomicWrite(this.codexFile, text.endsWith("\n") || !text ? text : `${text}\n`);
      }
    }
    return this.statusOf(agent);
  }
}
