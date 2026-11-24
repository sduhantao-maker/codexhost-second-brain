/**
 * The PR and issue index: every GitHub pull request or issue that shows up in a conversation,
 * where it showed up, what the user had asked in that turn, and whether it has news on GitHub.
 * It answers "the maintainer replied to #42 — which window was that, and what was it for?"
 */
import { isThreadId } from "./model.js";
import { maskSecrets } from "./redact.js";

export const REFS_VERSION = 1;

export const REF_LIMITS = {
  refs: 2000,
  mentions: 8,
  prompt: 200,
  note: 300,
  results: 20,
} as const;

export type RefKind = "pr" | "issue";
export type RefState = "open" | "closed" | "merged";

export interface Mention {
  threadId: string;
  /** Turn number in that window; 0 when an agent recorded it without one. */
  turn: number;
  at: number;
  role: "user" | "agent";
  /** The user's message in that turn: what the work was for. */
  prompt?: string;
}

export interface Ref {
  key: string;
  repo: string;
  number: number;
  kind: RefKind;
  url: string;
  title?: string;
  state?: RefState;
  checkedAt?: number;
  /** Earliest first; the first one is where the PR or issue came from. */
  mentions: Mention[];
  note?: { text: string; threadId: string; at: number };
  /** The latest news worth a bell: a review, a merge or a new comment by someone else. */
  activity?: { at: number; reason: string; unseen: boolean };
  /** The latest GitHub notification on it that has been looked into. */
  notifiedAt?: number;
  lastMentionAt: number;
}

export interface ScanRecord {
  turns: number;
  updatedAt: string;
  title?: string;
  scannedAt: number;
  /** codexhost could not read it (for example a native session that no longer exists). */
  unreadable?: boolean;
  /**
   * The last folder of the conversation's working folder: all any view shows (its project), so the
   * full path is not kept. Earlier versions kept the full path; the backend cuts those down when it
   * starts. Readers still take `path.basename` of it, which gives the same for both.
   */
  cwd?: string;
  /** The first request of the conversation, for drafts. */
  firstPrompt?: string;
  /**
   * The agent that runs it, as codexhost lists it (its `harnessId`: "claude-code", "codex", "pi",
   * …), so the backfill knows without a read which conversations go to no model.
   */
  harnessId?: string;
}

export interface RefIndex {
  version: typeof REFS_VERSION;
  rev: number;
  refs: Record<string, Ref>;
  /** How far each window has been read. */
  threads: Record<string, ScanRecord>;
  crawl: { done: boolean; cursor?: string; listed: number; startedAt?: number; finishedAt?: number };
  github: { baselineAt?: number; lastPollAt?: number; error?: string };
}

export interface Link {
  key: string;
  repo: string;
  number: number;
  kind: RefKind;
  url: string;
}

export function emptyIndex(): RefIndex {
  return { version: REFS_VERSION, rev: 0, refs: {}, threads: {}, crawl: { done: false, listed: 0 }, github: {} };
}

export function refKey(repo: string, number: number): string {
  return `${repo}#${number}`;
}

const LINK = /https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(pull|issues)\/(\d{1,9})/gu;

/** GitHub pull request and issue links in a piece of text, each once. */
export function extractLinks(text: string): Link[] {
  const found = new Map<string, Link>();
  for (const match of text.matchAll(LINK)) {
    const [, owner = "", name = "", type, digits = "0"] = match;
    const repo = `${owner}/${name.replace(/\.git$/u, "")}`;
    const number = Number(digits);
    if (!number) continue;
    const kind: RefKind = type === "pull" ? "pr" : "issue";
    const key = refKey(repo, number);
    if (!found.has(key))
      found.set(key, { key, repo, number, kind, url: `https://github.com/${repo}/${type === "pull" ? "pull" : "issues"}/${number}` });
  }
  return [...found.values()];
}

