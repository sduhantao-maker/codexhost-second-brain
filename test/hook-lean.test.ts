/**
 * What agents get with each message: the full mainline text once, then one status line when
 * something changed, else nothing (the Claude Code hook); `mainline show` the same way for Codex.
 */
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run, type CliIo } from "../src/cli/main.js";
import { conversationView } from "../src/core/conversation-view.js";
import { agentContextV2, agentRulesV2, FULL_AGAIN_AFTER, nextContext, statusLineV2 } from "../src/core/protocol-v2.js";
import { contextDir, contextFile, pruneSeen } from "../src/node/context-record.js";
import { refsPaths, updateIndex } from "../src/node/refs-store.js";
import { readState, storePaths } from "../src/node/store.js";
import { sampleSources, T } from "./fixtures/v2.js";

const T0 = Date.parse("2026-11-24T08:00:00Z");
const HOUR = 60 * 60 * 1000;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "mainline-lean-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Call {
  env?: Record<string, string>;
  at?: number;
  stdin?: Record<string, unknown>;
}

const baseEnv = (env: Record<string, string> = { CODEXHOST_THREAD_ID: "t1" }) => ({ MAINLINE_DATA_DIR: dir, LANG: "zh_CN.UTF-8", ...env });

async function cli(argv: string[], call: Call = {}): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const io: CliIo = {
    env: baseEnv(call.env),
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    now: () => call.at ?? T0,
    ...(call.stdin ? { readStdin: async () => JSON.stringify(call.stdin) } : {}),
  };
  const code = await run(argv, io);
  return { code, out, err };
}

