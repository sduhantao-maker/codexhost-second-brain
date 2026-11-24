/**
 * Sample mainline v2 data for tests of the hover card, the in-conversation card and the overview
 * page. Realistic on purpose: a conversation with milestones and tasks, a spin-off already opened
 * as a child conversation, an open spin-off, and an old conversation that only has a draft.
 */
import type { StateV2 } from "../../src/core/conversation.js";
import { conversationView, type ConversationView, type DraftFacts, type ViewSources } from "../../src/core/conversation-view.js";
import type { ThreadInfo } from "../../src/core/model.js";
import type { RefView } from "../../src/core/refs.js";
import type { SearchResult, SnapshotResultV2 } from "../../src/core/rpc.js";

export const T = {
  main: "11111111-aaaa-4aaa-8aaa-111111111111",
  child: "22222222-bbbb-4bbb-8bbb-222222222222",
  old: "33333333-cccc-4ccc-8ccc-333333333333",
  other: "44444444-dddd-4ddd-8ddd-444444444444",
} as const;

export const NOW = Date.parse("2026-11-23T08:00:00Z");
const ago = (minutes: number) => NOW - minutes * 60_000;

export function sampleState(): StateV2 {
  return {
    version: 2,
    rev: 7,
    locale: "zh-CN",
    conversations: {
      [T.main]: {
        threadId: T.main,
        title: "修复结算页在窄屏下错位",
        tags: ["shop-web", "结算页", "bugfix", "PR #42"],
        status: "active",
        milestones: [
          {
            id: "m1",
            title: "定位原因：窄屏断点漏了结算页",
            state: "done",
            doneAt: ago(300),
            tasks: [
              { id: "t1", text: "录屏复现", done: true, at: ago(340), doneAt: ago(330) },
              { id: "t2", text: "读 CheckoutForm 的样式断点", done: true, at: ago(320), doneAt: ago(300) },
            ],
          },
          { id: "m2", title: "提交 PR #42", state: "done", doneAt: ago(200), tasks: [{ id: "t3", text: "补单元测试", done: true, at: ago(250), doneAt: ago(210) }] },
          {
            id: "m3",
            title: "维护者审查",
            state: "current",
            tasks: [
              { id: "t4", text: "回复 review 意见", done: false, at: ago(20) },
              { id: "t5", text: "修手机端菜单图标重叠", done: false, at: ago(15), threadId: T.child },
            ],
          },
          { id: "m4", title: "合并后验证", state: "planned", tasks: [] },
        ],
        now: { text: "回复 review 意见", at: ago(20) },
        spinoffs: [
          { id: "s1", text: "手机端菜单图标和标题重叠", at: ago(60), state: "spawned", childThreadId: T.child },
          { id: "s2", text: "商品页的视频点开没反应", at: ago(10), state: "open" },
        ],
        createdAt: ago(400),
        updatedAt: ago(10),
      },
      [T.child]: {
        threadId: T.child,
        title: "修复手机端菜单图标和标题重叠",
        tags: ["shop-web", "手机端", "Issue #57"],
        status: "active",
        milestones: [{ id: "c1", title: "定位样式来源", state: "current", tasks: [{ id: "ct1", text: "对比桌面端与手机端的菜单样式", done: false, at: ago(12) }] }],
        now: { text: "对比桌面端与手机端的菜单样式", at: ago(12) },
        spinoffs: [],
        parentId: T.main,
        createdAt: ago(60),
        updatedAt: ago(12),
      },
    },
    prompts: {
      [T.main]: { text: "维护者回复了 #42，帮我看看", at: ago(20) },
      [T.old]: { text: "把登录页的样式再检查一遍", at: ago(3000) },
    },
  };
}

export function sampleInfo(): Record<string, ThreadInfo> {
  return {
    [T.main]: { title: "结算页在手机上还是有问题，按钮压住了表单…", status: "running", harnessId: "claude-code" },
    [T.child]: { title: "修复手机端菜单图标和标题重叠", status: "waiting", harnessId: "claude-code" },
    [T.old]: { title: "登录页样式检查", status: "idle", harnessId: "codex" },
  };
}

export const ref42: RefView = {
  key: "acme/widgets#42",
  repo: "acme/widgets",
  number: 42,
  kind: "pr",
  url: "https://github.com/acme/widgets/pull/42",
  title: "fix(checkout): 窄屏下结算按钮不再压住表单",
  state: "open",
  origin: { threadId: T.main, title: "结算页在手机上还是有问题…", turn: 3, prompt: "手机上打开结算页，按钮压住了表单" },
  windows: 1,
  activity: { at: ago(25), reason: "comment", unseen: true },
  lastMentionAt: ago(200),
};

export const refWidgets: RefView = {
  key: "acme/widgets#3",
  repo: "acme/widgets",
  number: 3,
  kind: "issue",
  url: "https://github.com/acme/widgets/issues/3",
  title: "登录页按钮错位",
  state: "open",
  origin: { threadId: T.old, title: "登录页样式检查", turn: 1, prompt: "把登录页的样式再检查一遍" },
  windows: 1,
  lastMentionAt: ago(3000),
};

export function sampleSources(): ViewSources {
  const drafts: Record<string, DraftFacts> = {
    [T.old]: { title: "登录页样式检查", firstPrompt: "把登录页的样式再检查一遍，错位的列出来", workspace: "shop", refs: [refWidgets] },
  };
  return {
    state: sampleState(),
    info: sampleInfo(),
    parents: { [T.child]: T.main },
    refsOf: (threadId) => [ref42, refWidgets].filter((ref) => ref.origin?.threadId === threadId),
    draftOf: (threadId) => drafts[threadId],
  };
}

export function sampleView(threadId: string = T.main): ConversationView {
  return conversationView(threadId, sampleSources());
}

export function sampleSnapshot(): SnapshotResultV2 {
  return {
    version: "v2-sample",
    state: sampleState(),
    info: sampleInfo(),
    settings: { driftPolicy: "ask", showCapsule: true, prAlerts: true, autoSummarize: true, summarizeModel: "follow", summarizeOthers: "none" },
    command: "/home/me/.codexhost/host-extension-data/second-brain/bin/mainline",
    alerts: [ref42],
    parents: { [T.child]: T.main },
  };
}

export function sampleSearchResults(): SearchResult[] {
  return [
    {
      threadId: T.main,
      title: "修复结算页在窄屏下错位",
      tags: ["shop-web", "结算页", "bugfix", "PR #42"],
      status: "active",
      draft: false,
      current: "维护者审查",
      progress: { done: 2, total: 4 },
      match: { field: "ref", text: "PR #42 fix(checkout): 窄屏下结算按钮不再压住表单" },
      refs: [ref42.key],
      threadStatus: "running",
      updatedAt: ago(10),
    },
    {
      threadId: T.old,
      title: "登录页样式检查",
      tags: ["shop", "widgets", "Issue #3"],
      status: "active",
      draft: true,
      progress: { done: 0, total: 0 },
      match: { field: "prompt", text: "把登录页的样式再检查一遍，错位的列出来" },
      refs: [refWidgets.key],
      threadStatus: "idle",
      updatedAt: ago(3000),
    },
  ];
}
