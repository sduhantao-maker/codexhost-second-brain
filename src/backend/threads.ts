/**
 * Live facts about Threads: titles, states and delegation parents. Desktop reports its Thread
 * tree when it runs, and that wins while it is fresh. Otherwise codexhost's local API answers:
 *
 * - One list of the most recently updated Threads (`/v1/thread/list`), at most every 20 seconds
 *   and shared by everyone who asks, gives the title, agent and state of most of them.
 * - A Thread is read on its own (`/v1/thread/read`, which can cost codexhost half a second of
 *   work on a long conversation) only when the list cannot tell: it is not on the list (an old
 *   parent or child), or the list says it runs, since only a read tells running from waiting
 *   for the user. The conversation open on a surface is read every 15 seconds, a running one
 *   every minute, any other every 5 minutes.
 * - Reads wait in one queue, two at a time; an id counts as asked for from the moment it is
 *   queued, so polls that overlap never read it twice. A read that fails waits a minute before the
 *   next try, then twice as long each time up to a cap, and is logged once per step.
 * - A conversation on another computer (a remote host) is read on that host, in a queue of its own,
 *   one at a time, so that a slow host never holds up the reads of this machine; while its host
 *   cannot be reached it is not read at all. Its host's list (`noteListed`) counts like the list of
 *   this machine.
 */
import { shortHost } from "../core/hosts.js";
import type { ThreadInfo, ThreadStatus } from "../core/model.js";
import type { TreeReport } from "../core/rpc.js";
import { HttpError, type ExternalApi, type ListedThread } from "./external-api.js";
import type { Log } from "./log.js";

/** Where conversations run, for those on another computer (see RemoteHosts). */
export interface ThreadHosts {
  /** The remote host a conversation runs on; none for a local conversation. */
  hostOf(threadId: string): string | undefined;
  /** Whether that host cannot be reached now: its conversations are not read meanwhile. */
  down(hostId: string): boolean;
  /** A conversation found on a remote host (a child its list named). */
  note?(threadId: string, hostId: string): void;
  /** A read on that host failed as if it could not be reached. */
  failed?(hostId: string, error: unknown): void;
}

export interface ThreadInfoOptions {
  hosts?: ThreadHosts;
  /** Reads conversations on other computers, which may take longer; `api` by default. */
  remoteApi?: Pick<ExternalApi, "readThread" | "listChildren">;
}

type Source = "desktop" | "list" | "read";

interface Fact extends ThreadInfo {
  at: number;
  source: Source;
}

/** A read or list that failed, and when to try again. */
interface Failure {
  /** How many times in a row it failed. */
  step: number;
  retryAt: number;
}

const DESKTOP_FRESH_MS = 20_000;
/** The list of recently updated Threads is asked for at most this often. */
export const LIST_EVERY_MS = 20_000;
/** Threads one list brings: the most recently updated, where the live states are. */
export const LIST_LIMIT = 50;
/** What the last list said counts this long; after that its Threads are read like the rest. */
const LIST_TRUSTED_MS = 2 * 60_000;
/** The conversation open on a surface, when the list cannot tell its state. */
export const FOCUS_MAX_AGE_MS = 15_000;
/** A running conversation: whether it waits for the user shows only in a read. */
export const RUNNING_MAX_AGE_MS = 60_000;
/** Any other conversation the list does not answer. */
export const OTHER_MAX_AGE_MS = 5 * 60_000;
/** A failed read or list is tried again after this long, then twice as long each time, up to the cap. */
export const RETRY_FIRST_MS = 60_000;
export const RETRY_CAP_MS = 15 * 60_000;
/** An id codexhost refused (4xx) is no Thread at all, such as an unsent draft: asked again much later. */
const REFUSED_FIRST_MS = 10 * 60_000;
const REFUSED_CAP_MS = 60 * 60_000;
/** Reads under way at once. */
export const READS_AT_ONCE = 2;
/** Reads of conversations on other computers under way at once, beside those. */
export const REMOTE_READS_AT_ONCE = 1;

const live = (status: ThreadStatus | undefined) => status === "running" || status === "waiting";
/** codexhost answered that it cannot reach the remote host: no answer about the conversation itself. */
const unreachable = (error: unknown) => !(error instanceof HttpError) || error.status >= 500 || error.code === "RUNTIME_UNREACHABLE";

export class ThreadInfoService {
  readonly #facts = new Map<string, Fact>();
  /** Delegation links by where they came from; Desktop's tree is the most complete. */
  #parents = new Map<string, string>();
  #webParents = new Map<string, string>();
  readonly #apiParents = new Map<string, string>();
  readonly #childLookups = new Map<string, number>();
  #desktopAt = 0;
  #version = 0;

