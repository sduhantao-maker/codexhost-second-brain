/**
 * Watches GitHub for news on indexed PRs and issues through the user's own `gh` login. Only read
 * calls are made: notifications are listed, never marked as read.
 *
 * When it last asked is kept apart from the index, in `github-poll.json`: it changes every few
 * minutes and no page shows it but the PR tab, so the index is not rewritten for it.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { applyActivity, linkFromApiUrl, newsAfter, noteNotified, type Ref } from "../core/refs.js";
import { createGhRunner, findGh, type RunGh } from "../node/gh.js";
import { FRESH_MS, freshenRefs, lookUpNews, lookUpRef, type RefFacts, type RefNews } from "../node/refs-github.js";
import { readIndex, updateIndex, type RefsPaths } from "../node/refs-store.js";
import { writeJsonFile } from "../node/store.js";

export { createGhRunner, findGh, type RunGh };
import type { Log } from "./log.js";

/** Where the time of the last poll is kept. */
export const POLL_FILE = "github-poll.json";

const DAY = 24 * 60 * 60 * 1000;
const OPEN_RECHECK_MS = 30 * 60 * 1000;
const CLOSED_RECHECK_MS = DAY;
const LOOKUPS_PER_ROUND = 20;
/** PRs looked into at the same time when GitHub has news on several. */
export const LOOKS_AT_ONCE = 4;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A GitHub notification about a PR or issue. */
interface Notice {
  key: string;
  /** When the notification was last updated: any activity moves it, a bot editing its comment too. */
  at: number;
  /** Why GitHub notifies the user about it: `author`, `comment`, `mention`… */
  reason: string;
  title?: string;
  unread: boolean;
  lastReadAt?: number;
}

function readNotice(item: unknown): Notice | undefined {
  if (!isRecord(item) || !isRecord(item.subject) || typeof item.subject.url !== "string") return undefined;
  const link = linkFromApiUrl(item.subject.url, typeof item.subject.type === "string" ? item.subject.type : undefined);
  const at = Date.parse(typeof item.updated_at === "string" ? item.updated_at : "");
  if (!link || !Number.isFinite(at)) return undefined;
  const lastReadAt = Date.parse(typeof item.last_read_at === "string" ? item.last_read_at : "");
  return {
    key: link.key,
    at,
    reason: typeof item.reason === "string" ? item.reason : "activity",
    unread: item.unread === true,
    ...(typeof item.subject.title === "string" ? { title: item.subject.title } : {}),
    ...(Number.isFinite(lastReadAt) ? { lastReadAt } : {}),
  };
}

