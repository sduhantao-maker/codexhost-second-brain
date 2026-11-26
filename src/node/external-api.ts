/**
 * Reads Thread titles, states and delegated children from codexhost's local HTTP API, the
 * one its own `codexhost` command line uses. Only read routes are called, and the delegation route
 * when the user confirms a child conversation. A conversation on another computer (a remote host
 * paired with codexhost Web) is read and listed with its host's id, which codexhost needs to find it.
 */
import { readFile, stat } from "node:fs/promises";
import { hostState, isRemoteHostId, type HostState } from "../core/hosts.js";
import { isThreadId, type ThreadStatus } from "../core/model.js";

export interface ApiThread {
  threadId: string;
  title?: string;
  status: ThreadStatus;
  harnessId?: string;
  cwd?: string;
}

/**
 * One entry of `/v1/thread/list`. codexhost also sends `deepLink` and `recencyAt`. Its status is
 * `running` while a turn is active (also while it waits for the user's answer, which only a read
 * tells) and `completed`, `failed` or `interrupted` otherwise. A remote host's list names that host
 * on every entry (`hostId`); this machine's list names none.
 */
export interface ListedThread {
  threadId: string;
  updatedAt: string;
  createdAt?: string;
  title?: string;
  cwd?: string;
  status?: ThreadStatus;
  harnessId?: string;
  hostId?: string;
}

export interface ApiTurn {
  turnNumber: number;
  status: string;
  messages: Array<{ role: "user" | "agent"; text: string }>;
}

/** A computer paired with codexhost Web, as `/v1/host/list` says: its name, and whether it is connected. */
export interface RemoteHostInfo {
  hostId: string;
  name?: string;
  online: boolean;
  state: HostState;
}

/**
 * An answer from codexhost other than 2xx; 4xx means this Thread cannot be read as asked. `code` is
 * codexhost's own name for the error where it sent one (`RUNTIME_UNREACHABLE`: a remote host it
 * cannot reach).
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * A request that never reached codexhost: no local API on record, or nothing listening there. (A
 * model call that sent nothing is a `ModelNotSentError`, from models.ts.)
 */
export class ApiNotReachedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ApiNotReachedError";
  }
}

