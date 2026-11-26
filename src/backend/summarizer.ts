/**
 * Keeps mainlines up to date with a model. A conversation is summarized when a turn of it has
 * ended (it has been quiet for a minute and changed since its last summary) and automatic
 * summaries are on, when the user asks, and once for every older conversation when the user starts
 * a backfill, which can be stopped. Claude Code and Codex conversations go to the model the
 * settings name for them; other agents' conversations only when a model is set for those. Every
 * call is counted on disk, so the daily limit on automatic ones survives restarts, and logged in
 * one line without any conversation text. The model writes the title, tags and milestones;
 * applySummary leaves alone what the user fixed by hand, and a deleted mainline stays deleted.
 *
 * A summary that failed is tried again automatically after 30 minutes, then twice as long each
 * time up to 8 hours; at once when the conversation has a new turn or the user asks. A backfill
 * sends every conversation at most once (what it tried is kept on disk, so a restart does not send
 * any again), and gives no conversation a new mainline once the state holds as many as it keeps.
 * No call is spent on a conversation without a mainline when there is no room for one
 * (`hasRoomForMainline`); a summary refused for room after all (STATE_FULL) waits the longest.
 *
 * A conversation on another computer (a remote host paired with codexhost Web) is read on that host
 * and summarized here like a local one: its host's latest list stands beside this machine's when
 * finished turns are looked for, and the backfill takes it from the link index. While its host
 * cannot be reached nothing is read or sent; and at most one of the workers is on such a
 * conversation at a time, so a slow host never holds up the summaries of this machine.
 */
import path from "node:path";
import type { StateV2 } from "../core/conversation.js";
import { applySummary, hasRoomForMainline, includeInSummaries, isExcluded, MAX_CONVERSATIONS, noteHosts, type SummaryInput } from "../core/conversation-ops.js";
import { shortHost } from "../core/hosts.js";
import { MainlineError, requestOf, summaryEngineFor, type Settings } from "../core/model.js";
import type { RefIndex } from "../core/refs.js";
import type { SummarizerStatus } from "../core/rpc.js";
import { readSummary, SUMMARY_SCHEMA, SUMMARY_SYSTEM, summaryPrompt, type SummaryTurn } from "../core/summary-prompt.js";
import { updateState, type StorePaths } from "../node/store.js";
import {
  autoCalls,
  countSummaryCall,
  dayKey,
  dayOf,
  emptyCounts,
  readSummaryCounts,
  summaryCountsPaths,
  uncountSummaryCall,
  type CountsPaths,
  type SummaryCounts,
} from "../node/summary-counts.js";
import { BackfillTried } from "./backfill-tried.js";
import { within } from "./deadline.js";
import type { ExternalApi, ListedThread } from "./external-api.js";
import type { Log } from "./log.js";
import { ModelNotSentError, type Engine, type RunModel } from "./models.js";

/**
 * How many mainlines the state keeps (`MAX_CONVERSATIONS`): past it, every write removes mainlines
 * nobody edited and with no work open, and refuses a new one when none can go. A backfill gives no
 * conversation a new mainline beyond it, so it never makes the cap remove one.
 */
export function recordCap(): number {
  return MAX_CONVERSATIONS;
}

/** A conversation counts as between turns after this long without changes. */
export const QUIET_MS = 60_000;
/** The same conversation is summarized again automatically at most this often. */
export const AGAIN_AFTER_MS = 10 * 60_000;
/** Automatic summaries per day, counted on disk so restarts do not reset it. Asked-for ones and the backfill are counted, not limited. */
export const DAILY_LIMIT = 200;
const POLL_MS = 60_000;
const WORKERS = 2;
/** Of those, at most this many on conversations of other computers at once. */
const REMOTE_WORKERS = 1;
/** A conversation whose summary failed is tried again automatically after this long, then twice as long each time, up to the cap. */
export const RETRY_FIRST_MS = 30 * 60_000;
export const RETRY_CAP_MS = 8 * 60 * 60_000;
/** Failed conversations remembered for their next try. */
const FAILURES_KEPT = 5000;
/** How long a round waits for codexhost's list of recent conversations, and a request for its read of one: callers wait on both. */
const LIST_WAIT_MS = 4_000;
const READ_WAIT_MS = 4_000;
const TURNS_READ = 40;
/** Turns asked for per request: long ones in one go can outlast codexhost's answer time. */
const TURNS_PER_READ = 20;
/** Agents of conversations remembered, so those no model is set for are not looked up every round. */
const AGENTS_KEPT = 5000;

export type SummaryReason = "manual" | "auto" | "backfill";

