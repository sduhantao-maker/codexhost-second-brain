import { describe, expect, it } from "vitest";
import { currentMilestone, emptyStateV2 } from "../src/core/conversation.js";
import { applyMutationV2 } from "../src/backend/mutate-v2.js";
import {
  addSpinoff,
  addTask,
  applySummary,
  completeTask,
  createConversation,
  dismissSpinoff,
  focusMilestone,
  keepSpinoff,
  linkSpinoff,
  noteParents,
  planMilestones,
  reachMilestone,
  recordPromptV2,
  removeMilestone,
  setDoing,
  setTags,
} from "../src/core/conversation-ops.js";
import { conversationView } from "../src/core/conversation-view.js";
import { agentContextV2 } from "../src/core/protocol-v2.js";
import { emptyIndex, extractLinks, addMention } from "../src/core/refs.js";
import { searchConversations } from "../src/core/search.js";
import { childTask, spawnChild } from "../src/node/delegate.js";
import { ref42, sampleSources, sampleState, T } from "./fixtures/v2.js";

const ctx = (now = 1000) => ({ now });

describe("conversation ops", () => {
  it("creates a mainline with planned milestones and walks through them", () => {
    const state = emptyStateV2();
    createConversation(state, "c", { title: "修复结算页错位", tags: "shop-web,结算页", milestones: ["定位原因", "提交 PR", "合并验证"] }, ctx());
    const conversation = state.conversations.c!;
    expect(conversation.milestones.map(({ title, state: s }) => [title, s])).toEqual([
      ["定位原因", "current"],
      ["提交 PR", "planned"],
      ["合并验证", "planned"],
    ]);
    setDoing(state, "c", "读样式断点", ctx(2000));
    expect(currentMilestone(conversation)?.tasks.map(({ text, done }) => [text, done])).toEqual([["读样式断点", false]]);
    completeTask(state, "c", ctx(3000), {});
    expect(conversation.now).toBeUndefined();
    expect(currentMilestone(conversation)?.tasks[0]).toMatchObject({ done: true, doneAt: 3000 });
    const { reached, next } = reachMilestone(state, "c", ctx(4000));
    expect([reached.title, reached.state, next?.title, next?.state]).toEqual(["定位原因", "done", "提交 PR", "current"]);
    completeTask(state, "c", ctx(5000), { text: "补测试" });
    expect(currentMilestone(conversation)?.tasks.map(({ text, done }) => [text, done])).toEqual([["补测试", true]]);
    focusMilestone(state, "c", reached.id, ctx(6000));
    expect(currentMilestone(conversation)?.title).toBe("定位原因");
    expect(conversation.milestones.find(({ title }) => title === "提交 PR")?.state).toBe("planned");
  });

  it("carries unfinished tasks, and the one in progress, on to the next milestone", () => {
    const state = emptyStateV2();
    createConversation(state, "c", { title: "发布插件", milestones: ["合并分支", "真机验证"] }, ctx());
    addTask(state, "c", "写发布说明", ctx(2000));
    setDoing(state, "c", "跑真机截图", ctx(3000));
    completeTask(state, "c", ctx(4000), { text: "合并 hover 分支" });
    const { reached, next } = reachMilestone(state, "c", ctx(5000));
    expect(reached.tasks.map(({ text }) => text)).toEqual(["合并 hover 分支"]);
    expect(next?.tasks.map(({ text, done }) => [text, done])).toEqual([
      ["写发布说明", false],
      ["跑真机截图", false],
    ]);
    expect(state.conversations.c!.now?.text).toBe("跑真机截图");
    // With no milestone left, the task in progress ends with the last one.
    reachMilestone(state, "c", ctx(6000));
    expect(state.conversations.c!.now).toBeUndefined();
  });

  it("opens a stage when work starts without a plan, and refines on a second new", () => {
    const state = emptyStateV2();
    createConversation(state, "c", { title: "修复登录页样式" }, ctx());
    setDoing(state, "c", "整理样式表", ctx());
    expect(state.conversations.c!.milestones.map(({ title, state: s }) => [title, s])).toEqual([["第 1 阶段", "current"]]);
    createConversation(state, "c", { title: "修复登录页样式：按钮与表单对齐", tags: ["登录页", "CSS"], milestones: ["样式定稿"] }, ctx(2000));
    expect(state.conversations.c).toMatchObject({ title: "修复登录页样式：按钮与表单对齐", tags: ["登录页", "CSS"] });
    expect(state.conversations.c!.milestones.map(({ title }) => title)).toEqual(["第 1 阶段", "样式定稿"]);
    planMilestones(state, "c", ["表单部分", "样式定稿"], ctx());
    expect(state.conversations.c!.milestones.map(({ title }) => title)).toEqual(["第 1 阶段", "样式定稿", "表单部分"]);
  });

  it("keeps open tasks when a milestone is removed", () => {
    const state = emptyStateV2();
    createConversation(state, "c", { title: "T", milestones: ["A", "B"] }, ctx());
    setDoing(state, "c", "open task", ctx());
    const a = state.conversations.c!.milestones[0]!;
    removeMilestone(state, "c", a.id, ctx());
    expect(currentMilestone(state.conversations.c!)?.title).toBe("B");
    expect(currentMilestone(state.conversations.c!)?.tasks.map(({ text }) => text)).toEqual(["open task"]);
  });

  it("turns spin-offs into child conversations, tasks or nothing", () => {
    const state = emptyStateV2();
    createConversation(state, "p", { title: "修复结算页", tags: ["shop-web", "结算页", "bugfix", "x"] }, ctx());
    const a = addSpinoff(state, "p", "手机端菜单图标重叠", ctx());
    expect(addSpinoff(state, "p", "手机端菜单图标重叠", ctx()).id).toBe(a.id);
    linkSpinoff(state, "p", a.id, "child", ctx(2000));
    expect(state.conversations.p!.spinoffs[0]).toMatchObject({ state: "spawned", childThreadId: "child" });
    expect(state.conversations.child).toMatchObject({ title: "手机端菜单图标重叠", parentId: "p", tags: ["shop-web", "结算页", "bugfix"] });
    const b = addSpinoff(state, "p", "视频点不开", ctx());
    keepSpinoff(state, "p", b.id, ctx());
    expect(currentMilestone(state.conversations.p!)?.tasks.map(({ text }) => text)).toEqual(["视频点不开"]);
    const c = addSpinoff(state, "p", "顺手改个错别字", ctx());
    dismissSpinoff(state, "p", c.id, ctx());
    expect(state.conversations.p!.spinoffs.map(({ state: s }) => s)).toEqual(["spawned", "dismissed"]);
    setTags(state, "p", "#a, b", ctx());
    expect(state.conversations.p!.tags).toEqual(["a", "b"]);
    expect(noteParents(state, new Map([["child", "p"]]))).toBe(false);
    expect(recordPromptV2(state, "x", "# Files mentioned by the user:\n## a.png: /a.png\n## My request:\n看看这个", ctx())).toBe(true);
    expect(state.prompts.x?.text).toBe("看看这个");
  });
});

