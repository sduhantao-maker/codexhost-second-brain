/**
 * The state file on disk, shared by the command line and the backend. Writers take a lock
 * directory and replace the file atomically; readers never lock.
 *
 * Every store of the extension (the state, favorites, the link index, the summary counts, the
 * attachment owners) locks with `withLock`: a lock directory that holds its owner's token, kept
 * fresh while the work runs and removed only while it is still its owner's. A lock left by a
 * process that died is taken over once it has stayed untouched for a while. Takeovers and
 * releases go through a short guard directory one at a time, so two waiters never both take a
 * lock over and a slow holder never frees the next holder's lock.
 *
 * A damaged file (not JSON, or not a file the extension knows) is set aside as
 * `<name>.corrupt-<time>.json` before a write replaces it, the newest three kept per file. A file
 * a newer version of the extension wrote is never replaced: writes fail with NEWER_VERSION, and
 * so do the stores' reads, so every surface can say why.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, rmdir, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { emptyStateV2, normalizeStateV2, STATE_V2, type StateV2 } from "../core/conversation.js";
import { pruneV2, type V2Context } from "../core/conversation-ops.js";
import { DEFAULT_SETTINGS, LIMITS, MainlineError, readSettingsValues, type Settings } from "../core/model.js";

export interface StorePaths {
  dir: string;
  state: string;
  lock: string;
  settings: string;
}

export function storePaths(dir: string): StorePaths {
  return {
    dir,
    state: path.join(dir, "state.json"),
    lock: path.join(dir, "state.lock"),
    settings: path.join(dir, "settings.json"),
  };
}

const LOCK_RETRY_MS = 25;
/** A lock untouched this long is suspect; a live holder refreshes its lock every LOCK_REFRESH_MS. */
const LOCK_STALE_MS = 10_000;
const LOCK_REFRESH_MS = 500;
/**
 * A suspect lock is taken over only once it has stayed exactly as it was this long, so that a
 * holder that was asleep (a closed laptop, a clock that jumped) refreshes it first.
 */
const LOCK_CONFIRM_MS = 1_500;
/** The guard is held for a few file operations: one older than this was left by a process that died. */
const GUARD_STALE_MS = 2_000;
const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
/** The file in a lock directory that names its holder. */
const OWNER = "owner";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const code = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error ? (error as { code: unknown }).code : undefined;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// ---------------------------------------------------------------------------------------------
// Versioned JSON files: damaged ones are set aside, newer ones left alone.

/** A versioned JSON file of the extension, as found on disk. */
export type StoredJson =
  | { kind: "missing" }
  /** Not JSON, or not a version this code knows (and not a newer one): set aside before a write replaces it. */
  | { kind: "damaged" }
  /** Written by a newer version of the extension: never replaced. */
  | { kind: "newer"; version: number }
  | { kind: "ok"; raw: Record<string, unknown>; version: number; text: string };

/**
 * Reads a JSON file whose top level carries a `version`, one of `known`. A missing file is
 * "missing"; any other failure to read it is thrown, since it may hold what cannot be read now.
 */
export async function readStoredJson(file: string, known: readonly number[]): Promise<StoredJson> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (code(error) === "ENOENT") return { kind: "missing" };
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: "damaged" };
  }
  if (!isRecord(raw) || typeof raw.version !== "number" || !Number.isFinite(raw.version)) return { kind: "damaged" };
  if (raw.version > Math.max(...known)) return { kind: "newer", version: raw.version };
  if (!known.includes(raw.version)) return { kind: "damaged" };
  return { kind: "ok", raw, version: raw.version, text };
}

/** What reads and writes of a file a newer version wrote fail with. */
export function newerVersionError(file: string, version: number, known: number): MainlineError {
  return new MainlineError(
    "NEWER_VERSION",
    `${path.basename(file)} was written by a newer version of Second Brain (format ${version}; this version reads up to format ${known}). Update Second Brain; the file was left as it is.`,
  );
}

/** Damaged copies kept of each file, the newest. */
export const DAMAGED_COPIES_KEPT = 3;

