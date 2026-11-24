import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CODEX_FEATURES_OFF, createModelRunner, NO_MODEL_ENV, type ModelRequest } from "../src/backend/models.js";

/**
 * Stand-ins for `claude` and `codex`: they write down how they were called and answer as the
 * scenario next to them says. No test reaches a model.
 */
const FAKE = String.raw`
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const here = path.dirname(process.argv[1]);
const [tool, ...argv] = process.argv.slice(2);
const scenario = JSON.parse(readFileSync(path.join(here, "scenario.json"), "utf8"));
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  appendFileSync(path.join(here, "calls.jsonl"), JSON.stringify({ tool, argv, env: process.env, input }) + "\n");
  if (argv.includes("--help")) {
    process.stdout.write(scenario.help ?? "");
    return;
  }
  const at = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const reply = tool === "claude" ? scenario.reply : scenario.replies[at("--model") ?? "default"];
  setTimeout(() => {
    if (reply.answer !== undefined) writeFileSync(at("--output-last-message"), reply.answer);
    process.stdout.write(reply.stdout ?? "");
    process.stderr.write(reply.stderr ?? "");
    process.exitCode = reply.code ?? 0;
  }, reply.sleepMs ?? 0);
});
`;

interface Reply {
  stdout?: string;
  stderr?: string;
  code?: number;
  sleepMs?: number;
  answer?: string;
}

interface Call {
  tool: string;
  argv: string[];
  env: Record<string, string>;
  input: string;
}

const REQUEST: ModelRequest = {
  system: "Reply with JSON only.",
  prompt: "对话内容：修复结算页",
  schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
};
const SECRET = "fake-gateway-token-0123456789";

let root: string;
let home: string;
beforeEach(async () => {
  // These tests run the real runner, always against the stand-in tools below (`find`), so they
  // turn the test run's switch that refuses every model call off for themselves.
  vi.stubEnv(NO_MODEL_ENV, "");
  root = await mkdtemp(path.join(os.tmpdir(), "mainline-models-"));
  home = path.join(root, "home");
  await mkdir(path.join(home, ".claude"), { recursive: true });
  // How the user signs in to a gateway, as Claude Code's settings keep it.
  await writeFile(path.join(home, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: SECRET, ANTHROPIC_BASE_URL: "https://gateway.example", lower: "skipped" }, hooks: {} }));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

/** A fake tool in a folder of its own, with its scenario; returns its path and what it was asked. */
async function fake(tool: "claude" | "codex", scenario: { help?: string; reply?: Reply; replies?: Record<string, Reply> }) {
  const folder = await mkdtemp(path.join(root, `${tool}-`));
  await writeFile(path.join(folder, "fake.mjs"), FAKE);
  await writeFile(path.join(folder, "scenario.json"), JSON.stringify(scenario));
  const executable = path.join(folder, tool);
  await writeFile(executable, `#!/bin/sh\nexec "${process.execPath}" "${path.join(folder, "fake.mjs")}" ${tool} "$@"\n`);
  await chmod(executable, 0o755);
  const calls = async (): Promise<Call[]> =>
    (await readFile(path.join(folder, "calls.jsonl"), "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Call);
  return { executable, calls };
}

/** The message a call failed with. */
const failureOf = (call: Promise<unknown>): Promise<string> =>
  call.then(
    () => "it did not fail",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

/**
 * What the stand-in's shell and Node add to a tool's environment by themselves: Node passes
 * NODE_V8_COVERAGE on to every child when coverage is collected, macOS adds its text encoding.
 */
const ADDED_BY_RUNTIME = new Set(["PWD", "OLDPWD", "SHLVL", "_", "__CF_USER_TEXT_ENCODING", "NODE_V8_COVERAGE"]);

/**
 * A tool got exactly `expected` of this process's environment: those names are there, and nothing
 * else of the test runner's own variables (such as CODEXHOST_THREAD_ID) came along.
 */
function expectEnvOnly(call: Call, expected: readonly string[]): void {
  const names = Object.keys(call.env).filter((name) => !ADDED_BY_RUNTIME.has(name));
  expect(names).toEqual(expect.arrayContaining([...expected]));
  const leaked = names.filter((name) => !expected.includes(name) && process.env[name] !== undefined && process.env[name] === call.env[name]);
  expect(leaked).toEqual([]);
}

const runner = (tools: { claude?: string; codex?: string }, timeoutMs?: number) =>
  createModelRunner(path.join(root, "runs"), { find: (name) => tools[name], home, ...(timeoutMs ? { timeoutMs } : {}) });

const claudeAnswer = JSON.stringify({ type: "result", is_error: false, structured_output: { ok: true }, modelUsage: { "claude-haiku-test": {} } });
const codexFailed = (message: string) =>
  [JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "模型写的话：密码在 ~/.ssh 里" } }), JSON.stringify({ type: "error", message }), JSON.stringify({ type: "turn.failed", error: { message } })].join("\n");

