/** Copy of the overview page in Chinese and English, picked by the page's locale. */
import { V2_LIMITS, type ConversationStatus, type MilestoneState } from "../core/conversation.js";
import { MAX_CONVERSATIONS } from "../core/conversation-ops.js";
import { isErrorCode, type ErrorCode, type Locale, type ThreadStatus } from "../core/model.js";
import type { RefKind, RefState } from "../core/refs.js";
import type { AgentId, IntegrationPreview, IntegrationProblem, IntegrationState, SearchField, SummaryProblem } from "../core/rpc.js";
import { errorDetail } from "../ui/i18n.js";
import { ATTACH_MAX_FILE_BYTES, ATTACH_MAX_FILES, ATTACH_MAX_TOTAL_BYTES, formatSize } from "../core/attachments.js";

export interface PageStrings {
  pageTitle: string;
  loading: string;
  close: string;
  confirm: string;
  /** Said when a two-click button waits for its second click. */
  armed(label: string): string;
  jump: string;
  cancel: string;
  time(at: number, now: number): string;
  error(code: string | undefined, message: string): string;

  // Global search
  findLabel: string;
  findPlaceholder: string;
  finding: string;
  findEmpty: string;
  findFailed(message: string): string;
  match(field: SearchField, text: string): string;
  locate: string;

  // Conversation tree
  othersIntro: string;
  status: Record<ConversationStatus, string>;
  threadStatus: Record<ThreadStatus, string>;
  draft: string;
  progress(done: number, total: number): string;
  progressLabel(done: number, total: number): string;
  current(title: string): string;
  noMilestones: string;
  doing(text: string): string;
  lastPrompt(text: string): string;
  firstPrompt(text: string): string;
  showAll(count: number): string;
  showLess: string;
  parent(title: string): string;
  related(title: string): string;
  updated(time: string): string;

  // Expanded conversation
  milestones: string;
  milestoneState: Record<MilestoneState, string>;
  reach: string;
  focus: string;
  rename: string;
  removeMilestone: string;
  addTaskTo: string;
  addMilestone: string;
  addTask: string;
  taskDone: string;
  removeTask: string;
  carriedBy(title: string): string;
  editDoing: string;
  clearDoing: string;
  doingPlaceholder: string;
  spinoffs: string;
  spinoffsOpen(count: number): string;
  spawn: string;
  spawning: string;
  keep: string;
  dismiss: string;
  spawned(title: string): string;
  spawnedNotice(text: string): string;
  addSpinoff: string;
  refs: string;
  editTitle: string;
  titlePlaceholder: string;
  editTags: string;
  tagsPlaceholder: string;
  statusLabel: string;
  deleteMainline: string;
  createMainline: string;
  draftIntro: string;
  /** The page's tabs, the status tabs of the conversation list, and how it is grouped. */
  tabConversations(count: number): string;
  tabRefs(count: number): string;
  tabFavorites(count: number): string;
  tabSettings: string;
  statusTabs: Record<"active" | "paused" | "done" | "others", string>;
  /** Names the control that groups the list. */
  groupByLabel: string;
  groupBy: { time: string; project: string };
  timeBuckets: { today: string; yesterday: string; week: string; earlier: string };
  noWorkspace: string;
  childrenCount(count: number): string;
  hideChildren: string;
  emptyTab: string;
  /** Model summaries. */
  summarized(model: string, time: string): string;
  resummarize: string;
  summarizeQueued: string;
  /** "You changed the title and the tags by hand …", the parts listed in the language's own way. */
  pinnedNote(parts: readonly string[]): string;
  pinnedParts: { title: string; tags: string; status: string; milestones: (count: number) => string };
  unpin: string;
  /** Starts the backfill (two clicks), saying how many conversations go to a model at most. */
  backfillStart(count: number): string;
  /** `full`: conversations without a mainline left out because the mainlines are at their cap. */
  backfillProgress(done: number, total: number, failed: number, skipped: number, full: number): string;
  backfillStop: string;
  backfillStopped: string;
  summarizerBusy(running: number, queued: number): string;
  summarizerError(message: string): string;
  /** Why the last summary sent nothing, when the backend gives a code for it. */
  summaryProblem: Record<SummaryProblem, string>;
  /** Today's automatic summaries against the daily limit, and by model. */
  summarizerToday(count: number, limit: number, claude: number, codex: number): string;
  /** Today's summaries asked for by hand and made by the backfill. */
  summarizerAsked(manual: number, backfill: number): string;
  autoSummarize: string;
  summarizeModel: string;
  summarizeModels: Record<"follow" | "claude" | "codex", string>;
  summarizeOthers: string;
  summarizeOthersOptions: Record<"none" | "claude" | "codex", string>;
  summarizeOthersHint: string;

  // Favorites: passages saved from conversations
  favoritesSection: string;
  favoritesIntro: string;
  favoritesEmpty: string;
  favoritesPlaceholder: string;
  favoritesNone: string;
  favoriteRole: Record<"agent" | "user", string>;
  favoriteNote(text: string): string;
  jumpToPassage: string;
  openConversation: string;
  openFailed(reason: string): string;
  copy: string;
  copied: string;
  copyFailed: string;
  addNote: string;
  editNote: string;
  notePlaceholder: string;
  removeFavorite: string;
  expandPassage: string;
  foldPassage: string;

