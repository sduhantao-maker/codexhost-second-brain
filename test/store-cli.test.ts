import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs, resolveDataDir, run } from "../src/cli/main.js";
import { addTask, createConversation } from "../src/core/conversation-ops.js";
import { readState, storePaths, updateState, withLock } from "../src/node/store.js";
import { v1StateText } from "./fixtures/v1.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "mainline-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("store", () => {
  it("applies concurrent updates without losing any", async () => {
    const paths = storePaths(dir);
    await updateState(paths, (draft, ctx) => createConversation(draft, "t1", { title: "Goal" }, ctx));
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => updateState(paths, (draft, ctx) => addTask(draft, "t1", `step ${i}`, ctx), { timeoutMs: 10_000 })),
    );
    const state = await readState(paths);
    expect(state.conversations.t1?.milestones[0]?.tasks).toHaveLength(20);
    expect(state.rev).toBe(21);
  });

  it("does not bump the revision when nothing changes", async () => {
    const paths = storePaths(dir);
    await updateState(paths, () => undefined);
    expect((await readState(paths)).rev).toBe(0);
  });

  it("sets a damaged file aside and starts over", async () => {
    const paths = storePaths(dir);
    await writeFile(paths.state, "{not json");
    expect((await readState(paths)).rev).toBe(0);
    await updateState(paths, (draft, ctx) => createConversation(draft, "t", { title: "Goal" }, ctx));
    expect((JSON.parse(await readFile(paths.state, "utf8")) as { version: number; rev: number }).version).toBe(2);
  });

  it("migrates a version 1 file on the next write", async () => {
    const paths = storePaths(dir);
    await writeFile(paths.state, v1StateText());
    expect((await readState(paths)).conversations.main?.milestones.map(({ title }) => title)).toEqual(["设计确认"]);
    await updateState(paths, () => undefined);
    const raw = JSON.parse(await readFile(paths.state, "utf8")) as { version: number };
    expect(raw.version).toBe(2);
    expect(await readFile(path.join(dir, "state.v1.json"), "utf8")).toBe(v1StateText());
  });

  // A stale lock is taken over only after it has stayed the same for 1.5 s: allow for a busy machine.
  it("clears a stale lock and times out on a live one", { timeout: 20_000 }, async () => {
    const paths = storePaths(dir);
    await mkdir(paths.lock);
    const old = new Date(Date.now() - 60_000);
    await utimes(paths.lock, old, old);
    await expect(withLock(paths, async () => "ok")).resolves.toBe("ok");
    await mkdir(paths.lock);
    await expect(withLock(paths, async () => "ok", 100)).rejects.toMatchObject({ code: "LOCKED" });
  });
});

function harness(env: Record<string, string> = {}, delegation?: Parameters<typeof run>[1]["delegation"], turns?: Parameters<typeof run>[1]["turns"]) {
  let out = "";
  let err = "";
  /** The gh lookups this harness answered. */
  const looked: string[] = [];
  const io = {
    env: { MAINLINE_DATA_DIR: dir, LANG: "zh_CN.UTF-8", ...env },
    stdout: (text: string) => {
      out += text;
    },
    stderr: (text: string) => {
      err += text;
    },
    now: () => 1_700_000_000_000,
    // No test reaches GitHub: a stand-in gh answers lookups.
    runGh: async (args: string[]) => {
      looked.push(args[1] ?? "");
      return JSON.stringify({ title: "Keep the cart when switching pages", state: "closed", merged: true });
    },
    ...(delegation ? { delegation } : {}),
    ...(turns ? { turns } : {}),
  };
  return {
    io,
    looked,
    async run(...argv: string[]) {
      out = "";
      err = "";
      const code = await run(argv, io);
      return { code, out, err };
    },
  };
}

