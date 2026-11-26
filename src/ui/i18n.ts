import { ATTACH_MAX_FILE_BYTES, ATTACH_MAX_FILES, ATTACH_MAX_TOTAL_BYTES, formatSize } from "../core/attachments.js";
import { V2_LIMITS } from "../core/conversation.js";
import { isErrorCode, type ErrorCode, type Locale, type ThreadStatus } from "../core/model.js";
import type { SearchField } from "../core/rpc.js";

// ---------------------------------------------------------------------------------------------
// Backend errors. They arrive as "[CODE] message" with the message in English; the capsule, the
// hover card, the overview and the ★ button say each code in the page's language, and show a code
// they do not know with its message.

/** The message without its "[CODE]" prefix. */
export function errorDetail(message: string): string {
  return message.replace(/^\[[A-Z_]+\]\s*/u, "");
}

/** Sizes as the surfaces say them. */
const MAX_FILE = formatSize(ATTACH_MAX_FILE_BYTES);
const MAX_TOTAL = formatSize(ATTACH_MAX_TOTAL_BYTES);

/** The capsule's and the hover card's words for each error code; `detail` is the message without its code. */
const ZH_ERRORS: Record<ErrorCode, (detail: string) => string> = {
  INVALID_ARGUMENT: (detail) => `没有改成：${detail}`,
  EMPTY_TEXT: () => "没有改成：内容为空",
  NO_THREAD: () => "找不到这个对话",
  NO_MAINLINE: () => "本对话还没有主线",
  NO_CURRENT_MILESTONE: () => "没有当前里程碑可以达成",
  UNKNOWN_ITEM: () => "这一项已经不存在了",
  MILESTONE_EXISTS: () => "没有改成：这个里程碑已经有了",
  MILESTONE_LIMIT: () => `一条主线最多 ${V2_LIMITS.milestones} 个里程碑，请先删掉不用的里程碑`,
  LOCKED: () => "主线数据正在写入，请稍后再试",
  STATE_FULL: () => "主线数据已满，请在总览页删除不用的主线",
  FAVORITES_FULL: () => "收藏已满，请在总览页「收藏」里删除不用的收藏",
  FILE_FULL: (detail) => `数据文件已满，这次没有保存（${detail}）`,
  TOO_LARGE: (detail) => `超出上限：${detail}`,
  ATTACHMENT_TOO_LARGE: () => `单个附件不能超过 ${MAX_FILE}`,
  TOO_MANY_ATTACHMENTS: () => `最多附带 ${ATTACH_MAX_FILES} 个文件`,
  UPLOADS_BUSY: () => "等着发送的附件太多，请稍后再试",
  CHILD_FILES_TOO_LARGE: () => `一个子对话的附件合计不能超过 ${MAX_TOTAL}`,
  NO_SUMMARIZER: () => "没有凝练：按设置，这个 Agent 的对话不发给模型。要凝练，请在总览页「设置」里为「其他 Agent（如 pi、DeepSeek、Grok）的对话」选一个模型",
  UNAVAILABLE: (detail) => `改不了 Agent 协作：${detail}`,
  NEWER_VERSION: () => "数据文件是更新版本的第二大脑插件写的，这里没有改动它；请更新插件",
  PENDING: () => "codexhost 没有及时答复，子对话可能还在打开：开好后会出现在本对话下方，先不要再点",
  REMOTE_ATTACHMENTS: () => "这个对话在另一台电脑上，子对话也开在那里，那台电脑读不到本机的文件：开子对话时不能附带照片、文件或视频",
};

