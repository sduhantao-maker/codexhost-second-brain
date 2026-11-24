/**
 * Runs a small model once, through the command line tools the user already signed in to: Claude
 * Code (`claude -p`, Haiku) or Codex (`codex exec`). Each call is isolated: an empty private
 * working folder, no hooks or user settings, no MCP servers, no tools, nothing saved to the tools'
 * history, low reasoning effort, and none of the codexhost session variables, so the call is not
 * mistaken for a conversation. A tool that is missing is reported, never replaced by the other
 * one. Errors say what went wrong without repeating what the model wrote, with secrets masked.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SummaryEngine } from "../core/model.js";
import { maskSecrets } from "../core/redact.js";
import type { SummaryProblem } from "../core/rpc.js";

export type Engine = SummaryEngine;

export interface ModelRequest {
  /** Instructions. */
  system: string;
  /** The material: here, the conversation. */
  prompt: string;
  /** JSON Schema the answer must follow. */
  schema: object;
}

export interface ModelAnswer {
  value: unknown;
  /** Which model answered, for the record. */
  model: string;
}

export type RunModel = (engine: Engine, request: ModelRequest) => Promise<ModelAnswer>;

/**
 * A model call that failed before anything was sent: model calls are turned off, the tool is
 * missing or it could not start. Not counted. (A request that never reached codexhost is an
 * `ApiNotReachedError`, from external-api.ts.)
 */
export class ModelNotSentError extends Error {
  override readonly name = "ModelNotSentError";

  constructor(
    message: string,
    /** Why, as a code the overview says in its language; none when the tool could not start. */
    readonly problem?: SummaryProblem,
  ) {
    super(message);
  }
}

/**
 * The switch that turns every model call off: with `MAINLINE_NO_MODEL=1` in the environment the
 * runner refuses each call before it looks for a tool or starts anything. The test run sets it.
 */
export const NO_MODEL_ENV = "MAINLINE_NO_MODEL";

export function modelCallsOff(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(?:1|true|yes|on)$/iu.test(env[NO_MODEL_ENV]?.trim() ?? "");
}

const CALLS_OFF = `model calls are turned off (${NO_MODEL_ENV}=1): nothing was sent`;

export const CLAUDE_MODEL = "haiku";
export const CODEX_MODEL = "gpt-6-luna";
const TIMEOUT_MS = 120_000;
const HELP_TIMEOUT_MS = 15_000;
const OUTPUT_LIMIT = 2_000_000;

/**
 * Codex features turned off for a summary: everything that runs commands or reads local files
 * (`shell_tool`, `unified_exec`, `view_image`), apps and plugins, the browser and computer use,
 * memories, hooks, image generation and sub-agents. Given as `-c features.<name>=false`: Codex
 * ignores a name it does not know there, where `--disable <name>` refuses to start.
 */
export const CODEX_FEATURES_OFF = [
  "shell_tool",
  "unified_exec",
  "shell_snapshot",
  "view_image",
  "apps",
  "plugins",
  "remote_plugin",
  "browser_use",
  "in_app_browser",
  "computer_use",
  "memories",
  "hooks",
  "image_generation",
  "multi_agent",
] as const;

function candidates(name: Engine): string[] {
  const home = os.homedir();
  if (process.platform === "win32")
    return [path.join(home, ".local", "bin", `${name}.exe`), path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "npm", `${name}.cmd`)];
  return [
    path.join(home, ".local", "bin", name),
    path.join(home, ".claude", "local", name),
    "/opt/homebrew/bin/" + name,
    "/usr/local/bin/" + name,
    path.join(home, ".npm-global", "bin", name),
    path.join(home, ".bun", "bin", name),
    "/usr/bin/" + name,
  ];
}

export function findExecutable(name: Engine): string | undefined {
  return candidates(name).find((candidate) => existsSync(candidate));
}

/**
 * The environment Claude Code gives every session from the user's settings (`env` in
 * ~/.claude/settings.json): how the user signs in, such as a gateway's address and token. The
 * call skips the rest of the user's settings (hooks, plugins), so these are passed on by hand.
 */
