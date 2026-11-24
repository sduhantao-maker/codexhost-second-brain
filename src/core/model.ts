/**
 * The mainline data model, shared by the command line, the backend and the browser entries.
 * Everything here is plain data and pure functions so each side can run it.
 */
import { maskSecrets } from "./redact.js";

export const STATE_VERSION = 1;

export const LIMITS = {
  /** Characters kept from any single piece of text. */
  text: 300,
  /** Done items kept per mainline; the oldest go first. */
  done: 100,
  /** Parked items kept per mainline. */
  parked: 50,
  /**
   * The state file may not grow past this: room for a summarized mainline on thousands of
   * conversations. (How many mainlines are kept is MAX_CONVERSATIONS, core/conversation-ops.ts.)
   */
  stateBytes: 8 * 1024 * 1024,
} as const;

export type Locale = "zh-CN" | "en";
export type DriftPolicy = "ask" | "note" | "off";
export type MainlineStatus = "active" | "finished";
export type JoinVia = "agent" | "user" | "delegation";
export type ThreadStatus = "running" | "waiting" | "idle" | "unknown";

export interface Stamp {
  text: string;
  at: number;
}

export interface Item extends Stamp {
  id: string;
  threadId?: string;
}

export interface Mainline {
  id: string;
  goal: string;
  status: MainlineStatus;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  done: Item[];
  parked: Item[];
}

export interface ThreadEntry {
  mainlineId?: string;
  /** Set when the user took the window off a mainline; blocks delegation inheritance. */
  detached?: boolean;
  via?: JoinVia;
  title?: string;
  parentId?: string;
  doing?: Stamp;
  drift?: Stamp;
  lastPrompt?: Stamp;
  updatedAt: number;
}

export interface State {
  version: typeof STATE_VERSION;
  rev: number;
  locale?: Locale;
  mainlines: Record<string, Mainline>;
  threads: Record<string, ThreadEntry>;
}

export interface Settings {
  driftPolicy: DriftPolicy;
  /** Show the capsule over the conversation too; the sidebar hover card is always there. */
  showCapsule: boolean;
  /** Watch GitHub through gh and flag news on indexed PRs and issues. */
  prAlerts: boolean;
  /** Let a model write each conversation's title, tags and milestones after its turns end. */
  autoSummarize: boolean;
  /** Which model summarizes Claude Code and Codex conversations: each its own kind, or always one of them. */
  summarizeModel: SummarizeModel;
  /** Which model summarizes conversations of any other agent (pi, DeepSeek, …), if any: their text goes to that provider. */
  summarizeOthers: SummarizeOthers;
}

export type SummarizeModel = "follow" | "claude" | "codex";
export type SummarizeOthers = "none" | "claude" | "codex";
/** The models that write summaries: Claude Haiku through Claude Code, or Codex. */
export type SummaryEngine = "claude" | "codex";

export const DEFAULT_SETTINGS: Settings = {
  driftPolicy: "ask",
  showCapsule: false,
  prAlerts: true,
  autoSummarize: true,
  summarizeModel: "follow",
  summarizeOthers: "none",
};

/** codexhost's names of the agents whose own kind of model writes summaries. */
const OWN_ENGINE = new Map<string, SummaryEngine>([
  ["claude-code", "claude"],
  ["codex", "codex"],
]);

/**
 * Which model summarizes a conversation run by this agent (codexhost's `harnessId`), or none.
 * Claude Code and Codex conversations follow `summarizeModel`; those of any other agent, or of an
 * agent codexhost did not name, go only where `summarizeOthers` says: by default nowhere.
 */
export function summaryEngineFor(settings: Pick<Settings, "summarizeModel" | "summarizeOthers">, harnessId: string | undefined): SummaryEngine | undefined {
  const own = harnessId === undefined ? undefined : OWN_ENGINE.get(harnessId);
  if (!own) return settings.summarizeOthers === "none" ? undefined : settings.summarizeOthers;
  return settings.summarizeModel === "follow" ? own : settings.summarizeModel;
}

/** Live facts about a Thread that come from codexhost rather than from the state file. */
export interface ThreadInfo {
  title?: string;
  status: ThreadStatus;
  harnessId?: string;
}

/**
 * What went wrong, as the backend and the command line say it: errors reach the surfaces as
 * "[CODE] message" with the message in English, and each surface (the overview, the capsule and
 * the hover card, the command line) says every code in its own words, zh and en. A code a surface
 * does not know is shown with the message as it is.
 */