/**
 * Moves a damaged file aside as `<name>.corrupt-<time>.json` next to it, keeping the newest
 * three such copies of it. Returns where it went, or undefined when there was no file.
 */
export async function setAside(file: string, now = Date.now()): Promise<string | undefined> {
  const dir = path.dirname(file);
  const base = path.basename(file, ".json");
  const time = new Date(now).toISOString().replace(/[:.]/gu, "-");
  let aside = path.join(dir, `${base}.corrupt-${time}.json`);
  for (let n = 2; await stat(aside).then(() => true, () => false); n += 1) aside = path.join(dir, `${base}.corrupt-${time}-${n}.json`);
  try {
    await rename(file, aside);
  } catch (error) {
    if (code(error) === "ENOENT") return undefined;
    throw error;
  }
  const prefix = `${base}.corrupt-`;
  const copies = (await readdir(dir).catch(() => [] as string[])).filter((name) => name.startsWith(prefix) && name.endsWith(".json")).sort();
  for (const name of copies.slice(0, Math.max(0, copies.length - DAMAGED_COPIES_KEPT))) await rm(path.join(dir, name), { force: true });
  return aside;
}

// ---------------------------------------------------------------------------------------------
// The lock

/** What a holder can ask of its lock while it holds it. */
export interface LockLease {
  /**
   * Throws LOCKED when the lock is no longer this holder's (it was taken over as stale while this
   * process was stopped). Called right before writing, so a writer that lost its lock writes nothing.
   */
  check(): Promise<void>;
}

interface LockSeen {
  ino: number;
  mtimeMs: number;
  owner: string | undefined;
}

const untouched = (seen: Pick<LockSeen, "mtimeMs">) => Date.now() - seen.mtimeMs > LOCK_STALE_MS;

/** The lock as a waiter sees it; who holds it is read only once it looks abandoned. */
async function lookAt(lock: string): Promise<LockSeen | undefined> {
  const info = await stat(lock).catch(() => undefined);
  if (!info) return undefined;
  const owner = untouched(info) ? await readFile(path.join(lock, OWNER), "utf8").catch(() => undefined) : undefined;
  return { ino: info.ino, mtimeMs: info.mtimeMs, owner };
}

const sameLock = (a: LockSeen, b: LockSeen) => a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.owner === b.owner;
const guardOf = (lock: string) => `${lock}.guard`;

/** Takes the guard when it is free, and breaks one left by a process that died (then it is for the next try). */
async function tryGuard(lock: string): Promise<boolean> {
  const guard = guardOf(lock);
  try {
    await mkdir(guard);
    return true;
  } catch (error) {
    if (code(error) !== "EEXIST") return false;
  }
  const info = await stat(guard).catch(() => undefined);
  if (info && Date.now() - info.mtimeMs > GUARD_STALE_MS) await rm(guard, { recursive: true, force: true }).catch(() => undefined);
  return false;
}

const dropGuard = (lock: string) => rm(guardOf(lock), { recursive: true, force: true }).catch(() => undefined);

/** Removes a lock whose holder is gone, under the guard and only if it is still exactly the lock that was seen. */
async function takeOver(lock: string, seen: LockSeen): Promise<void> {
  if (!(await tryGuard(lock))) return;
  try {
    const now = await lookAt(lock);
    if (now && sameLock(now, seen) && untouched(now)) await rm(lock, { recursive: true, force: true });
  } finally {
    await dropGuard(lock);
  }
}

async function acquire(lock: string, token: string, timeoutMs: number): Promise<void> {
  const started = performance.now();
  let suspect: { seen: LockSeen; since: number } | undefined;
  for (;;) {
    try {
      await mkdir(lock);
    } catch (error) {
      if (code(error) !== "EEXIST") throw error;
      const seen = await lookAt(lock);
      if (!seen || !untouched(seen)) suspect = undefined;
      else if (!suspect || !sameLock(suspect.seen, seen)) suspect = { seen, since: performance.now() };
      else if (performance.now() - suspect.since >= LOCK_CONFIRM_MS) {
        await takeOver(lock, seen);
        suspect = undefined;
        continue;
      }
      if (performance.now() - started >= timeoutMs)
        throw new MainlineError("LOCKED", "The mainline state is busy; try again in a moment");
      await sleep(LOCK_RETRY_MS);
      continue;
    }
    try {
      await writeFile(path.join(lock, OWNER), token, { flag: "wx", mode: 0o600 });
      return;
    } catch (error) {
      // Only an empty directory is the one just made here.
      await rmdir(lock).catch(() => undefined);
      throw error;
    }
  }
}