describe("search", () => {
  it("finds conversations by number, tag, milestone, words and drafts", () => {
    const sources = sampleSources();
    const index = emptyIndex();
    const [link] = extractLinks(ref42.url);
    addMention(index, link!, { threadId: T.main, turn: 3, at: 1, role: "agent", prompt: "手机上结算按钮还是点不到" });
    index.refs[ref42.key]!.title = ref42.title!;
    index.threads[T.old] = { turns: 2, updatedAt: "2026-11-01T00:00:00Z", scannedAt: 1, title: "登录页样式检查", firstPrompt: "把登录页的样式再检查一遍" };
    const search = (query: string) => searchConversations({ sources, index, query });
    expect(search("42").map(({ threadId, match }) => [threadId, match.field])).toEqual([[T.main, "ref"]]);
    expect(search("手机端")[0]).toMatchObject({ threadId: T.child, match: { field: "tag" } });
    expect(search("维护者审查")[0]).toMatchObject({ threadId: T.main, current: "维护者审查", progress: { done: 2, total: 4 } });
    expect(search("登录页")[0]).toMatchObject({ threadId: T.old, draft: true });
    expect(search("菜单 重叠").map(({ threadId }) => threadId)).toContain(T.child);
    expect(search("   ")).toEqual([]);
  });
});

describe("protocol v2", () => {
  it("tells agents the milestones, current tasks and the rules", () => {
    const text = agentContextV2(conversationView(T.main, sampleSources()), { cli: "/x/mainline", policy: "ask", locale: "zh-CN" });
    expect(text).toContain("【主线】本对话：「修复结算页在窄屏下错位」 #shop-web #结算页 #bugfix #PR #42");
    expect(text).toContain("里程碑（2/4）：✓ 定位原因：窄屏断点漏了结算页 → ✓ 提交 PR #42 → ● 维护者审查 → ○ 合并后验证");
    expect(text).toContain("▸ 回复 review 意见（正在做）");
    expect(text).toContain("修手机端菜单图标重叠（子对话「修复手机端菜单图标和标题重叠」）");
    expect(text).toContain("商品页的视频点开没反应（未处理，编号 s2）");
    expect(text).toContain("mainline spawn <编号>");
    expect(text).toContain("/x/mainline");
    const child = agentContextV2(conversationView(T.child, sampleSources()), { cli: "c", policy: "off", locale: "zh-CN" });
    expect(child).toContain("来自父对话：「修复结算页在窄屏下错位」");
    expect(child).not.toContain("mainline spawn");
    const draft = agentContextV2(conversationView(T.old, sampleSources()), { cli: "c", policy: "ask", locale: "en" });
    expect(draft).toContain('Draft: "登录页样式检查"');
    expect(draft).toContain("mainline new");
  });
});

