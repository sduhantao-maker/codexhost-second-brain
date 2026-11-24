/**
 * Before 0.10 the extension was called Mainline (主线任务), with the id `mainline`. codexhost gives
 * each extension id a data folder of its own, so Second Brain starts with an empty one. At its first
 * start the backend copies the data of the old folder (`<root>/host-extension-data/mainline/`, a
 * sibling of its own) over, once:
 *
 * - Only when the new folder holds no data yet, and the old one has some. Data in the new folder is
 *   never replaced; the old folder is only read: nothing in it is moved, changed or deleted (child
 *   conversations keep reading their attachments from there).
 * - Copied: the data files, the agents' context records, and the attachments with their owners.
 *   Not copied: `backups/` (full copies of the user's configuration, which can hold credentials),
 *   `state.v1.json`, damaged copies set aside, logs, `bin/`, `model-runs/`, locks and temporary
 *   files.
 * - Everything is copied into a staging folder first, under the new folder's state lock; its plan
 *   (`ready.json`) is written last. Only then do the copies move into place, and the marker
 *   (`migrated-from-mainline.json`, with the time and what was copied) is written after them. A
 *   start that finds a staging folder without its plan throws it away and copies again; one that
 *   finds the plan finishes moving. With the marker there, nothing is copied again.
 * - The user's settings come along too, through codexhost (`writeSettings`), unless they were
 *   changed under the new id already.
 * - Attachments the file system can clone are copied in no time and take no room; plain copies are
 *   made only up to PLAIN_COPY_MAX_BYTES in all, under a second even on a slow disk, so the copy
 *   always fits in the 5 seconds codexhost gives the backend to start (one that did not would be
 *   stopped and tried again at every start). Beyond that, or when they cannot be read, they stay in
 *   the old folder only (where their child conversations read them anyway), and the marker says
 *   how many.
 */
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { isUploadId } from "../core/attachments.js";
import { DEFAULT_SETTINGS, readSettingsValues, type Settings } from "../core/model.js";
import { isExtensionDataDir } from "../node/paths.js";
import { storePaths, withLock, writeJsonFile } from "../node/store.js";
import { within } from "./deadline.js";

/** The extension's id before 0.10, and so the name of its data folder. */
export const OLD_EXTENSION_ID = "mainline";
/** Written into the new folder once the copy is complete. */
export const MIGRATION_MARKER = "migrated-from-mainline.json";
/** Where the copy is made before it moves into place. */
export const MIGRATION_STAGING = ".migrating-from-mainline";
/** The staging folder's plan, written once everything is copied into it. */
const READY = "ready.json";

/** The data files copied as they are. */
export const MIGRATED_FILES = ["state.json", "refs.json", "favorites.json", "summary-counts.json", "github-poll.json", "backfill-tried.json"] as const;
/** The records of `context/`: `<conversation>.<hook|show>.json` (not damaged copies or temporary files). */
const CONTEXT_RECORD = /^[\w-]{1,128}\.(?:hook|show)\.json$/u;
const OWNERS = "owners.json";
/** Attachments copied without cloning, at most: well under a second's work, even on a slow disk. */
export const PLAIN_COPY_MAX_BYTES = 64 * 1024 * 1024;
/**
 * How long the new folder's lock and codexhost's answers about the settings are waited for: the
 * copy runs while codexhost waits for the backend to start, which it allows 5 seconds.
 */
const LOCK_WAIT_MS = 2_000;
const SETTINGS_WAIT_MS = 1_000;

const code = (error: unknown) => (typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "");
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * What happened to the settings: carried over; the same as the defaults (nothing to carry); kept
 * (changed under the new id already); none to carry; unreadable (left alone); or writing them failed.
 */
export type SettingsCarried = "carried" | "same" | "kept" | "none" | "unreadable" | "failed";

/** What was copied, as the marker keeps it: names and counts, no paths. */
export interface MigrationRecord {
  version: 1;
  from: typeof OLD_EXTENSION_ID;
  /** When the copy was made. */
  at: number;
  /** The data files copied. */
  files: string[];
  /** Records of `context/` copied. */
  context: number;
  /** Folders of attachments copied, whether their owners came along, and folders left in the old folder. */
  attachments: { folders: number; owners: boolean; left?: number };
  settings: SettingsCarried;
}