const EN_ERRORS: Record<ErrorCode, (detail: string) => string> = {
  INVALID_ARGUMENT: (detail) => `Not changed: ${detail}`,
  EMPTY_TEXT: () => "Not changed: the text is empty",
  NO_THREAD: () => "That conversation cannot be found",
  NO_MAINLINE: () => "This conversation has no mainline",
  NO_CURRENT_MILESTONE: () => "There is no current milestone to reach",
  UNKNOWN_ITEM: () => "That item no longer exists",
  MILESTONE_EXISTS: () => "Not changed: that milestone exists already",
  MILESTONE_LIMIT: () => `A mainline has at most ${V2_LIMITS.milestones} milestones; delete one you no longer need first`,
  LOCKED: () => "The mainline data is being written; try again in a moment",
  STATE_FULL: () => "The mainline data is full; delete mainlines you no longer need in the overview",
  FAVORITES_FULL: () => "The saved passages are full; delete ones you no longer need in the overview's Favorites tab",
  FILE_FULL: (detail) => `A data file is full; nothing was saved (${detail})`,
  TOO_LARGE: (detail) => `Over the limit: ${detail}`,
  ATTACHMENT_TOO_LARGE: () => `One attachment may be ${MAX_FILE} at most`,
  TOO_MANY_ATTACHMENTS: () => `At most ${ATTACH_MAX_FILES} files`,
  UPLOADS_BUSY: () => "Too many files are waiting to be sent; try again in a moment",
  CHILD_FILES_TOO_LARGE: () => `The files of one child conversation may add up to ${MAX_TOTAL} at most`,
  NO_SUMMARIZER: () =>
    "Not summarized: the settings send conversations of this agent to no model. To summarize it, choose a model under “Conversations of other agents (pi, DeepSeek, Grok, …)” in the overview's Settings tab",
  UNAVAILABLE: (detail) => `The agent integration cannot be changed: ${detail}`,
  NEWER_VERSION: () => "A data file was written by a newer version of Second Brain and was left as it is; update the extension",
  PENDING: () => "No answer from codexhost yet; the child may still open under this conversation",
  REMOTE_ATTACHMENTS: () => "This conversation is on another computer, where the child opens too, and that computer cannot read files on this one: no photos, files or videos can go along",
};

/** An error as the capsule and the hover card say it: by its code, else the message as it is. */
function errorText(table: Record<ErrorCode, (detail: string) => string>, fallback: (detail: string) => string, code: string | undefined, message: string): string {
  const detail = errorDetail(message);
  return isErrorCode(code) ? table[code](detail) : fallback(detail);
}

// ---------------------------------------------------------------------------------------------
// The capsule over the conversation and its card.

export interface Strings {
  mainline: string;
  doing: string;
  noMainline: string;
  setAsMainline: string;
  goalPlaceholder: string;
  dismiss: string;
  showLess: string;
  complete: string;
  remove: string;
  edit: string;
  confirm: string;
  /** Said when a two-click button waits for its second click. */
  armed(label: string): string;
  collapse: string;
  offline: string;
  /** Where the overview is, on the surface the capsule runs on. */
  overviewHint: Record<"desktop" | "web", string>;
  agentHint: string;
  status: Record<ThreadStatus, string>;
  open: string;
  time(at: number, now: number): string;
  error(code: string | undefined, message: string): string;
  /** "Label: text", with the language's own colon. */
  labelled(label: string, text: string): string;
  /** A section title with the progress, such as "Milestones (2/5)". */
  counted(title: string, done: number, total: number): string;
  /** The lines of the capsule's tooltip, joined into its accessible name. */
  joinParts(parts: readonly string[]): string;
  /** The card's accessible name. */
  cardLabel(title: string): string;
  // PRs and issues
  /** One PR or issue with unseen GitHub news. */
  newsOne(number: number): string;
  /** Several of them. */
  newsMany(count: number): string;
  news: string;
  reason(reason: string): string;
  jump: string;
  inThisWindow: string;
  turn(number: number): string;
  asked(text: string): string;
  noteLabel(text: string): string;
  windowRefs: string;
  noResults: string;
  kind: Record<"pr" | "issue", string>;
  refState: Record<"open" | "closed" | "merged", string>;
  fromWindow(title: string): string;
  // Mainline v2
  draftLabel: string;
  milestones: string;
  noMilestones: string;
  reach: string;
  addMilestone: string;
  makeCurrent: string;
  addTask: string;
  tasksCount(count: number): string;
  earlierMilestones(count: number): string;
  byChild(title: string): string;
  spinoffs: string;
  spawnChild: string;
  keepHere: string;
  spawned(title: string): string;
  children: string;
  fromParent(title: string): string;
  linkedTo(title: string): string;
  conversationStatus: Record<"active" | "paused" | "done", string>;
  pause: string;
  resume: string;
  finishMainline: string;
  reopenMainline: string;
  editTags: string;
  tagsPlaceholder: string;
  planPlaceholder: string;
  firstPromptLabel(text: string): string;
  lastPromptLabel(text: string): string;
  findConversations: string;
  findConversationsPlaceholder: string;
  matchField: Record<SearchField, string>;
  progress(done: number, total: number): string;
  current(title: string): string;
}

function relative(at: number, now: number, locale: Locale): string {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return locale === "zh-CN" ? "刚刚" : "just now";
  if (minutes < 60) return locale === "zh-CN" ? `${minutes} 分钟前` : `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return locale === "zh-CN" ? `${hours} 小时前` : `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return locale === "zh-CN" ? `${days} 天前` : `${days} d ago`;
  const date = new Date(at);
  return locale === "zh-CN" ? `${date.getMonth() + 1}月${date.getDate()}日` : date.toLocaleDateString("en", { month: "short", day: "numeric" });
}