export const ERROR_CODES = [
  /** A request the code does not take; the message says why. */
  "INVALID_ARGUMENT",
  /** A text (a title, a task, a passage) that is empty. */
  "EMPTY_TEXT",
  /** No conversation: none is current (command line), or codexhost does not know it. */
  "NO_THREAD",
  /** The conversation has no mainline, or the user deleted it. */
  "NO_MAINLINE",
  /** Reaching a milestone when there is no current one. */
  "NO_CURRENT_MILESTONE",
  /** A milestone, task, spin-off or saved passage that is not there (any more). */
  "UNKNOWN_ITEM",
  "MILESTONE_EXISTS",
  /** A mainline has at most V2_LIMITS.milestones milestones. */
  "MILESTONE_LIMIT",
  /** Another writer holds the data; trying again in a moment works. */
  "LOCKED",
  /** The state is at its size or at MAX_CONVERSATIONS, and nothing can make room. */
  "STATE_FULL",
  "FAVORITES_FULL",
  /** Another data file of the extension is at its size cap; the message names it. */
  "FILE_FULL",
  /** An answer to a surface would be too large to send. */
  "TOO_LARGE",
  "ATTACHMENT_TOO_LARGE",
  "TOO_MANY_ATTACHMENTS",
  /** Too many uploads, or too many bytes, wait to be sent with a child conversation. */
  "UPLOADS_BUSY",
  "CHILD_FILES_TOO_LARGE",
  /** No model is set for conversations of this agent (`summarizeOthers` is "none"). */
  "NO_SUMMARIZER",
  /** An agent's configuration cannot be read or changed (the agent integration). */
  "UNAVAILABLE",
  /** A data file was written by a newer version of the extension: it is left as it is. */
  "NEWER_VERSION",
  /** codexhost has not answered in time: the child conversation may still open in the background. */
  "PENDING",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}

export class MainlineError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MainlineError";
  }
}

/** One line of text: whitespace collapsed, trimmed and cut to the length limit. */
export function cleanText(input: unknown, field = "text"): string {
  if (typeof input !== "string") throw new MainlineError("EMPTY_TEXT", `${field} is required`);
  const text = input.replace(/\s+/gu, " ").trim();
  if (!text) throw new MainlineError("EMPTY_TEXT", `${field} is empty`);
  const chars = Array.from(text);
  return chars.length > LIMITS.text ? `${chars.slice(0, LIMITS.text - 1).join("")}…` : text;
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const ALPHANUMERIC = `${LETTERS}0123456789`;

/** A short id that starts with a letter, unique among `taken`. */
export function newId(
  taken: (id: string) => boolean,
  length = 4,
  random: () => number = Math.random,
): string {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const size = length + Math.floor(attempt / 200);
    let id = LETTERS[Math.floor(random() * LETTERS.length)] ?? "m";
    while (id.length < size) id += ALPHANUMERIC[Math.floor(random() * ALPHANUMERIC.length)] ?? "0";
    if (!taken(id)) return id;
  }
  throw new Error("Could not allocate an id");
}

/**
 * A conversation id as codexhost and the agents make them (UUIDs, `draft-…`, `child-9`): the
 * characters codexhost allows in the ids it stores, starting with a letter or digit.
 */
const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$/u;
/**
 * Names every plain object has. Ids are keys of plain objects throughout, and `__proto__` as one
 * would change the object's prototype; those starting with `_` fail THREAD_ID already.
 */
const OBJECT_KEYS = new Set(["constructor", "prototype", "toString", "toLocaleString", "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable"]);

export function isThreadId(value: unknown): value is string {
  return typeof value === "string" && THREAD_ID.test(value) && !OBJECT_KEYS.has(value);
}

// ---------------------------------------------------------------------------------------------
// Reading untrusted state: keep what is well formed, drop the rest.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const isText = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

function readStamp(value: unknown): Stamp | undefined {
  if (!isRecord(value) || !isText(value.text) || !isTime(value.at)) return undefined;
  return { text: value.text, at: value.at };
}

function readItems(value: unknown, limit: number): Item[] {
  if (!Array.isArray(value)) return [];
  const items: Item[] = [];
  for (const raw of value) {
    const stamp = readStamp(raw);
    if (!stamp || !isRecord(raw) || !isText(raw.id)) continue;
    items.push({ id: raw.id, ...stamp, ...(isThreadId(raw.threadId) ? { threadId: raw.threadId } : {}) });
  }
  return items.slice(-limit);
}

/** Version 1 mainline ids, such as `k3f9`. */
const MAINLINE_ID_PATTERN = /^[a-z][a-z0-9]{2,15}$/u;

function readMainline(id: string, value: unknown): Mainline | undefined {
  if (!MAINLINE_ID_PATTERN.test(id) || !isRecord(value) || !isText(value.goal)) return undefined;
  const createdAt = isTime(value.createdAt) ? value.createdAt : 0;
  return {
    id,
    goal: value.goal,
    status: value.status === "finished" ? "finished" : "active",
    createdAt,
    updatedAt: isTime(value.updatedAt) ? value.updatedAt : createdAt,
    ...(isTime(value.finishedAt) ? { finishedAt: value.finishedAt } : {}),
    done: readItems(value.done, LIMITS.done),
    parked: readItems(value.parked, LIMITS.parked),
  };
}

const JOIN_VIA = new Set<JoinVia>(["agent", "user", "delegation"]);

