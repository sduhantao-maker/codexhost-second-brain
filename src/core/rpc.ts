/** Messages between the browser entries and the backend (`backend.invoke`). */
import type { Locale, Settings, ThreadInfo, ThreadStatus } from "./model.js";
import type { Favorite } from "./favorites.js";
import type { RefView } from "./refs.js";

export type Surface = "desktop" | "web" | "page";

export interface SnapshotParams {
  /** The version the caller already has; an unchanged snapshot comes back as `{ version }`. */
  version?: string;
  focus?: { threadId: string; surface: Surface };
  locale?: Locale;
  /** The overview page knows the UI language for sure; the capsule only guesses it. */
  localeSource?: "page" | "surface";
}

export interface RefsStatus {
  conversations: { scanned: number; listed: number; done: boolean; unreadable: number };
  refs: number;
  github: { enabled: boolean; lastPollAt?: number; error?: string };
}

export interface RefsList {
  status: RefsStatus;
  /** Those with news first, then the most recently mentioned; as many as fit in one answer. */
  refs: RefView[];
  /** How many older ones did not fit, when any did not. */
  omitted?: number;
}

export interface TreeReport {
  nodes: Record<string, { title?: string; status: ThreadStatus; harnessId?: string }>;
  /** Child to parent. */
  parents: Record<string, string>;
}

export type AgentId = "claude" | "codex";
export type IntegrationState = "installed" | "missing" | "outdated" | "unavailable";

/**
 * Why an agent's configuration cannot be changed, for the overview to say in its language:
 * ~/.claude or ~/.codex is missing (the agent is not set up), is no folder or cannot be read;
 * settings.json or AGENTS.md cannot be read; settings.json is not valid JSON, or not an object.
 */
export type IntegrationProblem = "NOT_SET_UP" | "NOT_A_FOLDER" | "FOLDER_UNREADABLE" | "FILE_UNREADABLE" | "NOT_JSON" | "NOT_AN_OBJECT";

export interface IntegrationStatus {
  agent: AgentId;
  file: string;
  state: IntegrationState;
  /** When unavailable: why, in English. */
  detail?: string;
  /** When unavailable: why, as a code; `cause` is the system's error code (EACCES, …) where there is one. */
  problem?: IntegrationProblem;
  cause?: string;
}

export interface IntegrationPreview {
  agent: AgentId;
  file: string;
  action: "create" | "add" | "replace" | "remove" | "none";
  /** The exact text that will be added or removed; when unavailable, why (in English). */
  snippet: string;
  /** When the configuration cannot be changed: why, as in IntegrationStatus. */
  problem?: IntegrationProblem;
  cause?: string;
}

/** Thrown errors cross the backend boundary as plain messages prefixed with the code. */
export function errorCodeOf(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  return /^\[([A-Z_]+)\]/u.exec(message)?.[1];
}

// ---------------------------------------------------------------------------------------------
// Mainline v2 contracts. The hover card, the in-conversation card and the overview page build on
// these; see docs/superpowers/specs/2026-11-23-mainline-v2-design.md section 5.

export interface SnapshotResultV2 {
  version: string;
  state?: import("./conversation.js").StateV2;
  info?: Record<string, ThreadInfo>;
  settings?: Settings;
  command?: string;
  alerts?: RefView[];
  /** Known delegation links, child to parent. */
  parents?: Record<string, string>;
  /** How the model summaries are doing. */
  summarizer?: SummarizerStatus;
  /** The workspace (last folder of the working directory) of each conversation, where known. */
  workspaces?: Record<string, string>;
  /** How many passages are saved. */
  favorites?: number;
  /** A saved passage to show again, sent to the surface that has its conversation open. */
  reveal?: Reveal;
  /**
   * While the folder of the extension's earlier name (Mainline) is still there after its data was
   * copied over: where it is, the home folder written as ~. The settings tab says it can go.
   */
  migration?: { oldFolder: string };
  /**
   * Only when the whole state would make the answer too large: the conversations sent as an
   * outline, with their milestones reached and in all. An outline in `state.conversations` has the
   * title, status, last change, links and the current milestone; tags, spin-offs, tasks and the
   * first date are left out (normalizeStateV2 reads them as empty), so read the state through it.
   * A page asks for the rest with `conversation`.
   */
  outline?: Record<string, [done: number, total: number]>;
  /** Only when even outlines are too much: how many of the oldest conversations and last requests were left out. */
  omitted?: number;
}

/** `favorites.reveal` asks for it; the surface showing the conversation finds and marks the passage. */
export interface Reveal {
  id: string;
  threadId: string;
  text: string;
}

export interface FavoriteAdded {
  favorite: Favorite;
  /** False when the same passage was saved before. */
  added: boolean;
}

/** Characters of a saved passage `favorites.list` sends; `favorites.get` gives all of it. */
export const FAVORITE_EXCERPT_CHARS = 600;

/** A saved passage as listed: its text cut to FAVORITE_EXCERPT_CHARS when `truncated`. */
export type FavoriteExcerpt = Favorite & { truncated?: true };

/** `favorites.list`: a page of the saved passages matching the query (all without one), the newest first. */
export interface FavoritesListParams {
  query?: string;
  /** Where the page starts among the matching passages (0 by default). */
  offset?: number;
  /** How many at most (FAVORITES_PAGE by default, FAVORITES_PAGE_MAX at most); fewer when they would make the answer too large. */
  limit?: number;
}

export const FAVORITES_PAGE = 100;
export const FAVORITES_PAGE_MAX = 300;

export interface FavoritesList {
  items: FavoriteExcerpt[];
  /** The current title of each source conversation. */
  titles: Record<string, string>;
  /** Passages saved in all. */
  total: number;
  /** Passages matching the query. */
  matched?: number;
  /** Where the next page starts, when there are more. */
  nextOffset?: number;
}

