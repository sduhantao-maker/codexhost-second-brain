/** Recording work in a conversation that has no mainline yet starts one from its draft. */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run, type CliIo } from "../src/cli/main.js";
import { deleteConversation, isExcluded, recordPromptV2 } from "../src/core/conversation-ops.js";
import { refsPaths, updateIndex } from "../src/node/refs-store.js";
import { readState, storePaths, updateState } from "../src/node/store.js";

const NOW = Date.parse("2026-11-24T08:00:00Z");
const DRAFT = "5f0c9a1e-0000-4000-8000-000000000001";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "mainline-drafts-"));
  await updateIndex(refsPaths(dir), (index) => {
    index.threads[DRAFT] = { turns: 2, updatedAt: "2026-11-24T07:59:00Z", scannedAt: 1, title: "检查登录页样式", firstPrompt: "把登录页的样式再检查一遍", cwd: "/work/shop" };
    index.threads.second = { turns: 1, updatedAt: "2026-11-24T07:59:00Z", scannedAt: 1, firstPrompt: "给登录页加上记住我" };
  });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function cli(threadId: string, ...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const io: CliIo = {
    env: { MAINLINE_DATA_DIR: dir, LANG: "zh_CN.UTF-8", CODEXHOST_THREAD_ID: threadId },
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    now: () => NOW,
  };
  return { code: await run(argv, io), out, err };
}

const conversation = async (threadId: string) => (await readState(storePaths(dir))).conversations[threadId];

describe("work recorded in a draft", () => {
  it("doing starts the mainline from the draft's title and tags", async () => {
    const doing = await cli(DRAFT, "doing", "列出错位的按钮");
    expect(doing).toMatchObject({ code: 0, out: "✓ 正在做：列出错位的按钮\n" });
    expect(await conversation(DRAFT)).toMatchObject({
      title: "检查登录页样式",
      tags: ["shop"],
      status: "active",
      now: { text: "列出错位的按钮" },
      milestones: [{ title: "第 1 阶段", state: "current", tasks: [{ text: "列出错位的按钮", done: false }] }],
    });
    // From then on it is an ordinary mainline.
    expect((await cli(DRAFT, "done")).out).toContain("✓ 完成：列出错位的按钮（阶段「第 1 阶段」）");
  });

  it("task and done take what started the conversation, else its latest message, as the title", async () => {
    expect((await cli("second", "task", "写回归测试")).out).toContain("✓ 支线任务：写回归测试");
    expect(await conversation("second")).toMatchObject({ title: "给登录页加上记住我", milestones: [{ tasks: [{ text: "写回归测试", done: false }] }] });
    await updateState(storePaths(dir), (draft, ctx) => recordPromptV2(draft, "third", "导出按钮点了没反应，帮我修一下", ctx));
    expect((await cli("third", "done", "修好导出按钮")).out).toContain("✓ 完成：修好导出按钮");
    expect(await conversation("third")).toMatchObject({ title: "导出按钮点了没反应，帮我修一下", milestones: [{ tasks: [{ text: "修好导出按钮", done: true }] }] });
  });

  it("a spin-off noted in a draft keeps the new problem out of the title", async () => {
    const noted = await cli("fourth-0000-4000", "spinoff", "顺便看看图标");
    expect(noted.out).toContain("✓ 记下引申问题：顺便看看图标");
    expect(await conversation("fourth-0000-4000")).toMatchObject({ title: "#fourth-0", spinoffs: [{ text: "顺便看看图标", state: "open" }] });
  });

  it("starts nothing when there is nothing to record", async () => {
    const done = await cli(DRAFT, "done");
    expect(done.code).toBe(1);
    expect(done.err).toContain("Which task");
    expect((await cli(DRAFT, "doing", "--clear")).out).toBe("✓ 已清除「正在做」\n");
    expect(await conversation(DRAFT)).toBeUndefined();
    // Commands about the mainline itself still say there is none, without sending the agent to write one.
    const title = await cli(DRAFT, "title", "新标题");
    expect(title.code).toBe(1);
    expect(title.err).toContain("本对话还没有主线");
    expect(title.err).not.toContain("mainline new");
  });

  it("does not bring back a mainline the user deleted; asking for one with new does", async () => {
    await cli(DRAFT, "new", "检查登录页样式");
    await updateState(storePaths(dir), (draft, ctx) => deleteConversation(draft, DRAFT, ctx));
    for (const argv of [["doing", "列出错位的按钮"], ["task", "写回归测试"], ["done", "修好导出按钮"], ["spinoff", "顺便看看图标"], ["title", "新标题"]]) {
      const refused = await cli(DRAFT, ...argv);
      expect(refused.code).toBe(1);
      expect(refused.err).toContain("用户删除了本对话的主线");
    }
    const state = await readState(storePaths(dir));
    expect(state.conversations[DRAFT]).toBeUndefined();
    expect(isExcluded(state, DRAFT)).toBe(true);
    expect((await cli(DRAFT, "new", "重新建立的主线")).code).toBe(0);
    expect(isExcluded(await readState(storePaths(dir)), DRAFT)).toBe(false);
  });

  it("explains a reach without a current milestone as that, not as a missing mainline", async () => {
    await cli(DRAFT, "new", "发布插件", "--plan", "合并");
    expect((await cli(DRAFT, "reach")).code).toBe(0);
    const again = await cli(DRAFT, "reach");
    expect(again.code).toBe(1);
    expect(again.err).toContain("没有当前里程碑可以达成");
  });
});