  /** The Threads on the last list that came back, and when it came. */
  #listed = new Set<string>();
  #listedAt = 0;
  /** When the list was last asked for, and the one under way. */
  #listAskedAt = Number.NEGATIVE_INFINITY;
  #listing: Promise<void> | undefined;
  #listFailure: Failure | undefined;

  /** What each remote host's last list named (with its state), and when it came. */
  readonly #remoteListed = new Map<string, { ids: Set<string>; at: number }>();

  /** When each Thread was last read on its own. */
  readonly #readAt = new Map<string, number>();
  readonly #failures = new Map<string, Failure>();
  /** Queued or being read, with what resolves when its read is over. */
  readonly #pending = new Map<string, Promise<void>>();
  /** This machine's reads, and those of conversations on other computers, each queue with its own count. */
  readonly #queue: Array<{ threadId: string; hostId?: string; done: () => void }> = [];
  readonly #remoteQueue: Array<{ threadId: string; hostId?: string; done: () => void }> = [];
  #reading = 0;
  #remoteReading = 0;
  readonly #hosts: ThreadHosts | undefined;
  readonly #remoteApi: Pick<ExternalApi, "readThread" | "listChildren"> | undefined;

  constructor(
    private readonly api: ExternalApi | undefined,
    private readonly log: Log,
    private readonly now: () => number = Date.now,
    options: ThreadInfoOptions = {},
  ) {
    this.#hosts = options.hosts;
    this.#remoteApi = options.remoteApi ?? api;
  }

  /** The remote host a conversation runs on, and whether it can be reached; none for a local conversation. */
  #hostOf(threadId: string): { hostId: string; down: boolean } | undefined {
    const hostId = this.#hosts?.hostOf(threadId);
    return hostId ? { hostId, down: this.#hosts!.down(hostId) } : undefined;
  }

  get version(): number {
    return this.#version;
  }

  desktopFresh(): boolean {
    return this.now() - this.#desktopAt < DESKTOP_FRESH_MS;
  }