const zh: Strings = {
  mainline: "主线",
  doing: "正在做",
  noMainline: "本对话还没有主线",
  setAsMainline: "设为主线",
  goalPlaceholder: "这个对话在做什么？",
  dismiss: "忽略",
  showLess: "收起",
  complete: "完成",
  remove: "删除",
  edit: "修改",
  confirm: "再点一次确认",
  armed: (label) => `${label}：3 秒内再点一次确认`,
  collapse: "收起",
  offline: "第二大脑的后台未连接，正在重试",
  overviewHint: { desktop: "完整总览与 Agent 协作：设置 → 插件页面 → 第二大脑", web: "完整总览与 Agent 协作：左侧「插件」→「第二大脑」" },
  agentHint: "开着自动凝练时，模型会在回复结束后写出主线；装好 Agent 协作后，Agent 会边做边记录支线任务。",
  status: { running: "运行中", waiting: "等你处理", idle: "空闲", unknown: "状态未知" },
  open: "打开",
  time: (at, now) => relative(at, now, "zh-CN"),
  error: (code, message) => errorText(ZH_ERRORS, (detail) => `操作没有成功：${detail}`, code, message),
  labelled: (label, text) => `${label}：${text}`,
  counted: (title, done, total) => `${title}（${done}/${total}）`,
  joinParts: (parts) => parts.join("，"),
  cardLabel: (title) => `主线：${title}`,
  newsOne: (number) => `#${number} 有新动态`,
  newsMany: (n) => `${n} 个 PR/Issue 有新动态`,
  news: "PR 与 Issue 新动态",
  reason: (reason) =>
    ({
      comment: "有新评论",
      review: "有新评审",
      approved: "评审通过",
      changes_requested: "要求修改",
      merged: "已合并",
      review_requested: "请你 review",
      mention: "提到了你",
      author: "有新动态",
      state_change: "状态变了",
      assign: "指派给你",
      ci_activity: "CI 有结果",
      manual: "有新动态",
      subscribed: "有新动态",
      team_mention: "提到了你的团队",
    })[reason] ?? "有新动态",
  jump: "跳转",
  inThisWindow: "就在本对话",
  turn: (n) => `第 ${n} 轮`,
  asked: (text) => `当时的问题：${text}`,
  noteLabel: (text) => `说明：${text}`,
  windowRefs: "本对话的 PR 与 Issue",
  noResults: "没找到。可以换成 PR 或 issue 编号、链接里的一段、标签，或当时问的话。",
  kind: { pr: "PR", issue: "Issue" },
  refState: { open: "进行中", closed: "已关闭", merged: "已合并" },
  fromWindow: (title) => `来源对话「${title}」`,
  draftLabel: "未凝练",
  milestones: "里程碑",
  noMilestones: "还没有里程碑。里程碑是阶段性成果，例如「定位原因」「提交 PR」「合并验证」。",
  reach: "达成本阶段",
  addMilestone: "添加里程碑…",
  makeCurrent: "设为当前",
  addTask: "记一条支线任务…",
  tasksCount: (n) => `${n} 个支线任务`,
  earlierMilestones: (n) => `还有 ${n} 个更早的里程碑`,
  byChild: (title) => `子对话「${title}」`,
  spinoffs: "引申问题",
  spawnChild: "开子对话",
  keepHere: "本对话处理",
  spawned: (title) => `已开子对话：${title}`,
  children: "子对话",
  fromParent: (title) => `来自：${title}`,
  linkedTo: (title) => `关联：${title}`,
  conversationStatus: { active: "进行中", paused: "已暂停", done: "已完成" },
  pause: "暂停",
  resume: "继续",
  finishMainline: "完成主线",
  reopenMainline: "重新打开",
  editTags: "改标签",
  tagsPlaceholder: "标签，用逗号分隔：项目、模块、类型、编号",
  planPlaceholder: "里程碑（可选），用 | 分隔：定位原因|提交 PR|合并验证",
  firstPromptLabel: (text) => `起因：${text}`,
  lastPromptLabel: (text) => `最近请求：${text}`,
  findConversations: "找对话",
  findConversationsPlaceholder: "编号、链接或关键词，例如 42、登录页",
  matchField: { ref: "PR/Issue", tag: "标签", title: "主线", milestone: "里程碑", task: "支线任务", spinoff: "引申问题", prompt: "当时的问题", threadTitle: "对话标题", favorite: "收藏" },
  progress: (done, total) => `◆ ${done}/${total}`,
  current: (title) => `● ${title}`,
};