/** `api.github.com/repos/o/r/pulls/12` or `/issues/12`, as notifications name their subject. */
export function linkFromApiUrl(url: string, type?: string): Link | undefined {
  const match = /^https:\/\/api\.github\.com\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(pulls|issues)\/(\d+)$/u.exec(url);
  if (!match) return undefined;
  const [, owner = "", name = "", collection, digits = "0"] = match;
  const kind: RefKind = collection === "pulls" || type === "PullRequest" ? "pr" : "issue";
  const repo = `${owner}/${name}`;
  const number = Number(digits);
  return { key: refKey(repo, number), repo, number, kind, url: `https://github.com/${repo}/${kind === "pr" ? "pull" : "issues"}/${number}` };
}

function clip(text: string, limit: number): string {
  const clean = text.replace(/\s+/gu, " ").trim();
  const chars = Array.from(clean);
  return chars.length > limit ? `${chars.slice(0, limit - 1).join("")}…` : clean;
}

function ensureRef(index: RefIndex, link: Link, now: number): Ref {
  let ref = index.refs[link.key];
  if (!ref) {
    ref = { ...link, mentions: [], lastMentionAt: now };
    index.refs[link.key] = ref;
  }
  return ref;
}

const earlier = (a: Mention, b: Mention) => a.at - b.at || a.turn - b.turn;

/**
 * Records that a link appeared in a window. A window keeps only its earliest mention, so the
 * list reads as "where did this come from, and where else did it come up".
 */
export function addMention(index: RefIndex, link: Link, mention: Mention): boolean {
  const ref = ensureRef(index, link, mention.at);
  const prompt = mention.prompt ? clip(mention.prompt, REF_LIMITS.prompt) : undefined;
  const next: Mention = { threadId: mention.threadId, turn: mention.turn, at: mention.at, role: mention.role, ...(prompt ? { prompt } : {}) };
  const existing = ref.mentions.findIndex((item) => item.threadId === mention.threadId);
  let changed = false;
  if (existing < 0) {
    ref.mentions.push(next);
    changed = true;
  } else {
    const current = ref.mentions[existing]!;
    // A turn number beats an unnumbered record of the same window; an earlier turn beats a later one.
    if ((current.turn === 0 && next.turn > 0) || (next.turn > 0 && next.turn < current.turn)) {
      ref.mentions[existing] = { ...next, at: Math.min(current.at, next.at), ...(next.prompt ? {} : current.prompt ? { prompt: current.prompt } : {}) };
      changed = true;
    } else if (next.turn === current.turn && next.prompt && next.prompt !== current.prompt) {
      // Reading the same turn again with a better extraction replaces the old text.
      ref.mentions[existing] = { ...current, prompt: next.prompt };
      changed = true;
    }
  }
  ref.mentions.sort(earlier);
  ref.mentions.splice(REF_LIMITS.mentions);
  if (mention.at > ref.lastMentionAt) {
    ref.lastMentionAt = mention.at;
    changed = true;
  }
  if (ref.kind !== link.kind && link.kind === "pr") {
    ref.kind = "pr";
    ref.url = link.url;
    changed = true;
  }
  return changed;
}

export function setNote(index: RefIndex, link: Link, threadId: string, text: string, now: number): void {
  const ref = ensureRef(index, link, now);
  const clean = clip(text, REF_LIMITS.note);
  if (clean) ref.note = { text: clean, threadId, at: now };
}

/** Records GitHub news. Returns true when it is news the user has not seen. */
export function applyActivity(
  index: RefIndex,
  key: string,
  activity: { at: number; reason: string; title?: string },
  alert: boolean,
): boolean {
  const ref = index.refs[key];
  if (!ref) return false;
  if (activity.title && !ref.title) ref.title = clip(activity.title, 200);
  if (ref.activity && activity.at <= ref.activity.at) return false;
  // Only looking at it clears a bell; later, quieter news does not.
  ref.activity = { at: activity.at, reason: activity.reason, unseen: alert || ref.activity?.unseen === true };
  return alert;
}