  /** Every known delegation link, child to parent. */
  parentMap(): Map<string, string> {
    return new Map([...this.#apiParents, ...this.#webParents, ...this.#parents]);
  }

  /** Links the Web sidebar shows on its rows (`data-thread-parent`). Returns true when they changed. */
  reportWebParents(parents: Readonly<Record<string, string>>): boolean {
    const next = new Map(Object.entries(parents));
    const changed = next.size !== this.#webParents.size || [...next].some(([child, parent]) => this.#webParents.get(child) !== parent);
    this.#webParents = new Map([...this.#webParents, ...next]);
    return changed;
  }

  /** Asks codexhost for a conversation's delegated children, at most once a minute per parent. */
  async lookupChildren(parentId: string): Promise<boolean> {
    if (!this.api) return false;
    // A conversation on another computer: its children are there too, and nothing goes to a host that cannot be reached.
    const host = this.#hostOf(parentId);
    if (host ? host.down : this.desktopFresh()) return false;
    const last = this.#childLookups.get(parentId) ?? 0;
    if (this.now() - last < 60_000) return false;
    this.#childLookups.set(parentId, this.now());
    let changed = false;
    try {
      const children = host ? await this.#remoteApi!.listChildren(parentId, host.hostId) : await this.api.listChildren(parentId);
      for (const child of children) {
        if (child.threadId === parentId) continue;
        if (host) this.#hosts?.note?.(child.threadId, host.hostId);
        if (this.#apiParents.get(child.threadId) !== parentId) changed = true;
        this.#apiParents.set(child.threadId, parentId);
        // A list of children tells as much as the list of all Threads: running or not.
        this.#set(child.threadId, child, "list");
      }
    } catch (error) {
      if (host && unreachable(error)) this.#hosts?.failed?.(host.hostId, error);
      this.log.error(`list children of ${parentId.slice(0, 8)}${host ? ` on remote host ${shortHost(host.hostId)}` : ""}`, error);
    }
    return changed;
  }

  /**
   * Takes a remote host's list (RemoteHosts lists each host now and then): titles, agents and
   * states, which count like those of this machine's list.
   */
  noteListed(hostId: string, threads: readonly ListedThread[]): void {
    for (const thread of threads)
      this.#set(
        thread.threadId,
        {
          status: thread.status ?? this.#facts.get(thread.threadId)?.status ?? "unknown",
          ...(thread.title ? { title: thread.title } : {}),
          ...(thread.harnessId ? { harnessId: thread.harnessId } : {}),
        },
        "list",
      );
    this.#remoteListed.set(hostId, { ids: new Set(threads.filter((thread) => thread.status).map((thread) => thread.threadId)), at: this.now() });
  }

  /** All facts known so far, for building views. */
  all(): Record<string, ThreadInfo> {
    const result: Record<string, ThreadInfo> = {};
    for (const threadId of this.#facts.keys()) {
      const info = this.get(threadId);
      if (info) result[threadId] = info;
    }
    return result;
  }

  #set(threadId: string, info: ThreadInfo, source: Source): void {
    const previous = this.#facts.get(threadId);
    // Desktop's tree knows more than a list (it tells waiting from running); while it is fresh it stays.
    if (source === "list" && previous?.source === "desktop" && this.desktopFresh()) return;
    // A list says "running" also while the Thread waits for the user's answer: a known wait stays.
    const status = source === "list" && info.status === "running" && previous?.status === "waiting" ? "waiting" : info.status;
    const title = info.title ?? previous?.title;
    const harnessId = info.harnessId ?? previous?.harnessId;
    const fact: Fact = {
      status,
      at: this.now(),
      source,
      ...(title === undefined ? {} : { title }),
      ...(harnessId === undefined ? {} : { harnessId }),
    };
    if (previous?.title !== fact.title || previous?.status !== fact.status || previous?.harnessId !== fact.harnessId)
      this.#version += 1;
    this.#facts.set(threadId, fact);
  }

  /** Takes Desktop's Thread tree. Returns true when the parent links changed. */
  reportTree(report: TreeReport): boolean {
    this.#desktopAt = this.now();
    for (const [threadId, node] of Object.entries(report.nodes)) this.#set(threadId, node, "desktop");
    const parents = new Map(Object.entries(report.parents));
    const changed =
      parents.size !== this.#parents.size ||
      [...parents].some(([child, parent]) => this.#parents.get(child) !== parent);
    this.#parents = parents;
    return changed;
  }

  get(threadId: string): ThreadInfo | undefined {
    const fact = this.#facts.get(threadId);
    if (!fact) return undefined;
    return {
      status: fact.status,
      ...(fact.title === undefined ? {} : { title: fact.title }),
      ...(fact.harnessId === undefined ? {} : { harnessId: fact.harnessId }),
    };
  }

  snapshot(threadIds: Iterable<string>): Record<string, ThreadInfo> {
    const result: Record<string, ThreadInfo> = {};
    for (const threadId of threadIds) {
      const info = this.get(threadId);
      if (info) result[threadId] = info;
    }
    return result;
  }

  /**
   * Brings the facts of `threadIds` up to date as far as they need it, `focus` being the
   * conversations open on a surface: the shared list first when it is due, then the reads only the
   * conversations it cannot tell about need. Resolves when those reads are over.
   */
  async refresh(threadIds: Iterable<string>, focus: Iterable<string> = []): Promise<void> {
    if (!this.api) return;
    const focused = new Set(focus);
    const ids = [...new Set([...focused, ...threadIds])];
    const desktop = this.desktopFresh();
    const open = ids.filter((threadId) => !(desktop && this.#facts.get(threadId)?.source === "desktop"));
    if (!open.length) return;
    await this.#list();
    const due = open.filter((threadId) => this.#readDue(threadId, focused.has(threadId)));
    await Promise.all(due.map((threadId) => this.#enqueue(threadId)));
  }

  /** Whether a Thread needs a read of its own now. */
  #readDue(threadId: string, focused: boolean): boolean {
    if (this.#pending.has(threadId)) return false;
    const now = this.now();
    const failure = this.#failures.get(threadId);
    if (failure && now < failure.retryAt) return false;
    const fact = this.#facts.get(threadId);
    if (fact?.source === "desktop" && this.desktopFresh()) return false;
    const host = this.#hostOf(threadId);
    if (host?.down) return false;
    const remote = host ? this.#remoteListed.get(host.hostId) : undefined;
    const listed = host
      ? Boolean(remote?.ids.has(threadId) && now - remote.at <= LIST_TRUSTED_MS)
      : this.#listed.has(threadId) && now - this.#listedAt <= LIST_TRUSTED_MS;
    // On the list and not running: the list said all there is to say.
    if (listed && !live(fact?.status)) return false;
    const maxAge = focused ? FOCUS_MAX_AGE_MS : live(fact?.status) ? RUNNING_MAX_AGE_MS : OTHER_MAX_AGE_MS;
    return now - (this.#readAt.get(threadId) ?? Number.NEGATIVE_INFINITY) > maxAge;
  }

  /** The list of recently updated Threads, once for every caller, at most every LIST_EVERY_MS. */
  #list(): Promise<void> {
    if (this.#listing) return this.#listing;
    const now = this.now();
    if (now - this.#listAskedAt < LIST_EVERY_MS || (this.#listFailure && now < this.#listFailure.retryAt)) return Promise.resolve();
    this.#listAskedAt = now;
    const api = this.api!;
    this.#listing = (async () => {
      try {
        const { threads } = await api.listThreads({ limit: LIST_LIMIT });
        for (const thread of threads)
          this.#set(
            thread.threadId,
            {
              status: thread.status ?? this.#facts.get(thread.threadId)?.status ?? "unknown",
              ...(thread.title ? { title: thread.title } : {}),
              ...(thread.harnessId ? { harnessId: thread.harnessId } : {}),
            },
            "list",
          );
        // Only an entry with its state answers for it (a codexhost that lists none leaves it to reads).
        this.#listed = new Set(threads.filter((thread) => thread.status).map((thread) => thread.threadId));
        this.#listedAt = this.now();
        if (this.#listFailure) this.log.info("listing Threads works again");
        this.#listFailure = undefined;
      } catch (error) {
        this.#listFailure = this.#failed("list recent Threads", error, this.#listFailure, false);
      } finally {
        this.#listing = undefined;
      }
    })();
    return this.#listing;
  }

  /** Queues a read, unless one is queued or under way; resolves when it is over. */
  #enqueue(threadId: string): Promise<void> {
    const pending = this.#pending.get(threadId);
    if (pending) return pending;
    const hostId = this.#hosts?.hostOf(threadId);
    const queue = hostId ? this.#remoteQueue : this.#queue;
    const read = new Promise<void>((done) => queue.push({ threadId, ...(hostId ? { hostId } : {}), done }));
    this.#pending.set(threadId, read);
    this.#pump();
    return read;
  }

  #pump(): void {
    const settle = (job: { threadId: string; done: () => void }) => {
      this.#pending.delete(job.threadId);
      job.done();
      this.#pump();
    };
    while (this.#reading < READS_AT_ONCE && this.#queue.length) {
      const job = this.#queue.shift()!;
      this.#reading += 1;
      void this.#read(job.threadId).finally(() => {
        this.#reading -= 1;
        settle(job);
      });
    }
    while (this.#remoteReading < REMOTE_READS_AT_ONCE && this.#remoteQueue.length) {
      const job = this.#remoteQueue.shift()!;
      this.#remoteReading += 1;
      void this.#read(job.threadId, job.hostId).finally(() => {
        this.#remoteReading -= 1;
        settle(job);
      });
    }
  }

  async #read(threadId: string, hostId?: string): Promise<void> {
    // Its host became unreachable while the read waited: nothing is sent, and nothing failed.
    if (hostId && this.#hosts?.down(hostId)) return;
    try {
      const thread = hostId ? await this.#remoteApi!.readThread(threadId, hostId) : await this.api!.readThread(threadId);
      this.#readAt.set(threadId, this.now());
      this.#failures.delete(threadId);
      if (thread) this.#set(threadId, thread, "read");
    } catch (error) {
      // A refused id (4xx) is no Thread at all, such as one deleted meanwhile: said once, asked again
      // much later. On another computer, codexhost not reaching the host says nothing of the conversation.
      const remoteDown = hostId !== undefined && unreachable(error);
      if (remoteDown) this.#hosts?.failed?.(hostId, error);
      const refused = !remoteDown && error instanceof HttpError && error.status >= 400 && error.status < 500;
      const where = hostId ? ` on remote host ${shortHost(hostId)}` : "";
      this.#failures.set(threadId, this.#failed(`read Thread ${threadId.slice(0, 8)}${where}`, error, this.#failures.get(threadId), refused));
    }
  }

  /**
   * The next step of waiting after a failure: a minute, then twice as long each time up to the cap.
   * Logged once per step, so a Thread that keeps failing fills no log; a refusal only the first time.
   */
  #failed(what: string, error: unknown, previous: Failure | undefined, refused: boolean): Failure {
    const [first, cap] = refused ? [REFUSED_FIRST_MS, REFUSED_CAP_MS] : [RETRY_FIRST_MS, RETRY_CAP_MS];
    const step = (previous?.step ?? 0) + 1;
    const wait = Math.min(cap, first * 2 ** (step - 1));
    const capped = previous !== undefined && Math.min(cap, first * 2 ** (previous.step - 1)) >= cap;
    if (refused ? !previous : !capped) this.log.error(`${what} (next try in ${Math.round(wait / 60_000)} min)`, error);
    return { step, retryAt: this.now() + wait };
  }
}