describe("spawn a child conversation", () => {
  it("starts a delegation under the parent with the parent's agent and folder", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const childId = await spawnChild(
      {
        readThread: async () => ({ harnessId: "codex", title: "parent" }),
        threadCwd: async () => "/work/repo",
        startDelegation: async (body) => {
          calls.push(body);
          return { threadId: "child-1" };
        },
      },
      { parentThreadId: "p", problem: "手机端菜单图标重叠", parentTitle: "修复结算页", currentMilestone: "维护者审查", locale: "zh-CN" },
    );
    expect(childId).toBe("child-1");
    expect(calls[0]).toMatchObject({ harnessId: "codex", parentThreadId: "p", cwd: "/work/repo", taskName: "手机端菜单图标重叠" });
    expect(String(calls[0]!.task)).toContain("这是从对话「修复结算页」引申出的新问题");
    expect(childTask({ parentThreadId: "p", problem: "x", parentTitle: "y", locale: "en" })).toContain('came up in the conversation "y"');
  });
});

describe("model summaries", () => {
  const record = { at: 9_000, model: "claude-haiku" };

  it("gives an old conversation a mainline from the summary, dated by its own activity and marked by how it ended", () => {
    const state = emptyStateV2();
    const old = Date.parse("2026-10-01T00:00:00Z");
    const now = Date.parse("2026-11-23T00:00:00Z");
    applySummary(
      state,
      "old",
      { title: "检查登录页按钮对齐", tags: ["登录页", "widgets", "按钮"], milestones: [{ title: "列出错位的按钮", state: "done" }, { title: "重排", state: "current" }], finished: false },
      record,
      { now, activityAt: old },
    );
    expect(state.conversations.old).toMatchObject({ title: "检查登录页按钮对齐", status: "paused", createdAt: old, updatedAt: old, summary: record });
    expect(state.conversations.old!.milestones.map(({ title, state: s }) => [title, s])).toEqual([
      ["列出错位的按钮", "done"],
      ["重排", "current"],
    ]);
    applySummary(state, "done-one", { title: "导出 PDF", tags: [], milestones: [], finished: true }, record, { now, activityAt: old });
    expect(state.conversations["done-one"]!.status).toBe("done");
  });

  it("follows the model on whether the work is done, unless the user set the status or a task is under way", () => {
    const state = emptyStateV2();
    const now = Date.parse("2026-11-23T00:00:00Z");
    const finished = { title: "导出 PDF", tags: [], milestones: [{ title: "导出", state: "done" as const }], finished: true };
    applySummary(state, "c", finished, record, { now, activityAt: now - 60_000 });
    expect(state.conversations.c!.status).toBe("done");
    expect(state.conversations.c!.summary?.finished).toBe(true);
    applySummary(state, "c", { ...finished, finished: false }, record, { now, activityAt: now - 60_000 });
    expect(state.conversations.c!.status).toBe("active");
    // The user marks it paused by hand: summaries leave the status alone.
    applyMutationV2(state, { op: "status", threadId: "c", status: "paused" }, { now });
    applySummary(state, "c", finished, record, { now, activityAt: now - 60_000 });
    expect(state.conversations.c!.status).toBe("paused");
    // An agent in the middle of a task keeps it active.
    applyMutationV2(state, { op: "unpin", threadId: "c" }, { now });
    applyMutationV2(state, { op: "status", threadId: "c", status: "active" }, { now });
    applyMutationV2(state, { op: "unpin", threadId: "c" }, { now });
    setDoing(state, "c", "再导出一版", { now });
    applySummary(state, "c", finished, record, { now, activityAt: now - 60_000 });
    expect(state.conversations.c!.status).toBe("active");
  });

  it("refines a mainline but keeps what the user changed by hand, reached milestones and the agent's tasks", () => {
    const state = sampleState();
    const ctx = { now: Date.parse("2026-11-23T09:00:00Z") };
    // The user renamed the title and added a milestone of their own, and removed one.
    applyMutationV2(state, { op: "title", threadId: T.main, title: "修结算页「窄屏错位」" }, ctx);
    const mine = applyMutationV2(state, { op: "milestoneAdd", threadId: T.main, title: "写回归测试" }, ctx) as string;
    applyMutationV2(state, { op: "milestoneRemove", threadId: T.main, milestoneId: "m4" }, ctx);
    applySummary(
      state,
      T.main,
      {
        title: "修复结算页在窄屏下的断点",
        tags: ["shop-web", "结算页", "断点", "PR #42"],
        milestones: [
          { title: "定位原因：窄屏断点漏了结算页", state: "current" },
          { title: "提交 PR #42", state: "done" },
          { title: "回复维护者审查意见", state: "current" },
          { title: "合并后验证", state: "planned" },
        ],
        finished: false,
      },
      record,
      ctx,
    );
    const conversation = state.conversations[T.main]!;
    expect(conversation.title).toBe("修结算页「窄屏错位」");
    expect(conversation.tags).toEqual(["shop-web", "结算页", "断点", "PR #42"]);
    expect(conversation.milestones.map(({ title, state: s }) => [title, s])).toEqual([
      ["定位原因：窄屏断点漏了结算页", "done"],
      ["提交 PR #42", "done"],
      ["回复维护者审查意见", "current"],
      ["写回归测试", "planned"],
    ]);
    // Kept milestones keep their ids and tasks; the dropped one's open tasks move to the current one.
    expect(conversation.milestones[0]!.id).toBe("m1");
    expect(conversation.milestones[0]!.tasks).toHaveLength(2);
    expect(conversation.milestones[2]!.tasks.map(({ text }) => text)).toEqual(["回复 review 意见", "修手机端菜单图标重叠"]);
    expect(conversation.milestones[3]!.id).toBe(mine);
    expect(conversation.now?.text).toBe("回复 review 意见");
    // Restoring automatic summaries lets the next one change everything again.
    applyMutationV2(state, { op: "unpin", threadId: T.main }, ctx);
    applySummary(state, T.main, { title: "修复结算页窄屏错位", tags: ["shop-web"], milestones: [{ title: "合并后验证", state: "current" }], finished: false }, record, ctx);
    expect(conversation.title).toBe("修复结算页窄屏错位");
    expect(conversation.milestones.map(({ title }) => title)).toEqual(["定位原因：窄屏断点漏了结算页", "提交 PR #42", "合并后验证"]);
  });
});

