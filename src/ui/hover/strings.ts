/** Words of the sidebar hover card, in Chinese and English. Kept apart from src/ui/i18n.ts on purpose. */
import type { ConversationStatus } from "../../core/conversation.js";
import type { HostState } from "../../core/hosts.js";
import { localeOf, type Locale, type ThreadStatus } from "../../core/model.js";
import type { RefKind, RefState } from "../../core/refs.js";

export interface HoverStrings {
  locale: Locale;
  /** No mainline yet: a model has not summarized this conversation. */
  draft: string;
  draftTip: string;
  status: Record<ConversationStatus, string>;
  live: Record<ThreadStatus, string>;
  milestones: string;
  noMilestones: string;
  doing: string;
  /** A task a child conversation carries. */
  inChild(title: string): string;
  earlierMilestones(count: number): string;
  earlierTasks(count: number): string;
  children(count: number): string;
  moreChildren(count: number): string;
  from: string;
  related: string;
  refs: string;
  moreRefs(count: number): string;
  kind: Record<RefKind, string>;
  refState: Record<RefState | "unknown", string>;
  origin: string;
  lastPrompt: string;
  loading: string;
  failed(message: string): string;
  noThread: string;
  badResponse: string;
  open(title: string): string;
  /** Problems noted while working, not opened yet. */
  spinoffs: string;
  spawnChild: string;
  newChild: string;
  newChildHint: string;
  confirm: string;
  cancel: string;
  spawning: string;
  spawned(title: string): string;
  spawnFailed(message: string): string;
  /** codexhost has not answered in time: the child may still open, and shows up once it does. */
  spawnPending: string;
  /** Said when the button waits for its confirming second click. */
  armed(label: string): string;
  openIt: string;
  /** GitHub news about the PRs and issues this conversation started. */
  news: string;
  reason(reason: string): string;
  seen: string;
  /** The name of "🔔 N" at the top of the sidebar: news whose conversation has no row in sight. */
  summary(count: number): string;
  /** Its tooltip, saying why it is there. */
  summaryTip(count: number): string;
  /** In its list: opens the conversation a piece of news came from. */
  openConversation: string;
  /** In its list: the conversation a piece of news came from, and the turn. */
  fromConversation(title: string, turn: number): string;
  /** A model wrote this mainline. */
  summarized(time: string): string;
  resummarize: string;
  /** The same button on a conversation no model has summarized yet. */
  summarizeNow: string;
  summarizing: string;
  /** A summary refused: the conversation is another agent's, and no model is set for those. */
  noSummarizer: string;
  /** Files sent along with a new child conversation. */
  attach: string;
  attachTip: string;
  detach(name: string): string;
  uploading(percent: number): string;
  dropHere: string;
  tooLarge(name: string, limit: string): string;
  tooMany(count: number): string;
  tooMuch(limit: string): string;
  /** The computer a conversation on another computer runs on: its name and how it is doing, as codexhost's own preview says it. */
  host(name: string | undefined, state: HostState): string;
  hostTip: string;
  /** Why no files go along with a child of a conversation on another computer. */
  remoteFiles: string;
  time(at: number, now: number): string;
  date(at: number): string;
}

/** codexhost's own words for how a paired computer is doing. */
const HOST_STATES_ZH: Record<HostState, string> = { connected: "已连接", connecting: "连接中", "auth-error": "认证失败", offline: "离线", disabled: "已停用", unknown: "状态未知" };
const HOST_STATES_EN: Record<HostState, string> = { connected: "Connected", connecting: "Connecting", "auth-error": "Auth error", offline: "Offline", disabled: "Disabled", unknown: "State unknown" };

const REASONS_ZH: Record<string, string> = {
  comment: "有新评论",
  review: "有新评审",
  approved: "评审通过",
  changes_requested: "要求修改",
  merged: "已合并",
  review_requested: "请你 review",
  mention: "提到了你",
  state_change: "状态变了",
  assign: "指派给你",
  ci_activity: "CI 有结果",
  team_mention: "提到了你的团队",
};
const REASONS_EN: Record<string, string> = {
  comment: "New comment",
  review: "New review",
  approved: "Approved",
  changes_requested: "Changes requested",
  merged: "Merged",
  review_requested: "Review requested",
  mention: "You were mentioned",
  state_change: "State changed",
  assign: "Assigned to you",
  ci_activity: "CI finished",
  team_mention: "Your team was mentioned",
};