/**
 * Records that GitHub notified about a PR or issue at `at`. Returns the time after which what
 * happened on it is new, or nothing when this notification was already looked into. `firstSince`
 * stands in for the previous notification when there was none.
 */
export function noteNotified(index: RefIndex, key: string, notice: { at: number; title?: string }, firstSince: number): number | undefined {
  const ref = index.refs[key];
  if (!ref || (ref.notifiedAt !== undefined && notice.at <= ref.notifiedAt)) return undefined;
  const after = Math.max(ref.notifiedAt ?? firstSince, ref.activity?.at ?? -Infinity);
  ref.notifiedAt = notice.at;
  if (notice.title && !ref.title) ref.title = clip(notice.title, 200);
  return after;
}

/** Something a person or a bot did on a PR or issue, as GitHub reports it. */
export interface GitHubEvent {
  kind: "comment" | "review" | "merged";
  at: number;
  /** A review's verdict: APPROVED, CHANGES_REQUESTED, COMMENTED or DISMISSED. */
  state?: string;
  /** Missing when GitHub no longer knows who it was (a deleted account). */
  login?: string;
  bot: boolean;
}

const WEIGHT: Record<GitHubEvent["kind"], number> = { comment: 1, review: 2, merged: 3 };

/**
 * The news worth a bell among `events` after `after`: the merge, or a review or a new comment by
 * a person. Bots (CodeRabbit, CI) and the user's own actions never are, and edits are not events.
 * The reason names the weightiest of them; the time is the latest.
 */
export function newsAfter(events: readonly GitHubEvent[], after: number, viewer?: string): { at: number; reason: string } | undefined {
  const me = viewer?.toLowerCase();
  const news = events.filter(
    (event) => event.at > after && (event.kind === "merged" || !event.bot) && (me === undefined || event.login?.toLowerCase() !== me),
  );
  if (!news.length) return undefined;
  const main = news.reduce((best, event) =>
    WEIGHT[event.kind] > WEIGHT[best.kind] || (WEIGHT[event.kind] === WEIGHT[best.kind] && event.at > best.at) ? event : best,
  );
  const reason =
    main.kind !== "review"
      ? main.kind
      : main.state === "APPROVED"
        ? "approved"
        : main.state === "CHANGES_REQUESTED"
          ? "changes_requested"
          : "review";
  return { at: Math.max(...news.map((event) => event.at)), reason };
}

export function markSeen(index: RefIndex, key: string): boolean {
  const activity = index.refs[key]?.activity;
  if (!activity?.unseen) return false;
  activity.unseen = false;
  return true;
}

export function origin(ref: Ref): Mention | undefined {
  return ref.mentions.find((mention) => mention.turn > 0) ?? ref.mentions[0];
}

/** Marks as seen the news of everything that came from this conversation. */
export function markSeenForThread(index: RefIndex, threadId: string): string[] {
  const keys: string[] = [];
  for (const ref of Object.values(index.refs))
    if (ref.activity?.unseen && origin(ref)?.threadId === threadId && markSeen(index, ref.key)) keys.push(ref.key);
  return keys;
}

export function alerts(index: RefIndex): Ref[] {
  return Object.values(index.refs)
    .filter((ref) => ref.activity?.unseen)
    .sort((a, b) => (b.activity?.at ?? 0) - (a.activity?.at ?? 0));
}

export function refsForThread(index: RefIndex, threadId: string): Ref[] {
  return Object.values(index.refs)
    .filter((ref) => ref.mentions.some((mention) => mention.threadId === threadId))
    .sort((a, b) => Number(origin(b)?.threadId === threadId) - Number(origin(a)?.threadId === threadId) || b.lastMentionAt - a.lastMentionAt);
}