/** One user message through the hook: the context it adds, or undefined when it adds nothing. */
async function message(call: Call & { session?: string | null } = {}): Promise<string | undefined> {
  const stdin = { prompt: "继续", hook_event_name: "UserPromptSubmit", ...(call.session === null ? {} : { session_id: call.session ?? "s1" }) };
  const { code, out } = await cli(["hook", "claude-prompt"], { ...call, stdin });
  expect(code).toBe(0);
  if (!out) return undefined;
  const payload = JSON.parse(out) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  expect(payload.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
  return payload.hookSpecificOutput.additionalContext;
}

describe("the Claude Code hook", () => {
  it("gives the full text once per session, then a status line only when it changes", async () => {
    await cli(["new", "修复结算页错位", "--plan", "定位原因|提交 PR"]);
    const first = await message();
    expect(first).toContain("【主线】本对话：「修复结算页错位」");
    expect(first).toContain("约定（mainline 即");
    expect(first).toContain("mainline --help");
    // Nothing changed: nothing is added at all.
    expect(await message()).toBeUndefined();
    await cli(["doing", "读样式断点"]);
    expect(await message()).toBe("【主线】「修复结算页错位」 · 里程碑 0/2，当前「定位原因」 · 正在做：读样式断点");
    expect(await message()).toBeUndefined();
    await cli(["spinoff", "手机端菜单图标重叠"]);
    expect(await message()).toContain("1 个引申问题未处理");
    // The prompt is still recorded with every message.
    expect((await readState(storePaths(dir))).prompts.t1?.text).toBe("继续");
    // A new Claude session for the same conversation starts from the full text.
    expect(await message({ session: "s2" })).toContain("约定（mainline 即");
    expect(await message({ session: "s2" })).toBeUndefined();
  });

  it("gives the full text again after 30 messages, after 12 hours and when the rules change", async () => {
    await cli(["new", "整理发布流程"]);
    expect(await message()).toContain("约定");
    for (let index = 1; index < FULL_AGAIN_AFTER; index += 1) expect(await message()).toBeUndefined();
    expect(await message()).toContain("约定");
    expect(await message({ at: T0 + 11 * HOUR })).toBeUndefined();
    expect(await message({ at: T0 + 13 * HOUR })).toContain("约定");
    // Another drift policy is other rules.
    await writeFile(path.join(dir, "settings.json"), JSON.stringify({ values: { driftPolicy: "off" } }));
    const off = await message({ at: T0 + 13 * HOUR });
    expect(off).toContain("约定");
    expect(off).not.toContain("mainline spinoff");
    expect(await message({ at: T0 + 13 * HOUR })).toBeUndefined();
  });

  it("keeps its record in a private file of its own; a broken or missing one means the full text", async () => {
    await cli(["new", "整理发布流程"]);
    await message();
    const file = contextFile(dir, "t1", "hook");
    expect(path.dirname(file)).toBe(contextDir(dir));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await message()).toBeUndefined();
    await writeFile(file, "{ broken");
    expect(await message()).toContain("约定");
    await rm(file);
    expect(await message()).toContain("约定");
    // Without the session id it cannot tell a new session from this one.
    expect(await message({ session: null })).toContain("约定");
    expect(await message({ session: null })).toContain("约定");
    // An id that is no plain file name gets a hashed one.
    expect(path.basename(contextFile(dir, "../x", "hook"))).toMatch(/^h-[0-9a-f]{32}\.hook\.json$/u);
  });

  it("tells a conversation without a mainline the same rules, and the status line when the mainline appears", async () => {
    const draft = await message();
    expect(draft).toContain("【主线】本对话还没有主线。");
    expect(draft).not.toContain("mainline new");
    expect(await message()).toBeUndefined();
    await cli(["doing", "读日志"]);
    // Same rules: no full text again, just the new status.
    expect(await message()).toMatch(/^【主线】「继续」 · 里程碑 0\/1，当前「第 1 阶段」 · 正在做：读日志$/u);
  });

  it("stays silent in a Codex session codexhost does not know, and on any failure", async () => {
    expect(await message({ env: { CODEX_THREAD_ID: "codex-unknown" } })).toBeUndefined();
    expect((await readState(storePaths(dir))).prompts["codex-unknown"]).toBeUndefined();
    // Known to codexhost (a mainline, a recorded message or the link index): briefed as usual.
    await updateIndex(refsPaths(dir), (index) => {
      index.threads["codex-known"] = { turns: 1, updatedAt: "2026-11-24T08:00:00Z", scannedAt: 1, title: "Codex 对话" };
    });
    expect(await message({ env: { CODEX_THREAD_ID: "codex-known" } })).toContain("约定");
    // A new conversation in a Codex session codexhost started: not read by the scanner yet, but
    // codexhost's other variables say whose it is.
    expect(await message({ env: { CODEX_THREAD_ID: "codex-new", CODEXHOST_CLI_PATH: "/opt/codexhost/bin/codexhost" } })).toContain("约定");
    expect((await readState(storePaths(dir))).prompts["codex-new"]?.text).toBe("继续");
    // An empty one says nothing.
    expect(await message({ env: { CODEX_THREAD_ID: "codex-plain", CODEXHOST_DATA_DIR: " " } })).toBeUndefined();
    expect((await readState(storePaths(dir))).prompts["codex-plain"]).toBeUndefined();
    expect(await message({ env: {} })).toBeUndefined();
    expect((await cli(["hook", "something-else"])).out).toBe("");
    // A state file that cannot be read: nothing, and exit 0.
    await rm(path.join(dir, "state.json"), { force: true });
    await mkdir(path.join(dir, "state.json"));
    expect(await message()).toBeUndefined();
  });

  it("deletes records unused for days when it prints the full text", async () => {
    await cli(["new", "整理发布流程"]);
    await message();
    const stale = contextFile(dir, "old", "hook");
    await writeFile(stale, "{}");
    const old = new Date(Date.now() - 4 * 24 * HOUR);
    await utimes(stale, old, old);
    expect(await message()).toBeUndefined();
    expect((await readdir(contextDir(dir))).sort()).toEqual(["old.hook.json", "t1.hook.json"]);
    expect(await message({ session: "s2" })).toContain("约定");
    expect(await readdir(contextDir(dir))).toEqual(["t1.hook.json"]);
    expect(await pruneSeen(dir)).toBe(0);
  });
});

