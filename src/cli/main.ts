/**
 * `mainline`: the command agents run to read and keep current the mainline of their conversation:
 * a specific title and tags, milestones (stage results), tasks between them, spin-offs that become
 * child conversations, and links back to PRs and issues. `run` is the whole program.
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ExternalApi } from "../node/external-api.js";
import { ATTACH_MAX_FILE_BYTES, ATTACH_MAX_FILES, ATTACH_MAX_TOTAL_BYTES, formatSize } from "../core/attachments.js";
import { currentMilestone, V2_LIMITS, type ConversationStatus, type StateV2 } from "../core/conversation.js";
import {
  addMilestone,
  addSpinoff,
  addTags,
  addTask,
  completeTask,
  createConversation,
  dismissSpinoff,
  focusMilestone,
  isExcluded,
  keepSpinoff,
  linkSpinoff,
  noteHosts,
  planMilestones,
  reachMilestone,
  recordPromptV2,
  relate,
  removeMilestone,
  removeTags,
  renameMilestone,
  requireConversation,
  resolveMilestone,
  setDoing,
  setStatus,
  setTags,
  setTitle,
  spinoffOf,
  type V2Context,
} from "../core/conversation-ops.js";
import { conversationView, type ConversationView, type DraftFacts, type ViewSources } from "../core/conversation-view.js";
import { addFavorite, flatten, lastReply, locatePassage, removeFavorite, searchFavorites, type NewFavorite } from "../core/favorites.js";
import { DEFAULT_SETTINGS, isErrorCode, isThreadId, localeOf, MainlineError, type ErrorCode, type Locale, type Settings } from "../core/model.js";
import { agentContextV2, agentRulesV2, nextContext, statusLineV2, type ContextPrint, type ProtocolV2Options } from "../core/protocol-v2.js";
import { addMention, extractLinks, refView, setNote, type RefIndex } from "../core/refs.js";
import { searchConversations } from "../core/search.js";
import { fingerprint, pruneSeen, readSeen, writeSeen, type ContextChannel } from "../node/context-record.js";
import { spawnChild, type DelegationApi } from "../node/delegate.js";
import { favoritesPaths, readFavorites, updateFavorites } from "../node/favorites-store.js";
import { createGhRunner, type RunGh } from "../node/gh.js";
import { freshenRefs } from "../node/refs-github.js";
import { commandPath, defaultDataDir, EXTENSION_ID, isExtensionDataDir } from "../node/paths.js";
import { readIndex, refsPaths, updateIndex } from "../node/refs-store.js";
import { readSettings, readState, storePaths, updateState, type StorePaths } from "../node/store.js";

declare const __VERSION__: string;
const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "dev";

export interface CliIo {
  env: NodeJS.ProcessEnv;
  stdout(text: string): void;
  stderr(text: string): void;
  readStdin?(): Promise<string>;
  /** Where this script lives; an installed copy sits in `<data dir>/bin/`. */
  scriptPath?: string;
  now?(): number;
  /** Overrides how child conversations are started (tests). */
  delegation?: DelegationApi;
  /** Overrides how gh is run (tests). */
  runGh?: RunGh;
  /** Overrides how a conversation's turns are read (tests). */
  turns?: Pick<ExternalApi, "readTurns">;
}

interface Flags {
  json: boolean;
  clear: boolean;
  help: boolean;
  version: boolean;
  all: boolean;
  /** `show`: everything, even when the agent has seen it already. */
  full: boolean;
  thread?: string;
  dataDir?: string;
  tags?: string;
  plan?: string;
  harness?: string;
}

const VALUE_FLAGS: Record<string, "thread" | "dataDir" | "tags" | "plan" | "harness"> = {
  "--thread": "thread",
  "--data-dir": "dataDir",
  "--tags": "tags",
  "--plan": "plan",
  "--harness": "harness",
};

export function parseArgs(argv: readonly string[]): { positional: string[]; flags: Flags } {
  const flags: Flags = { json: false, clear: false, help: false, version: false, all: false, full: false };
  const positional: string[] = [];
  let literal = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (literal || !arg.startsWith("-") || arg === "-") {
      positional.push(arg);
      continue;
    }
    if (arg === "--") {
      literal = true;
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined;
    const valueKey = VALUE_FLAGS[name];
    if (valueKey) {
      const value = inline ?? argv[(index += 1)];
      if (value === undefined) throw new MainlineError("INVALID_ARGUMENT", `${name} needs a value`);
      flags[valueKey] = value;
      continue;
    }
    switch (name) {
      case "--json":
        flags.json = true;
        break;
      case "--clear":
        flags.clear = true;
        break;
      case "--all":
        flags.all = true;
        break;
      case "--full":
        flags.full = true;
        break;
      case "-h":
      case "--help":
        flags.help = true;
        break;
      case "--version":
        flags.version = true;
        break;
      default:
        // Text that happens to start with a dash, such as "-1 test", stays text.
        positional.push(arg);
    }
  }
  return { positional, flags };
}

export function resolveDataDir(flags: Pick<Flags, "dataDir">, io: Pick<CliIo, "env" | "scriptPath">): string {
  if (flags.dataDir) return path.resolve(flags.dataDir);
  if (io.env.MAINLINE_DATA_DIR?.trim()) return path.resolve(io.env.MAINLINE_DATA_DIR);
  if (io.scriptPath) {
    const installed = path.dirname(path.dirname(io.scriptPath));
    if (isExtensionDataDir(installed)) return installed;
  }
  return defaultDataDir(io.env);
}

/** "a|b|c", or several arguments each one milestone. */
function splitPlan(values: readonly string[]): string[] {
  return values
    .flatMap((value) => value.split("|"))
    .map((title) => title.trim())
    .filter(Boolean);
}

/** What an UNKNOWN_ITEM message ("No milestone \"x\"", "No spin-off s2", …) names, in Chinese. */
function unknownItemZh(message: string): string {
  const found = /^No (?:such )?(milestone|task|spin-off|saved passage)\b\s*(.*)$/u.exec(message);
  const what: Record<string, string> = { milestone: "里程碑", task: "支线任务", "spin-off": "引申问题", "saved passage": "收藏" };
  return found ? `${what[found[1] ?? ""] ?? ""}${found[2] ? ` ${found[2]}` : ""}` : message;
}

/**
 * What the command line says for each error code. NO_MAINLINE depends on more than the code (see
 * `error` below); INVALID_ARGUMENT is the command line's own word on its arguments, as it is.
 */