/** Runs `task` on every item, at most `limit` at a time; the results keep the items' order. */
async function inTurns<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const at = next++;
      results[at] = await task(items[at]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export class GitHubWatcher {
  /** When the last poll that went through was, once read from its file. */
  #lastPollAt: number | undefined;
  #pollTimeRead = false;
  /** The file has the time: the copy the index kept before can go. */
  #pollFileWritten = false;

  constructor(
    private readonly paths: RefsPaths,
    private readonly log: Log,
    private readonly runGh: RunGh,
    private readonly now: () => number = Date.now,
    /** Aborts when the backend stops: lookups cut off by it change nothing on record. */
    private readonly stopping?: AbortSignal,
  ) {}

  /** When GitHub was last asked successfully; the index has it from versions that kept it there. */
  async lastPollAt(): Promise<number | undefined> {
    if (!this.#pollTimeRead) {
      try {
        const raw = JSON.parse(await readFile(path.join(this.paths.dir, POLL_FILE), "utf8")) as { lastPollAt?: unknown };
        if (typeof raw.lastPollAt === "number" && Number.isFinite(raw.lastPollAt) && raw.lastPollAt >= 0) {
          this.#lastPollAt = raw.lastPollAt;
          this.#pollFileWritten = true;
        }
      } catch {
        // Not written yet.
      }
      this.#lastPollAt ??= (await readIndex(this.paths)).github.lastPollAt;
      this.#pollTimeRead = true;
    }
    return this.#lastPollAt;
  }

  /**
   * Lists notifications since the last poll and rings for news on indexed PRs and issues: a
   * review, a merge or a new comment by a person. GitHub notifies about any activity, a bot
   * editing its own comment or CI too, so what happened is looked up before anything rings.
   */
  async poll(): Promise<number> {
    const lastPollAt = await this.lastPollAt();
    const index = await readIndex(this.paths);
    const first = index.github.baselineAt === undefined;
    const since = (lastPollAt ?? this.now() - 3 * DAY) - 5 * 60_000;
    let notifications: unknown;
    try {
      notifications = JSON.parse(
        await this.runGh([
          "api",
          "-X",
          "GET",
          "notifications",
          "-f",
          "all=true",
          "-f",
          `since=${new Date(since).toISOString()}`,
          "-f",
          "per_page=50",
        ]),
      );
    } catch (error) {
      // Cut off by the backend stopping: that is no trouble with GitHub.
      if (this.stopping?.aborted) return 0;
      const message = error instanceof Error ? error.message : String(error);
      await updateIndex(this.paths, (draft) => {
        draft.github.error = message;
      });
      this.log.error("read GitHub notifications", error);
      return 0;
    }
    // The latest notification on each indexed PR or issue that has not been looked into yet.
    const notices = new Map<string, Notice>();
    for (const item of Array.isArray(notifications) ? notifications : []) {
      const notice = readNotice(item);
      const ref = notice ? index.refs[notice.key] : undefined;
      if (!notice || !ref || (ref.notifiedAt !== undefined && notice.at <= ref.notifiedAt)) continue;
      if ((notices.get(notice.key)?.at ?? -Infinity) < notice.at) notices.set(notice.key, notice);
    }
    // The first poll only looks into what is still unread on GitHub; the rest is the baseline.
    // Looking up also brings the state (closed, merged) right away instead of at the next round.
    const toLook = [...notices.values()].filter((notice) => !first || notice.unread).sort((a, b) => b.at - a.at);
    const found = await inTurns(toLook, LOOKS_AT_ONCE, (notice) => lookUpNews(this.runGh, index.refs[notice.key]!));
    if (this.stopping?.aborted) return 0;
    const looked = new Map<string, RefNews | undefined>(toLook.map((notice, i) => [notice.key, found[i]]));
    const now = this.now();
    const quiet: string[] = [];
    const unknown: string[] = [];
    const { result: alerts } = await updateIndex(this.paths, (draft) => {
      let count = 0;
      for (const notice of notices.values()) {
        // With no earlier notification to go by, news is what came after the last poll, or on the
        // first poll after it was last read on GitHub.
        const after = noteNotified(draft, notice.key, notice, first ? (notice.lastReadAt ?? since) : since);
        const ref = draft.refs[notice.key];
        if (after === undefined || !ref || !looked.has(notice.key)) continue;
        const news = looked.get(notice.key);
        if (!news) {
          // What happened could not be looked up: ring as before rather than miss a reply.
          unknown.push(notice.key);
          if (applyActivity(draft, notice.key, { at: notice.at, reason: notice.reason }, true)) count += 1;
          continue;
        }
        if (news.facts.title) ref.title = news.facts.title.slice(0, 200);
        if (news.facts.state) {
          ref.state = news.facts.state;
          ref.checkedAt = now;
        }
        const worth = newsAfter(news.events, after, news.viewer);
        if (!worth) quiet.push(notice.key);
        else if (applyActivity(draft, notice.key, worth, true)) count += 1;
      }
      if (this.#pollFileWritten) delete draft.github.lastPollAt;
      draft.github.baselineAt ??= now;
      delete draft.github.error;
      return count;
    });
    // Saved once what it found is saved, so a poll that could not save is asked again.
    this.#lastPollAt = now;
    try {
      await writeJsonFile(path.join(this.paths.dir, POLL_FILE), { lastPollAt: now }, 4096);
      this.#pollFileWritten = true;
    } catch (error) {
      this.log.error("save when GitHub was asked", error);
    }
    if (alerts) this.log.info(`GitHub news on indexed PRs and issues: ${alerts}`);
    if (quiet.length) this.log.info(`GitHub activity with no review, merge or comment by a person, no bell: ${quiet.join(", ")}`);
    if (unknown.length) {
      this.log.info(`GitHub activity that could not be looked up, rung anyway: ${unknown.join(", ")}`);
      // Their state may still have changed: try the plain lookup.
      await this.freshen(unknown, { maxAgeMs: 0 });
    }
    return alerts;
  }

  /** Fills in titles and states, a few per round. */
  async enrich(): Promise<void> {
    const index = await readIndex(this.paths);
    const now = this.now();
    const lastCheck = (ref: Ref) => Math.max(ref.state ? ref.checkedAt ?? 0 : 0, this.#checked.get(ref.key) ?? 0);
    const due = Object.values(index.refs)
      .filter((ref) => {
        // A lookup when it was looked at counts too, also one the index was not rewritten for.
        const last = lastCheck(ref);
        if (!last) return true;
        const closed = ref.state === "closed" || ref.state === "merged";
        return now - last > (!ref.state ? FRESH_MS : closed ? CLOSED_RECHECK_MS : OPEN_RECHECK_MS);
      })
      .sort((a, b) => lastCheck(a) - lastCheck(b) || b.lastMentionAt - a.lastMentionAt)
      .slice(0, LOOKUPS_PER_ROUND);
    if (!due.length) return;
    const found = new Map<string, RefFacts>();
    for (const ref of due) found.set(ref.key, await lookUpRef(this.runGh, ref));
    if (this.stopping?.aborted) return;
    await updateIndex(this.paths, (draft) => {
      for (const [key, facts] of found) {
        const ref = draft.refs[key];
        if (!ref || !facts.state) continue;
        ref.checkedAt = now;
        if (facts.title) ref.title = facts.title.slice(0, 200);
        ref.state = facts.state;
      }
    });
    for (const key of found.keys()) this.#checked.set(key, now);
  }

  readonly #freshening = new Map<string, Promise<number>>();
  /** When each PR or issue was last looked up for someone looking at it, also when the index was not rewritten for it. */
  readonly #checked = new Map<string, number>();

  /**
   * Looks up the PRs and issues someone is looking at right now, when what is known of them is
   * older than a minute; the 30-minute rounds keep the rest current. Returns how many it asked.
   * An answer that changes nothing rewrites the index at most every ten minutes.
   */
  async freshen(keys: readonly string[], options: { maxAgeMs?: number; limit?: number } = {}): Promise<number> {
    const pending = new Set<Promise<number>>();
    const wanted: string[] = [];
    for (const key of new Set(keys)) {
      const running = this.#freshening.get(key);
      if (running) pending.add(running);
      else wanted.push(key);
    }
    if (wanted.length) {
      const work = freshenRefs(this.paths, wanted, this.runGh, { now: this.now(), checked: this.#checked, ...options }).finally(() => {
        for (const key of wanted) this.#freshening.delete(key);
      });
      for (const key of wanted) this.#freshening.set(key, work);
      pending.add(work);
    }
    return (await Promise.all(pending)).reduce((sum, count) => sum + count, 0);
  }
}