describe("mainline show", () => {
  it("prints everything the first time, then the status line with a pointer to --full", async () => {
    await cli(["new", "修复结算页错位", "--plan", "定位原因|提交 PR"]);
    const first = await cli(["show"]);
    expect(first.out).toContain("里程碑（0/2）：● 定位原因 → ○ 提交 PR");
    expect(first.out).toContain("约定（mainline 即");
    await cli(["doing", "读样式断点"]);
    const again = await cli(["show"]);
    expect(again.out).toBe(
      "【主线】「修复结算页错位」 · 里程碑 0/2，当前「定位原因」 · 正在做：读样式断点\n完整内容（里程碑、支线任务和约定）：mainline show --full\n",
    );
    expect((await cli(["show", "--full"])).out).toContain("▸ 读样式断点（正在做）");
    expect(JSON.parse((await cli(["show", "--json"])).out)).toMatchObject({ title: "修复结算页错位", now: { text: "读样式断点" } });
    // --full and --json leave the record alone; 12 hours later show prints everything again.
    expect((await cli(["show"])).out).toContain("mainline show --full");
    expect((await cli(["show"], { at: T0 + 13 * HOUR })).out).toContain("约定（mainline 即");
  });

  it("prints nothing for a Codex session codexhost does not know", async () => {
    for (const argv of [["show"], ["show", "--full"], ["show", "--json"]]) {
      const outside = await cli(argv, { env: { CODEX_THREAD_ID: "codex-unknown" } });
      expect(outside).toEqual({ code: 0, out: "", err: "" });
    }
    // An empty CODEXHOST_THREAD_ID is no codexhost session either.
    expect((await cli(["show"], { env: { CODEXHOST_THREAD_ID: "", CODEX_THREAD_ID: "codex-unknown" } })).out).toBe("");
    // Asked for by id, or in a codexhost session, it answers (a draft).
    expect((await cli(["show", "--thread", "codex-unknown"], { env: { CODEX_THREAD_ID: "codex-unknown" } })).out).toContain("还没有主线");
    expect((await cli(["show"], { env: { CODEXHOST_THREAD_ID: "fresh" } })).out).toContain("还没有主线");
    // A conversation with a mainline, or one the link index knows, is codexhost's.
    await cli(["new", "Codex 里的主线"], { env: { CODEXHOST_THREAD_ID: "codex-own" } });
    expect((await cli(["show"], { env: { CODEX_THREAD_ID: "codex-own" } })).out).toContain("Codex 里的主线");
    // So is a new one in a Codex session codexhost started (it gives its sessions CODEXHOST_* variables).
    for (const env of [{ CODEXHOST_DATA_DIR: "/nonexistent/codexhost" }, { CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:1" }])
      expect((await cli(["show"], { env: { CODEX_THREAD_ID: "codex-brand-new", ...env } })).out).toContain("还没有主线");
    // No conversation at all is still an error.
    expect((await cli(["show"], { env: {} })).code).toBe(1);
  });
});

describe("the status line and when the full text comes", () => {
  it("names the title, progress, current milestone, task in progress and open spin-offs", () => {
    const view = conversationView(T.main, sampleSources());
    expect(statusLineV2(view, "zh-CN")).toBe("【主线】「修复结算页在窄屏下错位」 · 里程碑 2/4，当前「维护者审查」 · 正在做：回复 review 意见 · 1 个引申问题未处理");
    expect(statusLineV2(view, "en")).toBe('[Mainline] "修复结算页在窄屏下错位" · milestones 2/4, current "维护者审查" · doing: 回复 review 意见 · 1 open spin-off');
    expect(statusLineV2(conversationView(T.old, sampleSources()), "en")).toBe("[Mainline] No mainline yet");
  });

  it("decides between the full text, the status line and nothing", () => {
    const first = nextContext(undefined, { at: 0, rules: "r", status: "a", session: "s" });
    expect(first).toEqual({ print: "full", seen: { session: "s", fullAt: 0, rules: "r", since: 0, status: "a" } });
    const same = nextContext(first.seen, { at: 1, rules: "r", status: "a", session: "s" });
    expect(same).toEqual({ print: "none", seen: { ...first.seen, since: 1 } });
    expect(nextContext(same.seen, { at: 2, rules: "r", status: "b", session: "s" }).print).toBe("status");
    expect(nextContext(same.seen, { at: 2, rules: "r2", status: "a", session: "s" }).print).toBe("full");
    expect(nextContext(same.seen, { at: 2, rules: "r", status: "a", session: "s2" }).print).toBe("full");
    expect(nextContext({ ...same.seen, since: FULL_AGAIN_AFTER - 1 }, { at: 2, rules: "r", status: "a", session: "s" }).print).toBe("full");
    // A clock that went back cannot be trusted either.
    expect(nextContext(same.seen, { at: -1, rules: "r", status: "a", session: "s" }).print).toBe("full");
  });

  it("keeps every command an agent needs in the rules, shorter than before", () => {
    const view = conversationView(T.main, sampleSources());
    // The rules of 0.7.1 for this conversation were 526 (zh) and 1218 (en) characters long.
    const limits = { "zh-CN": 440, en: 830 };
    for (const locale of ["zh-CN", "en"] as const) {
      const options = { cli: "/x/mainline", policy: "ask" as const, locale, summaries: true };
      const text = agentContextV2(view, options);
      for (const command of ["mainline --help", "mainline doing", "mainline done", "mainline spinoff", "mainline spawn", "mainline keep", "mainline dismiss", "mainline link", "mainline find", "mainline fav last"])
        expect(text).toContain(command);
      expect(agentRulesV2(view, options).length).toBeLessThan(limits[locale]);
    }
  });
});