/** A lock while it is held: refreshed so it never looks abandoned, and released only while it is its holder's. */
class Hold {
  readonly #lock: string;
  readonly #token: string;
  readonly #timer: ReturnType<typeof setInterval>;
  #refreshing: Promise<void> | undefined;
  #lost = false;

  constructor(lock: string, token: string) {
    this.#lock = lock;
    this.#token = token;
    this.#timer = setInterval(() => {
      this.#refreshing ??= this.#refresh()
        .catch(() => undefined)
        .finally(() => {
          this.#refreshing = undefined;
        });
    }, LOCK_REFRESH_MS);
    this.#timer.unref?.();
  }

  async #ours(): Promise<boolean> {
    return (await readFile(path.join(this.#lock, OWNER), "utf8").catch(() => undefined)) === this.#token;
  }

  async #refresh(): Promise<void> {
    if (this.#lost) return;
    if (!(await this.#ours())) {
      this.#lost = true;
      return;
    }
    const now = new Date();
    await utimes(this.#lock, now, now);
  }

  readonly lease: LockLease = {
    check: async () => {
      if (!this.#lost && (await this.#ours())) return;
      this.#lost = true;
      throw new MainlineError("LOCKED", "The lock was taken over while this change waited; nothing was saved, try again");
    },
  };

  async release(): Promise<void> {
    clearInterval(this.#timer);
    await this.#refreshing;
    // Under the guard, so that no takeover runs between seeing the lock is ours and removing it.
    // A guard that stays busy (its holder died) is broken after GUARD_STALE_MS; past that, go on without it.
    const until = performance.now() + GUARD_STALE_MS + 500;
    let guarded = await tryGuard(this.#lock);
    while (!guarded && performance.now() < until) {
      await sleep(LOCK_RETRY_MS);
      guarded = await tryGuard(this.#lock);
    }
    try {
      if (await this.#ours()) await rm(this.#lock, { recursive: true, force: true });
    } finally {
      if (guarded) await dropGuard(this.#lock);
    }
  }
}

/**
 * Runs `fn` while holding the lock `paths.lock`. `fn` gets a lease to check, right before it
 * writes, that the lock is still its own. Fails with LOCKED when the lock stays busy `timeoutMs`.
 */
export async function withLock<T>(
  paths: Pick<StorePaths, "dir" | "lock">,
  fn: (lease: LockLease) => Promise<T>,
  timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
): Promise<T> {
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  const token = `${process.pid}-${randomBytes(8).toString("hex")}`;
  await acquire(paths.lock, token, timeoutMs);
  const hold = new Hold(paths.lock, token);
  try {
    return await fn(hold.lease);
  } finally {
    // A lock that cannot be removed goes stale and is taken over; it must not hide fn's outcome.
    await hold.release().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------
// The state

interface LoadedState {
  state: StateV2;
  /** The version the file had, when it was read. */
  version?: number;
  text?: string;
}

/** The state as `readState` reads it, with the version and text of the file it came from. */
async function loadState(paths: StorePaths, recover: boolean): Promise<LoadedState> {
  const stored = await readStoredJson(paths.state, [1, STATE_V2]);
  if (stored.kind === "missing") return { state: emptyStateV2() };
  if (stored.kind === "newer") throw newerVersionError(paths.state, stored.version, STATE_V2);
  if (stored.kind === "ok")
    try {
      // Version 1 files are migrated in memory and saved as version 2 on the next change.
      return { state: normalizeStateV2(stored.raw), version: stored.version, text: stored.text };
    } catch {
      // Not a state after all: damaged.
    }
  if (recover) await setAside(paths.state);
  return { state: emptyStateV2() };
}

/**
 * Reads the state. A missing file is an empty state. A damaged file is set aside when `recover`
 * is true (only while holding the lock) and treated as empty either way. A file written by a newer
 * version fails with NEWER_VERSION and is left alone.
 */
export async function readState(paths: StorePaths, options: { recover?: boolean } = {}): Promise<StateV2> {
  return (await loadState(paths, options.recover === true)).state;
}

/**
 * Replaces a JSON file atomically: write a private temporary file, then rename it into place.
 * Compact unless an indent is given: the files written here are machine-written, and indentation
 * alone would be a third of a large state. The size cap applies to the text as written: past it,
 * nothing is written and FILE_FULL names the file (the state and the favorites say STATE_FULL and
 * FAVORITES_FULL instead).
 */
export async function writeJsonFile(file: string, value: unknown, maxBytes: number, indent?: number): Promise<void> {
  const text = `${JSON.stringify(value, null, indent)}\n`;
  if (Buffer.byteLength(text) > maxBytes) throw new MainlineError("FILE_FULL", `${path.basename(file)} is full`);
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function writeState(paths: StorePaths, state: StateV2): Promise<void> {
  try {
    // Compact: with every conversation summarized, indentation alone would be a third of the file.
    await writeJsonFile(paths.state, state, LIMITS.stateBytes);
  } catch (error) {
    if (error instanceof MainlineError && error.code === "FILE_FULL")
      throw new MainlineError("STATE_FULL", "The mainline state is full; delete mainlines you no longer need in the overview");
    throw error;
  }
}

export interface UpdateResult<T> {
  state: StateV2;
  result: T;
  changed: boolean;
}

/** Conversations `after` has that `before` did not. */
function addedConversations(before: StateV2, after: StateV2): Set<string> {
  return new Set(Object.keys(after.conversations).filter((threadId) => !Object.hasOwn(before.conversations, threadId)));
}

/**
 * Applies `mutate` to a copy of the state under the lock and saves it if anything changed.
 * `rev` goes up by one on every saved change.
 */
export async function updateState<T>(
  paths: StorePaths,
  mutate: (draft: StateV2, ctx: V2Context) => T,
  options: { now?: number; timeoutMs?: number; random?: () => number } = {},
): Promise<UpdateResult<T>> {
  return withLock(
    paths,
    async (lease) => {
      const loaded = await loadState(paths, true);
      const current = loaded.state;
      const ctx: V2Context = {
        now: options.now ?? Date.now(),
        ...(options.random ? { random: options.random } : {}),
      };
      const draft = structuredClone(current);
      const result = mutate(draft, ctx);
      // The cap never removes a record this change made: with nothing else to go, the change is refused.
      pruneV2(draft, ctx, addedConversations(current, draft));
      // A migrated version 1 file is written out even when nothing else changed.
      const migrated = loaded.version === 1;
      if (!migrated && JSON.stringify(draft) === JSON.stringify(current)) return { state: current, result, changed: false };
      await lease.check();
      // Keep the version 1 file once, so going back to 0.2 stays possible.
      if (migrated && loaded.text !== undefined)
        await writeFile(path.join(paths.dir, "state.v1.json"), loaded.text, { flag: "wx", mode: 0o600 }).catch(() => undefined);
      draft.rev = current.rev + 1;
      await writeState(paths, draft);
      return { state: draft, result, changed: true };
    },
    options.timeoutMs,
  );
}

/** The plugin settings codexhost keeps next to the state: `{ settingsRevision, values }`. */
export async function readSettings(paths: StorePaths): Promise<Settings> {
  try {
    const raw = JSON.parse(await readFile(paths.settings, "utf8")) as { values?: unknown };
    return readSettingsValues(raw?.values);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Changes whenever the file is replaced. */
export async function fileSignature(file: string): Promise<string> {
  try {
    const info = await stat(file);
    return `${info.mtimeMs}:${info.size}:${info.ino}`;
  } catch {
    return "missing";
  }
}

export async function stateSignature(paths: StorePaths): Promise<string> {
  return fileSignature(paths.state);
}
