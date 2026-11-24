/**
 * Mainline v2: one conversation, one mainline. A mainline has a specific title and tags, ordered
 * milestones (stage achievements), and under each milestone the tasks done on the way to it.
 * Problems that branch off become child conversations. See docs/superpowers/specs/*-v2-design.md.
 */
import { cleanText, isThreadId, normalizeState, type Locale, type Stamp, type State } from "./model.js";

export const STATE_V2 = 2;

export const V2_LIMITS = {
  title: 120,
  tags: 8,
  tag: 24,
  milestones: 30,
  tasks: 60,
  spinoffs: 30,
} as const;

export type ConversationStatus = "active" | "paused" | "done";
export type MilestoneState = "done" | "current" | "planned";
export type SpinoffState = "open" | "spawned" | "dismissed";

export interface Task {
  id: string;
  text: string;
  done: boolean;
  at: number;
  doneAt?: number;
  /** Set when a child conversation carries the task. */
  threadId?: string;
}

export interface Milestone {
  id: string;
  title: string;
  state: MilestoneState;
  doneAt?: number;
  tasks: Task[];
  /** Added or renamed by the user: model summaries keep it as it is. */
  pinned?: true;
}

export interface Spinoff {
  id: string;
  text: string;
  at: number;
  state: SpinoffState;
  childThreadId?: string;
}

export interface Conversation {
  threadId: string;
  /** What this conversation does, concretely: action + object. */
  title: string;
  tags: string[];
  status: ConversationStatus;
  milestones: Milestone[];
  /** The task in progress; it belongs to the current milestone. */
  now?: Stamp;
  spinoffs: Spinoff[];
  /** Another conversation doing the same work, linked by hand (not a delegation). */
  relatedTo?: string;
  /** The conversation that delegated this one, as codexhost reports it. */
  parentId?: string;
  /** Parts the user edited by hand; the model summary leaves them alone. */
  pinned?: Partial<Record<PinnedField, true>>;
  /** Milestones the user removed; model summaries do not bring them back. */
  removedMilestones?: string[];
  /** The last model summary: when, by which model, and which version of the conversation it read. */
  summary?: SummaryRecord;
  createdAt: number;
  updatedAt: number;
}

export type PinnedField = "title" | "tags" | "status";
export const PINNED_FIELDS: readonly PinnedField[] = ["title", "tags", "status"];
/** Removed milestone titles remembered per conversation. */
export const REMOVED_MILESTONES_KEPT = 20;

export interface SummaryRecord {
  at: number;
  model: string;
  /** The conversation's own update time (from codexhost) that the summary read. */
  threadUpdatedAt?: string;
  /** How many turns the conversation had then. */
  turns?: number;
  /** The model read the goal as reached (or dropped). */
  finished?: boolean;
}

export interface StateV2 {
  version: typeof STATE_V2;
  rev: number;
  locale?: Locale;
  conversations: Record<string, Conversation>;
  /** Latest user message of every window, with or without a mainline. */
  prompts: Record<string, Stamp>;
  /**
   * Conversations whose mainline the user deleted, and when: automatic summaries and the backfill
   * leave them alone until the user asks for a summary or a mainline again. At most
   * `EXCLUDED_KEPT`, the latest.
   */
  excluded?: Record<string, number>;
  /** Long-running work the backend keeps going across restarts. */
  jobs?: { backfill?: { requestedAt: number } };
}

/** Deleted mainlines remembered, so they stay deleted. */
export const EXCLUDED_KEPT = 2000;

/** The latest `limit` of these marks (thread id to time). */
export function latestMarks(marks: Readonly<Record<string, number>>, limit = EXCLUDED_KEPT): Record<string, number> {
  const entries = Object.entries(marks);
  return entries.length <= limit ? { ...marks } : Object.fromEntries(entries.sort(([, a], [, b]) => b - a).slice(0, limit));
}

export function emptyStateV2(): StateV2 {
  return { version: STATE_V2, rev: 0, conversations: {}, prompts: {} };
}