/** `42`, `#42`, `widgets#42`, a GitHub link, or words from the title or the request. */
export function searchRefs(index: RefIndex, query: string, titleOf: (threadId: string) => string | undefined = () => undefined): Ref[] {
  const text = query.trim();
  if (!text) return [];
  const all = Object.values(index.refs);
  const [link] = extractLinks(text);
  if (link) return all.filter((ref) => ref.key === link.key);
  // A repo name, when given, ends at "#": `widgets#42`, `owner/repo#42`.
  const numbered = /^(?:([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?)#)?#?(\d{1,9})$/u.exec(text.replace(/\s+/gu, ""));
  if (numbered) {
    const [, repo, digits] = numbered;
    const number = Number(digits);
    return all
      .filter((ref) => ref.number === number && (!repo || ref.repo.toLowerCase().endsWith(repo.toLowerCase())))
      .sort((a, b) => b.lastMentionAt - a.lastMentionAt)
      .slice(0, REF_LIMITS.results);
  }
  const words = text.toLowerCase().split(/\s+/u).filter(Boolean);
  const haystack = (ref: Ref) =>
    [ref.key, ref.title, ref.note?.text, ...ref.mentions.flatMap((mention) => [mention.prompt, titleOf(mention.threadId)])]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  return all
    .filter((ref) => words.every((word) => haystack(ref).includes(word)))
    .sort((a, b) => b.lastMentionAt - a.lastMentionAt)
    .slice(0, REF_LIMITS.results);
}

/** Keeps the index bounded: the refs that have not come up for the longest go first. */
export function pruneIndex(index: RefIndex): void {
  const all = Object.values(index.refs);
  if (all.length <= REF_LIMITS.refs) return;
  all.sort((a, b) => Math.max(a.lastMentionAt, a.activity?.at ?? 0) - Math.max(b.lastMentionAt, b.activity?.at ?? 0));
  for (const ref of all.slice(0, all.length - REF_LIMITS.refs)) delete index.refs[ref.key];
}

/** The last folder of a working folder, `/Users/me/work/site/` → `site`; either kind of slash. */
export function folderName(cwd: string): string {
  return cwd.split(/[\\/]+/u).filter(Boolean).at(-1) ?? "";
}

/**
 * Masks secrets in what the index keeps of what users said: the request next to each mention of a
 * PR or issue, and each conversation's first request. They are masked when they are recorded now;
 * indexes written before that kept them as said. Returns how many of each changed.
 */
export function maskIndexText(index: RefIndex): { requests: number; firstPrompts: number } {
  let requests = 0;
  let firstPrompts = 0;
  for (const ref of Object.values(index.refs))
    for (const mention of ref.mentions) {
      if (mention.prompt === undefined) continue;
      const masked = maskSecrets(mention.prompt);
      if (masked === mention.prompt) continue;
      mention.prompt = masked;
      requests += 1;
    }
  for (const record of Object.values(index.threads)) {
    if (record.firstPrompt === undefined) continue;
    const masked = maskSecrets(record.firstPrompt);
    if (masked === record.firstPrompt) continue;
    record.firstPrompt = masked;
    firstPrompts += 1;
  }
  return { requests, firstPrompts };
}

/**
 * Forgets the conversations a complete listing of codexhost no longer has (deleted or archived):
 * those that no PR or issue names and that `keep` does not hold on to (the backend keeps those
 * with a mainline, a last request or a saved passage). Returns how many went.
 */
export function pruneThreads(index: RefIndex, listed: ReadonlySet<string>, keep: ReadonlySet<string> = new Set()): number {
  const named = new Set<string>();
  for (const ref of Object.values(index.refs)) {
    for (const mention of ref.mentions) named.add(mention.threadId);
    if (ref.note) named.add(ref.note.threadId);
  }
  let pruned = 0;
  for (const threadId of Object.keys(index.threads))
    if (!listed.has(threadId) && !named.has(threadId) && !keep.has(threadId)) {
      delete index.threads[threadId];
      pruned += 1;
    }
  return pruned;
}

/**
 * What the views show of the index, in a stable order: every PR and issue with where it came up,
 * its title, state, note and news, and each conversation's title, project and first request. What
 * is only bookkeeping (when a conversation or a PR was last read, how far a scan got, how many
 * turns it has, the crawl and the GitHub poll times) is left out, so rewriting it changes nothing
 * here and no page loads its snapshot again for it.
 */
export function shownContent(index: RefIndex): unknown {
  const refs = Object.keys(index.refs)
    .sort()
    .map((key) => {
      const ref = index.refs[key]!;
      return [
        key,
        ref.repo,
        ref.number,
        ref.kind,
        ref.url,
        ref.title ?? null,
        ref.state ?? null,
        ref.mentions.map((mention) => [mention.threadId, mention.turn, mention.at, mention.role, mention.prompt ?? null]),
        ref.note ? [ref.note.text, ref.note.threadId] : null,
        ref.activity ? [ref.activity.at, ref.activity.reason, ref.activity.unseen] : null,
        ref.lastMentionAt,
      ];
    });
  const threads = Object.keys(index.threads)
    .sort()
    .map((threadId) => {
      const record = index.threads[threadId]!;
      return [threadId, record.title ?? null, record.cwd ? folderName(record.cwd) : null, record.firstPrompt ?? null];
    });
  return { refs, threads };
}

// ---------------------------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

function readMention(raw: unknown): Mention | undefined {
  if (!isRecord(raw) || typeof raw.threadId !== "string" || !isTime(raw.at)) return undefined;
  const turn = typeof raw.turn === "number" && Number.isInteger(raw.turn) && raw.turn >= 0 ? raw.turn : 0;
  return {
    threadId: raw.threadId,
    turn,
    at: raw.at,
    role: raw.role === "user" ? "user" : "agent",
    ...(typeof raw.prompt === "string" && raw.prompt ? { prompt: raw.prompt } : {}),
  };
}

function readRef(key: string, raw: unknown): Ref | undefined {
  if (!isRecord(raw) || typeof raw.repo !== "string" || typeof raw.number !== "number" || typeof raw.url !== "string") return undefined;
  if (key !== refKey(raw.repo, raw.number)) return undefined;
  const mentions = Array.isArray(raw.mentions) ? raw.mentions.flatMap((item) => readMention(item) ?? []) : [];
  const ref: Ref = {
    key,
    repo: raw.repo,
    number: raw.number,
    kind: raw.kind === "pr" ? "pr" : "issue",
    url: raw.url,
    mentions: mentions.sort(earlier).slice(0, REF_LIMITS.mentions),
    lastMentionAt: isTime(raw.lastMentionAt) ? raw.lastMentionAt : 0,
  };
  if (typeof raw.title === "string" && raw.title) ref.title = raw.title;
  if (raw.state === "open" || raw.state === "closed" || raw.state === "merged") ref.state = raw.state;
  if (isTime(raw.checkedAt)) ref.checkedAt = raw.checkedAt;
  if (isRecord(raw.note) && typeof raw.note.text === "string" && typeof raw.note.threadId === "string" && isTime(raw.note.at))
    ref.note = { text: raw.note.text, threadId: raw.note.threadId, at: raw.note.at };
  if (isRecord(raw.activity) && isTime(raw.activity.at) && typeof raw.activity.reason === "string")
    ref.activity = { at: raw.activity.at, reason: raw.activity.reason, unseen: raw.activity.unseen === true };
  if (isTime(raw.notifiedAt)) ref.notifiedAt = raw.notifiedAt;
  // Written before 0.5.4, the activity was the latest notification itself.
  else if (ref.activity) ref.notifiedAt = ref.activity.at;
  return ref;
}

export function normalizeIndex(raw: unknown): RefIndex {
  if (!isRecord(raw) || raw.version !== REFS_VERSION) throw new Error("Not a mainline refs file");
  const index = emptyIndex();
  index.rev = typeof raw.rev === "number" && Number.isSafeInteger(raw.rev) && raw.rev > 0 ? raw.rev : 0;
  if (isRecord(raw.refs))
    for (const [key, value] of Object.entries(raw.refs)) {
      const ref = readRef(key, value);
      if (ref) index.refs[key] = ref;
    }
  if (isRecord(raw.threads))
    for (const [threadId, value] of Object.entries(raw.threads)) {
      // A key like `__proto__` would change the object's prototype instead of adding a record.
      if (!isThreadId(threadId) || !isRecord(value) || typeof value.turns !== "number" || typeof value.updatedAt !== "string") continue;
      index.threads[threadId] = {
        turns: value.turns,
        updatedAt: value.updatedAt,
        scannedAt: isTime(value.scannedAt) ? value.scannedAt : 0,
        ...(typeof value.title === "string" && value.title ? { title: value.title } : {}),
        ...(value.unreadable === true ? { unreadable: true } : {}),
        ...(typeof value.cwd === "string" && value.cwd ? { cwd: value.cwd } : {}),
        ...(typeof value.firstPrompt === "string" && value.firstPrompt ? { firstPrompt: value.firstPrompt } : {}),
        ...(typeof value.harnessId === "string" && value.harnessId ? { harnessId: value.harnessId.slice(0, 64) } : {}),
      };
    }
  if (isRecord(raw.crawl))
    index.crawl = {
      done: raw.crawl.done === true,
      listed: typeof raw.crawl.listed === "number" ? raw.crawl.listed : 0,
      ...(typeof raw.crawl.cursor === "string" ? { cursor: raw.crawl.cursor } : {}),
      ...(isTime(raw.crawl.startedAt) ? { startedAt: raw.crawl.startedAt } : {}),
      ...(isTime(raw.crawl.finishedAt) ? { finishedAt: raw.crawl.finishedAt } : {}),
    };
  if (isRecord(raw.github))
    index.github = {
      ...(isTime(raw.github.baselineAt) ? { baselineAt: raw.github.baselineAt } : {}),
      ...(isTime(raw.github.lastPollAt) ? { lastPollAt: raw.github.lastPollAt } : {}),
      ...(typeof raw.github.error === "string" ? { error: raw.github.error } : {}),
    };
  return index;
}

// ---------------------------------------------------------------------------------------------
// What the browser gets: small, flat and ready to show.

export interface RefView {
  key: string;
  repo: string;
  number: number;
  kind: RefKind;
  url: string;
  title?: string;
  state?: RefState;
  origin?: { threadId: string; title?: string; turn: number; prompt?: string };
  windows: number;
  note?: string;
  activity?: { at: number; reason: string; unseen: boolean };
  lastMentionAt: number;
}

export function refView(index: RefIndex, ref: Ref, titleOf: (threadId: string) => string | undefined): RefView {
  const first = origin(ref);
  const title = first ? (titleOf(first.threadId) ?? index.threads[first.threadId]?.title) : undefined;
  return {
    key: ref.key,
    repo: ref.repo,
    number: ref.number,
    kind: ref.kind,
    url: ref.url,
    windows: new Set(ref.mentions.map((mention) => mention.threadId)).size,
    lastMentionAt: ref.lastMentionAt,
    ...(ref.title ? { title: ref.title } : {}),
    ...(ref.state ? { state: ref.state } : {}),
    ...(first
      ? { origin: { threadId: first.threadId, turn: first.turn, ...(title ? { title } : {}), ...(first.prompt ? { prompt: first.prompt } : {}) } }
      : {}),
    ...(ref.note ? { note: ref.note.text } : {}),
    ...(ref.activity ? { activity: ref.activity } : {}),
  };
}
