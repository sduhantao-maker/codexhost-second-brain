import { describe, expect, it } from "vitest";
import { cleanTags, currentMilestone, migrateV1, normalizeStateV2, progressOf } from "../src/core/conversation.js";
import { draftTags } from "../src/core/conversation-view.js";
import { v1State } from "./fixtures/v1.js";
import { refWidgets, sampleState, sampleView, T } from "./fixtures/v2.js";

describe("mainline v2 model", () => {
  it("cleans tags", () => {
    expect(cleanTags("#shop-web, 结算页，shop-web、 bugfix ")).toEqual(["shop-web", "结算页", "bugfix"]);
    expect(cleanTags(Array.from({ length: 12 }, (_, i) => `t${i}`))).toHaveLength(8);
  });

  it("reads its own files back and keeps one current milestone", () => {
    const raw = JSON.parse(JSON.stringify(sampleState())) as ReturnType<typeof sampleState>;
    raw.conversations[T.main]!.milestones[3]!.state = "current";
    const state = normalizeStateV2(raw);
    expect(state.conversations[T.main]!.milestones.filter((milestone) => milestone.state === "current")).toHaveLength(1);
    expect(currentMilestone(state.conversations[T.main]!)?.id).toBe("m3");
    expect(progressOf(state.conversations[T.main]!)).toEqual({ done: 2, total: 4 });
    expect(() => normalizeStateV2({ version: 9 })).toThrow();
  });

  it("moves a v1 mainline to its main window only", () => {
    const v1 = v1State();
    const state = migrateV1(v1);
    expect(Object.keys(state.conversations)).toEqual(["main"]);
    const conversation = state.conversations.main!;
    expect(conversation).toMatchObject({ title: "开发主线插件", status: "active", now: { text: "写迁移" } });
    expect(conversation.milestones.map(({ title, state: s }) => [title, s])).toEqual([["设计确认", "done"]]);
    expect(conversation.spinoffs.map(({ text, state: s }) => [text, s])).toEqual([["侧栏图标错位", "open"]]);
    expect(state.prompts.unrelated?.text).toBe("把屋子填满");
    expect(normalizeStateV2(JSON.parse(JSON.stringify(v1))).conversations.main?.title).toBe("开发主线插件");
  });
});

describe("conversation view", () => {
  it("shows milestones, the current one, children and the parent", () => {
    const view = sampleView(T.main);
    expect(view.draft).toBe(false);
    expect(view.current?.title).toBe("维护者审查");
    expect(view.progress).toEqual({ done: 2, total: 4 });
    expect(view.current?.tasks.find((task) => task.threadId === T.child)?.threadTitle).toBe("修复手机端菜单图标和标题重叠");
    expect(view.children.map(({ threadId, threadStatus, current }) => [threadId, threadStatus, current])).toEqual([[T.child, "waiting", "定位样式来源"]]);
    expect(view.spinoffs.map(({ id }) => id)).toEqual(["s1", "s2"]);
    expect(view.refs.map(({ number }) => number)).toEqual([42]);
    const child = sampleView(T.child);
    expect(child.parent).toMatchObject({ threadId: T.main, title: "修复结算页在窄屏下错位" });
  });

  it("builds a draft for a conversation without a mainline", () => {
    const view = sampleView(T.old);
    expect(view).toMatchObject({ draft: true, title: "登录页样式检查", firstPrompt: "把登录页的样式再检查一遍，错位的列出来" });
    expect(view.tags).toEqual(["shop", "widgets", "Issue #3"]);
    expect(view.lastPrompt?.text).toBe("把登录页的样式再检查一遍");
    expect(draftTags({ refs: [refWidgets], workspace: "shop" })).toEqual(["shop", "widgets", "Issue #3"]);
    expect(sampleView(T.other)).toMatchObject({ draft: true, title: "#44444444", tags: [] });
  });
});
