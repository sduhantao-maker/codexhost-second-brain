/**
 * What agents read about their conversation's mainline, from the Claude Code hook (with each user
 * message) or from `mainline show` (Codex): the full text (the mainline, its milestones and tasks,
 * and how to keep them current) when they have not seen it, and after that one status line, only
 * when something changed. `nextContext` decides which.
 */
import type { ConversationView } from "./conversation-view.js";
import type { DriftPolicy, Locale } from "./model.js";

export interface ProtocolV2Options {
  cli: string;
  policy: DriftPolicy;
  locale: Locale;
  /** A model keeps the title, tags, milestones and status (setting autoSummarize): agents only record tasks. */
  summaries?: boolean;
}

const MILESTONES_SHOWN = 6;
const TASKS_SHOWN = 6;
/** Characters of the task in progress the status line keeps. */
const STATUS_TASK_CHARS = 80;

const zh = {
  head: (title: string, tags: string[], status: string) => `【主线】本对话：「${title}」${tags.length ? ` ${tags.map((tag) => `#${tag}`).join(" ")}` : ""}${status ? `（${status}）` : ""}`,
  status: { active: "", paused: "已暂停", done: "已完成" } as Record<string, string>,
  none: "【主线】本对话还没有主线。",
  draft: (title: string, tags: string[]) => `草稿：「${title}」${tags.length ? ` ${tags.map((tag) => `#${tag}`).join(" ")}` : ""}`,
  firstPrompt: (text: string) => `起因：${text}`,
  milestones: (done: number, total: number, line: string) => `里程碑（${done}/${total}）：${line}`,
  earlier: (count: number) => `✓ 前面 ${count} 个已达成`,
  noMilestones: "里程碑：还没有规划",
  tasks: (title: string, line: string) => `当前阶段「${title}」的支线任务：${line}`,
  doing: (text: string) => `▸ ${text}（正在做）`,
  byChild: (text: string, title: string) => `${text}（子对话「${title}」）`,
  spinoffs: (line: string) => `引申问题：${line}`,
  spinoff: (text: string, id: string) => `${text}（未处理，编号 ${id}）`,
  children: (line: string) => `子对话：${line}`,
  child: (title: string, status: string) => `「${title}」${status}`,
  threadStatus: { running: "运行中", waiting: "等你处理", idle: "", unknown: "" } as Record<string, string>,
  parent: (title: string) => `来自父对话：「${title}」`,
  rules: (cli: string) => `约定（mainline 即 ${cli}，全部命令见 mainline --help）：`,
  title: '- 标题要具体：做什么 + 对象（不要写「修 bug」），用 mainline title "…" 精炼；mainline tags "a,b,c" 维护 3–6 个标签（项目、模块、类型、编号）。',
  plan: '- 里程碑是阶段性成果：mainline plan "阶段1|阶段2|…" 规划 2–5 个（没有时先规划），达成当前阶段时 mainline reach。',
  task: '- 支线任务（具体的一步）开始时 mainline doing "…"，完成时 mainline done。',
  ask: '- 新问题若不属于本主线（不是它的步骤、追问或修正）：先别动手，运行 mainline spinoff "一句话" 并提醒用户可以开子对话；用户同意 mainline spawn <编号>，在本对话做 mainline keep <编号>，不管 mainline dismiss <编号>。',
  note: '- 新问题若不属于本主线：照常处理，同时运行 mainline spinoff "一句话"，并在回复开头说明它不在主线上。',
  childRule: "- 本对话是从父对话开出的子对话：专注它要解决的问题，完成后用一两句话总结结果。",
  model: "- 标题、标签、里程碑和状态由插件在每轮结束后调用模型自动凝练，你不用维护。",
  refs: '- 提交 GitHub PR 或 issue 后 mainline link <链接> "用途"；不清楚来历的编号或事情用 mainline find <线索> 查。',
  fav: '- 用户要收藏回复时：mainline fav last（上一条全文）或 mainline fav "<原文>"（一段）。',
  start: '- 需要多步完成的工作：运行 mainline new "具体标题" --tags "a,b,c" --plan "阶段1|阶段2|阶段3" 建立主线（有草稿时以草稿为起点）；闲聊或一两句能答完的问题不建。',
  line: {
    none: "【主线】本对话还没有主线",
    head: (title: string, status: string) => `【主线】「${title}」${status ? `（${status}）` : ""}`,
    progress: (done: number, total: number, current: string | undefined) => `里程碑 ${done}/${total}${current ? `，当前「${current}」` : ""}`,
    doing: (text: string) => `正在做：${text}`,
    spinoffs: (count: number) => `${count} 个引申问题未处理`,
  },
  sep: "；",
  arrow: " → ",
};