describe("agent rules with model summaries", () => {
  it("asks agents only for tasks when a model keeps the title, tags and milestones", () => {
    const view = conversationView(T.main, sampleSources());
    const manual = agentContextV2(view, { cli: "/bin/mainline", policy: "ask", locale: "zh-CN" });
    const model = agentContextV2(view, { cli: "/bin/mainline", policy: "ask", locale: "zh-CN", summaries: true });
    expect(manual).toContain("mainline plan");
    expect(model).not.toContain("mainline plan");
    expect(model).not.toContain("mainline title");
    expect(model).toContain("由插件在每轮结束后调用模型自动凝练");
    expect(model).toContain('mainline doing "…"');
    expect(model.length).toBeLessThan(manual.length);
    const draft = agentContextV2(conversationView(T.old, sampleSources()), { cli: "/bin/mainline", policy: "ask", locale: "zh-CN", summaries: true });
    expect(draft).not.toContain("mainline new");
  });
});

describe("a long run of reached milestones", () => {
  it("makes the next planned stage current when the model names none, and the agent line shows the latest ones", () => {
    const state = emptyStateV2();
    const now = Date.parse("2026-11-23T00:00:00Z");
    const reached = Array.from({ length: 9 }, (_, i) => ({ title: `阶段 ${i + 1}`, state: "done" as const }));
    applySummary(
      state,
      "c",
      { title: "开发插件", tags: [], milestones: [...reached, { title: "你试用并反馈", state: "planned" }, { title: "发布", state: "planned" }], finished: false },
      { at: now, model: "m" },
      { now, activityAt: now },
    );
    const conversation = state.conversations.c!;
    expect(conversation.milestones.map(({ state: s }) => s).slice(-2)).toEqual(["current", "planned"]);
    const line = agentContextV2(conversationView("c", { state, info: {}, parents: {} }), { cli: "m", policy: "off", locale: "zh-CN" }).split("\n")[1]!;
    expect(line).toContain("✓ 前面 6 个已达成 → ✓ 阶段 7");
    expect(line).toContain("● 你试用并反馈");
    expect(line).not.toContain("阶段 1 ");
  });
});