const en: Strings = {
  mainline: "Mainline",
  doing: "Doing",
  noMainline: "This conversation has no mainline",
  setAsMainline: "Set as mainline",
  goalPlaceholder: "What is this conversation doing?",
  dismiss: "Dismiss",
  showLess: "Show less",
  complete: "Done",
  remove: "Remove",
  edit: "Edit",
  confirm: "Click again to confirm",
  armed: (label) => `${label}: click again within 3 seconds to confirm`,
  collapse: "Collapse",
  offline: "Second Brain's backend is unreachable, retrying",
  overviewHint: { desktop: "Overview and agent setup: Settings → Plugin pages → Second Brain", web: "Overview and agent setup: Plugins → Second Brain" },
  agentHint: "With automatic summaries on, a model writes the mainline after a reply; with the agent integration installed, agents record tasks as they work.",
  status: { running: "Running", waiting: "Needs you", idle: "Idle", unknown: "Unknown" },
  open: "Open",
  time: (at, now) => relative(at, now, "en"),
  error: (code, message) => errorText(EN_ERRORS, (detail) => `That did not work: ${detail}`, code, message),
  labelled: (label, text) => `${label}: ${text}`,
  counted: (title, done, total) => `${title} (${done}/${total})`,
  joinParts: (parts) => parts.join(", "),
  cardLabel: (title) => `Mainline: ${title}`,
  newsOne: (number) => `#${number} has news`,
  newsMany: (n) => `${n} PRs or issues have news`,
  news: "PR and issue news",
  reason: (reason) =>
    ({
      comment: "New comment",
      review: "New review",
      approved: "Approved",
      changes_requested: "Changes requested",
      merged: "Merged",
      review_requested: "Review requested",
      mention: "You were mentioned",
      author: "New activity",
      state_change: "State changed",
      assign: "Assigned to you",
      ci_activity: "CI finished",
      manual: "New activity",
      subscribed: "New activity",
      team_mention: "Your team was mentioned",
    })[reason] ?? "New activity",
  jump: "Go",
  inThisWindow: "This conversation",
  turn: (n) => `turn ${n}`,
  asked: (text) => `Asked then: ${text}`,
  noteLabel: (text) => `Note: ${text}`,
  windowRefs: "PRs and issues of this conversation",
  noResults: "Nothing found. Try a PR or issue number, part of a link, a tag or words from the request.",
  kind: { pr: "PR", issue: "Issue" },
  refState: { open: "Open", closed: "Closed", merged: "Merged" },
  fromWindow: (title) => `From "${title}"`,
  draftLabel: "Not summarized",
  milestones: "Milestones",
  noMilestones: "No milestones yet. Milestones are stage results, such as \"find the cause\", \"open the PR\", \"verify after merge\".",
  reach: "Stage reached",
  addMilestone: "Add a milestone…",
  makeCurrent: "Make current",
  addTask: "Add a task…",
  tasksCount: (n) => `${n} task${n === 1 ? "" : "s"}`,
  earlierMilestones: (n) => `${n} earlier milestone${n === 1 ? "" : "s"}`,
  byChild: (title) => `child conversation "${title}"`,
  spinoffs: "Spin-offs",
  spawnChild: "Child conversation",
  keepHere: "Handle here",
  spawned: (title) => `Child conversation: ${title}`,
  children: "Child conversations",
  fromParent: (title) => `From: ${title}`,
  linkedTo: (title) => `Linked: ${title}`,
  conversationStatus: { active: "Active", paused: "Paused", done: "Done" },
  pause: "Pause",
  resume: "Resume",
  finishMainline: "Finish",
  reopenMainline: "Reopen",
  editTags: "Edit tags",
  tagsPlaceholder: "Tags, separated by commas: project, area, kind, numbers",
  planPlaceholder: "Milestones (optional), separated by |: find the cause|open the PR|verify",
  firstPromptLabel: (text) => `Started with: ${text}`,
  lastPromptLabel: (text) => `Last request: ${text}`,
  findConversations: "Find a conversation",
  findConversationsPlaceholder: "Number, link or words, for example 42 or login page",
  matchField: { ref: "PR/issue", tag: "tag", title: "mainline", milestone: "milestone", task: "task", spinoff: "spin-off", prompt: "request", threadTitle: "conversation title", favorite: "saved passage" },
  progress: (done, total) => `◆ ${done}/${total}`,
  current: (title) => `● ${title}`,
};

export function strings(locale: Locale): Strings {
  return locale === "zh-CN" ? zh : en;
}