const ZH_ERRORS: Record<ErrorCode, (message: string) => string> = {
  INVALID_ARGUMENT: (message) => message,
  EMPTY_TEXT: (message) => `内容不能为空（${message}）。`,
  NO_THREAD: () => "找不到当前对话：请在 codexhost 会话里运行（需要环境变量 CODEXHOST_THREAD_ID 或 CODEX_THREAD_ID），或用 --thread <id> 指定。",
  NO_MAINLINE: () => "本对话还没有主线。",
  NO_CURRENT_MILESTONE: () => "没有当前里程碑可以达成。运行 mainline show --full 查看里程碑。",
  UNKNOWN_ITEM: (message) => `找不到这一项：${unknownItemZh(message)}。里程碑和引申问题的名称与编号见 mainline show --full，收藏的编号见 mainline fav list。`,
  MILESTONE_EXISTS: () => "这个里程碑已经有了。",
  MILESTONE_LIMIT: () => `一条主线最多 ${V2_LIMITS.milestones} 个里程碑，这次没有加上。`,
  LOCKED: () => "主线数据正在写入，请稍后重试。",
  STATE_FULL: () => "主线数据已满，请在总览页删除不用的主线。",
  FAVORITES_FULL: () => "收藏已满，请在总览页「收藏」里删除不用的收藏。",
  FILE_FULL: (message) => `数据文件已满，这次没有保存（${message}）。`,
  TOO_LARGE: (message) => `超出上限：${message}`,
  ATTACHMENT_TOO_LARGE: () => `单个附件不能超过 ${formatSize(ATTACH_MAX_FILE_BYTES)}。`,
  TOO_MANY_ATTACHMENTS: () => `最多附带 ${ATTACH_MAX_FILES} 个文件。`,
  UPLOADS_BUSY: () => "等着发送的附件太多，请稍后重试。",
  CHILD_FILES_TOO_LARGE: () => `一个子对话的附件合计不能超过 ${formatSize(ATTACH_MAX_TOTAL_BYTES)}。`,
  NO_SUMMARIZER: () => "按设置，这个 Agent 的对话不发给模型。要凝练，请在总览页「设置」里为「其他 Agent（如 pi、DeepSeek、Grok）的对话」选一个模型。",
  UNAVAILABLE: (message) => `改不了 Agent 协作：${message}`,
  NEWER_VERSION: () => "主线的数据文件是更新版本的插件写的，这个版本不读也不改它。请把第二大脑插件更新到最新版本。",
  PENDING: () => "codexhost 没有及时答复，子对话可能还在打开：开好后会出现在本对话下方，先不要再点。",
  REMOTE_ATTACHMENTS: () => "这个对话在另一台电脑上，子对话也开在那里，那台电脑读不到本机的文件：开子对话时不能附带照片、文件或视频。",
};

const EN_ERRORS: Record<ErrorCode, (message: string) => string> = {
  INVALID_ARGUMENT: (message) => message,
  EMPTY_TEXT: (message) => `The text cannot be empty (${message}).`,
  NO_THREAD: () => "No current conversation: run this inside a codexhost session (CODEXHOST_THREAD_ID or CODEX_THREAD_ID), or pass --thread <id>.",
  NO_MAINLINE: () => "This conversation has no mainline yet.",
  NO_CURRENT_MILESTONE: () => "There is no current milestone to reach. Run mainline show --full to see the milestones.",
  UNKNOWN_ITEM: (message) => `${message}. See mainline show --full for milestones and spin-off ids, mainline fav list for saved passages.`,
  MILESTONE_EXISTS: () => "That milestone exists already.",
  MILESTONE_LIMIT: () => `A mainline has at most ${V2_LIMITS.milestones} milestones; this one was not added.`,
  LOCKED: () => "The mainline state is being written; try again in a moment.",
  STATE_FULL: () => "The mainline data is full; delete mainlines you no longer need in the overview.",
  FAVORITES_FULL: () => "The saved passages are full; delete ones you no longer need in the overview's Favorites tab.",
  FILE_FULL: (message) => `A data file is full; nothing was saved (${message}).`,
  TOO_LARGE: (message) => `Over the limit: ${message}`,
  ATTACHMENT_TOO_LARGE: () => `One attachment may be ${formatSize(ATTACH_MAX_FILE_BYTES)} at most.`,
  TOO_MANY_ATTACHMENTS: () => `At most ${ATTACH_MAX_FILES} files.`,
  UPLOADS_BUSY: () => "Too many files are waiting to be sent; try again in a moment.",
  CHILD_FILES_TOO_LARGE: () => `The files of one child conversation may add up to ${formatSize(ATTACH_MAX_TOTAL_BYTES)} at most.`,
  NO_SUMMARIZER: () =>
    "The settings send conversations of this agent to no model. To summarize it, choose a model under “Conversations of other agents (pi, DeepSeek, Grok, …)” in the overview's Settings tab.",
  UNAVAILABLE: (message) => `The agent integration cannot be changed: ${message}`,
  NEWER_VERSION: () => "A data file was written by a newer version of the extension; this version neither reads nor changes it. Update the Second Brain extension.",
  PENDING: () => "No answer from codexhost yet; the child may still open under this conversation.",
  REMOTE_ATTACHMENTS: () => "This conversation is on another computer, where the child opens too, and that computer cannot read files on this one: no photos, files or videos can go along.",
};