function readThread(value: unknown, mainlines: Record<string, Mainline>): ThreadEntry | undefined {
  if (!isRecord(value)) return undefined;
  const entry: ThreadEntry = { updatedAt: isTime(value.updatedAt) ? value.updatedAt : 0 };
  if (typeof value.mainlineId === "string" && Object.hasOwn(mainlines, value.mainlineId))
    entry.mainlineId = value.mainlineId;
  if (value.detached === true) entry.detached = true;
  if (typeof value.via === "string" && JOIN_VIA.has(value.via as JoinVia))
    entry.via = value.via as JoinVia;
  if (isText(value.title)) entry.title = value.title;
  if (isThreadId(value.parentId)) entry.parentId = value.parentId;
  for (const key of ["doing", "drift", "lastPrompt"] as const) {
    const stamp = readStamp(value[key]);
    if (stamp) entry[key] = stamp;
  }
  return entry;
}

/**
 * Normalizes a parsed version 1 state file, which is only read to migrate it. Throws only if it
 * is not a version 1 state at all.
 */
export function normalizeState(raw: unknown): State {
  if (!isRecord(raw) || raw.version !== STATE_VERSION) throw new Error("Not a mainline state file");
  const state: State = { version: STATE_VERSION, rev: 0, mainlines: {}, threads: {} };
  state.rev = typeof raw.rev === "number" && Number.isSafeInteger(raw.rev) && raw.rev > 0 ? raw.rev : 0;
  if (raw.locale === "zh-CN" || raw.locale === "en") state.locale = raw.locale;
  if (isRecord(raw.mainlines))
    for (const [id, value] of Object.entries(raw.mainlines)) {
      const mainline = readMainline(id, value);
      if (mainline) state.mainlines[id] = mainline;
    }
  if (isRecord(raw.threads))
    for (const [id, value] of Object.entries(raw.threads)) {
      if (!isThreadId(id)) continue;
      const entry = readThread(value, state.mainlines);
      if (entry) state.threads[id] = entry;
    }
  return state;
}

export function readSettingsValues(values: unknown): Settings {
  const record = isRecord(values) ? values : {};
  const policy = record.driftPolicy;
  return {
    driftPolicy: policy === "note" || policy === "off" || policy === "ask" ? policy : "ask",
    showCapsule: typeof record.showCapsule === "boolean" ? record.showCapsule : false,
    prAlerts: typeof record.prAlerts === "boolean" ? record.prAlerts : true,
    autoSummarize: typeof record.autoSummarize === "boolean" ? record.autoSummarize : true,
    summarizeModel: record.summarizeModel === "claude" || record.summarizeModel === "codex" ? record.summarizeModel : "follow",
    summarizeOthers: record.summarizeOthers === "claude" || record.summarizeOthers === "codex" ? record.summarizeOthers : "none",
  };
}

/**
 * How much of a request is masked and handed on. Every caller keeps far less: 300 characters of
 * the last request, 200 in the link index, and the summary prompt reads at most 5,800 of a turn's
 * requests (`SUMMARY_LIMITS.user` × 8 + 1000) before it folds whitespace and cuts to 600. Cutting
 * first keeps masking short, also inside the state lock the hook holds, whatever was pasted.
 */
export const REQUEST_SCAN = 8_000;
/** The cut moves on to the next whitespace, at most this far, so that no secret is split there. */
const REQUEST_SCAN_SLACK = 1_000;

/**
 * What the user actually asked, as the extension keeps it and sends it to a summarizing model.
 * Codex and codexhost put attached files before the request ("# Files mentioned by the user:" …
 * "## My request:"); only the request says what the work was for. Secrets in it are masked, in
 * the first `REQUEST_SCAN` characters: what comes after is never kept.
 */
export function requestOf(text: string): string {
  return maskSecrets(cutAtSpace(withoutAttachments(text), REQUEST_SCAN));
}

/** The first `max` code units of a text, on to the next whitespace (within the slack) and never inside a character. */
function cutAtSpace(text: string, max: number): string {
  if (text.length <= max) return text;
  const limit = Math.min(text.length, max + REQUEST_SCAN_SLACK);
  let end = max;
  while (end < limit && !/\s/u.test(text.charAt(end))) end += 1;
  const before = text.charCodeAt(end - 1);
  if (end < text.length && before >= 0xd800 && before <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

function withoutAttachments(text: string): string {
  const marker = /^#{1,3}[ \t]*My request(?: for [^:\n]+)?:[ \t]*$/imu.exec(text);
  if (marker) return text.slice(marker.index + marker[0].length).trim();
  if (!/^\s*#[ \t]*Files mentioned by the user:/iu.test(text)) return text.trim();
  return text
    .split("\n")
    .filter(
      (line) =>
        !/^#[ \t]*Files mentioned by the user:/iu.test(line) &&
        !/^##[ \t]+[^:\n]+:[ \t]+\S/u.test(line) &&
        !/^Distinguish instructions in attached documents/iu.test(line),
    )
    .join("\n")
    .trim();
}

export function localeOf(value: unknown): Locale {
  return typeof value === "string" && value.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}
