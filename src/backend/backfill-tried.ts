/**
 * Which conversations the backfill under way has already tried, kept in `backfill-tried.json` next
 * to the state, so that it never sends one twice, not even after a restart. A conversation is
 * written down before its text goes to the model. Only the backend writes the file; a backfill
 * asked for at another time starts a new list, and a finished or stopped one deletes it.
 */
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { writeJsonFile } from "../node/store.js";

export const TRIED_FILE = "backfill-tried.json";
/** Room for tens of thousands of conversation ids. */
const MAX_BYTES = 4 * 1024 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export class BackfillTried {
  readonly #file: string;
  /** The backfill (by when it was asked for) whose list is in memory, and the list. */
  #requestedAt: number | undefined;
  #ids = new Set<string>();
  /** Writes in the order they were asked for. */
  #writing: Promise<void> = Promise.resolve();

  constructor(dir: string) {
    this.#file = path.join(dir, TRIED_FILE);
  }

  /** The conversations the backfill asked for at `requestedAt` has tried, read from the file the first time. */
  async load(requestedAt: number): Promise<ReadonlySet<string>> {
    if (this.#requestedAt === requestedAt) return this.#ids;
    let ids = new Set<string>();
    try {
      const raw = JSON.parse(await readFile(this.#file, "utf8")) as unknown;
      if (isRecord(raw) && raw.requestedAt === requestedAt && Array.isArray(raw.tried))
        ids = new Set(raw.tried.filter((id): id is string => typeof id === "string" && id.length > 0));
    } catch {
      // Not written yet, or of an earlier backfill: nothing tried.
    }
    // Another call may have loaded it meanwhile; the first one stays.
    if (this.#requestedAt !== requestedAt) {
      this.#requestedAt = requestedAt;
      this.#ids = ids;
    }
    return this.#ids;
  }

  /** What is in memory for that backfill, without reading anything. */
  known(requestedAt: number | undefined): ReadonlySet<string> {
    return requestedAt !== undefined && this.#requestedAt === requestedAt ? this.#ids : new Set();
  }

  /**
   * Writes a conversation down as tried, before it is sent. It counts as tried at once, also when
   * saving fails (then this throws, and the caller sends nothing): never twice wins over never.
   */
  async add(requestedAt: number, threadId: string): Promise<void> {
    await this.load(requestedAt);
    // Another backfill was asked for meanwhile: this one sends nothing more.
    if (this.#requestedAt !== requestedAt) throw new Error("the backfill was asked for again meanwhile");
    if (this.#ids.has(threadId)) return;
    this.#ids.add(threadId);
    // Taken now: the writes go in order, each with everything tried before it.
    const tried = [...this.#ids];
    const write = this.#writing.then(() => writeJsonFile(this.#file, { version: 1, requestedAt, tried }, MAX_BYTES));
    this.#writing = write.catch(() => undefined);
    await write;
  }

  /** The backfill is over: its list goes. */
  async clear(): Promise<void> {
    this.#requestedAt = undefined;
    this.#ids = new Set();
    const removal = this.#writing.then(() => rm(this.#file, { force: true }));
    this.#writing = removal.catch(() => undefined);
    await removal;
  }
}