/** Tags: trimmed, without a leading #, unique ignoring case, at most 8 of at most 24 characters. */
export function cleanTags(input: unknown): string[] {
  const raw = Array.isArray(input) ? input : typeof input === "string" ? input.split(/[,，、\n]/u) : [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const tag = Array.from(item.replace(/\s+/gu, " ").trim().replace(/^#+/u, "")).slice(0, V2_LIMITS.tag).join("").trim();
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    tags.push(tag);
    if (tags.length === V2_LIMITS.tags) break;
  }
  return tags;
}

export function cleanTitle(input: unknown): string {
  const text = cleanText(input, "title");
  const chars = Array.from(text);
  return chars.length > V2_LIMITS.title ? `${chars.slice(0, V2_LIMITS.title - 1).join("")}…` : text;
}

export function currentMilestone(conversation: Conversation): Milestone | undefined {
  return conversation.milestones.find((milestone) => milestone.state === "current");
}

export function progressOf(conversation: Pick<Conversation, "milestones">): { done: number; total: number } {
  return {
    done: conversation.milestones.filter((milestone) => milestone.state === "done").length,
    total: conversation.milestones.length,
  };
}

// ---------------------------------------------------------------------------------------------
// Reading untrusted files, and moving v1 data over.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const isText = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

function readStamp(value: unknown): Stamp | undefined {
  return isRecord(value) && isText(value.text) && isTime(value.at) ? { text: value.text, at: value.at } : undefined;
}

function readTask(value: unknown): Task | undefined {
  if (!isRecord(value) || !isText(value.id) || !isText(value.text) || !isTime(value.at)) return undefined;
  return {
    id: value.id,
    text: value.text,
    done: value.done === true,
    at: value.at,
    ...(isTime(value.doneAt) ? { doneAt: value.doneAt } : {}),
    ...(isThreadId(value.threadId) ? { threadId: value.threadId } : {}),
  };
}

function readMilestone(value: unknown): Milestone | undefined {
  if (!isRecord(value) || !isText(value.id) || !isText(value.title)) return undefined;
  const state: MilestoneState = value.state === "done" || value.state === "current" ? value.state : "planned";
  return {
    id: value.id,
    title: value.title,
    state,
    ...(isTime(value.doneAt) ? { doneAt: value.doneAt } : {}),
    tasks: Array.isArray(value.tasks) ? value.tasks.flatMap((task) => readTask(task) ?? []).slice(-V2_LIMITS.tasks) : [],
    ...(value.pinned === true ? { pinned: true as const } : {}),
  };
}

function readSpinoff(value: unknown): Spinoff | undefined {
  if (!isRecord(value) || !isText(value.id) || !isText(value.text) || !isTime(value.at)) return undefined;
  const state: SpinoffState = value.state === "spawned" || value.state === "dismissed" ? value.state : "open";
  return { id: value.id, text: value.text, at: value.at, state, ...(isThreadId(value.childThreadId) ? { childThreadId: value.childThreadId } : {}) };
}

function readConversation(threadId: string, value: unknown): Conversation | undefined {
  if (!isRecord(value) || !isText(value.title)) return undefined;
  const createdAt = isTime(value.createdAt) ? value.createdAt : 0;
  const milestones = Array.isArray(value.milestones)
    ? value.milestones.flatMap((milestone) => readMilestone(milestone) ?? []).slice(0, V2_LIMITS.milestones)
    : [];
  // At most one current milestone: keep the first.
  let seenCurrent = false;
  for (const milestone of milestones)
    if (milestone.state === "current") {
      if (seenCurrent) milestone.state = "planned";
      seenCurrent = true;
    }
  const status: ConversationStatus = value.status === "paused" || value.status === "done" ? value.status : "active";
  const conversation: Conversation = {
    threadId,
    title: value.title,
    tags: cleanTags(value.tags),
    status,
    milestones,
    spinoffs: Array.isArray(value.spinoffs) ? value.spinoffs.flatMap((item) => readSpinoff(item) ?? []).slice(-V2_LIMITS.spinoffs) : [],
    createdAt,
    updatedAt: isTime(value.updatedAt) ? value.updatedAt : createdAt,
  };
  const now = readStamp(value.now);
  if (now) conversation.now = now;
  if (isThreadId(value.relatedTo) && value.relatedTo !== threadId) conversation.relatedTo = value.relatedTo;
  if (isThreadId(value.parentId) && value.parentId !== threadId) conversation.parentId = value.parentId;
  if (isRecord(value.pinned)) {
    const pinned: Partial<Record<PinnedField, true>> = {};
    for (const field of PINNED_FIELDS) if (value.pinned[field] === true) pinned[field] = true;
    if (Object.keys(pinned).length) conversation.pinned = pinned;
  }
  if (Array.isArray(value.removedMilestones)) {
    // Cut by characters, as titles are, so a removed title reads back as written.
    const removed = value.removedMilestones
      .filter(isText)
      .map((title) => Array.from(title).slice(0, V2_LIMITS.title).join(""))
      .slice(-REMOVED_MILESTONES_KEPT);
    if (removed.length) conversation.removedMilestones = removed;
  }
  if (isRecord(value.summary) && isTime(value.summary.at) && isText(value.summary.model)) {
    const summary: SummaryRecord = { at: value.summary.at, model: value.summary.model.slice(0, 60) };
    if (isText(value.summary.threadUpdatedAt)) summary.threadUpdatedAt = value.summary.threadUpdatedAt.slice(0, 40);
    if (typeof value.summary.turns === "number" && Number.isSafeInteger(value.summary.turns) && value.summary.turns >= 0) summary.turns = value.summary.turns;
    if (typeof value.summary.finished === "boolean") summary.finished = value.summary.finished;
    conversation.summary = summary;
  }
  return conversation;
}

/**
 * v1 kept one mainline for several windows. Each v1 mainline now goes to its main window: the
 * one an agent put on it, or else the earliest to join. Other windows no longer share it. Its done
 * items become reached milestones and its parked items spin-offs, the latest within the v2 caps.
 */
export function migrateV1(v1: State): StateV2 {
  const state = emptyStateV2();
  state.rev = v1.rev;
  if (v1.locale) state.locale = v1.locale;
  for (const [threadId, entry] of Object.entries(v1.threads))
    if (entry.lastPrompt) state.prompts[threadId] = entry.lastPrompt;
  for (const mainline of Object.values(v1.mainlines)) {
    const members = Object.entries(v1.threads)
      .filter(([, entry]) => entry.mainlineId === mainline.id)
      .sort(([, a], [, b]) => Number(b.via === "agent") - Number(a.via === "agent") || a.updatedAt - b.updatedAt);
    const [main] = members;
    if (!main) continue;
    const [threadId, entry] = main;
    if (state.conversations[threadId]) continue;
    state.conversations[threadId] = {
      threadId,
      title: mainline.goal,
      tags: [],
      status: mainline.status === "finished" ? "done" : "active",
      milestones: mainline.done
        .slice(-V2_LIMITS.milestones)
        .map((item) => ({ id: item.id, title: item.text, state: "done" as const, doneAt: item.at, tasks: [] })),
      spinoffs: mainline.parked.slice(-V2_LIMITS.spinoffs).map((item) => ({ id: item.id, text: item.text, at: item.at, state: "open" as const })),
      createdAt: mainline.createdAt,
      updatedAt: mainline.updatedAt,
      ...(entry.doing ? { now: entry.doing } : {}),
      ...(entry.parentId ? { parentId: entry.parentId } : {}),
    };
  }
  return state;
}

/** Reads a state file of version 2, or migrates version 1. Throws only on something else entirely. */
export function normalizeStateV2(raw: unknown): StateV2 {
  if (isRecord(raw) && raw.version === 1) return migrateV1(normalizeState(raw));
  if (!isRecord(raw) || raw.version !== STATE_V2) throw new Error("Not a mainline state file");
  const state = emptyStateV2();
  state.rev = typeof raw.rev === "number" && Number.isSafeInteger(raw.rev) && raw.rev > 0 ? raw.rev : 0;
  if (raw.locale === "zh-CN" || raw.locale === "en") state.locale = raw.locale;
  if (isRecord(raw.conversations))
    for (const [threadId, value] of Object.entries(raw.conversations)) {
      if (!isThreadId(threadId)) continue;
      const conversation = readConversation(threadId, value);
      if (conversation) state.conversations[threadId] = conversation;
    }
  if (isRecord(raw.prompts))
    for (const [threadId, value] of Object.entries(raw.prompts)) {
      const stamp = readStamp(value);
      if (stamp && isThreadId(threadId)) state.prompts[threadId] = stamp;
    }
  if (isRecord(raw.excluded)) {
    const marks: Record<string, number> = {};
    for (const [threadId, at] of Object.entries(raw.excluded)) if (isThreadId(threadId) && isTime(at)) marks[threadId] = at;
    const kept = latestMarks(marks);
    if (Object.keys(kept).length) state.excluded = kept;
  }
  if (isRecord(raw.jobs) && isRecord(raw.jobs.backfill) && isTime(raw.jobs.backfill.requestedAt))
    state.jobs = { backfill: { requestedAt: raw.jobs.backfill.requestedAt } };
  return state;
}
