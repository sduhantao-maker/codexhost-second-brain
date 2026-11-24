/**
 * What the summarizing model is asked, and how its answer is read. A model reads a conversation
 * and writes its mainline: a specific title, distinctive tags, and the milestones reached, in
 * progress and agreed. Pure text in, plain data out; the backend runs the model.
 */
import type { Conversation, MilestoneState } from "./conversation.js";
import type { SummaryInput } from "./conversation-ops.js";
import { maskSecrets } from "./redact.js";

/** JSON Schema of the answer, strict enough for both Claude's --json-schema and Codex's --output-schema. */
export const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    milestones: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          state: { type: "string", enum: ["done", "current", "planned"] },
        },
        required: ["title", "state"],
        additionalProperties: false,
      },
    },
    finished: { type: "boolean" },
  },
  required: ["title", "tags", "milestones", "finished"],
  additionalProperties: false,
} as const;

export const SUMMARY_SYSTEM = [
  "你是「第二大脑」插件的凝练器：读一段 AI 编程助手的对话，写出这个对话的主线。只输出符合 JSON schema 的结果，不要别的文字。",
  "",
  "规则：",
  "1. title：整个对话的目标是什么，写成「动作 + 对象」，具体到一眼能认出是哪件事，不超过 30 个字。概括全程，不要只写最近一步。已有标题仍然贴切时保持不变，只在目标变了或能写得更具体时才改。不要写「修 bug」「讨论问题」这类空话。用对话本身的语言。",
  "2. tags：3 到 6 个有辨识度的短标签，每个不超过 12 个字，从项目或仓库、模块、工作类型、编号（如 PR #123、Issue #45）里挑，能区分这个对话和别的对话。不要「进行中」「对话」「AI」这类状态词或泛词。",
  "3. milestones：阶段性成果，不是具体步骤，按时间顺序列 2 到 8 个。",
  "   - done：对话里已经明确做成的阶段，有结果或有确认。",
  "   - current：正在推进的阶段，最多一个。",
  "   - planned：对话里已经说好、还没开始的后续阶段。不要臆造。",
  "   - 已有主线里标为 done 的里程碑会原样保留，不用重复列出；只列出之后新达成的、正在进行的和计划中的阶段。其他已有里程碑如果仍然适用，沿用原标题。",
  "4. finished：对话的目标已经完成，或明显放弃了，就是 true；还在进行或在等下一步，就是 false。",
  "5. 只依据对话内容，不要编造。",
].join("\n");

export interface SummaryTurn {
  turn: number;
  user: string;
  agent: string;
}

export interface SummaryPromptInput {
  /** The conversation's title in codexhost. */
  threadTitle?: string;
  /** The mainline as it stands, if any. */
  current?: Pick<Conversation, "title" | "tags" | "milestones" | "now">;
  /** What started the conversation, when the turns shown do not reach back that far. */
  firstPrompt?: string;
  totalTurns: number;
  turns: readonly SummaryTurn[];
}

/** Characters kept of each message, and of the whole conversation text. */
export const SUMMARY_LIMITS = { user: 600, agent: 400, total: 24_000, turns: 40 } as const;

/**
 * A text as the model reads it: secrets masked, whitespace folded, at most `max` characters.
 * Masking comes before cutting, so no part of a secret is left at the cut; it reads a generous
 * slice, since what lies beyond that is cut off anyway.
 */
const cut = (text: string, max: number) => {
  const flat = maskSecrets(text.slice(0, max * 8 + 1000))
    .replace(/\s+/gu, " ")
    .trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : flat;
};

/**
 * The material a model summarizes. Every text in it has secrets masked; user messages should come
 * without their attachment lists (`requestOf`).
 */
export function summaryPrompt(input: SummaryPromptInput): string {
  const lines: string[] = [];
  const current = input.current;
  lines.push(
    "已有主线：",
    current
      ? maskSecrets(
          JSON.stringify({
            title: current.title,
            tags: current.tags,
            milestones: current.milestones.map(({ title, state }) => ({ title, state })),
            ...(current.now ? { doing: current.now.text } : {}),
          }),
        )
      : "（还没有）",
    "",
  );
  if (input.threadTitle) lines.push(`对话标题：${cut(input.threadTitle, 120)}`);
  const turns = [...input.turns].sort((a, b) => a.turn - b.turn).slice(-SUMMARY_LIMITS.turns);
  const first = turns[0]?.turn ?? 1;
  if (input.firstPrompt && first > 1) lines.push(`对话开头的请求：${cut(input.firstPrompt, SUMMARY_LIMITS.user)}`);
  lines.push(`对话共 ${input.totalTurns} 轮。下面是第 ${first}–${turns[turns.length - 1]?.turn ?? first} 轮：每轮是用户的话，以及助手最后的回复。`, "");
  const blocks = turns.map((turn) =>
    [`[第 ${turn.turn} 轮] 用户：${cut(turn.user, SUMMARY_LIMITS.user) || "（无）"}`, `助手：${cut(turn.agent, SUMMARY_LIMITS.agent) || "（无）"}`].join("\n"),
  );
  // Over the limit, the oldest turns go first; the latest ones say where the work stands.
  let size = lines.join("\n").length;
  const kept: string[] = [];
  for (const block of blocks.reverse()) {
    if (size + block.length > SUMMARY_LIMITS.total && kept.length) break;
    kept.unshift(block);
    size += block.length + 2;
  }
  return [...lines, kept.join("\n\n")].join("\n");
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const STATES = new Set<MilestoneState>(["done", "current", "planned"]);

/** The model's answer as a summary, or undefined when it is not one. */
export function readSummary(value: unknown): SummaryInput | undefined {
  if (!isRecord(value) || typeof value.title !== "string" || !value.title.trim()) return undefined;
  const tags = Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === "string") : [];
  const milestones = Array.isArray(value.milestones)
    ? value.milestones.flatMap((item) =>
        isRecord(item) && typeof item.title === "string" && item.title.trim() && STATES.has(item.state as MilestoneState)
          ? [{ title: item.title, state: item.state as MilestoneState }]
          : [],
      )
    : [];
  return { title: value.title, tags, milestones, finished: value.finished === true };
}