export function normalizeStatus(status: unknown, pendingQuestions?: unknown): ThreadStatus {
  if (Array.isArray(pendingQuestions) && pendingQuestions.length > 0) return "waiting";
  if (typeof status !== "string") return "unknown";
  const value = status.toLowerCase();
  if (value === "running" || value === "inprogress" || value === "in_progress") return "running";
  if (value.includes("wait") || value.includes("input") || value.includes("approval")) return "waiting";
  return "idle";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The host field of a request: only a remote host's id; this machine needs none. */
const onHost = (hostId: string | undefined) => (isRemoteHostId(hostId) ? { hostId } : {});

function toThread(raw: unknown): ApiThread | undefined {
  if (!isRecord(raw) || !isThreadId(raw.threadId)) return undefined;
  return {
    threadId: raw.threadId,
    status: normalizeStatus(raw.status, raw.pendingQuestions),
    ...(typeof raw.title === "string" && raw.title.trim() ? { title: raw.title.trim() } : {}),
    ...(typeof raw.harnessId === "string" ? { harnessId: raw.harnessId } : {}),
    ...(typeof raw.cwd === "string" && raw.cwd ? { cwd: raw.cwd } : {}),
  };
}

/** Only loopback endpoints are trusted with the local credential. */
function isLoopback(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

export class ExternalApi {
  #cache: { key: string; endpoint: string; token: string } | undefined;

  constructor(
    private readonly credentialsPath: string,
    private readonly timeoutMs = 3000,
    private readonly fetchImpl: typeof fetch = fetch,
    /** Ends every request under way when it aborts (the backend stopping). */
    private readonly signal?: AbortSignal,
  ) {}

  async #credentials(): Promise<{ endpoint: string; token: string } | undefined> {
    const info = await stat(this.credentialsPath).catch(() => undefined);
    if (!info) return undefined;
    const key = `${info.mtimeMs}:${info.size}`;
    if (this.#cache?.key === key) return this.#cache;
    const raw = JSON.parse(await readFile(this.credentialsPath, "utf8")) as unknown;
    if (!isRecord(raw) || typeof raw.endpoint !== "string" || typeof raw.token !== "string") return undefined;
    if (!isLoopback(raw.endpoint)) return undefined;
    this.#cache = { key, endpoint: raw.endpoint.replace(/\/+$/u, ""), token: raw.token };
    return this.#cache;
  }

  async #post(route: string, body: Record<string, unknown>): Promise<unknown> {
    this.signal?.throwIfAborted();
    const credentials = await this.#credentials();
    if (!credentials) return undefined;
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const response = await this.fetchImpl(`${credentials.endpoint}${route}`, {
      method: "POST",
      headers: { authorization: `Bearer ${credentials.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: this.signal ? AbortSignal.any([timeout, this.signal]) : timeout,
    });
    if (!response.ok) {
      // codexhost's name for the error, never its message: that is not kept anywhere.
      const answer = (await response.json().catch(() => undefined)) as unknown;
      const code = isRecord(answer) && isRecord(answer.error) && typeof answer.error.code === "string" ? answer.error.code.slice(0, 64) : undefined;
      throw new HttpError(response.status, `${route} answered HTTP ${response.status}${code ? ` (${code})` : ""}`, code);
    }
    return response.json();
  }

  /** A conversation's title, state, agent and working folder; on its remote host when `hostId` names one. */
  async readThread(threadId: string, hostId?: string): Promise<ApiThread | undefined> {
    return toThread(await this.#post("/v1/thread/read", { threadId, ...onHost(hostId) }));
  }

  /**
   * One page of all Threads across workspaces, most recently updated first: this machine's, or with
   * `hostId` a remote host's (each entry then names that host).
   */
  async listThreads(options: { cursor?: string; limit?: number; hostId?: string } = {}): Promise<{ threads: ListedThread[]; nextCursor: string | null }> {
    const raw = await this.#post("/v1/thread/list", {
      limit: options.limit ?? 100,
      sort: "updated-desc",
      ...(options.cursor ? { cursor: options.cursor } : {}),
      ...onHost(options.hostId),
    });
    if (!isRecord(raw) || !Array.isArray(raw.threads)) return { threads: [], nextCursor: null };
    const threads = raw.threads.flatMap((thread): ListedThread[] => {
      if (!isRecord(thread) || !isThreadId(thread.threadId) || typeof thread.updatedAt !== "string") return [];
      return [
        {
          threadId: thread.threadId,
          updatedAt: thread.updatedAt,
          ...(typeof thread.createdAt === "string" ? { createdAt: thread.createdAt } : {}),
          ...(typeof thread.title === "string" && thread.title.trim() ? { title: thread.title.trim() } : {}),
          ...(typeof thread.cwd === "string" && thread.cwd ? { cwd: thread.cwd } : {}),
          ...(typeof thread.status === "string" ? { status: normalizeStatus(thread.status) } : {}),
          ...(typeof thread.harnessId === "string" ? { harnessId: thread.harnessId } : {}),
          ...onHost(typeof thread.hostId === "string" ? thread.hostId : undefined),
        },
      ];
    });
    return { threads, nextCursor: typeof raw.nextCursor === "string" ? raw.nextCursor : null };
  }

  /** Turns with the user's messages and the final agent reply; the latest 10 without a range. On its remote host when `hostId` names one. */
  async readTurns(threadId: string, range?: { from: number; to: number }, hostId?: string): Promise<{ totalTurns: number; turns: ApiTurn[] }> {
    const raw = await this.#post("/v1/thread/read", { threadId, view: "messages", ...(range ?? {}), ...onHost(hostId) });
    if (!isRecord(raw)) return { totalTurns: 0, turns: [] };
    const turns = Array.isArray(raw.turns)
      ? raw.turns.flatMap((turn): ApiTurn[] => {
          if (!isRecord(turn) || typeof turn.turnNumber !== "number") return [];
          const messages = Array.isArray(turn.messages)
            ? turn.messages.flatMap((message) =>
                isRecord(message) && typeof message.text === "string"
                  ? [{ role: message.role === "user" ? ("user" as const) : ("agent" as const), text: message.text }]
                  : [],
              )
            : [];
          return [{ turnNumber: turn.turnNumber, status: typeof turn.status === "string" ? turn.status : "", messages }];
        })
      : [];
    return { totalTurns: typeof raw.totalTurns === "number" ? raw.totalTurns : 0, turns };
  }

  async threadCwd(threadId: string, hostId?: string): Promise<string | undefined> {
    return (await this.readThread(threadId, hostId))?.cwd;
  }

  /**
   * The computers paired with codexhost Web (`/v1/host/list`): their ids, names and whether they
   * are connected. Nothing else codexhost says about them (projects, folders) is read.
   */
  async listHosts(): Promise<RemoteHostInfo[]> {
    const raw = await this.#post("/v1/host/list", {});
    if (!isRecord(raw) || !Array.isArray(raw.hosts)) return [];
    return raw.hosts.flatMap((host): RemoteHostInfo[] => {
      if (!isRecord(host) || !isRemoteHostId(host.hostId)) return [];
      const name = typeof host.displayName === "string" ? Array.from(host.displayName.trim()).slice(0, 120).join("") : "";
      return [{ hostId: host.hostId, ...(name ? { name } : {}), online: host.online === true, state: hostState(host.state) }];
    });
  }

  /**
   * Starts a delegated child conversation (`codexhost delegate start`); needs a dispatching client.
   * Throws ApiNotReachedError when codexhost was never reached, HttpError when it said no; after any
   * other failure (no answer in time) the child may or may not have opened.
   */
  async startDelegation(body: Record<string, unknown>): Promise<{ threadId: string }> {
    let raw: unknown;
    try {
      raw = await this.#post("/v1/delegate/start", body);
    } catch (error) {
      const cause = error instanceof Error && isRecord(error.cause) ? error.cause : undefined;
      if (cause?.code === "ECONNREFUSED") throw new ApiNotReachedError("codexhost's local API is not running", { cause: error });
      throw error;
    }
    if (raw === undefined) throw new ApiNotReachedError("codexhost's local API is not available");
    if (!isRecord(raw) || typeof raw.threadId !== "string") throw new Error("codexhost did not return the new conversation");
    return { threadId: raw.threadId };
  }

  /** A conversation's delegated children; on its remote host when `hostId` names one (they are there too). */
  async listChildren(parentThreadId: string, hostId?: string): Promise<ApiThread[]> {
    const raw = await this.#post("/v1/thread/list", { parentThreadId, limit: 100, ...onHost(hostId) });
    if (!isRecord(raw) || !Array.isArray(raw.threads)) return [];
    return raw.threads.flatMap((thread) => toThread(thread) ?? []);
  }
}
