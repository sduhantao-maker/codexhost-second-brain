/**
 * Which child conversation each folder of kept attachments belongs to: `attachments/owners.json`,
 * next to the folders, with its own lock. Apart from the state on purpose: a damaged or lost record
 * only makes clearing more careful (a folder without an owner goes only with "clear all"), and it
 * can never take the mainlines with it. A damaged record is set aside before a write replaces it;
 * one a newer version wrote is never replaced, and reading it fails with NEWER_VERSION.
 */
import path from "node:path";
import { isUploadId } from "../core/attachments.js";
import { isThreadId } from "../core/model.js";
import { newerVersionError, readStoredJson, setAside, withLock, writeJsonFile, type StoredJson } from "./store.js";

const VERSION = 1;
const MAX_BYTES = 4 * 1024 * 1024;

export interface AttachmentOwner {
  /** The child conversation the files were sent with. */
  child: string;
  /** The conversation it was opened from. */
  parent: string;
  /** When it was opened. */
  at: number;
}

/** By upload id, which is also the folder's name. */
export type Owners = Record<string, AttachmentOwner>;

export interface OwnersPaths {
  dir: string;
  file: string;
  lock: string;
}

export function ownersPaths(attachmentsDir: string): OwnersPaths {
  return { dir: attachmentsDir, file: path.join(attachmentsDir, "owners.json"), lock: path.join(attachmentsDir, "owners.lock") };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Keeps the well-formed entries; one keyed by anything but an upload id is no record. */
function normalizeOwners(raw: unknown): Owners {
  const owners: Owners = {};
  if (!isRecord(raw) || raw.version !== VERSION || !isRecord(raw.owners)) return owners;
  for (const [id, value] of Object.entries(raw.owners))
    if (isUploadId(id) && isRecord(value) && isThreadId(value.child) && isThreadId(value.parent) && typeof value.at === "number" && Number.isFinite(value.at))
      owners[id] = { child: value.child, parent: value.parent, at: value.at };
  return owners;
}

function ownersOf(paths: OwnersPaths, stored: StoredJson): Owners {
  if (stored.kind === "newer") throw newerVersionError(paths.file, stored.version, VERSION);
  // Missing or damaged: every folder counts as "owner unknown".
  return stored.kind === "ok" ? normalizeOwners(stored.raw) : {};
}

export async function readOwners(paths: OwnersPaths): Promise<Owners> {
  return ownersOf(paths, await readStoredJson(paths.file, [VERSION]));
}

/** Applies `mutate` under the lock and saves the record if anything changed. */
export async function updateOwners(paths: OwnersPaths, mutate: (owners: Owners) => void | Promise<void>): Promise<void> {
  await withLock(paths, async (lease) => {
    const stored = await readStoredJson(paths.file, [VERSION]);
    const current = ownersOf(paths, stored);
    const draft = structuredClone(current);
    await mutate(draft);
    if (JSON.stringify(draft) === JSON.stringify(current)) return;
    await lease.check();
    if (stored.kind === "damaged") await setAside(paths.file);
    await writeJsonFile(paths.file, { version: VERSION, owners: draft }, MAX_BYTES);
  });
}