describe("cli", () => {
  it("parses flags and keeps dashes inside text", () => {
    expect(parseArgs(["new", "-1", "fix", "--json", "--tags=a,b", "--plan", "x|y"])).toEqual({
      positional: ["new", "-1", "fix"],
      flags: { json: true, clear: false, help: false, version: false, all: false, full: false, tags: "a,b", plan: "x|y" },
    });
  });

  it("finds the installed data directory from its own location", () => {
    const installed = path.join(dir, "host-extension-data", "second-brain");
    expect(resolveDataDir({}, { env: {}, scriptPath: path.join(installed, "bin", "mainline.mjs") })).toBe(installed);
    expect(resolveDataDir({}, { env: { CODEXHOST_DATA_DIR: dir }, scriptPath: "/repo/bin/mainline.mjs" })).toBe(
      path.join(dir, "host-extension-data", "second-brain"),
    );
  });

  it("runs the agent workflow: mainline, milestones, tasks, refinement", async () => {
    const cli = harness({ CODEXHOST_THREAD_ID: "t1" });
    const created = await cli.run("new", "修复结算页窄屏错位", "--tags", "shop-web,结算页", "--plan", "定位原因|提交 PR|合并验证");
    expect(created.out).toContain("✓ 主线：「修复结算页窄屏错位」，3 个里程碑");
    expect(created.out).toContain("#shop-web #结算页");
    expect((await cli.run("doing", "读样式断点")).out).toContain("✓ 正在做：读样式断点");
    expect((await cli.run("done")).out).toContain("✓ 完成：读样式断点（阶段「定位原因」）");
    expect((await cli.run("reach")).out).toContain("✓ 达成里程碑「定位原因」，下一阶段「提交 PR」");
    expect((await cli.run("title", "修复结算页在窄屏下错位")).out).toContain("在窄屏下错位");
    expect((await cli.run("tags", "add", "bugfix")).out).toContain("#bugfix");
    expect((await cli.run("milestone", "add", "写回归测试")).out).toContain("✓ 里程碑已添加：「写回归测试」");
    const shown = await cli.run("show");
    expect(shown.out).toContain("里程碑（1/4）：✓ 定位原因 → ● 提交 PR → ○ 合并验证 → ○ 写回归测试");
    expect(shown.out).toContain(path.join(dir, "bin", "mainline"));
    const json = JSON.parse((await cli.run("show", "--json")).out) as { current: { title: string }; settings: unknown };
    expect(json.current.title).toBe("提交 PR");
    expect(json.settings).toEqual({ driftPolicy: "ask", showCapsule: false, prAlerts: true, autoSummarize: true, summarizeModel: "follow", summarizeOthers: "none" });
    expect((await cli.run("list")).out).toContain("◆ 1/4 当前：提交 PR · t1");
    expect((await cli.run("finish")).out).toContain("✓ 状态：已完成");
  });

  it("saves the previous reply or a passage to the favorites, lists and removes them", async () => {
    const turns = {
      readTurns: async () => ({
        totalTurns: 3,
        turns: [
          { turnNumber: 3, status: "running", messages: [{ role: "user" as const, text: "收藏上一条回复" }] },
          { turnNumber: 2, status: "completed", messages: [{ role: "user" as const, text: "怎么发布？" }, { role: "agent" as const, text: ':codex-annotation{index="1" id="x"} 先打 tag，再跑 release 脚本。' }] },
          { turnNumber: 1, status: "completed", messages: [{ role: "agent" as const, text: "项目用 vitest 跑测试，命令是 npm test。" }] },
        ],
      }),
    };
    const cli = harness({ CODEXHOST_THREAD_ID: "t1" }, undefined, turns);
    await cli.run("new", "整理发布流程");
    const last = await cli.run("fav", "last");
    expect(last.out).toContain("✓ 已收藏第 2 轮的：先打 tag，再跑 release 脚本。");
    expect((await cli.run("fav", "last")).out).toContain("这段之前已经收藏过");
    expect((await cli.run("fav", "用 vitest 跑测试")).out).toContain("✓ 已收藏第 1 轮的：用 vitest 跑测试");
    const listed = await cli.run("fav", "list");
    expect(listed.out.split("\n").filter(Boolean)).toHaveLength(2);
    expect(listed.out).toContain("「整理发布流程」第 2 轮");
    const items = JSON.parse((await cli.run("fav", "list", "tag", "--json")).out) as Array<{ id: string; source: string; role: string }>;
    expect(items).toMatchObject([{ source: "chat", role: "agent" }]);
    expect((await cli.run("fav", "remove", items[0]!.id)).out).toContain("✓ 已取消收藏");
    expect((await cli.run("fav", "remove", items[0]!.id)).code).toBe(1);
    expect((await cli.run("show")).out).toContain("mainline fav last");
  });

  it("notes spin-offs and opens child conversations for them", async () => {
    const started: Array<Record<string, unknown>> = [];
    const delegation = {
      readThread: async () => ({ harnessId: "claude-code" }),
      threadCwd: async () => "/work",
      startDelegation: async (body: Record<string, unknown>) => {
        started.push(body);
        return { threadId: "child-1" };
      },
    };
    const cli = harness({ CODEXHOST_THREAD_ID: "p" }, delegation);
    await cli.run("new", "修复结算页", "--plan", "定位|修复");
    const noted = await cli.run("spinoff", "手机端菜单图标重叠");
    const id = /编号 (\S+?)）/u.exec(noted.out)?.[1] ?? "";
    expect(noted.out).toContain(`mainline spawn ${id}`);
    const spawned = await cli.run("spawn", id);
    expect(spawned.out).toContain("✓ 已开子对话「手机端菜单图标重叠」（child-1）");
    expect(started[0]).toMatchObject({ harnessId: "claude-code", parentThreadId: "p", cwd: "/work", taskName: "手机端菜单图标重叠" });
    const state = await readState(storePaths(dir));
    expect(state.conversations["child-1"]).toMatchObject({ title: "手机端菜单图标重叠", parentId: "p" });
    const second = /编号 (\S+?)）/u.exec((await cli.run("spinoff", "视频点不开")).out)?.[1] ?? "";
    expect((await cli.run("keep", second)).out).toContain("✓ 改为在本对话处理：视频点不开");
    const third = /编号 (\S+?)）/u.exec((await cli.run("spinoff", "错别字")).out)?.[1] ?? "";
    expect((await cli.run("dismiss", third)).out).toContain("✓ 已忽略");
  });

  it("records links and finds conversations by number or words", async () => {
    const cli = harness({ CODEXHOST_THREAD_ID: "t-side" });
    await cli.run("new", "修复购物车商品丢失", "--tags", "shop-web,购物车");
    const linked = await cli.run("link", "https://github.com/acme/widgets/pull/42", "切换页面时保留商品");
    expect(linked.out).toContain("acme/widgets#42");
    const other = harness({ CODEXHOST_THREAD_ID: "t-other" });
    const byNumber = await other.run("find", "42");
    expect(byNumber.out).toContain("「修复购物车商品丢失」 #shop-web #购物车");
    expect(byNumber.out).toContain("对话：t-side");
    expect(byNumber.out).toContain("命中PR/Issue");
    // Looked up on GitHub before answering: the agent sees the PR as it is now.
    expect(byNumber.out).toContain("PR/Issue：PR #42 已合并「Keep the cart when switching pages」");
    expect(other.looked).toEqual(["repos/acme/widgets/issues/42"]);
    expect((await other.run("find", "购物车")).out).toContain("t-side");
    expect((await other.run("find", "9999")).out).toContain("没有找到「9999」");
    expect((await other.run("link", "not-a-link")).code).toBe(1);
  });

  it("explains errors", async () => {
    const noThread = await harness().run("show");
    expect(noThread.code).toBe(1);
    expect(noThread.err).toContain("CODEXHOST_THREAD_ID");
    // With model summaries (the default) agents are not sent to write a mainline by hand.
    const noMainline = await harness({ CODEXHOST_THREAD_ID: "t1" }).run("reach");
    expect(noMainline.err).toContain("mainline doing");
    expect(noMainline.err).not.toContain("mainline new");
    await writeFile(path.join(dir, "settings.json"), JSON.stringify({ values: { autoSummarize: false } }));
    expect((await harness({ CODEXHOST_THREAD_ID: "t1" }).run("reach")).err).toContain("mainline new");
    const unknown = await harness({ CODEXHOST_THREAD_ID: "t1" }).run("show", "--json");
    expect(JSON.parse(unknown.out)).toMatchObject({ draft: true });
    expect((await harness().run("bogus")).code).toBe(1);
  });

  it("asks for a backfill, says which conversations it leaves out, and keeps one under way", async () => {
    const zh = await harness().run("summarize", "--all");
    expect(zh.code).toBe(0);
    expect(zh.out).toContain("Claude Code 和 Codex 以外的 Agent 的对话不会发给模型，除非在设置里为它们选了模型");
    const requestedAt = (await readState(storePaths(dir))).jobs?.backfill?.requestedAt;
    expect(requestedAt).toBe(1_700_000_000_000);
    const later = harness({ LANG: "en_US.UTF-8" });
    later.io.now = () => 1_700_000_600_000;
    const en = await later.run("summarize", "--all");
    expect(en.out).toContain("not sent to a model unless the settings choose one for them");
    expect((await readState(storePaths(dir))).jobs?.backfill?.requestedAt).toBe(requestedAt);
    expect((await harness().run("summarize")).code).toBe(1);
  });

  it("serves the Claude Code hook", async () => {
    const cli = harness({ CODEXHOST_THREAD_ID: "t1" });
    let out = "";
    const io = {
      ...cli.io,
      readStdin: async () => JSON.stringify({ prompt: "顺便看下图标", hook_event_name: "UserPromptSubmit" }),
      stdout: (text: string) => {
        out += text;
      },
    };
    expect(await run(["hook", "claude-prompt"], io)).toBe(0);
    const payload = JSON.parse(out) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(payload.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(payload.hookSpecificOutput.additionalContext).toContain("本对话还没有主线");
    expect((await readState(storePaths(dir))).prompts.t1?.text).toBe("顺便看下图标");
    let silent = "";
    const outside = { ...harness().io, stdout: (text: string) => (silent += text) };
    expect(await run(["hook", "claude-prompt"], outside)).toBe(0);
    expect(silent).toBe("");
  });
});