describe.skipIf(process.platform === "win32")("model calls", () => {
  // Each of these starts several stand-in processes: over the default 5 s on a busy machine.
  it("call Claude Code with Haiku, low effort when it knows the option, no tools, and nothing of the user's or codexhost's sessions", { timeout: 20_000 }, async () => {
    const claude = await fake("claude", { help: "Options:\n  --effort <level>  Effort level\n", reply: { stdout: claudeAnswer } });
    process.env.CODEXHOST_THREAD_ID = "thread-of-this-test";
    try {
      expect(await runner({ claude: claude.executable })("claude", REQUEST)).toEqual({ value: { ok: true }, model: "claude-haiku-test" });
    } finally {
      delete process.env.CODEXHOST_THREAD_ID;
    }
    const [help, call] = await claude.calls();
    expect(help!.argv).toEqual(["--help"]);
    expect(call!.argv).toEqual([
      "-p",
      "--model",
      "haiku",
      "--effort",
      "low",
      "--no-session-persistence",
      "--setting-sources",
      "local",
      "--strict-mcp-config",
      "--tools",
      "",
      "--output-format",
      "json",
      "--system-prompt",
      REQUEST.system,
      "--json-schema",
      JSON.stringify(REQUEST.schema),
    ]);
    expect(call!.input).toBe(REQUEST.prompt);
    expectEnvOnly(call!, ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "HOME", "LANG", "NO_COLOR", "PATH", "USER"]);
    expect(call!.env).not.toHaveProperty("CODEXHOST_THREAD_ID");
    expect(call!.env).toMatchObject({ HOME: home, ANTHROPIC_AUTH_TOKEN: SECRET, LANG: "en_US.UTF-8", NO_COLOR: "1" });

    // A Claude Code that does not know --effort is called without it.
    const older = await fake("claude", { help: "Options:\n  --model <model>\n", reply: { stdout: claudeAnswer } });
    await runner({ claude: older.executable })("claude", REQUEST);
    expect((await older.calls())[1]!.argv).not.toContain("--effort");
  });

  it("call Codex with every tool that reaches the computer off, read-only, low effort, and the user's rules and config left out", { timeout: 20_000 }, async () => {
    const codex = await fake("codex", { help: "      --ignore-rules\n", replies: { "gpt-6-luna": { answer: '{"ok":true}', stdout: '{"type":"turn.completed"}' } } });
    expect(await runner({ codex: codex.executable })("codex", REQUEST)).toEqual({ value: { ok: true }, model: "gpt-6-luna" });
    const [help, call] = await codex.calls();
    expect(help!.argv).toEqual(["exec", "--help"]);
    const cwd = call!.argv[call!.argv.indexOf("--cd") + 1]!;
    expect(call!.argv).toEqual([
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      ...CODEX_FEATURES_OFF.flatMap((name) => ["-c", `features.${name}=false`]),
      "-c",
      'web_search="disabled"',
      "-c",
      'model_reasoning_effort="low"',
      "--model",
      "gpt-6-luna",
      "--json",
      "--output-schema",
      path.join(cwd, "schema.json"),
      "--output-last-message",
      path.join(cwd, "answer.json"),
      "--color",
      "never",
      "--cd",
      cwd,
      "-",
    ]);
    for (const name of ["shell_tool", "unified_exec", "view_image", "apps", "plugins", "browser_use", "computer_use", "memories", "hooks"]) expect(call!.argv).toContain(`features.${name}=false`);
    // `--disable <name>` would stop a Codex that does not know the name.
    expect(call!.argv).not.toContain("--disable");
    expect(call!.input).toBe(`${REQUEST.system}\n\n${REQUEST.prompt}`);
    expectEnvOnly(call!, ["HOME", "LANG", "NO_COLOR", "PATH", "USER"]);

    const older = await fake("codex", { help: "      --ignore-user-config\n", replies: { "gpt-6-luna": { answer: '{"ok":true}' } } });
    await runner({ codex: older.executable })("codex", REQUEST);
    expect((await older.calls())[1]!.argv).not.toContain("--ignore-rules");
  });

  it("let Codex's default model answer, still with low effort, only when the small model is not offered", { timeout: 20_000 }, async () => {
    const codex = await fake("codex", {
      help: "--ignore-rules",
      replies: {
        "gpt-6-luna": { code: 1, stdout: codexFailed("The 'gpt-6-luna' model is not supported when using Codex with a ChatGPT account.") },
        default: { answer: '{"ok":true}' },
      },
    });
    expect(await runner({ codex: codex.executable })("codex", REQUEST)).toEqual({ value: { ok: true }, model: "codex-default" });
    const runs = (await codex.calls()).slice(1);
    expect(runs).toHaveLength(2);
    expect(runs[1]!.argv).not.toContain("--model");
    expect(runs[1]!.argv).toContain('model_reasoning_effort="low"');
  });

  it("do not try again after a timeout or any other failure, and say what went wrong without what the model wrote", { timeout: 20_000 }, async () => {
    // The timeout is shared by the --help probe before the call: a busy machine needs more than a second to start the stand-in.
    const slow = await fake("codex", { help: "--ignore-rules", replies: { "gpt-6-luna": { sleepMs: 10_000 }, default: { answer: '{"ok":true}' } } });
    await expect(runner({ codex: slow.executable }, 3000)("codex", REQUEST)).rejects.toThrow(/^codex did not answer within 3 s$/u);
    expect(await slow.calls()).toHaveLength(2);

    const broken = await fake("codex", { help: "--ignore-rules", replies: { "gpt-6-luna": { code: 1, stdout: codexFailed("stream disconnected before completion") }, default: { answer: '{"ok":true}' } } });
    expect(await failureOf(runner({ codex: broken.executable })("codex", REQUEST))).toBe("codex exited with code 1: a network problem");
    expect(await broken.calls()).toHaveLength(2);

    const refused = await fake("claude", {
      help: "--effort",
      reply: { code: 1, stdout: JSON.stringify({ is_error: true, subtype: "success", result: `API Error: 401 invalid x-api-key ${SECRET}`, api_error_status: 401 }) },
    });
    await expect(runner({ claude: refused.executable })("claude", REQUEST)).rejects.toThrow(/^claude exited with code 1: not signed in, or the sign-in was refused$/u);

    const odd = await fake("claude", {
      help: "--effort",
      reply: { code: 1, stdout: JSON.stringify({ is_error: true, result: `API Error: 500 upstream said: ${SECRET} rejected ${["sk", "ant", "api03", "AbCdEf0123456789xyz"].join("-")}` }) },
    });
    expect(await failureOf(runner({ claude: odd.executable })("claude", REQUEST))).toBe("claude exited with code 1: API Error: 500 upstream said: *** rejected sk-***");

    const prose = await fake("claude", { help: "--effort", reply: { stdout: "这是模型写的一段话，不是 JSON" } });
    expect(await failureOf(runner({ claude: prose.executable })("claude", REQUEST))).toBe("claude answered something other than JSON");

    const reported = await fake("claude", { help: "--effort", reply: { stdout: JSON.stringify({ is_error: true, subtype: "success", result: "模型写的话" }) } });
    expect(await failureOf(runner({ claude: reported.executable })("claude", REQUEST))).toBe("claude reported an error");
  });

  it("fail with the name of a missing tool instead of sending the conversation to the other one", async () => {
    const codex = await fake("codex", { help: "", replies: { "gpt-6-luna": { answer: '{"ok":true}' } } });
    await expect(runner({ codex: codex.executable })("claude", REQUEST)).rejects.toThrow("Claude Code (the claude command) was not found on this computer");
    await expect(runner({})("codex", REQUEST)).rejects.toThrow("Codex (the codex command) was not found on this computer");
    expect(await codex.calls()).toEqual([]);
  });
});
