/**
 * Reads conversations through codexhost's local API and indexes the GitHub PR and issue links
 * in them. The first pass lists every conversation (a few cheap pages), then reads them most
 * recent first; after that only recently updated ones are read, from the turn where the last
 * pass stopped. Requests go one at a time with a pause, and a failed read is retried later.
 *
 * A read that found nothing a page shows (no new link, the same title, project and first
 * request) only moved how far the conversation was read. Such records are held and written
 * together once a round is over, at the latest after a minute, instead of rewriting the index
 * for every conversation read. Every complete listing forgets the conversations codexhost no
 * longer has, unless a PR or issue names them or the backend keeps them.
 */
import { requestOf } from "../core/model.js";
import { addMention, extractLinks, folderName, pruneThreads, type Link, type Mention, type RefIndex, type ScanRecord } from "../core/refs.js";
import { readIndex, updateIndex, type RefsPaths } from "../node/refs-store.js";
import { HttpError, type ApiTurn, type ExternalApi, type ListedThread } from "./external-api.js";
import type { Log } from "./log.js";

const LIST_PAGE = 100;
const RECENT_PAGE = 50;
const CHUNK = 50;
const PAUSE_MS = 250;
const RETRY_MS = 30_000;
const ATTEMPTS = 3;
/** A full listing catches conversations an earlier pass missed; it costs a few list calls. */
const FULL_PASS_EVERY_MS = 6 * 60 * 60 * 1000;
/** Records only saying how far a conversation was read wait at most this long, or this many. */
const HOLD_MS = 60_000;
const HOLD_MAX = 50;

export interface ScannerOptions {
  /** How often to look at recently updated conversations once the first pass is done. */
  recentEveryMs(): number;
  /** Conversations to keep in the index even when codexhost no longer lists them. */
  keep?(): Iterable<string> | Promise<Iterable<string>>;
  now?(): number;
  pauseMs?: number;
}

type Queued = ListedThread & { attempts: number };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A turn still in progress gets read again next time, so its final reply is not missed. */
const unfinished = (turn: ApiTurn | undefined) => Boolean(turn && /run|progress|pending|queue/iu.test(turn.status));

/** Whether two records of a conversation look the same on every page. */
const sameShown = (a: ScanRecord, b: ScanRecord) =>
  !a.unreadable && a.title === b.title && (a.cwd ? folderName(a.cwd) : undefined) === b.cwd && a.firstPrompt === b.firstPrompt;

export class Scanner {
  readonly #queue: Queued[] = [];
  readonly #queued = new Set<string>();
  /** Records of conversations read since the last write that only moved how far they were read. */
  readonly #held = new Map<string, ScanRecord>();
  #heldSince = 0;
  /** True while a full pass still has conversations to read. */
  #crawling = false;
  /** When this process last listed every conversation; every start does one pass. */
  #fullPassAt = 0;
  #lastRecentAt = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #started = false;
  #stopped = false;
  #busy = false;

  constructor(
    private readonly api: ExternalApi,
    private readonly paths: RefsPaths,
    private readonly log: Log,
    private readonly options: ScannerOptions,
  ) {}