const en: typeof zh = {
  head: (title, tags, status) => `[Mainline] This conversation: "${title}"${tags.length ? ` ${tags.map((tag) => `#${tag}`).join(" ")}` : ""}${status ? ` (${status})` : ""}`,
  status: { active: "", paused: "paused", done: "done" },
  none: "[Mainline] This conversation has no mainline yet.",
  draft: (title, tags) => `Draft: "${title}"${tags.length ? ` ${tags.map((tag) => `#${tag}`).join(" ")}` : ""}`,
  firstPrompt: (text) => `Started with: ${text}`,
  milestones: (done, total, line) => `Milestones (${done}/${total}): ${line}`,
  earlier: (count) => `✓ ${count} earlier reached`,
  noMilestones: "Milestones: none planned yet",
  tasks: (title, line) => `Tasks toward "${title}": ${line}`,
  doing: (text) => `▸ ${text} (doing)`,
  byChild: (text, title) => `${text} (child conversation "${title}")`,
  spinoffs: (line) => `Spin-offs: ${line}`,
  spinoff: (text, id) => `${text} (open, id ${id})`,
  children: (line) => `Child conversations: ${line}`,
  child: (title, status) => `"${title}"${status ? ` ${status}` : ""}`,
  threadStatus: { running: "running", waiting: "needs you", idle: "", unknown: "" },
  parent: (title) => `Parent conversation: "${title}"`,
  rules: (cli) => `Rules (mainline is ${cli}; all commands: mainline --help):`,
  title: '- Keep the title specific, action + object (not "fix bug"): mainline title "…"; keep 3–6 tags (project, area, kind, numbers): mainline tags "a,b,c".',
  plan: '- Milestones are stage results: plan 2–5 with mainline plan "stage 1|stage 2|…" (first thing when there are none); mainline reach when the current one is reached.',
  task: '- Tasks (concrete steps): mainline doing "…" when you start one, mainline done when it is finished.',
  ask: '- A new problem outside this mainline (not a step, follow-up or correction of it): do not start on it; run mainline spinoff "one line" and suggest a child conversation. If the user agrees: mainline spawn <id>; to do it here: mainline keep <id>; to drop it: mainline dismiss <id>.',
  note: '- A new problem outside this mainline: handle it, also run mainline spinoff "one line", and say at the start of your reply that it is off the mainline.',
  childRule: "- This is a child conversation started from its parent: focus on its task, and sum up the result in a sentence or two when done.",
  model: "- A model summarizes the title, tags, milestones and status after each turn; you do not keep them.",
  refs: '- After you open or submit a GitHub PR or issue: mainline link <url> "what it is for". For a number or thing you do not know: mainline find <clue>.',
  fav: '- To save a reply the user asks for: mainline fav last (the whole previous reply) or mainline fav "<exact text>" (a passage).',
  start: '- A task that needs several steps: mainline new "specific title" --tags "a,b,c" --plan "stage 1|stage 2|stage 3" (start from the draft if there is one). None for small talk or one-line answers.',
  line: {
    none: "[Mainline] No mainline yet",
    head: (title, status) => `[Mainline] "${title}"${status ? ` (${status})` : ""}`,
    progress: (done, total, current) => `milestones ${done}/${total}${current ? `, current "${current}"` : ""}`,
    doing: (text) => `doing: ${text}`,
    spinoffs: (count) => `${count} open spin-off${count === 1 ? "" : "s"}`,
  },
  sep: "; ",
  arrow: " → ",
};

export function wordsV2(locale: Locale): typeof zh {
  return locale === "zh-CN" ? zh : en;
}

function milestoneLine(view: ConversationView, w: typeof zh): string {
  const parts = view.milestones.map((milestone) => `${milestone.state === "done" ? "✓" : milestone.state === "current" ? "●" : "○"} ${milestone.title}`);
  if (parts.length <= MILESTONES_SHOWN) return parts.join(w.arrow);
  // Keep the current milestone (else the next planned one, else the last) and its neighbours in
  // view; fold the reached ones before them.
  const current = view.milestones.findIndex((milestone) => milestone.state === "current");
  const planned = view.milestones.findIndex((milestone) => milestone.state === "planned");
  const currentIndex = current >= 0 ? current : planned >= 0 ? planned : view.milestones.length - 1;
  const start = Math.max(0, Math.min(currentIndex - 1, parts.length - MILESTONES_SHOWN + 1));
  return [w.earlier(start), ...parts.slice(start, start + MILESTONES_SHOWN - 1)].join(w.arrow);
}

/**
 * The rules part of the full text. With model summaries a conversation without a mainline gets the
 * same rules as one with a mainline, so the model naming it changes only the status line.
 */
function ruleLines(view: ConversationView, options: ProtocolV2Options, w: typeof zh): string[] {
  const policy = options.policy === "ask" ? w.ask : options.policy === "note" ? w.note : null;
  const lines = [w.rules(options.cli)];
  if (options.summaries) lines.push(w.model, w.task);
  else if (view.draft) lines.push(w.start);
  else lines.push(w.title, w.plan, w.task);
  // Without summaries a conversation decides whether it wants a mainline first.
  if (policy && (options.summaries || !view.draft)) lines.push(policy);
  if (view.parent) lines.push(w.childRule);
  lines.push(w.refs, w.fav);
  return lines;
}

