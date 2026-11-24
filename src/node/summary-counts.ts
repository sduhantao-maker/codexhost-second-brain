/**
 * How many times a day a conversation was sent to a model for a summary, by model and by reason,
 * in a small file of its own (`summary-counts.json`, the last 14 days) with its own lock. The
 * daily limit on automatic summaries is kept from it, so restarting the backend does not reset it.
 * A damaged file is set aside when the next call is counted, and the caller is told so (the day's
 * count starts again from nothing); one a newer version wrote is never replaced, and reading it
 * fails with NEWER_VERSION, so no call is made that cannot be counted.
 */
import path from "node:path";
import { newerVersionError, readStoredJson, setAside, withLock, writeJsonFile, type StoredJson } from "./store.js";

export type CountedEngine = "claude" | "codex";
export type CountedReason = "auto" | "manual" | "backfill";
export type DayCounts = Record<CountedEngine, Record<CountedReason, number>>;

export interface SummaryCounts {
  version: 1;
  /** Local calendar day (YYYY-MM-DD) to that day's calls. */
  days: Record<string, DayCounts>;
}

export interface CountsPaths {
  dir: string;
  file: string;
  lock: string;
}

/** Days kept, today included. */
export const COUNTED_DAYS = 14;
const MAX_BYTES = 64 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const ENGINES: readonly CountedEngine[] = ["claude", "codex"];
const REASONS: readonly CountedReason[] = ["auto", "manual", "backfill"];
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/u;

export function summaryCountsPaths(dir: string): CountsPaths {
  return { dir, file: path.join(dir, "summary-counts.json"), lock: path.join(dir, "summary-counts.lock") };
}

export function emptyCounts(): SummaryCounts {
  return { version: 1, days: {} };
}

export function emptyDay(): DayCounts {
  return { claude: { auto: 0, manual: 0, backfill: 0 }, codex: { auto: 0, manual: 0, backfill: 0 } };
}

/** The local calendar day of a time, as YYYY-MM-DD. */
export function dayKey(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** That day's calls, zeros where nothing was counted. */
export function dayOf(counts: SummaryCounts, at: number): DayCounts {
  const day = emptyDay();
  const kept = counts.days[dayKey(at)];
  if (kept) for (const engine of ENGINES) for (const reason of REASONS) day[engine][reason] = kept[engine][reason];
  return day;
}

/** Automatic calls of a day, both models together: what the daily limit counts. */
export function autoCalls(day: DayCounts): number {
  return day.claude.auto + day.codex.auto;
}

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Keeps what is well formed of a parsed file; anything else counts as nothing. */
export function normalizeCounts(raw: unknown): SummaryCounts {
  const counts = emptyCounts();
  if (!isRecord(raw) || !isRecord(raw.days)) return counts;
  for (const [key, value] of Object.entries(raw.days)) {
    if (!DAY_KEY.test(key) || !isRecord(value)) continue;
    const day = emptyDay();
    for (const engine of ENGINES) {
      const calls = value[engine];
      if (isRecord(calls)) for (const reason of REASONS) if (isCount(calls[reason])) day[engine][reason] = calls[reason];
    }
    counts.days[key] = day;
  }
  return counts;
}

/** Drops days older than the last `COUNTED_DAYS`. */
export function pruneCounts(counts: SummaryCounts, at: number): void {
  const oldest = dayKey(at - (COUNTED_DAYS - 1) * DAY_MS);
  for (const key of Object.keys(counts.days)) if (key < oldest) delete counts.days[key];
}

function countsOf(paths: CountsPaths, stored: StoredJson): SummaryCounts {
  if (stored.kind === "newer") throw newerVersionError(paths.file, stored.version, 1);
  return stored.kind === "ok" ? normalizeCounts(stored.raw) : emptyCounts();
}

/** The counts on disk; a missing or damaged file counts as nothing so far. */
export async function readSummaryCounts(paths: CountsPaths): Promise<SummaryCounts> {
  return countsOf(paths, await readStoredJson(paths.file, [1]));
}

export interface CountedCall {
  engine: CountedEngine;
  reason: CountedReason;
  at: number;
  /** For automatic calls: none is counted (or made) once the day has this many. */
  limit?: number;
}

export interface CountResult {
  counted: boolean;
  counts: SummaryCounts;
  /**
   * Set when the file was damaged: where it was set aside. The counts, and so the day's
   * automatic limit, started again from nothing; the caller should log it.
   */
  setAside?: string;
}

/**
 * Counts one call before it is made, under the lock, so two calls at once cannot both take the
 * last one of the day. Returns whether it was counted, and the counts as they now are.
 */
export async function countSummaryCall(paths: CountsPaths, call: CountedCall): Promise<CountResult> {
  return withLock(paths, async (lease) => {
    const stored = await readStoredJson(paths.file, [1]);
    const counts = countsOf(paths, stored);
    pruneCounts(counts, call.at);
    const key = dayKey(call.at);
    const day = counts.days[key] ?? emptyDay();
    if (call.limit !== undefined && autoCalls(day) >= call.limit) return { counted: false, counts };
    day[call.engine][call.reason] += 1;
    counts.days[key] = day;
    await lease.check();
    const aside = stored.kind === "damaged" ? await setAside(paths.file) : undefined;
    await writeJsonFile(paths.file, counts, MAX_BYTES, undefined);
    return { counted: true, counts, ...(aside ? { setAside: aside } : {}) };
  });
}

/** Takes back a call counted for that day that sent nothing after all (the tool was missing). Returns the counts as they now are. */
export async function uncountSummaryCall(paths: CountsPaths, call: Omit<CountedCall, "limit">): Promise<SummaryCounts> {
  return withLock(paths, async (lease) => {
    const stored = await readStoredJson(paths.file, [1]);
    const counts = countsOf(paths, stored);
    const day = counts.days[dayKey(call.at)];
    // A damaged file has nothing to take back: it stays as it is until the next call is counted.
    if (!day || day[call.engine][call.reason] <= 0) return counts;
    day[call.engine][call.reason] -= 1;
    await lease.check();
    await writeJsonFile(paths.file, counts, MAX_BYTES, undefined);
    return counts;
  });
}
