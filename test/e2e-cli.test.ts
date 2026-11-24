/**
 * Runs the command through the installed wrapper, as an agent would. It is built from the current
 * source first, the way scripts/build.mjs builds bin/mainline.mjs, so the test never runs a stale
 * build and never skips for want of one. (The POSIX wrapper needs a POSIX shell: not on Windows.)
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { posixWrapper } from "../src/backend/install-cli.js";

const run = promisify(execFile);

describe.skipIf(process.platform === "win32")("installed command", () => {
  let root: string;
  let command: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "mainline-e2e-"));
    const bin = path.join(root, "host-extension-data", "second-brain", "bin");
    await mkdir(bin, { recursive: true });
    const manifest = JSON.parse(await readFile(path.resolve("manifest.json"), "utf8")) as { version: string };
    await build({
      absWorkingDir: path.resolve("."),
      entryPoints: ["src/cli/bin.ts"],
      outfile: path.join(bin, "mainline.mjs"),
      bundle: true,
      platform: "node",
      target: "node22",
      format: "esm",
      banner: { js: "#!/usr/bin/env node" },
      define: { __VERSION__: JSON.stringify(manifest.version), __MAINLINE_CSS__: '""' },
      tsconfigRaw: {},
      logLevel: "warning",
    });
    command = path.join(bin, "mainline");
    await writeFile(command, posixWrapper(process.execPath));
    await chmod(command, 0o755);
  }, 60_000);
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const env = (extra: Record<string, string> = {}) => {
    const base: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: root, LANG: "zh_CN.UTF-8" };
    return { ...base, ...extra };
  };

  // These start the built command as processes: over the default 5 s on a busy machine.
  it("finds its data folder from its own location and runs the workflow", { timeout: 20_000 }, async () => {
    const thread = { CODEXHOST_THREAD_ID: "e2e-1" };
    const created = await run(command, ["new", "端到端测试主线", "--plan", "阶段一|阶段二"], { env: env(thread) });
    expect(created.stdout).toContain("「端到端测试主线」，2 个里程碑");
    await run(command, ["doing", "验证命令行"], { env: env(thread) });
    const shown = await run(command, ["show"], { env: env(thread) });
    expect(shown.stdout).toContain("▸ 验证命令行（正在做）");
    expect(shown.stdout).toContain(command);
    expect(existsSync(path.join(root, "host-extension-data", "second-brain", "state.json"))).toBe(true);
  });

  it("serves the Claude Code hook and stays silent outside codexhost", { timeout: 20_000 }, async () => {
    const child = execFile(command, ["hook", "claude-prompt"], { env: env({ CODEXHOST_THREAD_ID: "e2e-1" }) });
    child.stdin?.end(JSON.stringify({ prompt: "顺便问个别的问题" }));
    const output = await new Promise<string>((resolve) => {
      let text = "";
      child.stdout?.on("data", (chunk: Buffer) => (text += chunk.toString()));
      child.on("close", () => resolve(text));
    });
    const payload = JSON.parse(output) as { hookSpecificOutput: { additionalContext: string } };
    expect(payload.hookSpecificOutput.additionalContext).toContain("【主线】本对话：「端到端测试主线」");

    const outside = await run(command, ["hook", "claude-prompt"], { env: env() });
    expect(outside.stdout).toBe("");
  });

  it("is the current source, not an earlier build", async () => {
    const { stdout } = await run(command, ["--help"], { env: env() });
    expect(stdout).toContain("mainline link <GitHub PR or issue URL>");
  });

  it("reports errors with a non-zero exit code", async () => {
    await expect(run(command, ["done", "x"], { env: env() })).rejects.toMatchObject({ code: 1 });
  });
});