/** Conversations on other computers: where each runs, whether its host can be reached, and what each host listed last. */
export interface SummarizerRemote {
  hostOf(threadId: string): string | undefined;
  down(hostId: string): boolean;
  /** The latest list of every host that can be reached, each entry naming its host. */
  listed(): ListedThread[];
}

export interface SummarizerDeps {
  api: Pick<ExternalApi, "readThread" | "readTurns" | "listThreads">;
  /** How many mainlines the state keeps (tests make it small); recordCap() by default. */
  cap?: number;
  runModel: RunModel;
  paths: StorePaths;
  log: Log;
  state(): Promise<StateV2>;
  index(): Promise<RefIndex>;
  settings(): Promise<Settings>;
  /** Called after a summary changed the state. */
  changed(): void;
  remote?: SummarizerRemote;
  now?(): number;
}

interface Job {
  threadId: string;
  reason: SummaryReason;
  /** The conversation's update time as listed, when known. */
  updatedAt?: string;
  /** For the backfill: when the backfill that put it in line was asked for. */
  requestedAt?: number;
  /** The remote host it runs on, when it is on another computer. */
  hostId?: string;
}

/** A conversation the backfill will send: newest first, with its update time and, when remote, its host. */
interface Pending {
  threadId: string;
  updatedAt: string;
  hostId?: string;
}

/** Where the older conversations stand for a backfill. */
interface BackfillPlan {
  total: number;
  done: number;
  /** Tried by this backfill without a summary to show for it, or failed lately and not due again yet. */
  failed: number;
  /** Conversations of other agents, left out as the settings say. */
  skipped: number;
  /** Conversations without a mainline left out because the state keeps no more (not in `total`). */
  full: number;
  /** Still to summarize, newest first: what will really be sent. */
  pending: Pending[];
}

/** A summary that failed, and when the conversation is tried again automatically. */
interface Failure {
  count: number;
  retryAt: number;
  /** The conversation's update time the failed try was for: a new turn changes it. */
  updatedAt?: string;
}

const PRIORITY: Record<SummaryReason, number> = { manual: 0, auto: 1, backfill: 2 };

const ms = (iso: string | undefined) => {
  const value = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(value) ? value : undefined;
};

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** What the overview can say of an error in its language: its code, or why a model call sent nothing. */
const codeOf = (error: unknown): string | undefined =>
  error instanceof MainlineError ? error.code : error instanceof ModelNotSentError ? error.problem : undefined;

/** A summary of a conversation without a mainline, when none can be added. */
function stateFull(): MainlineError {
  return new MainlineError(
    "STATE_FULL",
    `At most ${MAX_CONVERSATIONS} mainlines are kept and none of the others can make room for this one; delete mainlines you no longer need in the overview`,
  );
}

const has = (state: StateV2, threadId: string) => Object.hasOwn(state.conversations, threadId);

function noSummarizer(harnessId: string | undefined): MainlineError {
  const agent = harnessId ? `the agent "${harnessId}"` : "an agent codexhost did not name";
  return new MainlineError(
    "NO_SUMMARIZER",
    `This conversation runs on ${agent}, not Claude Code or Codex, and the setting for other agents' conversations (summarizeOthers) is "none": it is not sent to a model`,
  );
}

export class Summarizer {
  readonly #deps: SummarizerDeps;
  readonly #counted: CountsPaths;
  readonly #queue: Job[] = [];
  /** Conversations being summarized now, and why. */
  readonly #running = new Map<string, SummaryReason>();
  /** Those of them on other computers. */
  readonly #runningRemote = new Set<string>();
  readonly #failures = new Map<string, Failure>();
  /** What the backfill under way has tried, on disk. */
  readonly #tried: BackfillTried;
  readonly #cap: number;
  /** The agent of each conversation read so far (codexhost's harness id; "" when it named none). */
  readonly #agents = new Map<string, string>();
  /** Errors the log already has, with the line of their call. */
  readonly #logged = new WeakSet<object>();
  readonly #startedAt: number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;
  /** Calls counted on disk, as last read or written. */
  #counts: SummaryCounts = emptyCounts();
  #autoOn = true;
  /** Why the last summary failed: in English, and as a code the overview says in its language. */
  #lastError: { text: string; code?: string } | undefined;
  #backfill: Omit<BackfillPlan, "pending"> | undefined;
  #toBackfill: number | undefined;
  /** The backfill request the log has already mentioned. */
  #backfillSeen: number | undefined;
  /** Goes up when a backfill is started or stopped, so a round that read the state before leaves it alone. */
  #backfillRound = 0;
  /** The day the log last said today's automatic summaries were used up. */
  #limitNoted = "";
  /** The day the log last said conversations without a mainline wait for room. */
  #fullNoted = "";
  /** Rounds under way, which stopping waits for. */
  readonly #ticks = new Set<Promise<void>>();