function relative(at: number, now: number, locale: Locale): string {
  const zh = locale === "zh-CN";
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return zh ? "刚刚" : "just now";
  if (minutes < 60) return zh ? `${minutes} 分钟前` : `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return zh ? `${hours} 小时前` : `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return zh ? `${days} 天前` : `${days} d ago`;
  const date = new Date(at);
  return zh ? `${date.getMonth() + 1}月${date.getDate()}日` : date.toLocaleDateString("en", { month: "short", day: "numeric" });
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

const zh: HoverStrings = {
  locale: "zh-CN",
  draft: "未凝练",
  draftTip: "还没有主线：标题、标签和起因暂取自对话标题、工作区、提到的 PR 和第一句话。开着自动凝练时，对话有新回复后一两分钟内会自动凝练；也可以点「立即凝练」。",
  status: { active: "进行中", paused: "暂停", done: "完成" },
  live: { running: "运行中", waiting: "等你处理", idle: "空闲", unknown: "状态未知" },
  milestones: "里程碑",
  noMilestones: "还没有记录里程碑",
  doing: "正在做",
  inChild: (title) => `子对话「${title}」`,
  earlierMilestones: (count) => `还有 ${count} 个更早的里程碑`,
  earlierTasks: (count) => `还有 ${count} 项已完成`,
  children: (count) => `子对话（${count}）`,
  moreChildren: (count) => `还有 ${count} 个子对话`,
  from: "来自：",
  related: "关联：",
  refs: "PR 与 Issue",
  moreRefs: (count) => `还有 ${count} 个`,
  kind: { pr: "PR", issue: "Issue" },
  refState: { open: "进行中", closed: "已关闭", merged: "已合并", unknown: "状态待确认" },
  origin: "起因：",
  lastPrompt: "最近请求：",
  loading: "正在读取…",
  failed: (message) => `读取失败：${message}`,
  noThread: "找不到这个对话",
  badResponse: "后台返回的数据无法识别",
  open: (title) => `打开「${title}」`,
  spinoffs: "引申问题",
  spawnChild: "开子对话",
  newChild: "＋ 开子对话",
  newChildHint: "新问题一句话，例如：视频点不开",
  confirm: "再点一次确认",
  cancel: "取消",
  spawning: "正在开子对话…",
  spawned: (title) => `已开子对话「${title}」`,
  spawnFailed: (message) => `没有开成：${message}`,
  spawnPending: "正在打开子对话：codexhost 还没答复，开好后会出现在本对话下方，先不要再点",
  armed: (label) => `${label}：3 秒内再点一次确认`,
  openIt: "打开",
  news: "PR 与 Issue 新动态",
  reason: (reason) => REASONS_ZH[reason] ?? "有新动态",
  seen: "知道了",
  summary: (count) => `${count} 条 PR 与 Issue 新动态`,
  summaryTip: (count) => `${count} 条 PR 与 Issue 新动态，它们所在的对话在侧栏里看不到（在收起的分组里、滚出了列表或没有列出）`,
  openConversation: "打开对话",
  fromConversation: (title, turn) => (turn > 0 ? `来自对话「${title}」第 ${turn} 轮` : `来自对话「${title}」`),
  summarized: (time) => `模型凝练 · ${time}`,
  resummarize: "↻ 重新凝练",
  summarizeNow: "↻ 立即凝练",
  summarizing: "凝练中…",
  noSummarizer: "没有凝练：按设置，Claude Code 和 Codex 以外的 Agent 的对话不发给模型。要凝练，请在总览页「设置」里为「其他 Agent（如 pi、DeepSeek、Grok）的对话」选一个模型。",
  attach: "添加照片、文件或视频",
  attachTip: "添加照片、文件或视频；也可以粘贴截图，或把文件拖进卡片",
  detach: (name) => `移除「${name}」`,
  uploading: (percent) => `正在上传附件 ${percent}%`,
  dropHere: "松开即可添加附件",
  tooLarge: (name, limit) => `「${name}」超过 ${limit}，没有加上`,
  tooMany: (count) => `最多附带 ${count} 个文件`,
  tooMuch: (limit) => `附件合计不能超过 ${limit}`,
  host: (name, state) => `${name ?? "另一台电脑"} · ${HOST_STATES_ZH[state]}`,
  hostTip: "这个对话在另一台电脑上（codexhost Web 连接的远程主机），经本机的 codexhost 读取，在本机凝练",
  remoteFiles: "这个对话在另一台电脑上，子对话也开在那里，那台电脑读不到本机的文件，所以不能附带照片、文件或视频",
  time: (at, now) => relative(at, now, "zh-CN"),
  date: (at) => new Date(at).toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" }),
};

const en: HoverStrings = {
  locale: "en",
  draft: "Not summarized",
  draftTip:
    "No mainline yet: the title, tags and origin come from the conversation's title, workspace, the PRs it mentions and its first message. With automatic summaries on, a model summarizes it a minute or two after a new reply; or click Summarize now.",
  status: { active: "Active", paused: "Paused", done: "Done" },
  live: { running: "Running", waiting: "Needs you", idle: "Idle", unknown: "Unknown" },
  milestones: "Milestones",
  noMilestones: "No milestones yet",
  doing: "Doing",
  inChild: (title) => `In child "${title}"`,
  earlierMilestones: (count) => plural(count, "earlier milestone"),
  earlierTasks: (count) => `${count} more done`,
  children: (count) => `Child conversations (${count})`,
  moreChildren: (count) => `${count} more`,
  from: "From:",
  related: "Linked to:",
  refs: "PRs and issues",
  moreRefs: (count) => `${count} more`,
  kind: { pr: "PR", issue: "Issue" },
  refState: { open: "Open", closed: "Closed", merged: "Merged", unknown: "Status unknown" },
  origin: "Started with:",
  lastPrompt: "Last request:",
  loading: "Loading…",
  failed: (message) => `Could not load: ${message}`,
  noThread: "This conversation was not found",
  badResponse: "The backend sent something unexpected",
  open: (title) => `Open "${title}"`,
  spinoffs: "Spin-offs",
  spawnChild: "Open child",
  newChild: "+ Child conversation",
  newChildHint: "The new problem in one line",
  confirm: "Click again to confirm",
  cancel: "Cancel",
  spawning: "Opening the child conversation…",
  spawned: (title) => `Opened child conversation "${title}"`,
  spawnFailed: (message) => `Could not open it: ${message}`,
  spawnPending: "Opening the child conversation: no answer from codexhost yet; it shows up under this conversation once it opens",
  armed: (label) => `${label}: click again within 3 seconds to confirm`,
  openIt: "Open",
  news: "PR and issue news",
  reason: (reason) => REASONS_EN[reason] ?? "New activity",
  seen: "Got it",
  summary: (count) => `${count} new on your PRs and issues`,
  summaryTip: (count) => `${count} new on your PRs and issues, from conversations the sidebar does not show (in a collapsed group, scrolled away, or not listed)`,
  openConversation: "Open conversation",
  fromConversation: (title, turn) => (turn > 0 ? `From "${title}", turn ${turn}` : `From "${title}"`),
  summarized: (time) => `Summarized ${time}`,
  resummarize: "↻ Summarize again",
  summarizeNow: "↻ Summarize now",
  summarizing: "Summarizing…",
  noSummarizer:
    "Not summarized: the settings send no conversation of an agent other than Claude Code and Codex to a model. To summarize it, choose a model under “Conversations of other agents (pi, DeepSeek, Grok, …)” in the overview's Settings tab.",
  attach: "Add photos, files or videos",
  attachTip: "Add photos, files or videos. You can also paste a screenshot or drop files on the card.",
  detach: (name) => `Remove "${name}"`,
  uploading: (percent) => `Uploading ${percent}%`,
  dropHere: "Drop to attach",
  tooLarge: (name, limit) => `"${name}" is over ${limit} and was left out`,
  tooMany: (count) => `At most ${count} files`,
  tooMuch: (limit) => `Attachments may add up to ${limit} at most`,
  host: (name, state) => `${name ?? "Another computer"} · ${HOST_STATES_EN[state]}`,
  hostTip: "This conversation is on another computer (a remote host connected to codexhost Web); it is read through codexhost on this machine and summarized here",
  remoteFiles: "This conversation is on another computer, where the child opens too, and that computer cannot read files on this one, so no photos, files or videos can go along",
  time: (at, now) => relative(at, now, "en"),
  date: (at) => new Date(at).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" }),
};

export function hoverStrings(locale: Locale): HoverStrings {
  return locale === "zh-CN" ? zh : en;
}

/** The page's language, as the capsule reads it: the document's lang, else the browser's. */
export function hoverLocale(doc: Document): Locale {
  return localeOf(doc.documentElement.lang || doc.defaultView?.navigator.language);
}