export type MigrationOutcome =
  /** Copied now. */
  | { kind: "migrated"; record: MigrationRecord }
  /** Copied at an earlier start. */
  | { kind: "done" }
  /** Nothing to copy: no old folder or no data in it, the new folder has data already, or it is no codexhost data folder. */
  | { kind: "none"; reason: "nothing to copy" | "data already here" | "not a codexhost data folder" };

/** Reads and writes the extension's settings through codexhost, as the backend's context does. */
export interface SettingsAccess {
  read(): Promise<Record<string, unknown>>;
  write(values: Record<string, unknown>): Promise<unknown>;
}

export interface MigrationOptions {
  /** The extension's data folder: `<root>/host-extension-data/second-brain`. */
  dataDir: string;
  /** The old one; its sibling `mainline` by default. */
  oldDir?: string;
  settings?: SettingsAccess;
  now?: () => number;
  /** PLAIN_COPY_MAX_BYTES; tests make it small. */
  plainCopyMaxBytes?: number;
}

/** The old folder of a data folder codexhost gave this extension. */
export function oldDataDir(dataDir: string): string {
  return path.join(path.dirname(dataDir), OLD_EXTENSION_ID);
}

const lstatOf = (file: string) => lstat(file).catch((error: unknown) => (code(error) === "ENOENT" ? undefined : Promise.reject(error)));
const exists = async (file: string) => (await lstatOf(file)) !== undefined;

/** Whether the copy was made at an earlier start. */
export async function migratedEarlier(dataDir: string): Promise<boolean> {
  return exists(path.join(dataDir, MIGRATION_MARKER));
}

/** What the old folder holds to copy. */
interface Found {
  files: string[];
  context: string[];
  owners: boolean;
  folders: string[];
  /** Bytes of the attachments. */
  bytes: number;
  settings: boolean;
}

/** Names in a folder; none when it is missing. */
async function entries(dir: string) {
  return readdir(dir, { withFileTypes: true }).catch((error: unknown) => (code(error) === "ENOENT" || code(error) === "ENOTDIR" ? [] : Promise.reject(error)));
}

/** The bytes of the regular files in a folder and below it, links not followed. */
async function bytesIn(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await entries(dir)) {
    const inner = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await bytesIn(inner);
    else if (entry.isFile()) total += (await lstatOf(inner))?.size ?? 0;
  }
  return total;
}

/** What a data folder holds of the extension's data (and, for the old one, its settings). */
async function look(dir: string): Promise<Found> {
  const files: string[] = [];
  for (const name of MIGRATED_FILES) if ((await lstatOf(path.join(dir, name)))?.isFile()) files.push(name);
  const context = (await entries(path.join(dir, "context"))).filter((entry) => entry.isFile() && CONTEXT_RECORD.test(entry.name)).map((entry) => entry.name);
  const attachments = path.join(dir, "attachments");
  const listed = await entries(attachments);
  const owners = listed.some((entry) => entry.isFile() && entry.name === OWNERS);
  const folders = listed.filter((entry) => entry.isDirectory() && isUploadId(entry.name)).map((entry) => entry.name);
  let bytes = 0;
  for (const folder of folders) bytes += await bytesIn(path.join(attachments, folder));
  const settings = (await lstatOf(path.join(dir, "settings.json")))?.isFile() === true;
  return { files, context, owners, folders, bytes, settings };
}

const holdsData = (found: Found) => found.files.length > 0 || found.context.length > 0 || found.owners || found.folders.length > 0;

/** A copy readable by the user only; links and anything but folders and files are left out. */
async function copyTree(from: string, to: string, mode: number): Promise<void> {
  await mkdir(to, { recursive: true, mode: 0o700 });
  for (const entry of await entries(from)) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) await copyTree(source, target, mode);
    else if (entry.isFile()) await copyPrivate(source, target, mode);
  }
}

async function copyPrivate(from: string, to: string, mode = constants.COPYFILE_FICLONE): Promise<void> {
  await copyFile(from, to, mode | constants.COPYFILE_EXCL);
  await chmod(to, 0o600);
}

/** The plan of a staging folder whose copy is complete, or undefined. */
interface Ready {
  version: 1;
  at: number;
  files: string[];
  context: number;
  attachments: MigrationRecord["attachments"];
}