const zh = {
  created: (title: string, milestones: number) => `✓ 主线：「${title}」${milestones ? `，${milestones} 个里程碑` : ""}`,
  title: (title: string) => `✓ 主线标题：「${title}」`,
  tags: (tags: string[]) => (tags.length ? `✓ 标签：${tags.map((tag) => `#${tag}`).join(" ")}` : "✓ 已清空标签"),
  planned: (titles: string[]) => (titles.length ? `✓ 新增里程碑：${titles.join(" → ")}` : "没有新增里程碑（都已存在）"),
  reached: (title: string, next?: string) => `✓ 达成里程碑「${title}」${next ? `，下一阶段「${next}」` : "，没有后续阶段了"}`,
  milestone: (what: string, title: string) => `✓ 里程碑${what}：「${title}」`,
  added: "已添加",
  renamed: "已改名",
  removed: "已删除",
  focused: "设为当前",
  doing: (text: string) => `✓ 正在做：${text}`,
  doingCleared: "✓ 已清除「正在做」",
  done: (text: string, milestone: string) => `✓ 完成：${text}（阶段「${milestone}」）`,
  task: (text: string, milestone: string) => `✓ 支线任务：${text}（阶段「${milestone}」）`,
  spinoff: (text: string, id: string) => `✓ 记下引申问题：${text}（编号 ${id}）。用户同意开子对话时运行 mainline spawn ${id}。`,
  spawned: (title: string, threadId: string) => `✓ 已开子对话「${title}」（${threadId}）`,
  kept: (text: string) => `✓ 改为在本对话处理：${text}`,
  dismissed: "✓ 已忽略这个引申问题",
  linked: (key: string, note: string) => `✓ 已把 ${key} 记到本对话${note ? `：${note}` : ""}`,
  status: (status: string) => `✓ 状态：${({ active: "进行中", paused: "已暂停", done: "已完成" } as Record<string, string>)[status] ?? status}`,
  related: (threadId: string | null) => (threadId ? `✓ 已关联到对话 ${threadId}` : "✓ 已取消关联"),
  backfill:
    "✓ 已请模型把还没按最新内容凝练过的对话凝练一遍（用户删掉主线的对话除外）：插件后台一分钟内开始，在总览页可以看到进度，也可以停止。Claude Code 和 Codex 以外的 Agent 的对话不会发给模型，除非在设置里为它们选了模型。",
  favSaved: (excerpt: string, turn?: number) => `✓ 已收藏${turn ? `第 ${turn} 轮的` : ""}：${excerpt}。在总览页「收藏」页签里可以找到。`,
  favAgain: (excerpt: string) => `这段之前已经收藏过：${excerpt}`,
  favNoReply: "还没有可以收藏的回复。",
  favEmpty: "还没有收藏。",
  favLine: (excerpt: string, title: string, turn: number | undefined, id: string) => `· ${excerpt}（「${title}」${turn ? `第 ${turn} 轮` : ""}，编号 ${id}）`,
  favRemoved: "✓ 已取消收藏",
  listEmpty: "没有进行中或暂停的主线。",
  listLine: (title: string, progress: string, current: string | undefined, threadId: string) =>
    `「${title}」${progress}${current ? ` 当前：${current}` : ""} · ${threadId}`,
  found: (title: string, tags: string[], draft: boolean) =>
    `「${title}」${tags.length ? ` ${tags.map((tag) => `#${tag}`).join(" ")}` : ""}${draft ? "（草稿）" : ""}`,
  foundWhere: (threadId: string, progress: string, current?: string) =>
    `  对话：${threadId}${progress ? ` · 里程碑 ${progress}` : ""}${current ? ` 当前「${current}」` : ""}`,
  foundWhy: (field: string, text: string) => `  命中${field}：${text}`,
  foundRefs: (line: string) => `  PR/Issue：${line}`,
  refWord: (kind: string, number: number, state: string | undefined, title: string | undefined) =>
    `${kind === "pr" ? "PR" : "Issue"} #${number}${state ? ` ${({ open: "进行中", closed: "已关闭", merged: "已合并" } as Record<string, string>)[state] ?? state}` : ""}${title ? `「${title.slice(0, 40)}」` : ""}`,
  field: { ref: "PR/Issue", tag: "标签", title: "主线标题", threadTitle: "对话标题", milestone: "里程碑", task: "支线任务", spinoff: "引申问题", prompt: "当时的问题", favorite: "收藏" } as Record<string, string>,
  notFound: (query: string) => `没有找到「${query}」。`,
  fullHint: "完整内容（里程碑、支线任务和约定）：mainline show --full",
  error: (code: string, message: string, summaries: boolean, deleted = false): string => {
    if (code === "NO_MAINLINE") {
      if (deleted) return "用户删除了本对话的主线，所以不再记录支线任务，也不要重新建立；需要时用户会在总览页自己建立。";
      return summaries
        ? "本对话还没有主线：插件会在本轮结束后调用模型凝练出标题、标签和里程碑，不用手动建立。现在可以先用 mainline doing、task、done 记录支线任务。"
        : '本对话还没有主线。先运行 mainline new "具体标题" --tags "a,b" --plan "阶段1|阶段2"。';
    }
    return isErrorCode(code) ? ZH_ERRORS[code](message) : message;
  },
};

const en: typeof zh = {
  created: (title, milestones) => `✓ Mainline: "${title}"${milestones ? `, ${milestones} milestones` : ""}`,
  title: (title) => `✓ Title: "${title}"`,
  tags: (tags) => (tags.length ? `✓ Tags: ${tags.map((tag) => `#${tag}`).join(" ")}` : "✓ Tags cleared"),
  planned: (titles) => (titles.length ? `✓ Milestones added: ${titles.join(" → ")}` : "No milestones added (they exist already)"),
  reached: (title, next) => `✓ Reached "${title}"${next ? `; next stage "${next}"` : "; no further stages"}`,
  milestone: (what, title) => `✓ Milestone ${what}: "${title}"`,
  added: "added",
  renamed: "renamed",
  removed: "removed",
  focused: "made current",
  doing: (text) => `✓ Doing: ${text}`,
  doingCleared: "✓ Cleared what is being done",
  done: (text, milestone) => `✓ Done: ${text} (stage "${milestone}")`,
  task: (text, milestone) => `✓ Task: ${text} (stage "${milestone}")`,
  spinoff: (text, id) => `✓ Spin-off noted: ${text} (id ${id}). If the user wants a child conversation: mainline spawn ${id}`,
  spawned: (title, threadId) => `✓ Child conversation "${title}" started (${threadId})`,
  kept: (text) => `✓ Handled in this conversation instead: ${text}`,
  dismissed: "✓ Spin-off dismissed",
  linked: (key, note) => `✓ Recorded ${key} for this conversation${note ? `: ${note}` : ""}`,
  status: (status) => `✓ Status: ${status}`,
  related: (threadId) => (threadId ? `✓ Linked to conversation ${threadId}` : "✓ Link removed"),
  backfill:
    "✓ The model will summarize every conversation not yet summarized as it is now (except those whose mainline the user deleted): the extension starts within a minute; the overview shows the progress and can stop it. Conversations of agents other than Claude Code and Codex are not sent to a model unless the settings choose one for them.",
  favSaved: (excerpt, turn) => `✓ Saved${turn ? ` from turn ${turn}` : ""}: ${excerpt}. Find it in the overview's Favorites tab.`,
  favAgain: (excerpt) => `This passage was saved before: ${excerpt}`,
  favNoReply: "There is no reply to save yet.",
  favEmpty: "Nothing saved yet.",
  favLine: (excerpt, title, turn, id) => `· ${excerpt} ("${title}"${turn ? `, turn ${turn}` : ""}, id ${id})`,
  favRemoved: "✓ Removed from the favorites",
  listEmpty: "No active or paused mainlines.",
  listLine: (title, progress, current, threadId) => `"${title}"${progress}${current ? ` now: ${current}` : ""} · ${threadId}`,
  found: (title, tags, draft) => `"${title}"${tags.length ? ` ${tags.map((tag) => `#${tag}`).join(" ")}` : ""}${draft ? " (draft)" : ""}`,
  foundWhere: (threadId, progress, current) =>
    `  Conversation: ${threadId}${progress ? ` · milestones ${progress}` : ""}${current ? ` now "${current}"` : ""}`,
  foundWhy: (field, text) => `  Matched ${field}: ${text}`,
  foundRefs: (line) => `  PRs and issues: ${line}`,
  refWord: (kind, number, state, title) =>
    `${kind === "pr" ? "PR" : "Issue"} #${number}${state ? ` ${({ open: "open", closed: "closed", merged: "merged" } as Record<string, string>)[state] ?? state}` : ""}${title ? ` "${title.slice(0, 40)}"` : ""}`,
  field: { ref: "PR/issue", tag: "tag", title: "title", threadTitle: "conversation title", milestone: "milestone", task: "task", spinoff: "spin-off", prompt: "request", favorite: "saved passage" },
  notFound: (query) => `Nothing found for "${query}".`,
  fullHint: "Everything (milestones, tasks and rules): mainline show --full",
  error: (code, message, summaries, deleted = false) => {
    if (code === "NO_MAINLINE") {
      if (deleted) return "The user deleted this conversation's mainline: tasks are not recorded, and do not create it again; the user can do that from the overview.";
      return summaries
        ? "This conversation has no mainline yet: the extension has a model write its title, tags and milestones after this turn, so do not create one by hand. Record tasks with mainline doing, task or done meanwhile."
        : 'This conversation has no mainline yet. Run mainline new "specific title" --tags "a,b" --plan "stage 1|stage 2".';
    }
    return isErrorCode(code) ? EN_ERRORS[code](message) : message;
  },
};

/**
 * What the command line prints for an error, by its code, in the conversation's language. Telling
 * an agent there is no mainline depends on whether a model keeps the mainlines (`summaries`) and on
 * whether the user deleted this one (`deleted`).
 */
export function errorText(locale: Locale, code: string, message: string, summaries: boolean, deleted = false): string {
  return (locale === "zh-CN" ? zh : en).error(code, message, summaries, deleted);
}

const USAGE = `mainline ${VERSION} — keep this conversation on its mainline (codexhost Second Brain extension)

  mainline show [--full] [--json]        This conversation's mainline, milestones, tasks and the rules;
                                         after the first time a status line (--full: everything again)
  mainline new "<title>" [--tags "a,b"] [--plan "m1|m2"]
                                         Create the mainline (or refine it)
  mainline title "<title>"               Make the title more specific
  mainline tags "a,b,c" | tags add <t…> | tags remove <t…>
  mainline plan "m1|m2"                  Add planned milestones (stage results)
  mainline reach [<milestone>]           Mark the current (or given) milestone reached
  mainline milestone add|rename|remove|focus …
  mainline doing "<task>"                The task in progress (--clear clears it)
  mainline done ["<task>"]               Finish a task (the one in progress by default)
  mainline task "<task>"                 Add a task to the current milestone
  mainline spinoff "<problem>"           Note a new problem that branches off
  mainline spawn <id> [--harness <id>]   Open a child conversation for it
  mainline keep <id> | dismiss <id>      Handle it here instead, or drop it
  mainline link <GitHub PR or issue URL> ["<note>"]
                                         Record a GitHub PR or issue and what it is for
  mainline find <clue>                   Find conversations by number, link or words
  mainline status active|paused|done     (finish = done)
  mainline relate <thread> | relate --clear
  mainline summarize --all               Summarize, in the background, every conversation not yet summarized
                                         as it is now (other agents' only if a model is set for them)
  mainline fav last                      Save the previous reply, in full, to the favorites
  mainline fav "<passage>"               Save a passage of this conversation
  mainline fav list [<words>] | fav remove <id>
  mainline list [--json]

Options: --thread <id> (default $CODEXHOST_THREAD_ID, then $CODEX_THREAD_ID), --data-dir <dir>, --json
`;

function localeFor(state: StateV2, env: NodeJS.ProcessEnv): Locale {
  return state.locale ?? localeOf(env.LC_ALL || env.LC_MESSAGES || env.LANG);
}

/**
 * The conversation a command is about, and where its id came from. Only conversation ids count
 * (they are keys of plain objects throughout): `--thread` with anything else is refused, and an
 * environment variable holding anything else names no conversation.
 */
function threadSource(flags: Pick<Flags, "thread">, env: NodeJS.ProcessEnv): { threadId: string; from: "flag" | "codexhost" | "codex" } | undefined {
  if (flags.thread !== undefined) {
    const threadId = flags.thread.trim();
    if (!threadId) return undefined;
    if (!isThreadId(threadId)) throw new MainlineError("INVALID_ARGUMENT", "--thread is not a conversation id");
    return { threadId, from: "flag" };
  }
  const codexhost = env.CODEXHOST_THREAD_ID?.trim();
  if (codexhost) return isThreadId(codexhost) ? { threadId: codexhost, from: "codexhost" } : undefined;
  const codex = env.CODEX_THREAD_ID?.trim();
  return codex && isThreadId(codex) ? { threadId: codex, from: "codex" } : undefined;
}

function threadOf(flags: Flags, env: NodeJS.ProcessEnv): string {
  const source = threadSource(flags, env);
  if (!source) throw new MainlineError("NO_THREAD", "No current conversation");
  return source.threadId;
}

/**
 * Codex sets CODEX_THREAD_ID in every session, codexhost's or not. A conversation with no
 * mainline, no recorded message and no place in the link index is no codexhost conversation.
 */
function knownThread(state: StateV2, index: RefIndex, threadId: string): boolean {
  return Object.hasOwn(state.conversations, threadId) || Object.hasOwn(state.prompts, threadId) || Object.hasOwn(index.threads, threadId);
}

/**
 * Whether codexhost started this process. Besides CODEXHOST_THREAD_ID it gives the sessions it
 * runs other CODEXHOST_* variables (the path of its command, the address of its runtime, its data
 * folder); a Codex session it runs natively has those and CODEX_THREAD_ID only. A plain Codex
 * session has none of them.
 */
function startedByCodexhost(env: NodeJS.ProcessEnv): boolean {
  return Object.entries(env).some(([name, value]) => name.startsWith("CODEXHOST_") && Boolean(value?.trim()));
}

/**
 * Whether a conversation is codexhost's to record and brief: its id came from codexhost or was
 * asked for, codexhost started this process (a new conversation the scanner has not read yet), or
 * codexhost knows it.
 */
async function ownConversation(source: NonNullable<ReturnType<typeof threadSource>>, env: NodeJS.ProcessEnv, known: () => Promise<boolean>): Promise<boolean> {
  return source.from !== "codex" || startedByCodexhost(env) || known();
}

function contextOptions(settings: Settings, locale: Locale, dataDir: string): ProtocolV2Options {
  return { cli: commandPath(dataDir), policy: settings.driftPolicy, locale, summaries: settings.autoSummarize };
}

/**
 * What an agent gets on one channel: the full text when it has not seen it (see `nextContext`),
 * else the status line, and the record of it, saved once the text is out. Saving never fails the
 * caller: without the record the agent only gets the full text again.
 */
async function leanContext(
  dataDir: string,
  threadId: string,
  channel: ContextChannel,
  view: ConversationView,
  options: ProtocolV2Options,
  now: number,
  session?: string,
): Promise<{ print: ContextPrint; full: string; status: string; save(): Promise<void> }> {
  const full = agentContextV2(view, options);
  const status = statusLineV2(view, options.locale);
  // A hook call without its session id cannot tell a new Claude session from this one.
  const seen = channel === "hook" && session === undefined ? undefined : await readSeen(dataDir, threadId, channel);
  const next = nextContext(seen, {
    at: now,
    rules: fingerprint(`${VERSION}\n${agentRulesV2(view, options)}`),
    status: fingerprint(status),
    ...(session === undefined ? {} : { session }),
  });
  return {
    print: next.print,
    full,
    status,
    save: async () => {
      try {
        await writeSeen(dataDir, threadId, channel, next.seen);
        if (next.print === "full") await pruneSeen(dataDir);
      } catch {
        // The next message gets the full text again.
      }
    },
  };
}

/**
 * A conversation without a mainline gets its draft as one once work is recorded in it, as the
 * backend does for a spin-off: the conversation's title (else what started it) and the draft's tags.
 */
function draftSeed(state: StateV2, index: RefIndex, threadId: string, fallback?: string): { title: string; tags: string[] } {
  const record = index.threads[threadId];
  const title = record?.title?.trim() || record?.firstPrompt?.trim() || fallback || `#${threadId.slice(0, 8)}`;
  return { title, tags: conversationView(threadId, offlineSources(state, index)).tags };
}

function startFromDraft(draft: StateV2, threadId: string, seed: { title: string; tags: string[] }, ctx: V2Context): void {
  if (!draft.conversations[threadId]) createConversation(draft, threadId, seed, ctx);
}

function textOf(positional: readonly string[], field: string): string {
  const text = positional.join(" ").trim();
  if (!text) throw new MainlineError("INVALID_ARGUMENT", `${field} is required`);
  return text;
}

const plain = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

/** View sources without a running backend: the state file and the link index. */
export function offlineSources(state: StateV2, index: RefIndex): ViewSources {
  const titleOf = (threadId: string) => state.conversations[threadId]?.title ?? index.threads[threadId]?.title;
  const refsOf = (threadId: string) =>
    Object.values(index.refs)
      .filter((ref) => ref.mentions.some((mention) => mention.threadId === threadId))
      .map((ref) => refView(index, ref, titleOf));
  return {
    state,
    info: {},
    parents: {},
    refsOf,
    draftOf: (threadId): DraftFacts | undefined => {
      const record = index.threads[threadId];
      if (!record) return undefined;
      return {
        refs: refsOf(threadId),
        ...(record.title ? { title: record.title } : {}),
        ...(record.firstPrompt ? { firstPrompt: record.firstPrompt } : {}),
        ...(record.cwd ? { workspace: path.basename(record.cwd) } : {}),
      };
    },
  };
}

function dataRootOf(dataDir: string, env: NodeJS.ProcessEnv): string {
  if (isExtensionDataDir(dataDir)) return path.resolve(dataDir, "..", "..");
  return env.CODEXHOST_DATA_DIR?.trim() || path.resolve(defaultDataDir(env), "..", "..");
}

const errorCode = (error: unknown) => (typeof error === "object" && error !== null && "code" in error ? (error as { code: unknown }).code : undefined);

/**
 * Whether the extension this command belongs to was uninstalled or turned off in codexhost. The
 * command stays in its data folder after that (codexhost keeps the folder), and the agent
 * integration may still run it. Only for the data folder codexhost gives the extension,
 * `<root>/host-extension-data/<id>` (EXTENSION_ID): codexhost keeps each installed extension in
 * `<root>/host-extensions/<id>/` and lists the enabled ones in `<root>/host-extensions/enabled.json`
 * (`{ "revision": n, "enabled": [ids] }`); uninstalling removes the folder and the entry, turning
 * off the entry. Whatever cannot be read or is not understood counts as installed and enabled.
 */
export async function extensionOff(dataDir: string): Promise<boolean> {
  if (!isExtensionDataDir(dataDir)) return false;
  const root = path.join(path.resolve(dataDir, "..", ".."), "host-extensions");
  try {
    if (!(await stat(root)).isDirectory()) return false;
  } catch {
    // No list of installed extensions at all: not a layout this command knows.
    return false;
  }
  try {
    await stat(path.join(root, EXTENSION_ID));
  } catch (error) {
    return errorCode(error) === "ENOENT";
  }
  try {
    const raw = JSON.parse(await readFile(path.join(root, "enabled.json"), "utf8")) as unknown;
    if (typeof raw === "object" && raw !== null && Array.isArray((raw as { enabled?: unknown }).enabled))
      return !(raw as { enabled: unknown[] }).enabled.includes(EXTENSION_ID);
  } catch {
    // Missing, unreadable or damaged: counted as enabled.
  }
  return false;
}

export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    io.stderr(`mainline: ${(error as Error).message}\n`);
    return 1;
  }
  const { positional, flags } = parsed;
  const [command, ...rest] = positional;
  if (flags.version) {
    io.stdout(`${VERSION}\n`);
    return 0;
  }
  if (flags.help || command === undefined || command === "help") {
    io.stdout(USAGE);
    return command === undefined && !flags.help ? 1 : 0;
  }
  const dataDir = resolveDataDir(flags, io);
  const paths = storePaths(dataDir);
  // Uninstalled or turned off in codexhost: what the agent integration runs says and records nothing.
  if ((command === "hook" || command === "show") && (await extensionOff(dataDir))) return 0;
  if (command === "hook") return hook(rest[0], paths, dataDir, io);
  let locale: Locale = localeOf(io.env.LC_ALL || io.env.LANG);
  let summaries = DEFAULT_SETTINGS.autoSummarize;
  let deleted = false;
  try {
    const settings = await readSettings(paths);
    summaries = settings.autoSummarize;
    const state = await readState(paths);
    locale = localeFor(state, io.env);
    const source = threadSource(flags, io.env);
    // A conversation whose mainline the user deleted is told so, not sent to make a new one.
    deleted = source !== undefined && !state.conversations[source.threadId] && isExcluded(state, source.threadId);
    const out = await execute(command, rest, flags, state, settings, paths, dataDir, io, locale);
    // Nothing at all (show outside codexhost), not even an empty line.
    if (out) io.stdout(out.endsWith("\n") ? out : `${out}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof MainlineError ? error.code : "ERROR";
    const message = error instanceof Error ? error.message : String(error);
    const text = errorText(locale, code, message, summaries, deleted);
    io.stderr(flags.json ? `${JSON.stringify({ error: { code, message: text } })}\n` : `mainline: ${text}\n`);
    return 1;
  }
}

async function execute(
  command: string,
  rest: string[],
  flags: Flags,
  state: StateV2,
  settings: Settings,
  paths: StorePaths,
  dataDir: string,
  io: CliIo,
  locale: Locale,
): Promise<string> {
  const t = locale === "zh-CN" ? zh : en;
  const now = io.now?.() ?? Date.now();
  const update = <T>(mutate: Parameters<typeof updateState<T>>[1]) => updateState(paths, mutate, { now });
  const reply = (text: string, json: unknown) => (flags.json ? JSON.stringify(plain(json)) : text);
  const thread = () => threadOf(flags, io.env);
  /**
   * For commands that record work: the draft to start a mainline from, when there is none yet.
   * Not when the user deleted this conversation's mainline: recording work does not bring it back
   * (asking for one does, with `mainline new` or on the overview).
   */
  const seedFor = async (threadId: string, fallback?: string) => {
    if (state.conversations[threadId]) return undefined;
    if (isExcluded(state, threadId)) throw new MainlineError("NO_MAINLINE", "The user deleted this conversation's mainline");
    return draftSeed(state, await readIndex(refsPaths(dataDir)), threadId, fallback);
  };

  switch (command) {
    case "show": {
      const source = threadSource(flags, io.env);
      if (!source) throw new MainlineError("NO_THREAD", "No current conversation");
      const { threadId } = source;
      const index = await readIndex(refsPaths(dataDir));
      if (!(await ownConversation(source, io.env, async () => knownThread(state, index, threadId)))) return "";
      const view = conversationView(threadId, offlineSources(state, index));
      if (flags.json) return JSON.stringify(plain({ ...view, settings, command: commandPath(dataDir) }));
      const options = contextOptions(settings, locale, dataDir);
      if (flags.full) return agentContextV2(view, options);
      // The full text the first time; after that what changed, and how to see everything again.
      const context = await leanContext(dataDir, threadId, "show", view, options, now);
      await context.save();
      return context.print === "full" ? context.full : `${context.status}\n${t.fullHint}`;
    }
    case "list": {
      const all = Object.values(state.conversations)
        .filter((conversation) => conversation.status !== "done")
        .sort((a, b) => b.updatedAt - a.updatedAt);
      if (flags.json) return JSON.stringify(plain(all));
      if (!all.length) return t.listEmpty;
      return all
        .map((conversation) => {
          const done = conversation.milestones.filter((milestone) => milestone.state === "done").length;
          const progress = conversation.milestones.length ? ` ◆ ${done}/${conversation.milestones.length}` : "";
          return t.listLine(conversation.title, progress, currentMilestone(conversation)?.title, conversation.threadId);
        })
        .join("\n");
    }
    case "new": {
      const threadId = thread();
      const title = textOf(rest, "title");
      const milestones = flags.plan ? splitPlan([flags.plan]) : [];
      const { result } = await update((draft, ctx) =>
        createConversation(draft, threadId, { title, ...(flags.tags !== undefined ? { tags: flags.tags } : {}), milestones }, ctx),
      );
      const lines = [t.created(result.title, result.milestones.length), ...(result.tags.length ? [t.tags(result.tags)] : [])];
      return reply(lines.join("\n"), { ok: true, conversation: result });
    }
    case "title": {
      const threadId = thread();
      const title = textOf(rest, "title");
      const { state: next } = await update((draft, ctx) => setTitle(draft, threadId, title, ctx));
      return reply(t.title(next.conversations[threadId]!.title), { ok: true });
    }
    case "tags": {
      const threadId = thread();
      const [mode, ...values] = rest;
      const { state: next } = await update((draft, ctx) => {
        if (mode === "add") addTags(draft, threadId, values, ctx);
        else if (mode === "remove") removeTags(draft, threadId, values, ctx);
        else setTags(draft, threadId, rest.join(","), ctx);
      });
      const tags = next.conversations[threadId]!.tags;
      return reply(t.tags(tags), { ok: true, tags });
    }
    case "plan": {
      const threadId = thread();
      const titles = splitPlan(rest);
      if (!titles.length) throw new MainlineError("INVALID_ARGUMENT", 'Give milestones, for example "stage 1|stage 2"');
      const { result } = await update((draft, ctx) => planMilestones(draft, threadId, titles, ctx));
      return reply(t.planned(result.map(({ title }) => title)), { ok: true, added: result });
    }
    case "reach": {
      const threadId = thread();
      const key = rest.join(" ").trim();
      // Without a current milestone reachMilestone says so (NO_CURRENT_MILESTONE), not that there is no mainline.
      const { result } = await update((draft, ctx) => reachMilestone(draft, threadId, ctx, key || undefined));
      return reply(t.reached(result.reached.title, result.next?.title), { ok: true, ...result });
    }
    case "milestone": {
      const threadId = thread();
      const [action, ...words] = rest;
      const { result } = await update((draft, ctx) => {
        const conversation = requireConversation(draft, threadId);
        switch (action) {
          case "add":
            return t.milestone(t.added, addMilestone(draft, threadId, words.join(" "), ctx).title);
          case "rename": {
            const [key = "", ...title] = words;
            const milestone = resolveMilestone(conversation, key);
            renameMilestone(draft, threadId, milestone.id, title.join(" "), ctx);
            return t.milestone(t.renamed, milestone.title);
          }
          case "remove": {
            const milestone = resolveMilestone(conversation, words.join(" "));
            removeMilestone(draft, threadId, milestone.id, ctx);
            return t.milestone(t.removed, milestone.title);
          }
          case "focus": {
            const milestone = resolveMilestone(conversation, words.join(" "));
            focusMilestone(draft, threadId, milestone.id, ctx);
            return t.milestone(t.focused, milestone.title);
          }
          default:
            throw new MainlineError("INVALID_ARGUMENT", "Use milestone add|rename|remove|focus");
        }
      });
      return reply(result, { ok: true });
    }
    case "doing": {
      const threadId = thread();
      const text = flags.clear ? null : textOf(rest, "text");
      const seed = text === null ? undefined : await seedFor(threadId, state.prompts[threadId]?.text ?? text);
      const { state: next } = await update((draft, ctx) => {
        if (seed) startFromDraft(draft, threadId, seed, ctx);
        // Without a mainline nothing is in progress, so there is nothing to clear.
        if (text !== null || draft.conversations[threadId]) setDoing(draft, threadId, text, ctx);
      });
      const doing = next.conversations[threadId]?.now;
      return reply(doing ? t.doing(doing.text) : t.doingCleared, { ok: true, now: doing ?? null });
    }
    case "done": {
      const threadId = thread();
      const text = rest.join(" ").trim();
      const seed = text ? await seedFor(threadId, state.prompts[threadId]?.text ?? text) : undefined;
      const { result, state: next } = await update((draft, ctx) => {
        if (seed) startFromDraft(draft, threadId, seed, ctx);
        if (!text && !draft.conversations[threadId]) throw new MainlineError("INVALID_ARGUMENT", "Which task? Give its text");
        return completeTask(draft, threadId, ctx, text ? { text } : {});
      });
      const milestone = next.conversations[threadId]!.milestones.find((item) => item.tasks.some((task) => task.id === result.id));
      return reply(t.done(result.text, milestone?.title ?? ""), { ok: true, task: result });
    }
    case "task": {
      const threadId = thread();
      const text = textOf(rest, "text");
      const seed = await seedFor(threadId, state.prompts[threadId]?.text ?? text);
      const { result, state: next } = await update((draft, ctx) => {
        if (seed) startFromDraft(draft, threadId, seed, ctx);
        return addTask(draft, threadId, text, ctx);
      });
      return reply(t.task(result.text, currentMilestone(next.conversations[threadId]!)?.title ?? ""), { ok: true, task: result });
    }
    case "spinoff": {
      const threadId = thread();
      const text = textOf(rest, "problem");
      // The new problem is no title for this conversation: the draft's, else its short id.
      const seed = await seedFor(threadId);
      const { result } = await update((draft, ctx) => {
        if (seed) startFromDraft(draft, threadId, seed, ctx);
        return addSpinoff(draft, threadId, text, ctx);
      });
      return reply(t.spinoff(result.text, result.id), { ok: true, spinoff: result });
    }
    case "spawn": {
      const threadId = thread();
      const key = textOf(rest, "spin-off id");
      const conversation = requireConversation(state, threadId);
      const spinoff = spinoffOf(state, threadId, key);
      // Opened already (from the card, or by an earlier try): that child, not a second one.
      if (spinoff.state === "spawned" && spinoff.childThreadId)
        return reply(t.spawned(spinoff.text, spinoff.childThreadId), { ok: true, childThreadId: spinoff.childThreadId });
      const current = currentMilestone(conversation);
      const hostId = conversation.hostId ?? (await readIndex(refsPaths(dataDir))).threads[threadId]?.hostId;
      const api = io.delegation ?? new ExternalApi(path.join(dataRootOf(dataDir, io.env), "cli-credentials.json"), 20_000);
      const childThreadId = await spawnChild(api, {
        parentThreadId: threadId,
        problem: spinoff.text,
        parentTitle: conversation.title,
        locale,
        ...(hostId ? { hostId } : {}),
        ...(current ? { currentMilestone: current.title } : {}),
        ...(flags.harness ? { harnessId: flags.harness } : {}),
      });
      await update((draft, ctx) => {
        linkSpinoff(draft, threadId, spinoff.id, childThreadId, ctx);
        if (hostId) noteHosts(draft, [[threadId, hostId], [childThreadId, hostId]]);
      });
      return reply(t.spawned(spinoff.text, childThreadId), { ok: true, childThreadId });
    }
    case "keep": {
      const threadId = thread();
      const key = textOf(rest, "spin-off id");
      const { result } = await update((draft, ctx) => keepSpinoff(draft, threadId, key, ctx));
      return reply(t.kept(result.text), { ok: true, task: result });
    }
    case "dismiss": {
      const threadId = thread();
      const key = textOf(rest, "spin-off id");
      await update((draft, ctx) => dismissSpinoff(draft, threadId, spinoffOf(draft, threadId, key).id, ctx));
      return reply(t.dismissed, { ok: true });
    }
    case "link": {
      const threadId = thread();
      const [url = "", ...words] = rest;
      const [link] = extractLinks(url);
      if (!link) throw new MainlineError("INVALID_ARGUMENT", "Give a GitHub pull request or issue link");
      const note = words.join(" ").trim();
      await updateIndex(refsPaths(dataDir), (draft) => {
        addMention(draft, link, { threadId, turn: 0, at: now, role: "agent" });
        if (note) setNote(draft, link, threadId, note, now);
      });
      return reply(t.linked(link.key, note), { ok: true, key: link.key });
    }
    case "find": {
      const query = textOf(rest, "clue");
      const paths = refsPaths(dataDir);
      let index = await readIndex(paths);
      const found = searchConversations({ sources: offlineSources(state, index), index, query, limit: 10 });
      // An agent looking a PR up in a chat sees its state as GitHub has it now (with gh, when allowed).
      const keys = found.flatMap((item) => item.refs);
      if (keys.length && settings.prAlerts) {
        const looked = freshenRefs(paths, keys, io.runGh ?? createGhRunner(undefined, 5000), { now: io.now?.() ?? Date.now() }).catch(() => 0);
        if (await Promise.race([looked, new Promise<number>((resolve) => setTimeout(() => resolve(0), 6000).unref?.())])) index = await readIndex(paths);
      }
      if (flags.json) return JSON.stringify(plain(found));
      if (!found.length) return t.notFound(query);
      return found
        .map((item) => {
          const refs = item.refs
            .map((key) => index.refs[key])
            .filter((ref) => ref !== undefined)
            .slice(0, 4)
            .map((ref) => t.refWord(ref.kind, ref.number, ref.state, ref.title));
          return [
            t.found(item.title, item.tags, item.draft),
            t.foundWhere(item.threadId, item.progress.total ? `${item.progress.done}/${item.progress.total}` : "", item.current),
            t.foundWhy(t.field[item.match.field] ?? item.match.field, item.match.text),
            ...(refs.length ? [t.foundRefs(refs.join(" · "))] : []),
          ].join("\n");
        })
        .join("\n\n");
    }
    case "status":
    case "finish": {
      const threadId = thread();
      const status = (command === "finish" ? "done" : rest[0]) as ConversationStatus;
      if (status !== "active" && status !== "paused" && status !== "done")
        throw new MainlineError("INVALID_ARGUMENT", "Status is active, paused or done");
      await update((draft, ctx) => setStatus(draft, threadId, status, ctx));
      return reply(t.status(status), { ok: true, status });
    }
    case "relate": {
      const threadId = thread();
      const target = flags.clear ? null : textOf(rest, "conversation id");
      await update((draft, ctx) => relate(draft, threadId, target, ctx));
      return reply(t.related(target), { ok: true });
    }
    case "summarize": {
      if (!flags.all) throw new MainlineError("INVALID_ARGUMENT", "Use mainline summarize --all; single conversations are summarized after each turn");
      // The extension's backend sees the request within a minute and works through it. One already
      // under way keeps its start, and so its progress, as when it is started from the overview.
      await update((draft, ctx) => {
        draft.jobs = { ...draft.jobs, backfill: draft.jobs?.backfill ?? { requestedAt: ctx.now } };
      });
      return reply(t.backfill, { ok: true });
    }
    case "fav":
      return favorite(rest, flags, state, dataDir, io, t, now, reply, thread);
    default:
      throw new MainlineError("INVALID_ARGUMENT", `Unknown command: ${command}. Run mainline --help.`);
  }
}

const excerpt = (text: string, max = 60) => {
  const chars = Array.from(flatten(text));
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
};

/** `mainline fav`: save the last reply or a passage, list the saved ones, or remove one. */
async function favorite(
  rest: readonly string[],
  flags: Flags,
  state: StateV2,
  dataDir: string,
  io: CliIo,
  t: typeof zh,
  now: number,
  reply: (text: string, json: unknown) => string,
  thread: () => string,
): Promise<string> {
  const [action = "", ...words] = rest;
  const paths = favoritesPaths(dataDir);
  const index = await readIndex(refsPaths(dataDir));
  const titleOf = (threadId: string) => state.conversations[threadId]?.title ?? index.threads[threadId]?.title;
  if (action === "list") {
    const found = searchFavorites((await readFavorites(paths)).items, words.join(" "), titleOf).slice(0, 10);
    if (flags.json) return JSON.stringify(plain(found));
    if (!found.length) return t.favEmpty;
    return found.map((item) => t.favLine(excerpt(item.text), titleOf(item.threadId) ?? item.threadTitle ?? item.threadId, item.turn, item.id)).join("\n");
  }
  if (action === "remove") {
    const id = textOf(words, "id");
    const { result } = await updateFavorites(paths, (file) => removeFavorite(file, id));
    if (!result) throw new MainlineError("UNKNOWN_ITEM", `No saved passage ${id}`);
    return reply(t.favRemoved, { ok: true });
  }
  const threadId = thread();
  const credentials = path.join(dataRootOf(dataDir, io.env), "cli-credentials.json");
  const hostId = state.conversations[threadId]?.hostId ?? index.threads[threadId]?.hostId;
  let input: NewFavorite;
  if (action === "last" && !words.length) {
    // While the agent runs this, its own turn is still going: the last reply is the previous turn's.
    const latest = await (io.turns ?? new ExternalApi(credentials, 20_000)).readTurns(threadId, undefined, hostId);
    const last = lastReply(latest.turns);
    if (!last) throw new MainlineError("INVALID_ARGUMENT", t.favNoReply);
    input = { threadId, text: last.text, role: "agent", turn: last.turn, source: "chat" };
  } else {
    const passage = textOf(rest, "text");
    // Where it is said, when it can be found quickly among the latest turns.
    const where = await (io.turns ?? new ExternalApi(credentials, 5000))
      .readTurns(threadId, undefined, hostId)
      .then((latest) => locatePassage(passage, latest.turns))
      .catch(() => undefined);
    input = { threadId, text: passage, source: "chat", ...(where ? { turn: where.turn, role: where.role } : {}) };
  }
  const title = titleOf(threadId);
  const { result } = await updateFavorites(paths, (file) => addFavorite(file, { ...input, ...(title ? { threadTitle: title } : {}), ...(hostId ? { hostId } : {}) }, now));
  const shown = excerpt(result.favorite.text);
  return reply(result.added ? t.favSaved(shown, result.favorite.turn) : t.favAgain(shown), { ok: true, ...result });
}

async function readAll(io: CliIo): Promise<string> {
  if (!io.readStdin) return "";
  return Promise.race([io.readStdin(), new Promise<string>((resolve) => setTimeout(() => resolve(""), 1500).unref?.())]);
}

/**
 * `mainline hook claude-prompt`: Claude Code's UserPromptSubmit hook. Records the message and adds
 * this conversation's mainline to the agent's context: the full text the first time in a Claude
 * session (and again after 30 messages, 12 hours or a change of the rules), then one status line
 * when something changed, else nothing. It never fails the user's message.
 */
async function hook(kind: string | undefined, paths: StorePaths, dataDir: string, io: CliIo): Promise<number> {
  try {
    if (kind !== "claude-prompt") return 0;
    const source = threadSource({}, io.env);
    if (!source) return 0;
    const { threadId } = source;
    let prompt = "";
    let session: string | undefined;
    try {
      const input = JSON.parse((await readAll(io)) || "{}") as { prompt?: unknown; session_id?: unknown };
      if (typeof input.prompt === "string") prompt = input.prompt;
      if (typeof input.session_id === "string" && input.session_id.trim()) session = input.session_id.trim();
    } catch {
      // Without the message the context is still useful.
    }
    const now = io.now?.() ?? Date.now();
    const index = await readIndex(refsPaths(dataDir));
    // Only CODEX_THREAD_ID, outside codexhost, for a conversation codexhost does not know: not ours to record or brief.
    if (!(await ownConversation(source, io.env, async () => knownThread(await readState(paths), index, threadId)))) return 0;
    let state: StateV2;
    try {
      ({ state } = await updateState(paths, (draft, ctx) => recordPromptV2(draft, threadId, prompt, ctx), { timeoutMs: 400, now }));
    } catch {
      state = await readState(paths);
    }
    const settings = await readSettings(paths);
    const view = conversationView(threadId, offlineSources(state, index));
    const context = await leanContext(dataDir, threadId, "hook", view, contextOptions(settings, localeFor(state, io.env), dataDir), now, session);
    if (context.print !== "none") {
      const text = context.print === "full" ? context.full : context.status;
      io.stdout(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } })}\n`);
    }
    await context.save();
  } catch {
    // Stay silent: a broken mainline must not block the user's message.
  }
  return 0;
}

export function scriptPathOf(url: string): string {
  return fileURLToPath(url);
}
