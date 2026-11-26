/**
 * Conversations on other computers: the remote hosts paired with codexhost Web (`remote-peer:…`).
 * The extension keeps knowing a conversation by its Thread id; this says which host each remote one
 * runs on, so that every read of it names that host. It is learned from the surfaces (codexhost Web
 * names a remote row's host in its key), from each host's list, and from the state, the link index
 * and the saved passages (`seed`). Which hosts there are, what they are called and whether they are
 * connected comes from codexhost's `/v1/host/list`.
 *
 * Each host is listed now and then (`/v1/thread/list { hostId }`, its most recently updated
 * conversations), so that new replies there are noticed and summarized like local ones: every
 * minute while the extension is in use, every 10 minutes otherwise (`everyMs`). A host that is not
 * connected is not asked at all; one whose list failed waits a minute, then twice as long each time
 * up to half an hour (logged once per step). Rounds run on their own timer, the hosts side by side,
 * each request with its own time limit: no call to the backend waits for any of it, and a host that
 * cannot be reached holds up nothing on this machine.
 */
import { hostState, isRemoteHostId, shortHost, type HostState, type HostView } from "../core/hosts.js";
import { isThreadId } from "../core/model.js";
import { HttpError, type ExternalApi, type ListedThread } from "./external-api.js";
import type { Log } from "./log.js";

/** A host's list asks for its this many most recently updated conversations. */
export const REMOTE_LIST_LIMIT = 50;
/** A failed list is tried again after this long, then twice as long each time, up to the cap. */
export const REMOTE_RETRY_FIRST_MS = 60_000;
export const REMOTE_RETRY_CAP_MS = 30 * 60_000;
/** What codexhost said about the hosts counts this long; a card's view asks again after that. */
const INFO_FRESH_MS = 30_000;
/** Conversations whose host is remembered (the most recently seen). */
const THREADS_KEPT = 5000;
/** Hosts remembered at most (codexhost pairs a few). */
const HOSTS_KEPT = 32;

interface HostEntry {
  info?: { name?: string; online: boolean; state: HostState };
  /** Its latest list, each entry naming the host, and when it came. */
  listed?: { threads: ListedThread[]; at: number };
  /** Lists that failed in a row, and when to try again. */
  failure?: { step: number; retryAt: number };
}

export interface RemoteHostsOptions {
  /** How long between rounds: shorter while the extension is in use. */
  everyMs(): number;
  /** Told each list that came back, with its entries naming the host. */
  onListed?(hostId: string, threads: readonly ListedThread[]): void;
  now?(): number;
}

export class RemoteHosts {
  readonly #api: Pick<ExternalApi, "listThreads" | "listHosts">;
  readonly #log: Log;
  readonly #options: RemoteHostsOptions;
  readonly #hosts = new Map<string, HostEntry>();
  /** Thread id to host id, the most recently noted last. */
  readonly #threads = new Map<string, string>();
  /** When codexhost was last asked about the hosts, whether it ever answered, and the request under way. */
  #infoAt = Number.NEGATIVE_INFINITY;
  #infoKnown = false;
  #infoRunning: Promise<void> | undefined;
  #infoFailedLogged = false;
  #version = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #round: Promise<void> | undefined;
  #started = false;
  #stopped = false;