export async function claudeSettingsEnv(home: string = os.homedir()): Promise<Record<string, string>> {
  try {
    const settings = JSON.parse(await readFile(path.join(home, ".claude", "settings.json"), "utf8")) as { env?: unknown };
    if (!isRecord(settings.env)) return {};
    return Object.fromEntries(Object.entries(settings.env).filter((entry): entry is [string, string] => typeof entry[1] === "string" && /^[A-Z_][A-Z0-9_]*$/u.test(entry[0])));
  } catch {
    return {};
  }
}

/** Text fit for an error message, the page and the log: the values passed to the tool, and secrets of any known shape, masked. */
function safe(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) if (secret.length >= 8) out = out.split(secret).join("***");
  return maskSecrets(out);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

interface CallOptions {
  timeoutMs: number;
  home: string;
}

interface Run {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

const failed = (result: Run) => result.timedOut || result.signal !== null || result.code !== 0;

/** Runs the tool once with `input` on stdin. Rejects only when it could not be started. */
function run(executable: string, args: readonly string[], input: string, cwd: string, options: CallOptions, extraEnv: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: {
        ...extraEnv,
        HOME: options.home,
        USER: os.userInfo().username,
        PATH: [path.dirname(executable), path.join(options.home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(path.delimiter),
        LANG: "en_US.UTF-8",
        NO_COLOR: "1",
        ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let kill: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      kill = setTimeout(() => child.kill("SIGKILL"), 5000);
      kill.unref?.();
    }, options.timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderr.length < OUTPUT_LIMIT) stderr += chunk;
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      clearTimeout(kill);
      reject(new ModelNotSentError(`could not start ${path.basename(executable)} (${error.code ?? "error"})`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(kill);
      resolve({ stdout, stderr, code, signal, timedOut });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

/** What each tool's `--help` says, asked once per version of it: which options it knows. */
const helps = new Map<string, Promise<string>>();

async function helpOf(executable: string, args: readonly string[], cwd: string, options: CallOptions): Promise<string> {
  const version = await stat(executable).then(
    (info) => `${info.mtimeMs}:${info.size}`,
    () => "",
  );
  const key = [executable, version, ...args].join("\0");
  let help = helps.get(key);
  if (!help) {
    help = run(executable, args, "", cwd, { ...options, timeoutMs: Math.min(options.timeoutMs, HELP_TIMEOUT_MS) }).then(
      (result) => `${result.stdout}\n${result.stderr}`,
      () => "",
    );
    helps.set(key, help);
  }
  return help;
}

/** The tools' own reports of a failure: lines that start like an error. Never what the model wrote. */
const ERROR_LINE = /^\s*(?:\[[^\]]*\]\s*)?(?:error|fatal|api error)\b/iu;
const errorLines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => ERROR_LINE.test(line));

/**
 * How the tools say a model is not offered to the account or does not exist: Codex ("The 'x'
 * model is not supported when using Codex with a ChatGPT account."), the OpenAI API ("The model
 * `x` does not exist or you do not have access to it."), Claude Code and its gateways ("API
 * Error: 400 unknown provider for model x").
 */
const MODEL_UNAVAILABLE =
  /\bmodel\b[^\n]{0,160}?\b(?:is not supported|not supported|is not available|not available|unavailable|does not exist|not found|do(?:es)? not have access|may not exist|no access|not enabled)\b|model_not_found|unsupported[_ ]model|unrecognized[_ ]model|unknown (?:provider for )?model|invalid model/iu;

/** Known troubles, in words that say what went wrong. */
const REASONS: ReadonlyArray<readonly [RegExp, string]> = [
  [MODEL_UNAVAILABLE, "the model is not available to this account"],
  [/\b401\b|authentication|unauthori[sz]ed|invalid (?:x-)?api[ -]?key|not logged in|log ?in required|please run \/login|codex login/iu, "not signed in, or the sign-in was refused"],
  [/\b429\b|rate[ _-]?limit|too many requests|usage limit|quota/iu, "a rate or usage limit was reached"],
  [/\b529\b|overloaded/iu, "the service is overloaded"],
  [/credit balance|billing|payment required|\b402\b/iu, "a billing or credit problem"],
  [/prompt is too long|context[_ ]length|context window|too many tokens/iu, "the conversation text was too long for the model"],
  [/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|network|connection (?:refused|reset|error|closed)|stream disconnected/iu, "a network problem"],
];

/**
 * Says why a call failed from the tools' own error reports: a known trouble in plain words, an
 * option the tool does not know, or else the first report, cut short.
 */
function reasonOf(reports: readonly string[]): string {
  const all = reports.join("\n");
  for (const [pattern, reason] of REASONS) if (pattern.test(all)) return reason;
  const option = /(?:unknown option|unexpected argument|unrecognized (?:option|argument))\s+'?(-{1,2}[\w-]+)/iu.exec(all);
  if (option) return `it does not know the option ${option[1]} (an older version?)`;
  const first = reports.find((report) => report.trim());
  return first ? Array.from(first.replace(/\s+/gu, " ").trim()).slice(0, 160).join("") : "";
}

function failure(tool: string, result: Run, reports: readonly string[], options: CallOptions, secrets: readonly string[] = []): Error {
  const what = result.timedOut
    ? `${tool} did not answer within ${Math.round(options.timeoutMs / 1000)} s`
    : result.signal
      ? `${tool} was stopped (${result.signal})`
      : `${tool} exited with code ${String(result.code)}`;
  // A timeout says it all; whatever was printed before it is beside the point.
  const why = result.timedOut ? "" : reasonOf(reports);
  return new Error(safe(why ? `${what}: ${why}` : what, secrets));
}

/**
 * Claude Code's JSON answer says what went wrong when `is_error` is set: in `result` ("API Error:
 * 400 …", kept only when it reads as an error report), `api_error_type`, `api_error_status` and
 * an error `subtype`.
 */
function claudeReports(raw: unknown): string[] {
  if (!isRecord(raw) || raw.is_error !== true) return [];
  const reports: string[] = [];
  if (typeof raw.result === "string" && (ERROR_LINE.test(raw.result) || REASONS.some(([pattern]) => pattern.test(raw.result as string)))) reports.push(raw.result);
  if (typeof raw.api_error_type === "string" || typeof raw.api_error_status === "number")
    reports.push(`API error ${[raw.api_error_status, raw.api_error_type].filter((part) => typeof part === "number" || typeof part === "string").join(" ")}`);
  if (typeof raw.subtype === "string" && /^error/iu.test(raw.subtype)) reports.push(`error: ${raw.subtype}`);
  return reports;
}

async function runClaude(executable: string, request: ModelRequest, cwd: string, options: CallOptions): Promise<ModelAnswer> {
  const env = await claudeSettingsEnv(options.home);
  const secrets = Object.values(env);
  const effort = /--effort\b/u.test(await helpOf(executable, ["--help"], cwd, options)) ? ["--effort", "low"] : [];
  const result = await run(
    executable,
    [
      "-p",
      "--model",
      CLAUDE_MODEL,
      ...effort,
      "--no-session-persistence",
      // Only settings of the empty working folder: none of the user's hooks or plugins run.
      "--setting-sources",
      "local",
      "--strict-mcp-config",
      "--tools",
      "",
      "--output-format",
      "json",
      "--system-prompt",
      request.system,
      "--json-schema",
      JSON.stringify(request.schema),
    ],
    request.prompt,
    cwd,
    options,
    env,
  );
  let raw: unknown;
  try {
    raw = JSON.parse(result.stdout);
  } catch {
    raw = undefined;
  }
  const reports = claudeReports(raw);
  if (failed(result)) throw failure("claude", result, [...reports, ...errorLines(result.stderr)], options, secrets);
  if (!isRecord(raw)) throw new Error("claude answered something other than JSON");
  if (raw.is_error === true) {
    const why = reasonOf(reports);
    throw new Error(safe(why ? `claude reported an error: ${why}` : "claude reported an error", secrets));
  }
  let value = raw.structured_output;
  if (value === undefined && typeof raw.result === "string") {
    try {
      value = JSON.parse(raw.result);
    } catch {
      value = undefined;
    }
  }
  if (value === undefined) throw new Error("claude did not answer in the asked shape");
  const used = isRecord(raw.modelUsage) ? Object.keys(raw.modelUsage)[0] : undefined;
  return { value, model: used ?? `claude-${CLAUDE_MODEL}` };
}

/** Codex's `--json` events that report a failure: `error` and `turn.failed`. Its other events carry what the model wrote. */
function codexReports(stdout: string): string[] {
  const reports: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const event = JSON.parse(line) as unknown;
      if (!isRecord(event)) continue;
      if (event.type === "error" && typeof event.message === "string") reports.push(event.message);
      else if (event.type === "turn.failed" && isRecord(event.error) && typeof event.error.message === "string") reports.push(event.error.message);
    } catch {
      // Not an event.
    }
  }
  return reports;
}

/** `codex exec` with no tools that reach the computer, nothing loaded from the user's configuration, and low effort. */
function codexArgs(files: { cwd: string; schema: string; answer: string }, ignoreRules: boolean, model?: string): string[] {
  return [
    "exec",
    "--ephemeral",
    // Skip the user's config: no MCP servers, profiles or hooks start for a one-line answer.
    "--ignore-user-config",
    ...(ignoreRules ? ["--ignore-rules"] : []),
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    ...CODEX_FEATURES_OFF.flatMap((name) => ["-c", `features.${name}=false`]),
    "-c",
    'web_search="disabled"',
    "-c",
    'model_reasoning_effort="low"',
    ...(model ? ["--model", model] : []),
    "--json",
    "--output-schema",
    files.schema,
    "--output-last-message",
    files.answer,
    "--color",
    "never",
    "--cd",
    files.cwd,
    "-",
  ];
}

async function runCodex(executable: string, request: ModelRequest, cwd: string, options: CallOptions): Promise<ModelAnswer> {
  const files = { cwd, schema: path.join(cwd, "schema.json"), answer: path.join(cwd, "answer.json") };
  await writeFile(files.schema, JSON.stringify(request.schema));
  const ignoreRules = (await helpOf(executable, ["exec", "--help"], cwd, options)).includes("--ignore-rules");
  const input = `${request.system}\n\n${request.prompt}`;
  const attempt = async (model?: string) => {
    await rm(files.answer, { force: true });
    const result = await run(executable, codexArgs(files, ignoreRules, model), input, cwd, options);
    return { result, reports: [...codexReports(result.stdout), ...errorLines(result.stderr)] };
  };
  let model = CODEX_MODEL;
  let { result, reports } = await attempt(CODEX_MODEL);
  // The small model may not be offered to this account: the account's default model answers
  // instead, with the same low effort. Not after a timeout or any other trouble.
  if (failed(result) && !result.timedOut && reports.some((report) => MODEL_UNAVAILABLE.test(report))) {
    model = "codex-default";
    // The first try did send the conversation: a second one that cannot start is still a call made.
    ({ result, reports } = await attempt().catch((error: unknown) => {
      throw new Error(error instanceof Error ? error.message : String(error));
    }));
  }
  if (failed(result)) throw failure("codex", result, reports, options);
  const text = await readFile(files.answer, "utf8").catch(() => "");
  try {
    return { value: JSON.parse(text), model };
  } catch {
    const why = reasonOf(reports);
    throw new Error(safe(why ? `codex gave no answer: ${why}` : "codex did not answer in the asked shape", []));
  }
}

export interface ModelRunnerOptions {
  /** Where each tool is; by default the usual install places. */
  find?: (name: Engine) => string | undefined;
  /** How long one call may take. */
  timeoutMs?: number;
  /** The home folder the tools run with (and Claude Code's settings are read from). */
  home?: string;
}

const MISSING: Record<Engine, string> = {
  claude: "Claude Code (the claude command) was not found on this computer: install it, or choose Codex for summaries in the settings",
  codex: "Codex (the codex command) was not found on this computer: install it, or choose Claude Haiku for summaries in the settings",
};

/**
 * A runner that calls the tool for the engine asked. When that tool is missing the call fails: the
 * conversation never goes to the other provider instead. With model calls turned off
 * (`MAINLINE_NO_MODEL=1`, read at every call) it refuses before looking for any tool.
 */
export function createModelRunner(workDir: string, runner: ModelRunnerOptions = {}): RunModel {
  const find = runner.find ?? findExecutable;
  const options: CallOptions = { timeoutMs: runner.timeoutMs ?? TIMEOUT_MS, home: runner.home ?? os.homedir() };
  return async (engine, request) => {
    if (modelCallsOff()) throw new ModelNotSentError(CALLS_OFF, "MODEL_CALLS_OFF");
    const executable = find(engine);
    if (!executable) throw new ModelNotSentError(MISSING[engine], engine === "claude" ? "CLAUDE_MISSING" : "CODEX_MISSING");
    const cwd = path.join(workDir, `${engine}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    try {
      return engine === "claude" ? await runClaude(executable, request, cwd, options) : await runCodex(executable, request, cwd, options);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  };
}