  #now(): number {
    return this.options.now?.() ?? Date.now();
  }

  #pause(): number {
    return this.options.pauseMs ?? PAUSE_MS;
  }

  start(delay = 1000): void {
    this.#started = true;
    this.#stopped = false;
    this.#schedule(delay);
  }

  /** Stops, and writes what is held. */
  stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#timer);
    return this.#held.size ? this.#write().then(() => undefined, (error: unknown) => this.log.error("save how far conversations were read", error)) : Promise.resolve();
  }

  /** Asks for the recently updated conversations on the next round. */
  refreshSoon(): void {
    this.#lastRecentAt = 0;
    if (!this.#busy && !this.#queue.length) this.#schedule(500);
  }

  /** Only a started scanner runs by itself; tests call tick() directly. */
  #schedule(delay: number): void {
    clearTimeout(this.#timer);
    if (!this.#started || this.#stopped) return;
    this.#timer = setTimeout(() => void this.tick(), delay);
    this.#timer.unref?.();
  }

  /** One unit of work. Public so tests can drive it step by step; returns the delay to the next. */
  async tick(): Promise<number> {
    if (this.#busy || this.#stopped) return this.#pause();
    this.#busy = true;
    let delay = this.#pause();
    try {
      // A round is over, or what is held has waited long enough: write it.
      if (this.#held.size && (!this.#queue.length || this.#held.size >= HOLD_MAX || this.#now() - this.#heldSince >= HOLD_MS)) await this.#write();
      const thread = this.#queue.shift();
      if (thread) {
        this.#queued.delete(thread.threadId);
        try {
          await this.#scan(thread);
        } catch (error) {
          // codexhost answering 4xx is not going to change soon; anything else may be a slow moment.
          const refused = error instanceof HttpError && error.status >= 400 && error.status < 500;
          if (thread.attempts + 1 < ATTEMPTS) this.#push({ ...thread, attempts: thread.attempts + 1 });
          else if (refused) await this.#markUnreadable(thread);
          else this.log.error(`skip conversation ${thread.threadId.slice(0, 8)} after ${ATTEMPTS} attempts`, error);
          delay = Math.max(delay, refused ? 500 : 2000);
        }
      } else if (this.#crawling) {
        this.#crawling = false;
        const now = this.#now();
        await this.#write((draft) => {
          draft.crawl.done = true;
          draft.crawl.finishedAt = now;
        });
        this.log.info("finished reading every conversation for PR and issue links");
      } else {
        const index = await readIndex(this.paths);
        const now = this.#now();
        const sinceRecent = now - this.#lastRecentAt;
        if (!this.#fullPassAt || now - this.#fullPassAt >= FULL_PASS_EVERY_MS) await this.#listAll(index);
        else if (sinceRecent >= this.options.recentEveryMs()) await this.#listRecent(index);
        else delay = Math.max(1000, this.options.recentEveryMs() - sinceRecent);
      }
    } catch (error) {
      this.log.error("scan conversations", error);
      delay = RETRY_MS;
    } finally {
      this.#busy = false;
      this.#schedule(delay);
    }
    return delay;
  }

  #push(thread: Queued): void {
    if (this.#queued.has(thread.threadId)) return;
    this.#queued.add(thread.threadId);
    this.#queue.push(thread);
  }

  /** What is known of a conversation: a held record is newer than the one in the file. */
  #known(index: RefIndex, threadId: string): ScanRecord | undefined {
    return this.#held.get(threadId) ?? index.threads[threadId];
  }

  #enqueue(threads: readonly ListedThread[], index: RefIndex): void {
    for (const thread of threads)
      if (this.#known(index, thread.threadId)?.updatedAt !== thread.updatedAt) this.#push({ ...thread, attempts: 0 });
  }

  /**
   * Writes the held records, with `mutate`'s change when there is one. Held records are let go
   * only once written; one held again meanwhile stays for the next write.
   */
  async #write(mutate?: (draft: RefIndex) => void): Promise<void> {
    const held = [...this.#held];
    await updateIndex(this.paths, (draft) => {
      for (const [threadId, record] of held) draft.threads[threadId] = record;
      mutate?.(draft);
    });
    for (const [threadId, record] of held) if (this.#held.get(threadId) === record) this.#held.delete(threadId);
    if (!this.#held.size) this.#heldSince = 0;
  }

  /** Lists every conversation, most recently updated first; already read ones are skipped. */
  async #listAll(index: RefIndex): Promise<void> {
    // Conversations updated while paging move to the front and show up twice; keep each once.
    const byId = new Map<string, ListedThread>();
    let cursor: string | undefined;
    do {
      const page = await this.api.listThreads({ limit: LIST_PAGE, ...(cursor ? { cursor } : {}) });
      for (const thread of page.threads) if (!byId.has(thread.threadId)) byId.set(thread.threadId, thread);
      cursor = page.nextCursor ?? undefined;
      if (cursor) await sleep(this.#pause());
    } while (cursor);
    const all = [...byId.values()];
    this.#enqueue(all, index);
    const now = this.#now();
    this.#fullPassAt = now;
    this.#crawling = true;
    let keep: Set<string> | undefined;
    try {
      keep = new Set((await this.options.keep?.()) ?? []);
    } catch (error) {
      this.log.error("find the conversations to keep in the index", error);
    }
    let pruned = 0;
    let doubted: number | undefined;
    await this.#write((draft) => {
      draft.crawl.startedAt ??= now;
      const before = draft.crawl.listed;
      draft.crawl.listed = all.length;
      // Projects and agents of conversations read before they were recorded: the listing has them anyway.
      for (const thread of all) {
        const record = draft.threads[thread.threadId];
        const cwd = thread.cwd ? folderName(thread.cwd) : "";
        if (record && !record.cwd && cwd) record.cwd = cwd;
        if (record && thread.harnessId && record.harnessId !== thread.harnessId) record.harnessId = thread.harnessId;
      }
      // Status reads "reading" while a pass has work queued.
      if (this.#queue.length) draft.crawl.done = false;
      // A listing far shorter than the last one may have missed a whole source: forget nothing on its word.
      if (!keep) return;
      if (all.length && all.length * 2 >= before) pruned = pruneThreads(draft, new Set(byId.keys()), keep);
      else if (Object.keys(draft.threads).length) doubted = before;
    });
    if (pruned) this.log.info(`forgot ${pruned} conversations codexhost no longer lists`);
    if (doubted !== undefined) this.log.info(`kept every conversation: codexhost listed ${all.length}, the last full listing ${doubted}`);
  }

  async #listRecent(index: RefIndex): Promise<void> {
    this.#lastRecentAt = this.#now();
    const page = await this.api.listThreads({ limit: RECENT_PAGE });
    this.#enqueue(page.threads, index);
  }

  /** Remembers a conversation codexhost cannot read, until it changes. */
  async #markUnreadable(thread: ListedThread): Promise<void> {
    const now = this.#now();
    await this.#write((draft) => {
      draft.threads[thread.threadId] = {
        turns: draft.threads[thread.threadId]?.turns ?? 0,
        updatedAt: thread.updatedAt,
        scannedAt: now,
        unreadable: true,
        ...(thread.title ? { title: thread.title } : {}),
      };
    });
  }

  async #scan(thread: ListedThread): Promise<void> {
    const known = this.#known(await readIndex(this.paths), thread.threadId);
    const from = (known?.turns ?? 0) + 1;
    const latest = await this.api.readTurns(thread.threadId);
    const total = latest.totalTurns;
    const turns = new Map<number, ApiTurn>(latest.turns.map((turn) => [turn.turnNumber, turn]));
    const lowest = latest.turns.reduce((min, turn) => Math.min(min, turn.turnNumber), total + 1);
    for (let start = from; start < lowest; start += CHUNK) {
      await sleep(this.#pause());
      const end = Math.min(start + CHUNK - 1, lowest - 1);
      for (const turn of (await this.api.readTurns(thread.threadId, { from: start, to: end })).turns) turns.set(turn.turnNumber, turn);
    }
    const scanned = unfinished(turns.get(total)) ? total - 1 : total;
    const now = this.#now();
    // A first read dates mentions by the conversation's start, so the window that came first wins.
    const base = known ? now : Date.parse(thread.createdAt ?? thread.updatedAt) || now;
    const found: Array<{ link: Link; mention: Mention }> = [];
    for (const number of [...turns.keys()].sort((a, b) => a - b)) {
      if (number < from) continue;
      const turn = turns.get(number)!;
      const prompt = turn.messages
        .filter((message) => message.role === "user")
        .map((message) => requestOf(message.text))
        .join(" ");
      for (const message of turn.messages)
        for (const link of extractLinks(message.text))
          found.push({ link, mention: { threadId: thread.threadId, turn: number, at: base + number, role: message.role, ...(prompt ? { prompt } : {}) } });
    }
    const first = turns.get(1);
    const firstPrompt = first
      ? first.messages
          .filter((message) => message.role === "user")
          .map((message) => requestOf(message.text))
          .join(" ")
          .replace(/\s+/gu, " ")
          .trim()
      : "";
    const keptFirst = known?.firstPrompt ?? (firstPrompt ? Array.from(firstPrompt).slice(0, 200).join("") : undefined);
    const cwd = thread.cwd ? folderName(thread.cwd) : known?.cwd ? folderName(known.cwd) : "";
    const harnessId = thread.harnessId ?? known?.harnessId;
    const record: ScanRecord = {
      turns: Math.max(scanned, known?.turns ?? 0, 0),
      updatedAt: thread.updatedAt,
      scannedAt: now,
      ...(thread.title ? { title: thread.title } : {}),
      ...(cwd ? { cwd } : {}),
      ...(keptFirst ? { firstPrompt: keptFirst } : {}),
      ...(harnessId ? { harnessId } : {}),
    };
    let quiet = false;
    const held = [...this.#held];
    await updateIndex(this.paths, (draft) => {
      let changed = false;
      for (const { link, mention } of found) changed = addMention(draft, link, mention) || changed;
      const before = this.#held.get(thread.threadId) ?? draft.threads[thread.threadId];
      // Nothing a page shows: hold the record, and leave the file as it is.
      if (!changed && before && sameShown(before, record)) {
        quiet = true;
        return;
      }
      for (const [threadId, value] of held) draft.threads[threadId] = value;
      draft.threads[thread.threadId] = record;
    });
    if (quiet) {
      this.#held.set(thread.threadId, record);
      this.#heldSince ||= now;
      return;
    }
    for (const [threadId, value] of held) if (this.#held.get(threadId) === value) this.#held.delete(threadId);
    this.#held.delete(thread.threadId);
    if (!this.#held.size) this.#heldSince = 0;
  }
}