async function readReady(staging: string): Promise<Ready | undefined> {
  try {
    const raw = JSON.parse(await readFile(path.join(staging, READY), "utf8")) as unknown;
    if (!isRecord(raw) || raw.version !== 1 || typeof raw.at !== "number" || !Array.isArray(raw.files) || typeof raw.context !== "number" || !isRecord(raw.attachments)) return undefined;
    const files = raw.files.filter((name): name is string => (MIGRATED_FILES as readonly string[]).includes(name as string));
    const { folders, owners, left } = raw.attachments;
    return {
      version: 1,
      at: raw.at,
      files,
      context: raw.context,
      attachments: { folders: typeof folders === "number" ? folders : 0, owners: owners === true, ...(typeof left === "number" && left > 0 ? { left } : {}) },
    };
  } catch {
    return undefined;
  }
}

/** Copies what the old folder holds into the staging folder, and writes its plan last. */
async function stage(oldDir: string, staging: string, found: Found, now: number, plainMax: number): Promise<Ready> {
  await mkdir(staging, { recursive: true, mode: 0o700 });
  for (const name of found.files) await copyPrivate(path.join(oldDir, name), path.join(staging, name));
  let context = 0;
  try {
    if (found.context.length) await mkdir(path.join(staging, "context"), { mode: 0o700 });
    for (const name of found.context) {
      await copyPrivate(path.join(oldDir, "context", name), path.join(staging, "context", name));
      context += 1;
    }
  } catch {
    // Records of what agents were shown: without them an agent only gets the full text again.
    await rm(path.join(staging, "context"), { recursive: true, force: true });
    context = 0;
  }
  let attachments: MigrationRecord["attachments"] = { folders: 0, owners: false };
  if (found.owners || found.folders.length) {
    // Cloned where the file system can (no time, no room); plain copies only up to plainMax in all.
    const mode = found.bytes <= plainMax ? constants.COPYFILE_FICLONE : constants.COPYFILE_FICLONE_FORCE;
    const from = path.join(oldDir, "attachments");
    const to = path.join(staging, "attachments");
    try {
      await mkdir(to, { mode: 0o700 });
      if (found.owners) await copyPrivate(path.join(from, OWNERS), path.join(to, OWNERS));
      for (const folder of found.folders) await copyTree(path.join(from, folder), path.join(to, folder), mode);
      attachments = { folders: found.folders.length, owners: found.owners };
    } catch {
      // Too much to copy without cloning, or not readable: they stay in the old folder, where their
      // child conversations read them anyway.
      await rm(to, { recursive: true, force: true });
      attachments = { folders: 0, owners: false, ...(found.folders.length ? { left: found.folders.length } : {}) };
    }
  }
  const ready: Ready = { version: 1, at: now, files: found.files, context, attachments };
  await writeJsonFile(path.join(staging, READY), ready, 64 * 1024);
  return ready;
}

/** Moves a staged copy into place, unless something is there already (which then stays) or it moved at an earlier start. */
async function place(from: string, to: string): Promise<void> {
  if (!(await exists(from)) || (await exists(to))) return;
  await rename(from, to);
}

async function moveIntoPlace(staging: string, dataDir: string, ready: Ready): Promise<void> {
  for (const name of ready.files) await place(path.join(staging, name), path.join(dataDir, name));
  for (const folder of ["context", "attachments"]) {
    const staged = await entries(path.join(staging, folder));
    if (!staged.length) continue;
    await mkdir(path.join(dataDir, folder), { recursive: true, mode: 0o700 });
    // owners.json goes with the folders it names: the folders first.
    for (const entry of staged.sort((a, b) => Number(a.name === OWNERS) - Number(b.name === OWNERS)))
      await place(path.join(staging, folder, entry.name), path.join(dataDir, folder, entry.name));
  }
}

/**
 * Whether the settings under the new id are as codexhost starts them: it keeps them in the data
 * folder as `{ settingsRevision, values }` and writes that file at the first change, and what it
 * answers holds the defaults. Anything it cannot tell counts as changed.
 */
async function untouched(dataDir: string, settings: SettingsAccess): Promise<boolean> {
  try {
    const stored = JSON.parse(await readFile(path.join(dataDir, "settings.json"), "utf8")) as unknown;
    if (!isRecord(stored)) return false;
    if (typeof stored.settingsRevision !== "number" || stored.settingsRevision > 0) return false;
    if (isRecord(stored.values) && Object.keys(stored.values).length) return false;
  } catch (error) {
    if (code(error) !== "ENOENT") return false;
  }
  let current: Record<string, unknown>;
  try {
    current = await within(settings.read(), SETTINGS_WAIT_MS);
  } catch {
    return false;
  }
  if (!isRecord(current)) return false;
  return (Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>).every((key) => !Object.hasOwn(current, key) || current[key] === DEFAULT_SETTINGS[key]);
}