  constructor(api: Pick<ExternalApi, "listThreads" | "listHosts">, log: Log, options: RemoteHostsOptions) {
    this.#api = api;
    this.#log = log;
    this.#options = options;
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  /** Goes up when what a card shows of a host (its name, its state) changed. */
  get version(): number {
    return this.#version;
  }

  /** Remembers that a conversation runs on a remote host. Anything that is no conversation id or no remote host id is ignored. Returns whether it is new. */
  note(threadId: string, hostId: unknown): boolean {
    if (!isThreadId(threadId) || !isRemoteHostId(hostId)) return false;
    this.#addHost(hostId);
    const before = this.#threads.get(threadId);
    this.#threads.delete(threadId);
    this.#threads.set(threadId, hostId);
    if (this.#threads.size > THREADS_KEPT) this.#threads.delete(this.#threads.keys().next().value!);
    return before !== hostId;
  }

  /** What the state, the link index and the saved passages say, when the backend starts. */
  seed(pairs: Iterable<readonly [string, string | undefined]>): void {
    for (const [threadId, hostId] of pairs) if (hostId !== undefined) this.note(threadId, hostId);
  }

  /** The remote host a conversation runs on; none for a local conversation (or one not known to be remote). */
  hostOf(threadId: string): string | undefined {
    return this.#threads.get(threadId);
  }

  /** Every conversation known to be remote, with its host. */
  entries(): IterableIterator<[string, string]> {
    return this.#threads.entries();
  }

  /** The remote hosts known. */
  hosts(): string[] {
    return [...this.#hosts.keys()];
  }

  #addHost(hostId: string): HostEntry {
    let entry = this.#hosts.get(hostId);
    if (!entry) {
      entry = {};
      this.#hosts.set(hostId, entry);
      // Hosts nobody pairs any more go first: those codexhost does not list.
      if (this.#hosts.size > HOSTS_KEPT) for (const [id, other] of this.#hosts) if (!other.info && id !== hostId && this.#hosts.size > HOSTS_KEPT) this.#hosts.delete(id);
    }
    return entry;
  }

  /**
   * Whether a host cannot be reached now, so that nothing is sent its way: codexhost says it is not
   * connected, or does not list it at all (no longer paired, or codexhost Web not running), or its
   * last list failed and its next try is not due yet.
   */
  down(hostId: string): boolean {
    const entry = this.#hosts.get(hostId);
    if (entry?.failure && this.#now() < entry.failure.retryAt) return true;
    if (!entry?.info) return this.#infoKnown;
    return !(entry.info.online && entry.info.state === "connected");
  }

  /** A read on that host failed as if it could not be reached: it waits like a failed list. */
  failed(hostId: string, error: unknown): void {
    const entry = this.#hosts.get(hostId);
    if (!entry || (entry.failure && this.#now() < entry.failure.retryAt)) return;
    entry.failure = this.#nextTry(`read on remote host ${shortHost(hostId)}`, error, entry.failure);
  }

  /** What a card shows of a host: its name, as its owner set it in codexhost, and how it is doing. */
  view(hostId: string): HostView {
    const info = this.#hosts.get(hostId)?.info;
    return { id: hostId, ...(info?.name ? { name: info.name } : {}), state: info ? info.state : "unknown" };
  }

  /** The latest list of every host that can be reached now, each entry naming its host. */
  listed(): ListedThread[] {
    const all: ListedThread[] = [];
    for (const [hostId, entry] of this.#hosts) if (entry.listed && !this.down(hostId)) all.push(...entry.listed.threads);
    return all;
  }

  /**
   * Asks codexhost which hosts there are, once for every caller, unless it was asked within the last
   * 30 seconds (`force`: whatever the time). Every host it lists becomes known.
   */
  refreshInfo(force = false): Promise<void> {
    if (this.#infoRunning) return this.#infoRunning;
    if (!force && this.#now() - this.#infoAt < INFO_FRESH_MS) return Promise.resolve();
    this.#infoAt = this.#now();
    this.#infoRunning = (async () => {
      try {
        const hosts = await this.#api.listHosts();
        const seen = new Set<string>();
        let changed = false;
        for (const host of hosts) {
          seen.add(host.hostId);
          const entry = this.#addHost(host.hostId);
          const info = { ...(host.name ? { name: host.name } : {}), online: host.online, state: hostState(host.state) };
          if (entry.info?.name !== info.name || entry.info?.online !== info.online || entry.info?.state !== info.state) changed = true;
          entry.info = info;
        }
        for (const [hostId, entry] of this.#hosts)
          if (!seen.has(hostId) && entry.info) {
            delete entry.info;
            changed = true;
          }
        if (changed || !this.#infoKnown) this.#version += 1;
        this.#infoKnown = true;
        this.#infoFailedLogged = false;
      } catch (error) {
        // An older codexhost without the route, or a moment it cannot answer: hosts are tried as they are.
        if (!this.#infoFailedLogged) this.#log.error("ask codexhost for its remote hosts", error);
        this.#infoFailedLogged = true;
      } finally {
        this.#infoRunning = undefined;
      }
    })();
    return this.#infoRunning;
  }

  /** Whether codexhost has said which hosts there are at least once: a card's view waits for it only until then. */
  get infoKnown(): boolean {
    return this.#infoKnown;
  }

  /** One round: which hosts there are, then the list of every one that can be reached, side by side. */
  tick(): Promise<void> {
    if (this.#round) return this.#round;
    this.#round = (async () => {
      try {
        await this.refreshInfo(true);
        await Promise.allSettled(this.hosts().filter((hostId) => !this.down(hostId)).map((hostId) => this.#list(hostId)));
      } finally {
        this.#round = undefined;
      }
    })();
    return this.#round;
  }

  async #list(hostId: string): Promise<void> {
    const entry = this.#addHost(hostId);
    try {
      const { threads } = await this.#api.listThreads({ hostId, limit: REMOTE_LIST_LIMIT });
      const listed = threads.filter((thread) => isThreadId(thread.threadId)).map((thread) => ({ ...thread, hostId }));
      for (const thread of listed) this.note(thread.threadId, hostId);
      entry.listed = { threads: listed, at: this.#now() };
      if (entry.failure) this.#log.info(`listing remote host ${shortHost(hostId)} works again`);
      delete entry.failure;
      this.#options.onListed?.(hostId, listed);
    } catch (error) {
      if (this.#stopped) return;
      entry.failure = this.#nextTry(`list remote host ${shortHost(hostId)}`, error, entry.failure);
    }
  }

  /** The next wait after a failure: a minute, then twice as long each time up to the cap; logged once per step until it is reached. */
  #nextTry(what: string, error: unknown, previous: HostEntry["failure"]): NonNullable<HostEntry["failure"]> {
    const step = (previous?.step ?? 0) + 1;
    const wait = Math.min(REMOTE_RETRY_CAP_MS, REMOTE_RETRY_FIRST_MS * 2 ** (step - 1));
    const capped = previous !== undefined && Math.min(REMOTE_RETRY_CAP_MS, REMOTE_RETRY_FIRST_MS * 2 ** (previous.step - 1)) >= REMOTE_RETRY_CAP_MS;
    // codexhost's error code only; its message could name the host.
    const why = error instanceof HttpError ? `HTTP ${error.status}${error.code ? ` ${error.code}` : ""}` : error instanceof Error ? error.name : "failed";
    if (!capped) this.#log.info(`${what} failed (${why}); next try in ${Math.round(wait / 60_000)} min`);
    return { step, retryAt: this.#now() + wait };
  }

  /** Starts the rounds: the first after `delay`, then every `everyMs()`. */
  start(delay: number): void {
    this.#started = true;
    this.#stopped = false;
    this.#schedule(delay);
  }

  #schedule(delay: number): void {
    clearTimeout(this.#timer);
    if (!this.#started || this.#stopped) return;
    this.#timer = setTimeout(() => {
      void this.tick().finally(() => this.#schedule(this.#options.everyMs()));
    }, delay);
    this.#timer.unref?.();
  }

  /** Stops the rounds; resolves once the round under way (cut off by the backend stopping) is over. */
  stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#timer);
    return Promise.allSettled([this.#round, this.#infoRunning]).then(() => undefined);
  }
}