/** `favorites.get { id }`: one saved passage in full. */
export interface FavoriteGot {
  favorite: Favorite;
}

/** How many times a conversation was sent to each model, and why: after a turn, asked for, or by the backfill. */
export type SummaryCalls = Record<"claude" | "codex", Record<"auto" | "manual" | "backfill", number>>;

/** Model summaries: work in progress, today's calls, and the one-time backfill of older conversations. */
export interface SummarizerStatus {
  running: number;
  queued: number;
  /** Today's calls (local day), counted on disk: `count` automatic ones against the daily `limit`, and all of them by model and reason. */
  today: { count: number; limit: number; calls: SummaryCalls };
  /**
   * A backfill in progress. `skipped`: conversations of other agents left out, as the settings say.
   * `full`: conversations without a mainline left out because the state keeps no more mainlines
   * (not in `total`); absent when none.
   */
  backfill?: { done: number; total: number; failed: number; skipped: number; full?: number };
  /** With no backfill running: at most how many conversations one started now would send to a model. */
  toBackfill?: number;
  /** Why the last summary failed, in English. */
  lastError?: string;
  /** The same as a code the overview says in its language: an ErrorCode, or a SummaryProblem. */
  lastErrorCode?: string;
}

/**
 * Why a summary sent nothing, for the overview to say in its language: the tool of the model set
 * for it is not on this computer, or model calls are turned off (MAINLINE_NO_MODEL=1).
 */
export type SummaryProblem = "CLAUDE_MISSING" | "CODEX_MISSING" | "MODEL_CALLS_OFF";

/** `conversation`: the full view of one conversation's mainline, or its draft. */
export interface ConversationParams {
  threadId: string;
}

/** `search`: find conversations by any clue. */
export interface SearchParams {
  query: string;
}

export type SearchField = "ref" | "tag" | "title" | "milestone" | "task" | "spinoff" | "prompt" | "threadTitle" | "favorite";

export interface SearchResult {
  threadId: string;
  title: string;
  tags: string[];
  status: import("./conversation.js").ConversationStatus;
  draft: boolean;
  /** Title of the current milestone. */
  current?: string;
  progress: { done: number; total: number };
  /** The best match, to show why this conversation came up. */
  match: { field: SearchField; text: string };
  /** Keys of PRs and issues of this conversation, e.g. "owner/repo#42". */
  refs: string[];
  threadStatus: ThreadStatus;
  updatedAt: number;
}

export type MutateV2Params =
  | { op: "create"; threadId: string; title: string; tags?: string[]; milestones?: string[] }
  | { op: "title"; threadId: string; title: string }
  | { op: "tags"; threadId: string; tags: string[] }
  | { op: "status"; threadId: string; status: import("./conversation.js").ConversationStatus }
  | { op: "milestoneAdd"; threadId: string; title: string; index?: number }
  | { op: "milestoneRename"; threadId: string; milestoneId: string; title: string }
  | { op: "milestoneRemove"; threadId: string; milestoneId: string }
  /** Marks the current (or the given) milestone done; the next planned one becomes current. */
  | { op: "milestoneReach"; threadId: string; milestoneId?: string }
  /** Makes the given milestone the current one again. */
  | { op: "milestoneFocus"; threadId: string; milestoneId: string }
  | { op: "taskAdd"; threadId: string; text: string; milestoneId?: string }
  | { op: "taskDone"; threadId: string; taskId: string }
  | { op: "taskRemove"; threadId: string; taskId: string }
  | { op: "doing"; threadId: string; text: string | null }
  | { op: "spinoffAdd"; threadId: string; text: string }
  | { op: "spinoffDismiss"; threadId: string; spinoffId: string }
  /** Handles a spin-off in this conversation: it becomes a task of the current milestone. */
  | { op: "spinoffKeep"; threadId: string; spinoffId: string }
  | { op: "relate"; threadId: string; toThreadId: string | null }
  | { op: "delete"; threadId: string }
  /** Lets model summaries update the title, tags and milestones the user edited again. */
  | { op: "unpin"; threadId: string };

/**
 * `spawn`: opens a child conversation of `threadId`: for a spin-off already noted, or for a new
 * problem written in one line (noted as a spin-off first; a conversation without a mainline gets
 * one from its draft). `attachments` are ids from `attach.begin`, fully sent with `attach.chunk`.
 */
export type SpawnParams = ({ threadId: string; spinoffId: string } | { threadId: string; text: string }) & { attachments?: string[] };

/** `attach.begin`: makes room for one file to send along with a new child conversation. */
export interface AttachBeginParams {
  name: string;
  size: number;
  type?: string;
}

/** `attach.chunk`: one piece of that file, `ATTACH_CHUNK_BYTES` long (the last may be shorter), in base64. */
export interface AttachChunkParams {
  id: string;
  offset: number;
  data: string;
}

export interface SpawnResult {
  childThreadId: string;
}

/** A number of files and the bytes they take. */
export interface FilesSize {
  files: number;
  bytes: number;
}

/**
 * `attachments.usage`: what the files sent along with child conversations take on this machine,
 * counted when asked: all of them, those of child conversations whose mainline is done, and those
 * no record says which child they belong to.
 */
export interface AttachmentsUsage {
  all: FilesSize;
  done: FilesSize;
  unknown: FilesSize;
}

/** Which of those files `attachments.clear` deletes: those of done child conversations, or all. */
export type AttachmentsScope = "done" | "all";

export interface AttachmentsClearParams {
  scope: AttachmentsScope;
}

/** `attachments.clear`: what was deleted, and what is left. */
export interface AttachmentsCleared {
  cleared: FilesSize;
  usage: AttachmentsUsage;
}