/** Carries the old settings over through codexhost: only the keys this version knows, with values it accepts. */
async function carrySettings(oldDir: string, dataDir: string, settings: SettingsAccess | undefined): Promise<SettingsCarried> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.join(oldDir, "settings.json"), "utf8"));
  } catch (error) {
    return code(error) === "ENOENT" ? "none" : "unreadable";
  }
  if (!isRecord(raw) || !isRecord(raw.values)) return "unreadable";
  const values = raw.values;
  const valid = readSettingsValues(values);
  const carried: Record<string, unknown> = {};
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>) if (Object.hasOwn(values, key) && values[key] === valid[key]) carried[key] = valid[key];
  if (!Object.keys(carried).length) return "none";
  if (Object.entries(carried).every(([key, value]) => DEFAULT_SETTINGS[key as keyof Settings] === value)) return "same";
  if (!settings) return "none";
  if (!(await untouched(dataDir, settings))) return "kept";
  try {
    await within(settings.write(carried), SETTINGS_WAIT_MS);
    return "carried";
  } catch {
    return "failed";
  }
}

/**
 * Copies the data of the extension's earlier folder into its own, once (see the top of the file).
 * Throws when the copy could not be made (it is tried again at the next start); the old folder is
 * left as it was either way.
 */
export async function migrateFromMainline(options: MigrationOptions): Promise<MigrationOutcome> {
  const { dataDir } = options;
  if (!isExtensionDataDir(dataDir)) return { kind: "none", reason: "not a codexhost data folder" };
  const oldDir = options.oldDir ?? oldDataDir(dataDir);
  const staging = path.join(dataDir, MIGRATION_STAGING);
  const marker = path.join(dataDir, MIGRATION_MARKER);
  if (await exists(marker)) {
    // A staging folder left after the marker was written (the start stopped right there) is of no use.
    await rm(staging, { recursive: true, force: true });
    return { kind: "done" };
  }
  // Without a copy under way (its plan written), most starts end here: nothing to copy.
  if (!(await readReady(staging))) {
    const found = await look(oldDir);
    if (!holdsData(found) && !found.settings) return { kind: "none", reason: "nothing to copy" };
    if (holdsData(await look(dataDir))) return { kind: "none", reason: "data already here" };
  }
  return withLock(
    storePaths(dataDir),
    async (lease): Promise<MigrationOutcome> => {
      // Again, now that nobody else writes the state.
      if (await exists(marker)) return { kind: "done" };
      let ready = await readReady(staging);
      if (!ready) {
        // Half a copy of an earlier start that stopped: it starts again.
        await rm(staging, { recursive: true, force: true });
        const found = await look(oldDir);
        if (!holdsData(found) && !found.settings) return { kind: "none", reason: "nothing to copy" };
        if (holdsData(await look(dataDir))) return { kind: "none", reason: "data already here" };
        try {
          ready = await stage(oldDir, staging, found, options.now?.() ?? Date.now(), options.plainCopyMaxBytes ?? PLAIN_COPY_MAX_BYTES);
        } catch (error) {
          // No half copy is left lying around; the next start tries again.
          await rm(staging, { recursive: true, force: true }).catch(() => undefined);
          throw error;
        }
      }
      await lease.check();
      await moveIntoPlace(staging, dataDir, ready);
      const settings = await carrySettings(oldDir, dataDir, options.settings);
      const record: MigrationRecord = { version: 1, from: OLD_EXTENSION_ID, at: ready.at, files: ready.files, context: ready.context, attachments: ready.attachments, settings };
      await lease.check();
      await writeJsonFile(marker, record, 64 * 1024, 2);
      await rm(staging, { recursive: true, force: true });
      return { kind: "migrated", record };
    },
    LOCK_WAIT_MS,
  );
}

/** One line for the log: what was copied, in counts. */
export function describeMigration(record: MigrationRecord): string {
  const { attachments } = record;
  return [
    `copied the data of the earlier Mainline extension: ${record.files.length ? record.files.join(", ") : "no data files"}`,
    `${record.context} context records`,
    `${attachments.folders} attachment folders${attachments.owners ? " with their owners" : ""}${attachments.left ? ` (${attachments.left} left in the old folder)` : ""}`,
    `settings ${record.settings}; the old folder was left as it was`,
  ].join(", ");
}
