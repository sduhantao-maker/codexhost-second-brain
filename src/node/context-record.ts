/**
 * What an agent has already been shown of a conversation's mainline, so later messages get only
 * what changed: `<data dir>/context/<conversation>.<channel>.json`, one small file per conversation
 * and channel (the Claude Code hook, or `mainline show`). Apart from the state on purpose: no lock,
 * no growth of state.json, and a missing or damaged record only means the full text comes again.
 * The record keeps fingerprints, not the mainline's text. A damaged record is set aside before it
 * is replaced; one a newer version wrote reads as nothing seen (so the full text comes) and is
 * never replaced: writing it fails with NEWER_VERSION.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { ContextSeen } from "../core/protocol-v2.js";
import { newerVersionError, readStoredJson, setAside, writeJsonFile } from "./store.js";

export type ContextChannel = "hook" | "show";

const VERSION = 1;
const MAX_BYTES = 16 * 1024;
/** Records unused this long are of no use (the full text is due anyway) and go. */
const UNUSED_MS = 3 * 24 * 60 * 60 * 1000;

export function contextDir(dataDir: string): string {
  return path.join(dataDir, "context");
}

/** A short fingerprint of a text. */
export function fingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** A file name for any conversation id: the id itself when it is plain, else its hash. */
export function contextFile(dataDir: string, threadId: string, channel: ContextChannel): string {
  const name = /^[\w-]{1,128}$/u.test(threadId) ? threadId : `h-${createHash("sha256").update(threadId).digest("hex").slice(0, 32)}`;
  return path.join(contextDir(dataDir), `${name}.${channel}.json`);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function normalizeSeen(raw: unknown): ContextSeen | undefined {
  if (!isRecord(raw) || raw.version !== VERSION) return undefined;
  const { session, fullAt, rules, since, status } = raw;
  if (typeof fullAt !== "number" || !Number.isFinite(fullAt)) return undefined;
  if (typeof since !== "number" || !Number.isInteger(since) || since < 0) return undefined;
  if (typeof rules !== "string" || typeof status !== "string") return undefined;
  if (session !== undefined && typeof session !== "string") return undefined;
  return { ...(typeof session === "string" ? { session } : {}), fullAt, rules, since, status };
}

/** The record, or undefined when it is missing, damaged or of a newer version. */
export async function readSeen(dataDir: string, threadId: string, channel: ContextChannel): Promise<ContextSeen | undefined> {
  try {
    const stored = await readStoredJson(contextFile(dataDir, threadId, channel), [VERSION]);
    return stored.kind === "ok" ? normalizeSeen(stored.raw) : undefined;
  } catch {
    return undefined;
  }
}

/** Replaces the record atomically, readable by the user only; a damaged one is set aside first. */
export async function writeSeen(dataDir: string, threadId: string, channel: ContextChannel, seen: ContextSeen): Promise<void> {
  const file = contextFile(dataDir, threadId, channel);
  await mkdir(contextDir(dataDir), { recursive: true, mode: 0o700 });
  const stored = await readStoredJson(file, [VERSION]);
  if (stored.kind === "newer") throw newerVersionError(file, stored.version, VERSION);
  if (stored.kind === "damaged") await setAside(file);
  await writeJsonFile(file, { version: VERSION, ...seen }, MAX_BYTES);
}

/** Deletes records (and temporary files left by a crash) nobody has used for days, by their file times. */
export async function pruneSeen(dataDir: string, now = Date.now()): Promise<number> {
  const dir = contextDir(dataDir);
  let removed = 0;
  for (const entry of await readdir(dir).catch(() => [] as string[])) {
    if (!entry.endsWith(".json") && !entry.endsWith(".tmp")) continue;
    const file = path.join(dir, entry);
    const info = await stat(file).catch(() => undefined);
    if (info?.isFile() && now - info.mtimeMs > UNUSED_MS) {
      await rm(file, { force: true });
      removed += 1;
    }
  }
  return removed;
}