  // PRs and issues (kept from v1)
  refsSection: string;
  refsIntro: string;
  refsEmpty: string;
  findRefs: string;
  refsPlaceholder: string;
  noResults: string;
  scanStatus(scanned: number, listed: number, done: boolean, refs: number, unreadable?: number): string;
  /** `refs`: how many PRs and issues the index holds; checking starts once there is one. */
  githubStatus(enabled: boolean, lastPollAt: number | undefined, error: string | undefined, now: number, refs: number): string;
  kind: Record<RefKind, string>;
  refState: Record<RefState, string>;
  reason(reason: string): string;
  fromWindow(title: string): string;
  turn(number: number): string;
  inWindows(count: number): string;
  asked(text: string): string;
  noteLabel(text: string): string;

  // Agent integration (kept from v1)
  integrations: string;
  integrationsIntro: string;
  agentName: Record<AgentId, string>;
  integrationState: Record<IntegrationState, string>;
  /** Why an agent's configuration cannot be changed; `cause` is the system's error code, when there is one. */
  integrationProblem(agent: AgentId, problem: IntegrationProblem, cause?: string): string;
  preview: string;
  install: string;
  update: string;
  uninstall: string;
  previewTitle(action: string, file: string): string;
  previewAction: Record<IntegrationPreview["action"], string>;
  applyChange: string;
  command(path: string): string;

  /** The data of the extension's earlier name was copied over, and its old folder is still there. */
  migratedNote(folder: string): string;

  // Settings (kept from v1)
  settings: string;
  driftPolicy: string;
  driftPolicies: Record<"ask" | "note" | "off", string>;
  showCapsule: string;
  prAlerts: string;

  // Files sent along with child conversations
  attachmentsSection: string;
  attachmentsUsage(files: number, size: string): string;
  attachmentsNone: string;
  attachmentsIntro: string;
  clearDoneAttachments(size: string): string;
  clearAllAttachments(size: string): string;
  clearingAttachments: string;
  attachmentsCleared(files: number, size: string): string;