  constructor(deps: SummarizerDeps) {
    this.#deps = deps;
    this.#counted = summaryCountsPaths(deps.paths.dir);
    this.#tried = new BackfillTried(deps.paths.dir);
    this.#cap = deps.cap ?? recordCap();
    this.#startedAt = this.#now();
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  start(): void {
    this.#stopped = false;
    this.#schedule(5_000);
  }

  /**
   * Stops: nothing new starts. Resolves once the rounds under way have written what they found (one
   * starts when a call of the backfill ends); calls to a model are not waited for.
   */
  stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#timer);
    return Promise.allSettled([...this.#ticks]).then(() => undefined);
  }

  #schedule(ms: number): void {
    clearTimeout(this.#timer);
    if (!this.#stopped) this.#timer = setTimeout(() => void this.tick(), ms);
  }

  status(): SummarizerStatus {
    const calls = dayOf(this.#counts, this.#now());
    return {
      running: this.#running.size,
      queued: this.#queue.length,
      today: { count: autoCalls(calls), limit: DAILY_LIMIT, calls },
      ...(this.#backfill ? { backfill: this.#progressOf(this.#backfill) } : {}),
      ...(!this.#backfill && this.#toBackfill !== undefined ? { toBackfill: this.#toBackfill } : {}),
      ...(this.#lastError ? { lastError: this.#lastError.text, ...(this.#lastError.code ? { lastErrorCode: this.#lastError.code } : {}) } : {}),
    };
  }

  #progressOf({ done, total, failed, skipped, full }: Omit<BackfillPlan, "pending">): NonNullable<SummarizerStatus["backfill"]> {
    return { done, total, failed, skipped, ...(full ? { full } : {}) };
  }

  /** Puts a conversation in line; a stronger reason moves an entry already waiting up. */
  enqueue(job: Job): void {
    if (this.#running.has(job.threadId)) return;
    const waiting = this.#queue.find((item) => item.threadId === job.threadId);
    if (waiting) {
      if (PRIORITY[job.reason] < PRIORITY[waiting.reason]) waiting.reason = job.reason;
      if (job.updatedAt) waiting.updatedAt = job.updatedAt;
      if (job.requestedAt !== undefined) waiting.requestedAt = job.requestedAt;
      if (job.hostId) waiting.hostId = job.hostId;
    } else this.#queue.push(job);
    this.#queue.sort((a, b) => PRIORITY[a.reason] - PRIORITY[b.reason]);
    this.#work();
  }

  /**
   * The user asked for this conversation now: it is summarized even with automatic summaries off,
   * and a mainline the user deleted may come back. A conversation of an agent no model is set for
   * is refused, naming the setting that decides.
   */
  async request(threadId: string): Promise<void> {
    const settings = await this.#deps.settings();
    const hostId = this.#deps.remote?.hostOf(threadId);
    // codexhost not answering (in time) is no reason to refuse: the summary then fails when its turn
    // comes. Nor is a host that cannot be reached now, which is not even asked.
    const thread = hostId && this.#deps.remote?.down(hostId) ? undefined : await within(this.#deps.api.readThread(threadId, hostId), READ_WAIT_MS).catch(() => undefined);
    if (thread) {
      this.#noteAgent(threadId, thread.harnessId);
      if (!summaryEngineFor(settings, thread.harnessId)) throw noSummarizer(thread.harnessId);
    }
    const state = await this.#deps.state();
    // No room for one more mainline: said now, before anything is sent.
    if (!has(state, threadId) && !hasRoomForMainline(state)) throw stateFull();
    if (isExcluded(state, threadId)) await updateState(this.#deps.paths, (draft) => includeInSummaries(draft, threadId));
    this.#failures.delete(threadId);
    this.enqueue({ threadId, reason: "manual", ...(hostId ? { hostId } : {}) });
  }

  /** Summarizes every conversation codexhost has, once; carries on after restarts until done or stopped. */
  async startBackfill(): Promise<void> {
    this.#backfillRound += 1;
    const { result: requestedAt } = await updateState(this.#deps.paths, (draft) => {
      // One already under way keeps its start, and so its progress.
      const backfill = draft.jobs?.backfill ?? { requestedAt: this.#now() };
      draft.jobs = { ...draft.jobs, backfill };
      return backfill.requestedAt;
    });
    if (this.#backfillSeen !== requestedAt) {
      this.#backfillSeen = requestedAt;
      await this.#tried.load(requestedAt);
      const plan = this.#plan(await this.#deps.state(), await this.#deps.index(), await this.#deps.settings(), requestedAt);
      this.#deps.log.info(`backfill started from the overview page: up to ${plan.pending.length} conversations to summarize${this.#fullNote(plan)}`);
    }
    await this.tick();
  }

  /** Stops the backfill: nothing more of it is sent. A call already running finishes, and its summary is kept. */
  async cancelBackfill(): Promise<void> {
    this.#backfillRound += 1;
    const { result: requested } = await updateState(this.#deps.paths, (draft) => {
      const had = draft.jobs?.backfill !== undefined;
      if (draft.jobs) delete draft.jobs.backfill;
      if (draft.jobs && !Object.keys(draft.jobs).length) delete draft.jobs;
      return had;
    });
    const dropped = this.#drop("backfill");
    const finishing = [...this.#running.values()].filter((reason) => reason === "backfill").length;
    const progress = this.#backfill;
    this.#backfill = undefined;
    this.#backfillSeen = undefined;
    await this.#tried.clear().catch((error: unknown) => this.#deps.log.error("forget what the stopped backfill tried", error));
    if (requested || dropped || progress)
      this.#deps.log.info(
        `backfill stopped from the overview page${progress ? ` after ${progress.done} of ${progress.total}` : ""}: ${dropped} waiting dropped${finishing ? `, ${finishing} running call(s) finish` : ""}`,
      );
    this.#toBackfill = this.#plan(await this.#deps.state(), await this.#deps.index(), await this.#deps.settings()).pending.length;
  }

  /** One round: pick up conversations that finished a turn, and feed the backfill. */
  tick(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    const tick = this.#tick().finally(() => this.#ticks.delete(tick));
    this.#ticks.add(tick);
    return tick;
  }

  async #tick(): Promise<void> {
    const round = this.#backfillRound;
    try {
      const [state, settings] = [await this.#deps.state(), await this.#deps.settings()];
      this.#autoOn = settings.autoSummarize;
      this.#counts = await readSummaryCounts(this.#counted);
      // Turned off: what waits in line goes, and nothing new is picked up.
      if (!settings.autoSummarize) this.#drop("auto");
      else await this.#findFinishedTurns(state, settings);
      const index = await this.#deps.index();
      // A backfill started or stopped meanwhile: the round that did it takes care of it.
      if (round !== this.#backfillRound) return;
      const requested = state.jobs?.backfill;
      if (requested) {
        await this.#tried.load(requested.requestedAt);
        await this.#feedBackfill(this.#plan(state, index, settings, requested.requestedAt), requested.requestedAt);
      } else {
        this.#backfill = undefined;
        this.#drop("backfill");
        this.#toBackfill = this.#plan(state, index, settings).pending.length;
      }
    } catch (error) {
      this.#deps.log.error("summarizer round", error);
    } finally {
      this.#schedule(POLL_MS);
    }
  }

  async #findFinishedTurns(state: StateV2, settings: Settings): Promise<void> {
    const now = this.#now();
    if (autoCalls(dayOf(this.#counts, now)) >= DAILY_LIMIT) return;
    let listed: ListedThread[];
    try {
      // Waited for briefly: starting a backfill waits on this round.
      listed = (await within(this.#deps.api.listThreads({ limit: 30 }), LIST_WAIT_MS)).threads;
    } catch {
      listed = [];
    }
    // Conversations on other computers, as their hosts listed them last (each entry names its host).
    listed = [...listed, ...(this.#deps.remote?.listed() ?? [])];
    if (!listed.length) return;
    // Whether a conversation without a mainline can get one: else it is not even read.
    const room = hasRoomForMainline(state);
    for (const thread of listed) {
      // The list names each conversation's agent: another agent's is skipped without a read.
      if (thread.harnessId) this.#noteAgent(thread.threadId, thread.harnessId);
      const updated = ms(thread.updatedAt);
      if (updated === undefined || now - updated < QUIET_MS) continue;
      // The user deleted its mainline: it stays deleted.
      if (isExcluded(state, thread.threadId)) continue;
      const summary = state.conversations[thread.threadId]?.summary;
      if (summary?.threadUpdatedAt === thread.updatedAt) continue;
      if (summary && now - summary.at < AGAIN_AFTER_MS) continue;
      // Only conversations that changed recently; older ones are the backfill's.
      if (now - updated > 24 * 60 * 60 * 1000) continue;
      // Failed lately: not before its next try, unless it has had a new turn since.
      if (!this.#retryDue(thread.threadId, thread.updatedAt)) continue;
      if (!this.#mayRoute(thread.threadId, settings)) continue;
      if (!room && !has(state, thread.threadId)) {
        this.#noteFull();
        continue;
      }
      this.enqueue({ threadId: thread.threadId, reason: "auto", updatedAt: thread.updatedAt, ...(thread.hostId ? { hostId: thread.hostId } : {}) });
    }
  }

  /**
   * Which older conversations a backfill (started at `requestedAt`, or one started now) has done,
   * cannot do, and has left: `pending` is what it will really send. A conversation it tried already
   * is never pending again, and one without a mainline only while the state has room for one more.
   * The tried list must be loaded (`#tried.load`) before.
   */
  #plan(state: StateV2, index: RefIndex, settings: Settings, requestedAt?: number): BackfillPlan {
    const plan: BackfillPlan = { total: 0, done: 0, failed: 0, skipped: 0, full: 0, pending: [] };
    const tried = this.#tried.known(requestedAt);
    const candidates: Array<Pending & { kept: boolean }> = [];
    for (const [threadId, record] of Object.entries(index.threads)) {
      // Conversations codexhost cannot read, with nothing said yet, or whose mainline the user deleted.
      if (record.unreadable || record.turns <= 0 || isExcluded(state, threadId)) continue;
      // On a computer that cannot be reached now: left out until it can (a later round counts it again).
      if (record.hostId && this.#deps.remote?.down(record.hostId)) continue;
      plan.total += 1;
      const conversation = state.conversations[threadId];
      const summary = conversation?.summary;
      // Summaries from before 0.4.1 did not record whether the work was finished: they are redone.
      const current =
        summary !== undefined && summary.finished !== undefined && (summary.threadUpdatedAt === record.updatedAt || (requestedAt !== undefined && summary.at >= requestedAt));
      if (current) plan.done += 1;
      // Known from a read, or from codexhost's listing (the index keeps the agent): so "at most N" is exact.
      else if (!this.#mayRoute(threadId, settings, record.harnessId)) plan.skipped += 1;
      // Being summarized right now.
      else if (this.#running.has(threadId)) continue;
      // Sent once by this backfill already (whatever became of it), or failed lately and not due again.
      else if (tried.has(threadId) || !this.#retryDue(threadId, record.updatedAt)) plan.failed += 1;
      else candidates.push({ threadId, updatedAt: record.updatedAt, kept: conversation !== undefined, ...(record.hostId ? { hostId: record.hostId } : {}) });
    }
    // Newest first, as they are sent. Summarizing a conversation that has a mainline adds none; one
    // without gets one, while there is room: past the cap, every new one would push an older one out.
    candidates.sort((a, b) => (ms(b.updatedAt) ?? 0) - (ms(a.updatedAt) ?? 0));
    let room = this.#room(state);
    for (const candidate of candidates) {
      if (!candidate.kept && room <= 0) {
        plan.full += 1;
        plan.total -= 1;
        continue;
      }
      if (!candidate.kept) room -= 1;
      const { kept: _kept, ...pending } = candidate;
      plan.pending.push(pending);
    }
    return plan;
  }

  /** How many more mainlines the state keeps, with those the summaries running now will add (other than `except`'s). */
  #room(state: StateV2, except?: string): number {
    const adding = [...this.#running.keys()].filter((threadId) => threadId !== except && !state.conversations[threadId]).length;
    return this.#cap - Object.keys(state.conversations).length - adding;
  }

  /**
   * Whether a summary of this conversation can be kept: it has a mainline already, or there is room
   * for a new one (`hasRoomForMainline`); for the backfill also below the cap, so it removes none.
   */
  #roomFor(state: StateV2, job: Job): boolean {
    if (has(state, job.threadId)) return true;
    if (job.reason === "backfill" && this.#room(state, job.threadId) <= 0) return false;
    return hasRoomForMainline(state);
  }

  /** Once a day in the log: conversations without a mainline wait, as the state has no room for one. */
  #noteFull(): void {
    const day = dayKey(this.#now());
    if (this.#fullNoted === day) return;
    this.#fullNoted = day;
    this.#deps.log.info(`automatic summaries leave out conversations without a mainline: at most ${MAX_CONVERSATIONS} mainlines are kept and none of the others can make room`);
  }

  /** Whether a conversation may be summarized automatically again: it has not failed, its next try is due, or it has had a new turn since. */
  #retryDue(threadId: string, updatedAt?: string): boolean {
    const failure = this.#failures.get(threadId);
    if (!failure) return true;
    if (updatedAt !== undefined && failure.updatedAt !== undefined && updatedAt !== failure.updatedAt) return true;
    return this.#now() >= failure.retryAt;
  }

  /**
   * A summary failed: the next automatic try waits 30 minutes, then twice as long each time, up to 8
   * hours, or comes with a new turn. One refused for want of room (`full`) waits the 8 hours whatever
   * happens meanwhile: a new turn makes no room, so no call is spent on every turn.
   */
  #noteFailure(job: Job, full = false): void {
    const count = (this.#failures.get(job.threadId)?.count ?? 0) + 1;
    this.#failures.delete(job.threadId);
    this.#failures.set(job.threadId, {
      count,
      retryAt: this.#now() + (full ? RETRY_CAP_MS : Math.min(RETRY_CAP_MS, RETRY_FIRST_MS * 2 ** (count - 1))),
      ...(job.updatedAt && !full ? { updatedAt: job.updatedAt } : {}),
    });
    if (this.#failures.size > FAILURES_KEPT) this.#failures.delete(this.#failures.keys().next().value!);
  }

  /** For the log: the conversations a backfill leaves out because the state keeps no more mainlines. */
  #fullNote(plan: BackfillPlan): string {
    return plan.full ? `; ${plan.full} conversations without a mainline left out: the state keeps at most ${this.#cap} mainlines` : "";
  }

  async #feedBackfill(plan: BackfillPlan, requestedAt: number): Promise<void> {
    const { pending, full, ...rest } = plan;
    const progress: Omit<BackfillPlan, "pending"> = { ...rest, full };
    if (this.#backfillSeen !== requestedAt) {
      this.#backfillSeen = requestedAt;
      this.#deps.log.info(
        (requestedAt < this.#startedAt
          ? `backfill asked for at ${new Date(requestedAt).toISOString()} carries on after a restart: ${pending.length} conversations left`
          : `backfill started with mainline summarize --all: up to ${pending.length} conversations to summarize`) + this.#fullNote(plan),
      );
    }
    this.#backfill = progress;
    this.#toBackfill = undefined;
    if (!pending.length) {
      // Only the backfill's own work holds it open; automatic summaries come and go all the time.
      if (![...this.#running.values()].includes("backfill") && !this.#queue.some((job) => job.reason === "backfill")) {
        const { result: outcome } = await updateState(this.#deps.paths, (draft): "finished" | "gone" | "again" => {
          const standing = draft.jobs?.backfill;
          // Stopped, finished by a round that overlapped this one, or asked for again: that is what stands.
          if (standing?.requestedAt !== requestedAt) return standing ? "again" : "gone";
          delete draft.jobs!.backfill;
          if (!Object.keys(draft.jobs!).length) delete draft.jobs;
          return "finished";
        });
        // Gone meanwhile: the progress this round put up is of a backfill no longer under way.
        if (outcome === "gone" && this.#backfill === progress) {
          this.#backfill = undefined;
          this.#backfillSeen = undefined;
        }
        if (outcome !== "finished") return;
        this.#deps.log.info(
          `backfill finished: ${progress.done} conversations summarized, ${progress.failed} could not be, ${progress.skipped} of other agents left out${this.#fullNote(plan)}`,
        );
        this.#backfill = undefined;
        this.#backfillSeen = undefined;
        this.#toBackfill = 0;
        await this.#tried.clear().catch((error: unknown) => this.#deps.log.error("forget what the finished backfill tried", error));
      }
      return;
    }
    // Newest first; keep the line short so asked-for and automatic summaries are not held up.
    pending.sort((a, b) => (ms(b.updatedAt) ?? 0) - (ms(a.updatedAt) ?? 0));
    const room = WORKERS * 3 - this.#queue.length;
    for (const { threadId, updatedAt, hostId } of pending.slice(0, Math.max(0, room)))
      this.enqueue({ threadId, reason: "backfill", updatedAt, requestedAt, ...(hostId ? { hostId } : {}) });
  }

  /** Takes the jobs waiting for this reason out of the line. Returns how many. */
  #drop(reason: SummaryReason): number {
    let dropped = 0;
    for (let i = this.#queue.length - 1; i >= 0; i -= 1)
      if (this.#queue[i]!.reason === reason) {
        this.#queue.splice(i, 1);
        dropped += 1;
      }
    return dropped;
  }

  #noteAgent(threadId: string, harnessId: string | undefined): void {
    this.#agents.delete(threadId);
    this.#agents.set(threadId, harnessId ?? "");
    if (this.#agents.size > AGENTS_KEPT) this.#agents.delete(this.#agents.keys().next().value!);
  }

  /**
   * False when this conversation is known to run on an agent no model is set for: from a read or
   * a list of it, else from `listed`, the agent the link index has for it.
   */
  #mayRoute(threadId: string, settings: Settings, listed?: string): boolean {
    const agent = this.#agents.get(threadId) ?? listed;
    return agent === undefined || summaryEngineFor(settings, agent || undefined) !== undefined;
  }

  /** The remote host a job's conversation runs on, when it is on another computer. */
  #hostOf(job: Job): string | undefined {
    return job.hostId ?? this.#deps.remote?.hostOf(job.threadId);
  }

  #work(): void {
    while (!this.#stopped && this.#running.size < WORKERS && this.#queue.length) {
      // A worker is on another computer's conversation already: the next one of this machine goes first.
      const next = this.#runningRemote.size >= REMOTE_WORKERS ? this.#queue.findIndex((item) => !this.#hostOf(item)) : 0;
      if (next < 0) break;
      const job = this.#queue.splice(next, 1)[0]!;
      // Turned off, or today's limit reached, while it waited: an automatic job goes.
      if (job.reason === "auto" && (!this.#autoOn || autoCalls(dayOf(this.#counts, this.#now())) >= DAILY_LIMIT)) continue;
      this.#running.set(job.threadId, job.reason);
      if (this.#hostOf(job)) this.#runningRemote.add(job.threadId);
      void this.#summarize(job)
        .catch((error: unknown) => {
          // Cut off by stopping: no failure of the conversation's, and nothing to remember.
          if (this.#stopped) return;
          this.#noteFailure(job, error instanceof MainlineError && error.code === "STATE_FULL");
          // The backfill tries each conversation once: one that failed is not tried again by it.
          if (job.reason === "backfill" && job.requestedAt !== undefined) void this.#tried.add(job.requestedAt, job.threadId).catch(() => undefined);
          const code = codeOf(error);
          this.#lastError = { text: messageOf(error).slice(0, 200), ...(code ? { code } : {}) };
          if (!(typeof error === "object" && error !== null && this.#logged.has(error))) this.#deps.log.error(`summarize ${job.threadId.slice(0, 8)}`, error);
        })
        .finally(() => {
          this.#running.delete(job.threadId);
          this.#runningRemote.delete(job.threadId);
          if (job.reason === "backfill" && this.#backfill) void this.tick();
          this.#work();
        });
    }
  }

  async #summarize(job: Job): Promise<void> {
    const { api } = this.#deps;
    const [state, settings] = [await this.#deps.state(), await this.#deps.settings()];
    this.#autoOn = settings.autoSummarize;
    // Looked at again when its turn comes: the user may have changed something while it waited.
    if (job.reason === "auto" && !settings.autoSummarize) return;
    if (job.reason === "backfill" && !state.jobs?.backfill) return;
    // Deleted after it was asked for (asking clears the mark): it stays deleted.
    if (isExcluded(state, job.threadId)) return;
    // No room for one more mainline: nothing is read or sent (looked at again right before sending).
    if (!this.#roomFor(state, job)) {
      if (job.reason === "manual") throw stateFull();
      if (job.reason === "auto") this.#noteFull();
      return;
    }
    // On another computer: read there, and not at all while it cannot be reached.
    const hostId = this.#hostOf(job);
    if (hostId && this.#deps.remote?.down(hostId)) throw new Error(`the computer this conversation runs on (remote host ${shortHost(hostId)}) is not connected now`);
    const thread = await api.readThread(job.threadId, hostId);
    if (!thread) throw new Error("codexhost could not read this conversation");
    this.#noteAgent(job.threadId, thread.harnessId);
    const engine = summaryEngineFor(settings, thread.harnessId);
    if (!engine) {
      if (job.reason === "manual") throw noSummarizer(thread.harnessId);
      // Another agent's conversation, and no model is set for those: it stays unsummarized.
      return;
    }
    // Mid-turn: wait for the next round, when it has finished.
    if (thread.status === "running" && job.reason === "auto") return;
    const latest = await api.readTurns(job.threadId, undefined, hostId);
    let turns = latest.turns;
    if (latest.totalTurns > turns.length) {
      turns = [];
      for (let to = latest.totalTurns; to >= 1 && turns.length < TURNS_READ; to -= TURNS_PER_READ) {
        const from = Math.max(1, to - TURNS_PER_READ + 1, latest.totalTurns - TURNS_READ + 1);
        turns.push(...(await api.readTurns(job.threadId, { from, to }, hostId)).turns);
        if (from <= Math.max(1, latest.totalTurns - TURNS_READ + 1)) break;
      }
    }
    // Nothing to read is a failure, not a success: the conversation is not asked for again and again.
    if (!turns.length) throw new Error("this conversation has no turns to summarize");
    const index = await this.#deps.index();
    const current = state.conversations[job.threadId];
    const record = index.threads[job.threadId];
    const prompt = summaryPrompt({
      ...(thread.title ? { threadTitle: thread.title } : {}),
      ...(current ? { current } : {}),
      ...(record?.firstPrompt ? { firstPrompt: record.firstPrompt } : {}),
      totalTurns: latest.totalTurns,
      turns: turns.map((turn): SummaryTurn => ({
        turn: turn.turnNumber,
        // What the user asked, without the list of attached files (names and paths) before it.
        user: turn.messages
          .filter(({ role }) => role === "user")
          .map(({ text }) => requestOf(text))
          .join("\n"),
        agent: turn.messages
          .filter(({ role }) => role === "agent")
          .map(({ text }) => text)
          .join("\n"),
      })),
    });
    // The backend is stopping: nothing more goes to a model.
    if (this.#stopped) return;
    // Looked at again right before sending: other summaries may have added mainlines meanwhile, and
    // the backfill may have been asked for again or stopped.
    const latestState = await this.#deps.state();
    if (job.reason === "auto") {
      // Another round may have read an old snapshot before a previous summary finished.
      const previous = latestState.conversations[job.threadId]?.summary;
      if (previous && ((job.updatedAt !== undefined && previous.threadUpdatedAt === job.updatedAt) || this.#now() - previous.at < AGAIN_AFTER_MS)) return;
    }
    if (!this.#roomFor(latestState, job)) {
      if (job.reason === "manual") throw stateFull();
      return;
    }
    if (job.reason === "backfill") {
      const requestedAt = latestState.jobs?.backfill?.requestedAt;
      if (requestedAt === undefined || (job.requestedAt !== undefined && requestedAt !== job.requestedAt)) return;
      // Written down before anything is sent, so that no restart sends it again.
      await this.#tried.add(requestedAt, job.threadId);
    }
    // Counted before the call, since the text leaves the machine either way; an automatic one only within today's limit.
    const at = this.#now();
    if (!(await this.#count(engine, job.reason, at))) return;
    const { summary, model } = await this.#call(engine, job, prompt, at);
    const updatedAt = job.updatedAt ?? record?.updatedAt;
    const activityAt = ms(updatedAt);
    await updateState(this.#deps.paths, (draft, ctx) => {
      // Deleted while the model was writing: it stays deleted.
      if (isExcluded(draft, job.threadId)) return;
      applySummary(
        draft,
        job.threadId,
        summary,
        { at: ctx.now, model, ...(updatedAt ? { threadUpdatedAt: updatedAt } : {}), turns: latest.totalTurns },
        { ...ctx, ...(activityAt !== undefined ? { activityAt } : {}) },
      );
      // The mainline says where the conversation runs, so it is read there after a restart too.
      if (hostId) noteHosts(draft, [[job.threadId, hostId]]);
    });
    this.#failures.delete(job.threadId);
    this.#lastError = undefined;
    this.#deps.changed();
  }

  /** Counts a call on disk before it is made. False when it is automatic and today's limit is reached. */
  async #count(engine: Engine, reason: SummaryReason, at: number): Promise<boolean> {
    const { counted, counts, setAside } = await countSummaryCall(this.#counted, { engine, reason, at, ...(reason === "auto" ? { limit: DAILY_LIMIT } : {}) });
    this.#counts = counts;
    if (setAside)
      this.#deps.log.info(`summary-counts.json could not be read and was set aside as ${path.basename(setAside)}; today's count of automatic summaries starts again from 0`);
    if (!counted) {
      this.#drop("auto");
      if (this.#limitNoted !== dayKey(at)) {
        this.#limitNoted = dayKey(at);
        this.#deps.log.info(`automatic summaries stop for today: ${DAILY_LIMIT} were made`);
      }
    }
    return counted;
  }

  /**
   * One model call, and its one line in the log: which model, why, which conversation, how long,
   * how it went. No conversation text. A call that sent nothing (the tool is missing) is not counted.
   */
  async #call(engine: Engine, job: Job, prompt: string, countedAt: number): Promise<{ summary: SummaryInput; model: string }> {
    const started = Date.now();
    // A remote host by the short form of its id only, never by its name.
    const hostId = this.#hostOf(job);
    const where = hostId ? ` (remote host ${shortHost(hostId)})` : "";
    const line = (outcome: string) => `model call: ${engine} ${job.reason} ${job.threadId.slice(0, 8)}${where} ${((Date.now() - started) / 1000).toFixed(1)}s ${outcome}`;
    try {
      const answer = await this.#deps.runModel(engine, { system: SUMMARY_SYSTEM, prompt, schema: SUMMARY_SCHEMA });
      const summary = readSummary(answer.value);
      if (!summary) throw new Error(`${answer.model} did not give a usable summary`);
      this.#deps.log.info(line(`ok (${answer.model})`));
      return { summary, model: answer.model };
    } catch (error) {
      this.#deps.log.error(line("failed"), error);
      if (typeof error === "object" && error !== null) this.#logged.add(error);
      if (error instanceof ModelNotSentError)
        this.#counts = await uncountSummaryCall(this.#counted, { engine, reason: job.reason, at: countedAt }).catch(() => this.#counts);
      throw error;
    }
  }
}