/** Just the rules, as the full text has them: when they change, the agent gets the full text again. */
export function agentRulesV2(view: ConversationView, options: ProtocolV2Options): string {
  return ruleLines(view, options, wordsV2(options.locale)).join("\n");
}

export function agentContextV2(view: ConversationView, options: ProtocolV2Options): string {
  const w = wordsV2(options.locale);
  const lines: string[] = [];
  if (view.draft) {
    lines.push(w.none);
    // The draft is where an agent starts a mainline by hand; with summaries the model does that.
    if (!options.summaries) {
      if (view.title && !view.title.startsWith("#")) lines.push(w.draft(view.title, view.tags));
      if (view.firstPrompt) lines.push(w.firstPrompt(view.firstPrompt));
    }
    if (view.parent) lines.push(w.parent(view.parent.title));
    return [...lines, ...ruleLines(view, options, w)].join("\n");
  }
  lines.push(w.head(view.title, view.tags, w.status[view.status] ?? ""));
  lines.push(view.milestones.length ? w.milestones(view.progress.done, view.progress.total, milestoneLine(view, w)) : w.noMilestones);
  if (view.current) {
    const tasks = view.current.tasks.slice(-TASKS_SHOWN).map((task) => {
      const text = task.threadId && task.threadTitle ? w.byChild(task.text, task.threadTitle) : task.text;
      if (task.done) return `✓ ${text}`;
      return view.now?.text === task.text ? w.doing(text) : `· ${text}`;
    });
    if (tasks.length) lines.push(w.tasks(view.current.title, tasks.join(w.sep)));
  } else if (view.now) lines.push(w.doing(view.now.text));
  const open = view.spinoffs.filter((spinoff) => spinoff.state === "open");
  if (open.length) lines.push(w.spinoffs(open.map((spinoff) => w.spinoff(spinoff.text, spinoff.id)).join(w.sep)));
  if (view.children.length)
    lines.push(w.children(view.children.slice(0, 4).map((child) => w.child(child.title, w.threadStatus[child.threadStatus] ?? "")).join(w.sep)));
  if (view.parent) lines.push(w.parent(view.parent.title));
  return [...lines, ...ruleLines(view, options, w)].join("\n");
}

const clip = (text: string, max: number) => {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
};

/**
 * One line with what an agent needs to notice between full texts: the title and status, the
 * progress and current milestone, the task in progress and how many spin-offs are open.
 */
export function statusLineV2(view: ConversationView, locale: Locale): string {
  const w = wordsV2(locale);
  if (view.draft) return w.line.none;
  const parts = [w.line.head(view.title, w.status[view.status] ?? "")];
  if (view.milestones.length) parts.push(w.line.progress(view.progress.done, view.progress.total, view.current?.title));
  if (view.now) parts.push(w.line.doing(clip(view.now.text, STATUS_TASK_CHARS)));
  const open = view.spinoffs.filter((spinoff) => spinoff.state === "open").length;
  if (open) parts.push(w.line.spinoffs(open));
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------------------------
// When an agent gets the full text again

/** Messages after which the full text comes again: rules lost when the context was compacted come back. */
export const FULL_AGAIN_AFTER = 30;
/** And the time after which it comes again. */
export const FULL_AGAIN_AFTER_MS = 12 * 60 * 60 * 1000;

/** What an agent has been shown of one conversation, on one channel (the hook, or `show`). */
export interface ContextSeen {
  /** The Claude Code session that got the full text (hook only). */
  session?: string;
  /** When it got the full text. */
  fullAt: number;
  /** Fingerprint of the rules in it. */
  rules: string;
  /** Messages (hook) or calls (`show`) since then. */
  since: number;
  /** Fingerprint of the status the agent knows. */
  status: string;
}

export type ContextPrint = "full" | "status" | "none";

/**
 * The full text the first time (in this Claude session, for the hook), again after 30 messages or
 * 12 hours or when the rules changed (another policy, another version); otherwise the status line
 * when it changed, and nothing when it did not.
 */
export function nextContext(
  seen: ContextSeen | undefined,
  current: { at: number; rules: string; status: string; session?: string },
): { print: ContextPrint; seen: ContextSeen } {
  const since = (seen?.since ?? 0) + 1;
  if (
    !seen ||
    seen.session !== current.session ||
    seen.rules !== current.rules ||
    since >= FULL_AGAIN_AFTER ||
    current.at - seen.fullAt > FULL_AGAIN_AFTER_MS ||
    current.at < seen.fullAt
  ) {
    const fresh: ContextSeen = { fullAt: current.at, rules: current.rules, since: 0, status: current.status };
    return { print: "full", seen: current.session === undefined ? fresh : { session: current.session, ...fresh } };
  }
  return { print: seen.status === current.status ? "none" : "status", seen: { ...seen, since, status: current.status } };
}