  // Favorites, more than one page of them (eng-backend)
  favoritesMore(left: number): string;
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

/** Backend errors arrive as "[CODE] message": each code is said in words, the message of an unknown one as it is. */
const detail = errorDetail;
const MAX_FILE = formatSize(ATTACH_MAX_FILE_BYTES);
const MAX_TOTAL = formatSize(ATTACH_MAX_TOTAL_BYTES);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** "a, b and c". */
const englishList = (parts: readonly string[]) => (parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`);

const ZH_MATCH: Record<SearchField, string> = {
  ref: "PR/Issue",
  tag: "标签",
  title: "主线标题",
  milestone: "里程碑",
  task: "支线任务",
  spinoff: "引申问题",
  prompt: "当时的问题",
  threadTitle: "对话标题",
  favorite: "收藏",
};

const EN_MATCH: Record<SearchField, string> = {
  ref: "PR or issue",
  tag: "tag",
  title: "mainline title",
  milestone: "milestone",
  task: "task",
  spinoff: "spin-off",
  prompt: "request",
  threadTitle: "conversation title",
  favorite: "saved passage",
};

/** The overview's words for each error code; `detail` is the message without its code. */
const ZH_ERRORS: Record<ErrorCode, (detail: string) => string> = {
  INVALID_ARGUMENT: (detail) => `内容不符合要求：${detail}`,
  EMPTY_TEXT: () => "内容不能为空",
  NO_THREAD: () => "找不到这个对话",
  NO_MAINLINE: () => "这个对话还没有主线，或者主线已经删除",
  NO_CURRENT_MILESTONE: () => "没有当前里程碑可以标记达成",
  UNKNOWN_ITEM: () => "这一项已经不存在了",
  MILESTONE_EXISTS: () => "这个里程碑已经有了",
  MILESTONE_LIMIT: () => `一条主线最多 ${V2_LIMITS.milestones} 个里程碑，请先删掉不用的里程碑`,
  LOCKED: () => "主线数据正在写入，请稍后再试",
  STATE_FULL: () => "主线数据已满，请删除不用的主线",
  FAVORITES_FULL: () => "收藏已满，请删除不用的收藏",
  FILE_FULL: (detail) => `数据文件已满，这次没有保存（${detail}）`,
  TOO_LARGE: (detail) => `超出上限：${detail}`,
  ATTACHMENT_TOO_LARGE: () => `单个附件不能超过 ${MAX_FILE}`,
  TOO_MANY_ATTACHMENTS: () => `最多附带 ${ATTACH_MAX_FILES} 个文件`,
  UPLOADS_BUSY: () => "等着发送的附件太多，请稍后再试",
  CHILD_FILES_TOO_LARGE: () => `一个子对话的附件合计不能超过 ${MAX_TOTAL}`,
  NO_SUMMARIZER: () =>
    "这个对话来自 Claude Code 和 Codex 以外的 Agent。设置里「其他 Agent（如 pi、DeepSeek、Grok）的对话」选的是「不凝练，不发给任何模型」，所以不会发给模型；要凝练，请先在「设置」页签为它们选一个模型。",
  UNAVAILABLE: (detail) => `改不了 Agent 协作：${detail}`,
  NEWER_VERSION: () => "数据文件是更新版本的第二大脑插件写的，这里没有改动它；请更新插件",
  PENDING: () => "codexhost 没有及时答复，子对话可能还在打开：开好后会出现在本对话下方，先不要再点",
  REMOTE_ATTACHMENTS: () => "这个对话在另一台电脑上，子对话也开在那里，那台电脑读不到本机的文件：开子对话时不能附带照片、文件或视频",
};

const EN_ERRORS: Record<ErrorCode, (detail: string) => string> = {
  INVALID_ARGUMENT: (detail) => `Not accepted: ${detail}`,
  EMPTY_TEXT: () => "The text cannot be empty",
  NO_THREAD: () => "That conversation cannot be found",
  NO_MAINLINE: () => "This conversation has no mainline, or it was deleted",
  NO_CURRENT_MILESTONE: () => "There is no current milestone to mark reached",
  UNKNOWN_ITEM: () => "That item no longer exists",
  MILESTONE_EXISTS: () => "That milestone exists already",
  MILESTONE_LIMIT: () => `A mainline has at most ${V2_LIMITS.milestones} milestones; delete one you no longer need first`,
  LOCKED: () => "The mainline data is being written; try again in a moment",
  STATE_FULL: () => "The mainline data is full; delete mainlines you no longer need",
  FAVORITES_FULL: () => "The saved passages are full; delete ones you no longer need",
  FILE_FULL: (detail) => `A data file is full; nothing was saved (${detail})`,
  TOO_LARGE: (detail) => `Over the limit: ${detail}`,
  ATTACHMENT_TOO_LARGE: () => `One attachment may be ${MAX_FILE} at most`,
  TOO_MANY_ATTACHMENTS: () => `At most ${ATTACH_MAX_FILES} files`,
  UPLOADS_BUSY: () => "Too many files are waiting to be sent; try again in a moment",
  CHILD_FILES_TOO_LARGE: () => `The files of one child conversation may add up to ${MAX_TOTAL} at most`,
  NO_SUMMARIZER: () =>
    "This conversation is run by an agent other than Claude Code and Codex, and the setting “Conversations of other agents (pi, DeepSeek, Grok, …)” is “Do not summarize; send them to no model”, so it is not sent to a model. To summarize it, choose a model for them in the Settings tab first.",
  UNAVAILABLE: (detail) => `The agent integration cannot be changed: ${detail}`,
  NEWER_VERSION: () => "A data file was written by a newer version of Second Brain and was left as it is; update the extension",
  PENDING: () => "No answer from codexhost yet; the child may still open under this conversation",
  REMOTE_ATTACHMENTS: () => "This conversation is on another computer, where the child opens too, and that computer cannot read files on this one: no photos, files or videos can go along",
};

/** Where each agent keeps what the integration changes. */
const AGENT_FILES: Record<AgentId, { name: string; folder: string; file: string }> = {
  claude: { name: "Claude Code", folder: "~/.claude", file: "settings.json" },
  codex: { name: "Codex", folder: "~/.codex", file: "AGENTS.md" },
};

const zh: PageStrings = {
  pageTitle: "第二大脑",
  loading: "正在加载…",
  close: "关闭",
  confirm: "再点一次确认",
  armed: (label) => `${label}：3 秒内再点一次确认`,
  jump: "跳转",
  cancel: "取消",
  time: (at, now) => relative(at, now, "zh-CN"),
  error: (code, message) => (isErrorCode(code) ? ZH_ERRORS[code](detail(message)) : `操作没有成功：${detail(message)}`),

  findLabel: "找回对话",
  findPlaceholder: "输入编号、链接或关键词找回对话，例如 42",
  finding: "正在查找…",
  findEmpty: "没找到。可以换成 PR 或 issue 编号、链接里的一段、标签，或当时问的话。",
  findFailed: (message) => `查找没有成功：${detail(message)}`,
  match: (field, text) => `命中${ZH_MATCH[field] ?? "内容"}：${text}`,
  locate: "在列表中展开",

  othersIntro: "这些对话还没被模型凝练出主线。展开后可以看到按对话标题、工作区和提到的 PR 拼出的临时内容，并建立主线。",
  status: { active: "进行中", paused: "暂停", done: "完成" },
  threadStatus: { running: "运行中", waiting: "等你处理", idle: "空闲", unknown: "状态未知" },
  draft: "未凝练",
  progress: (done, total) => `◆ ${done}/${total}`,
  progressLabel: (done, total) => `已达成 ${done} 个里程碑，共 ${total} 个`,
  current: (title) => `当前：${title}`,
  noMilestones: "还没有里程碑",
  doing: (text) => `正在做：${text}`,
  lastPrompt: (text) => `最近请求：${text}`,
  firstPrompt: (text) => `起因：${text}`,
  showAll: (n) => `显示全部（${n}）`,
  showLess: "收起",
  parent: (title) => `父对话：${title}`,
  related: (title) => `关联到：${title}`,
  updated: (time) => `更新于 ${time}`,

  milestones: "里程碑",
  milestoneState: { done: "已达成", current: "当前", planned: "计划" },
  reach: "标记达成",
  focus: "设为当前",
  rename: "重命名",
  removeMilestone: "删除里程碑",
  addTaskTo: "在这个里程碑下添加支线任务",
  addMilestone: "添加里程碑…",
  addTask: "添加支线任务…",
  taskDone: "完成",
  removeTask: "删除",
  carriedBy: (title) => `由子对话「${title}」处理`,
  editDoing: "修改正在做",
  clearDoing: "清除正在做",
  doingPlaceholder: "正在做的事…",
  spinoffs: "引申问题",
  spinoffsOpen: (n) => `${n} 个待处理`,
  spawn: "开子对话",
  spawning: "正在开子对话…",
  keep: "本对话处理",
  dismiss: "忽略",
  spawned: (title) => `已开子对话「${title}」`,
  spawnedNotice: (text) => `已为「${text}」开了子对话`,
  addSpinoff: "记下一个引申问题…",
  refs: "PR 与 Issue",
  editTitle: "修改标题",
  titlePlaceholder: "这个对话在做什么：动作 + 对象",
  editTags: "修改标签",
  tagsPlaceholder: "标签用逗号分隔，最多 8 个",
  statusLabel: "状态",
  deleteMainline: "删除主线",
  createMainline: "建立主线",
  draftIntro: "这个对话还没被模型凝练出主线。下面是按对话标题、工作区和提到的 PR 拼出的临时内容。",
  tabConversations: (n) => `对话 ${n}`,
  tabRefs: (n) => `PR 与 Issue ${n}`,
  tabFavorites: (n) => `收藏 ${n}`,
  tabSettings: "设置",
  statusTabs: { active: "进行中", paused: "暂停", done: "已完成", others: "没有主线" },
  groupByLabel: "分组方式",
  groupBy: { time: "按时间", project: "按项目" },
  timeBuckets: { today: "今天", yesterday: "昨天", week: "本周", earlier: "更早" },
  noWorkspace: "其他",
  childrenCount: (n) => `${n} 个子对话`,
  hideChildren: "收起子对话",
  emptyTab: "这里还没有对话。",
  summarized: (model, time) => `模型凝练于 ${time}（${model}）`,
  resummarize: "重新凝练",
  summarizeQueued: "已请模型凝练，稍后更新",
  pinnedNote: (parts) => `你手动改过${parts.join("、")}，模型不会覆盖。`,
  pinnedParts: { title: "标题", tags: "标签", status: "状态", milestones: (count) => `${count} 个里程碑` },
  unpin: "恢复自动凝练",
  backfillStart: (count) => `整理旧对话：最多把 ${count} 个对话发给模型`,
  backfillProgress: (done, total, failed, skipped, full) =>
    `模型正在整理旧对话：${done}/${total}${failed ? `，${failed} 个没有成功` : ""}${skipped ? `，${skipped} 个其他 Agent 的对话按设置不发送` : ""}${
      full ? `，${full} 个没有主线的对话因主线已满 ${MAX_CONVERSATIONS} 条不发送` : ""
    }`,
  backfillStop: "停止",
  backfillStopped: "已停止整理旧对话。正在进行的凝练会做完，其余不再发给模型。",
  summarizerBusy: (running, queued) => `模型正在凝练 ${running} 个对话${queued ? `，还有 ${queued} 个排队` : ""}`,
  summarizerError: (message) => `最近一次凝练没有成功：${message}`,
  summaryProblem: {
    CLAUDE_MISSING: "没有找到 Claude Code（claude 命令）：请安装，或在设置里改用 Codex 凝练",
    CODEX_MISSING: "没有找到 Codex（codex 命令）：请安装，或在设置里改用 Claude Haiku 凝练",
    MODEL_CALLS_OFF: "模型调用已关闭（MAINLINE_NO_MODEL=1），没有发送任何内容",
  },
  summarizerToday: (count, limit, claude, codex) => `今天自动凝练 ${count}/${limit}（Claude ${claude}，Codex ${codex}）`,
  summarizerAsked: (manual, backfill) => `手动凝练 ${manual}，整理旧对话 ${backfill}`,
  autoSummarize: "每轮回复结束后，用模型自动凝练主线（标题、标签、里程碑和状态）",
  summarizeModel: "Claude Code 和 Codex 的对话用哪个模型凝练",
  summarizeModels: { follow: "跟随对话：Claude Code 对话用 Claude Haiku，Codex 对话用 Codex", claude: "都用 Claude Haiku", codex: "都用 Codex" },
  summarizeOthers: "其他 Agent（如 pi、DeepSeek、Grok）的对话",
  summarizeOthersOptions: {
    none: "不凝练，不发给任何模型",
    claude: "用 Claude Haiku 凝练：对话内容发给你的 Claude Code 所用的服务商",
    codex: "用 Codex 凝练：对话内容发给你的 Codex 所用的服务商",
  },
  summarizeOthersHint: "选「不凝练」时，这些对话保持「未凝练」，自动凝练和整理旧对话都会跳过它们。",

  refsSection: "PR 与 Issue",
  favoritesSection: "收藏",
  favoritesIntro: "在对话里选中一段文字，点出现的「★ 收藏」；装好 Agent 协作后，也可以在聊天里说「收藏上一条回复」。点「跳回原文」会打开那个对话，并高亮这段文字。",
  favoritesEmpty: "还没有收藏。在对话里选中一段文字，点出现的「★ 收藏」，就会存到这里。",
  favoritesPlaceholder: "搜索收藏：原文、备注或对话标题",
  favoritesNone: "没有符合的收藏。",
  favoriteRole: { agent: "回复", user: "我的话" },
  favoriteNote: (text) => `备注：${text}`,
  jumpToPassage: "跳回原文",
  openConversation: "打开这个对话",
  openFailed: (reason) => `没能打开这个对话：${reason || "codexhost 没有回应"}。它可能在另一台机器上，或已被删除。`,
  copy: "复制",
  copied: "已复制",
  copyFailed: "没能复制：这个页面不允许写剪贴板，请手动选中文字复制。",
  addNote: "备注",
  editNote: "改备注",
  notePlaceholder: "写一句备注，Enter 保存，Esc 取消",
  removeFavorite: "删除",
  expandPassage: "展开全文",
  foldPassage: "收起",
  refsIntro:
    "所有在 codexhost 对话里出现过的 GitHub PR 和 issue：来自哪个对话、当时为了解决什么问题。有人评审、合并或评论时，这里排在最前，侧栏里提出它的对话行上挂 🔔（这个对话在侧栏里看不到时，算进侧栏顶部的「🔔 N」），悬停卡片最上面也会显示；打开了主线胶囊时胶囊上也会提醒。在这里点「跳转」、在卡片里点「知道了」或在 🔔 显示着时点那一行，🔔 才消失。",
  refsEmpty: "还没有找到 PR 或 issue。扫描完成后，这里会列出对话里出现过的链接。",
  findRefs: "找 PR / Issue",
  refsPlaceholder: "输入编号、链接或关键词，例如 42",
  noResults: "没找到。索引只收录在 codexhost 对话里出现过的链接。",
  scanStatus: (scanned, listed, done, refs, unreadable = 0) =>
    (done ? `已扫描 ${scanned} 个对话，找到 ${refs} 个 PR/Issue` : `正在扫描对话：已读 ${scanned} 个（已列出 ${listed} 个），找到 ${refs} 个 PR/Issue`) +
    (unreadable ? `；${unreadable} 个对话 codexhost 读不出来，已跳过` : ""),
  githubStatus: (enabled, lastPollAt, error, now, refs) =>
    !enabled
      ? "GitHub 回复提醒已关闭"
      : error
        ? `GitHub 回复提醒暂不可用：${error}`
        : lastPollAt
          ? `GitHub 回复提醒正常，${relative(lastPollAt, now, "zh-CN")}检查过`
          : refs
            ? "GitHub 回复提醒即将开始"
            : "GitHub 回复提醒已开启，有 PR 或 issue 后开始检查",
  kind: { pr: "PR", issue: "Issue" },
  refState: { open: "进行中", closed: "已关闭", merged: "已合并" },
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
  fromWindow: (title) => `来源对话「${title}」`,
  turn: (n) => `第 ${n} 轮`,
  inWindows: (n) => `出现在 ${n} 个对话`,
  asked: (text) => `当时的问题：${text}`,
  noteLabel: (text) => `说明：${text}`,

  integrations: "Agent 协作",
  integrationsIntro:
    "装好后，Claude Code 在每个会话的第一条消息时读到本对话的主线和约定，之后只在有变化时收到一行状态；Codex 在对话第一条消息时运行一次 mainline show。Agent 边做边记录支线任务（关掉自动凝练时也维护标题和里程碑），发现你在同一对话里开了新问题时按下方设置处理。安装前会显示要改的文件和内容，随时可以卸载。",
  agentName: { claude: "Claude Code", codex: "Codex" },
  integrationState: { installed: "已安装", missing: "未安装", outdated: "需要更新", unavailable: "不可用" },
  integrationProblem: (agent, problem, cause) => {
    const { name, folder, file } = AGENT_FILES[agent];
    const why = cause ? `（${cause}）` : "";
    switch (problem) {
      case "NOT_SET_UP":
        return `没有找到 ${name} 的配置（${folder} 不存在）`;
      case "NOT_A_FOLDER":
        return `${folder} 不是文件夹`;
      case "FOLDER_UNREADABLE":
        return `读不了 ${folder}${why}`;
      case "FILE_UNREADABLE":
        return `读不了 ${file}${why}，请先修好它`;
      case "NOT_JSON":
        return `${file} 不是有效的 JSON，请先修好它`;
      case "NOT_AN_OBJECT":
        return `${file} 不是 JSON 对象，请先修好它`;
    }
  },
  preview: "查看改动",
  install: "安装",
  update: "更新",
  uninstall: "卸载",
  previewTitle: (action, file) => `${action}：${file}`,
  previewAction: { create: "新建文件", add: "追加内容", replace: "替换旧版内容", remove: "删除这段内容", none: "无需改动" },
  applyChange: "确认修改",
  command: (path) => `Agent 使用的命令：${path}`,

  migratedNote: (folder) => `已从旧版「主线任务」复制数据。旧目录 ${folder} 仍在：确认无误后可以手动删除（里面的 backups/ 有你配置文件的完整备份）。0.10 以前开的子对话仍从这里读附件，删掉后它们就读不到这些文件了。`,

  settings: "设置",
  driftPolicy: "同一对话里出现新问题时",
  driftPolicies: { ask: "先问我（推荐）", note: "只记录，不打断", off: "不检查" },
  showCapsule: "对话标题栏也显示主线胶囊（切换到进行中的对话时自动展开 3 秒）",
  prAlerts: "我经手的 PR 或 issue 在 GitHub 上有人评审、合并或评论时提醒我（用已登录的 gh，只读；有 Codex Desktop 或 codexhost 的窗口开着时每分钟查一次，否则每 10 分钟）",

  attachmentsSection: "附件",
  attachmentsUsage: (files, size) => `开子对话时附带的文件：${files} 个，共 ${size}`,
  attachmentsNone: "开子对话时还没有附带过文件。",
  attachmentsIntro: "子对话以后还可能按路径读这些文件，所以不会自动删除。",
  clearDoneAttachments: (size) => `清理已完成子对话的附件（释放 ${size}）`,
  clearAllAttachments: (size) => `全部清理（释放 ${size}）`,
  clearingAttachments: "正在清理…",
  attachmentsCleared: (files, size) => `已删除 ${files} 个文件，释放 ${size}`,

  favoritesMore: (left) => `显示更多（还有 ${left} 条）`,
};

const en: PageStrings = {
  pageTitle: "Second Brain",
  loading: "Loading…",
  close: "Close",
  confirm: "Click again to confirm",
  armed: (label) => `${label}: click again within 3 seconds to confirm`,
  jump: "Go",
  cancel: "Cancel",
  time: (at, now) => relative(at, now, "en"),
  error: (code, message) => (isErrorCode(code) ? EN_ERRORS[code](detail(message)) : `That did not work: ${detail(message)}`),

  findLabel: "Find a conversation",
  findPlaceholder: "Number, link or words, for example 42",
  finding: "Searching…",
  findEmpty: "Nothing found. Try a PR or issue number, part of a link, a tag or words from the request.",
  findFailed: (message) => `Search failed: ${detail(message)}`,
  match: (field, text) => `Matched ${EN_MATCH[field] ?? "text"}: ${text}`,
  locate: "Show in the list",

  othersIntro: "No model has summarized these conversations into a mainline yet. Expand one to see what its title, workspace and the PRs it mentions suggest, and create a mainline from it.",
  status: { active: "Active", paused: "Paused", done: "Done" },
  threadStatus: { running: "Running", waiting: "Needs you", idle: "Idle", unknown: "Unknown" },
  draft: "Not summarized",
  progress: (done, total) => `◆ ${done}/${total}`,
  progressLabel: (done, total) => `${done} of ${total} milestones reached`,
  current: (title) => `Now: ${title}`,
  noMilestones: "No milestones yet",
  doing: (text) => `Doing: ${text}`,
  lastPrompt: (text) => `Last request: ${text}`,
  firstPrompt: (text) => `Started with: ${text}`,
  showAll: (n) => `Show all (${n})`,
  showLess: "Show less",
  parent: (title) => `Delegated from: ${title}`,
  related: (title) => `Linked to: ${title}`,
  updated: (time) => `Updated ${time}`,

  milestones: "Milestones",
  milestoneState: { done: "Reached", current: "Current", planned: "Planned" },
  reach: "Mark reached",
  focus: "Make current",
  rename: "Rename",
  removeMilestone: "Delete milestone",
  addTaskTo: "Add a task to this milestone",
  addMilestone: "Add a milestone…",
  addTask: "Add a task…",
  taskDone: "Done",
  removeTask: "Delete",
  carriedBy: (title) => `Handled in child conversation "${title}"`,
  editDoing: "Edit what is being done",
  clearDoing: "Clear what is being done",
  doingPlaceholder: "What is being done…",
  spinoffs: "Spin-offs",
  spinoffsOpen: (n) => `${n} open`,
  spawn: "Open child conversation",
  spawning: "Opening…",
  keep: "Handle here",
  dismiss: "Dismiss",
  spawned: (title) => `Child conversation "${title}"`,
  spawnedNotice: (text) => `Opened a child conversation for "${text}"`,
  addSpinoff: "Note a spin-off…",
  refs: "PRs and issues",
  editTitle: "Edit title",
  titlePlaceholder: "What this conversation does: action + object",
  editTags: "Edit tags",
  tagsPlaceholder: "Tags separated by commas, up to 8",
  statusLabel: "Status",
  deleteMainline: "Delete mainline",
  createMainline: "Create mainline",
  draftIntro: "No model has summarized this conversation into a mainline yet. Below is what its title, workspace and the PRs it mentions suggest.",
  tabConversations: (n) => `Conversations ${n}`,
  tabRefs: (n) => `PRs and issues ${n}`,
  tabFavorites: (n) => `Favorites ${n}`,
  tabSettings: "Settings",
  statusTabs: { active: "Active", paused: "Paused", done: "Done", others: "No mainline" },
  groupByLabel: "Group by",
  groupBy: { time: "By time", project: "By project" },
  timeBuckets: { today: "Today", yesterday: "Yesterday", week: "This week", earlier: "Earlier" },
  noWorkspace: "Other",
  childrenCount: (n) => `${n} child conversation${n === 1 ? "" : "s"}`,
  hideChildren: "Hide child conversations",
  emptyTab: "Nothing here yet.",
  summarized: (model, time) => `Summarized by a model ${time} (${model})`,
  resummarize: "Summarize again",
  summarizeQueued: "Asked the model; this updates shortly",
  pinnedNote: (parts) => `You changed ${englishList(parts)} by hand; the model leaves ${parts.length === 1 ? "it" : "them"} alone.`,
  pinnedParts: { title: "the title", tags: "the tags", status: "the status", milestones: (count) => `${count} milestone${count === 1 ? "" : "s"}` },
  unpin: "Summarize automatically again",
  backfillStart: (count) => `Summarize older conversations: send up to ${count} to the model`,
  backfillProgress: (done, total, failed, skipped, full) =>
    `Summarizing older conversations: ${done}/${total}${failed ? `, ${failed} did not work` : ""}${skipped ? `, ${skipped} from other agents not sent, per the settings` : ""}${
      full ? `, ${full} without a mainline not sent: the mainlines are at their cap of ${MAX_CONVERSATIONS.toLocaleString("en")}` : ""
    }`,
  backfillStop: "Stop",
  backfillStopped: "Stopped summarizing older conversations. Summaries in progress finish; nothing else is sent to the model.",
  summarizerBusy: (running, queued) => `Summarizing ${running} conversation${running === 1 ? "" : "s"}${queued ? `, ${queued} waiting` : ""}`,
  summarizerError: (message) => `The last summary did not work: ${message}`,
  summaryProblem: {
    CLAUDE_MISSING: "Claude Code (the claude command) was not found on this computer: install it, or choose Codex for summaries in the settings",
    CODEX_MISSING: "Codex (the codex command) was not found on this computer: install it, or choose Claude Haiku for summaries in the settings",
    MODEL_CALLS_OFF: "Model calls are turned off (MAINLINE_NO_MODEL=1): nothing was sent",
  },
  summarizerToday: (count, limit, claude, codex) => `Automatic summaries today: ${count}/${limit} (Claude ${claude}, Codex ${codex})`,
  summarizerAsked: (manual, backfill) => `asked for: ${manual}, older conversations: ${backfill}`,
  autoSummarize: "After each reply, let a model summarize the mainline (title, tags, milestones and status)",
  summarizeModel: "Model for Claude Code and Codex conversations",
  summarizeModels: { follow: "Follow the conversation: Claude Haiku for Claude Code, Codex for Codex", claude: "Claude Haiku for both", codex: "Codex for both" },
  summarizeOthers: "Conversations of other agents (pi, DeepSeek, Grok, …)",
  summarizeOthersOptions: {
    none: "Do not summarize; send them to no model",
    claude: "Claude Haiku: the conversation text goes to the provider your Claude Code uses",
    codex: "Codex: the conversation text goes to the provider your Codex uses",
  },
  summarizeOthersHint: "With “Do not summarize”, these conversations stay “Not summarized”: automatic summaries and the backfill skip them.",

  refsSection: "PRs and issues",
  favoritesSection: "Favorites",
  favoritesIntro:
    "Select text in a conversation and click the “★ Save” button that appears; with the agent integration installed, you can also say “save the last reply” in the chat. “Go to passage” opens its conversation and highlights it.",
  favoritesEmpty: "Nothing saved yet. Select text in a conversation and click “★ Save”; it is kept here.",
  favoritesPlaceholder: "Search saved passages, notes or conversation titles",
  favoritesNone: "No saved passage matches.",
  favoriteRole: { agent: "reply", user: "your message" },
  favoriteNote: (text) => `Note: ${text}`,
  jumpToPassage: "Go to passage",
  openConversation: "Open this conversation",
  openFailed: (reason) => `Could not open this conversation: ${reason || "codexhost did not answer"}. It may be on another machine, or deleted.`,
  copy: "Copy",
  copied: "Copied",
  copyFailed: "Could not copy: this page may not write to the clipboard; select the text and copy it instead.",
  addNote: "Note",
  editNote: "Edit note",
  notePlaceholder: "A short note; Enter saves, Esc cancels",
  removeFavorite: "Delete",
  expandPassage: "Show all",
  foldPassage: "Show less",
  refsIntro:
    "Every GitHub PR and issue that came up in a codexhost conversation: which conversation it came from and what it was for. When someone reviews, merges or comments, it moves to the top here, the conversation's sidebar row gets a 🔔 (counted in the 🔔 N at the top of the sidebar when the sidebar does not show that conversation) and its hover card shows the news first; the capsule shows it too when it is on. The 🔔 goes away once you select Go here, Got it in the card, or the row while its 🔔 shows.",
  refsEmpty: "No PRs or issues found yet. Once the scan finishes, the links from your conversations show here.",
  findRefs: "Find a PR or issue",
  refsPlaceholder: "Number, link or words, for example 42",
  noResults: "Nothing found. The index holds links that appeared in codexhost conversations.",
  scanStatus: (scanned, listed, done, refs, unreadable = 0) =>
    (done ? `Read ${scanned} conversations, found ${refs} PRs and issues` : `Reading conversations: ${scanned} read (${listed} listed), ${refs} PRs and issues found`) +
    (unreadable ? `; skipped ${unreadable} that codexhost cannot read` : ""),
  githubStatus: (enabled, lastPollAt, error, now, refs) =>
    !enabled
      ? "GitHub reply alerts are off"
      : error
        ? `GitHub reply alerts unavailable: ${error}`
        : lastPollAt
          ? `GitHub reply alerts on, last checked ${relative(lastPollAt, now, "en")}`
          : refs
            ? "GitHub reply alerts start shortly"
            : "GitHub reply alerts on; checking starts once a PR or issue shows up",
  kind: { pr: "PR", issue: "Issue" },
  refState: { open: "Open", closed: "Closed", merged: "Merged" },
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
  fromWindow: (title) => `From "${title}"`,
  turn: (n) => `turn ${n}`,
  inWindows: (n) => `In ${n} conversations`,
  asked: (text) => `Asked then: ${text}`,
  noteLabel: (text) => `Note: ${text}`,

  integrations: "Agent integration",
  integrationsIntro:
    "Once installed, Claude Code reads the conversation's mainline and rules with the first message of each session, and afterwards gets one status line only when something changed; Codex runs mainline show once at the first message of a conversation. Agents record tasks as they work (and keep the title and milestones when automatic summaries are off), and handle a new problem in the same conversation as set below. You see the exact change before it is made, and can remove it at any time.",
  agentName: { claude: "Claude Code", codex: "Codex" },
  integrationState: { installed: "Installed", missing: "Not installed", outdated: "Needs update", unavailable: "Unavailable" },
  integrationProblem: (agent, problem, cause) => {
    const { name, folder, file } = AGENT_FILES[agent];
    const why = cause ? ` (${cause})` : "";
    switch (problem) {
      case "NOT_SET_UP":
        return `${name} is not set up (${folder} is missing)`;
      case "NOT_A_FOLDER":
        return `${folder} is not a folder`;
      case "FOLDER_UNREADABLE":
        return `${folder} cannot be read${why}`;
      case "FILE_UNREADABLE":
        return `${file} cannot be read${why}; fix it first`;
      case "NOT_JSON":
        return `${file} is not valid JSON; fix it first`;
      case "NOT_AN_OBJECT":
        return `${file} is not a JSON object; fix it first`;
    }
  },
  preview: "Show change",
  install: "Install",
  update: "Update",
  uninstall: "Remove",
  previewTitle: (action, file) => `${action}: ${file}`,
  previewAction: { create: "Create the file", add: "Add", replace: "Replace the old version", remove: "Remove this section", none: "Nothing to change" },
  applyChange: "Apply",
  command: (path) => `Command agents use: ${path}`,

  migratedNote: (folder) =>
    `Copied the data over from the earlier version, “Mainline”. The old folder ${folder} is still there: once everything looks right, you can delete it by hand (its backups/ folder holds full copies of your configuration files). Child conversations opened before 0.10 read their attachments from there; deleting it takes those files away from them.`,

  settings: "Settings",
  driftPolicy: "When a new problem shows up in the same conversation",
  driftPolicies: { ask: "Ask me first (recommended)", note: "Note it, keep going", off: "Do not check" },
  showCapsule: "Also show the mainline capsule in the conversation header (it opens for 3 seconds when you switch to an active conversation)",
  prAlerts: "Alert me when someone reviews, merges or comments on a PR or issue I worked on (uses your gh login, read only; checks every minute while a Codex Desktop or codexhost window is open, every 10 minutes otherwise)",

  attachmentsSection: "Attachments",
  attachmentsUsage: (files, size) => `Files sent along with child conversations: ${plural(files, "file")}, ${size}`,
  attachmentsNone: "No files have been sent along with child conversations.",
  attachmentsIntro: "Child conversations may read these files again from their paths, so they are not deleted automatically.",
  clearDoneAttachments: (size) => `Clear files of child conversations marked done (frees ${size})`,
  clearAllAttachments: (size) => `Clear all (frees ${size})`,
  clearingAttachments: "Clearing…",
  attachmentsCleared: (files, size) => `Deleted ${plural(files, "file")}, freed ${size}`,

  favoritesMore: (left) => `Show more (${left} left)`,
};

export function pageStrings(locale: Locale): PageStrings {
  return locale === "zh-CN" ? zh : en;
}
