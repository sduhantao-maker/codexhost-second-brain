/**
 * Files on their way to a new child conversation, and the files kept for child conversations. The
 * hover card sends each one in pieces of ATTACH_CHUNK_BYTES, a few at a time; they wait in
 * attachments/.incoming/<id>/ until a child conversation is opened with them, then move to
 * attachments/<id>/ and stay, since the child's agent may read them again later. `owners.json`
 * next to them says which child each folder went with, so the overview can show what they take
 * and clear them on request. Uploads nobody used are cleared after an hour, and the files of an
 * attempt that failed at once: the card sends them again with its next try.
 *
 * The card keeps to the limits too, but the backend does not count on it: one file, the files of
 * one child, and everything waiting at once each have a cap here.
 */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  ATTACH_CHUNK_BYTES,
  ATTACH_MAX_FILE_BYTES,
  ATTACH_MAX_FILES,
  ATTACH_MAX_TOTAL_BYTES,
  formatSize,
  isPicture,
  isUploadId,
  safeFileName,
  type AttachedFile,
} from "../core/attachments.js";
import { MainlineError } from "../core/model.js";
import type { AttachmentsScope, AttachmentsUsage, FilesSize } from "../core/rpc.js";
import { ownersPaths, readOwners, updateOwners, type AttachmentOwner, type OwnersPaths } from "../node/attachment-owners.js";

/** An upload nobody opened a child conversation with is cleared after this long. */
export const UNUSED_UPLOAD_MS = 60 * 60_000;
/** More uploads than this waiting at once means something is wrong. */
const WAITING_LIMIT = 40;
/** Nor may the uploads waiting at once take more than this. */
export const WAITING_MAX_BYTES = 2 * 1024 * 1024 * 1024;

interface Upload {
  id: string;
  name: string;
  size: number;
  pieces: number;
  received: Set<number>;
  at: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface UploadBegun {
  id: string;
  chunkBytes: number;
}

export interface UploadProgress {
  /** Pieces received so far. */
  received: number;
  done: boolean;
}

/** Tells whether the files kept for a child conversation belong to one that is done. */
export type IsDone = (owner: AttachmentOwner) => boolean;

/** Bytes the files of one child may take, and the uploads waiting at once; tests make them small. */
export interface UploadLimits {
  childBytes: number;
  waitingBytes: number;
}

export class Uploads {
  readonly #root: string;
  readonly #incoming: string;
  readonly #owners: OwnersPaths;
  readonly #waiting = new Map<string, Upload>();
  /** Claimed for a child conversation that is being opened: neither waiting nor anyone's yet, and never cleared. */
  readonly #sending = new Set<string>();
  readonly #now: () => number;
  readonly #limits: UploadLimits;

  constructor(dataDir: string, now: () => number = Date.now, limits: Partial<UploadLimits> = {}) {
    this.#root = path.join(dataDir, "attachments");
    this.#incoming = path.join(this.#root, ".incoming");
    this.#owners = ownersPaths(this.#root);
    this.#now = now;
    this.#limits = { childBytes: ATTACH_MAX_TOTAL_BYTES, waitingBytes: WAITING_MAX_BYTES, ...limits };
  }

  /** `attach.begin { name, size }`: makes room for one file. */
  async begin(raw: unknown): Promise<UploadBegun> {
    const name = safeFileName(isRecord(raw) && typeof raw.name === "string" ? raw.name : "");
    const size = isRecord(raw) ? raw.size : undefined;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) throw new MainlineError("INVALID_ARGUMENT", "size must be a whole number of bytes");
    if (size > ATTACH_MAX_FILE_BYTES) throw new MainlineError("ATTACHMENT_TOO_LARGE", `${name} is over ${formatSize(ATTACH_MAX_FILE_BYTES)}`);
    this.#forgetOld();
    if (this.#waiting.size >= WAITING_LIMIT) throw new MainlineError("UPLOADS_BUSY", "too many uploads are waiting");
    const waiting = [...this.#waiting.values()].reduce((sum, upload) => sum + upload.size, 0);
    if (waiting + size > this.#limits.waitingBytes) throw new MainlineError("UPLOADS_BUSY", `uploads waiting would take over ${formatSize(this.#limits.waitingBytes)}`);
    const id = randomUUID();
    const dir = path.join(this.#incoming, id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await (await open(path.join(dir, name), "w", 0o600)).close();
    this.#waiting.set(id, { id, name, size, pieces: Math.ceil(size / ATTACH_CHUNK_BYTES), received: new Set(), at: this.#now() });
    return { id, chunkBytes: ATTACH_CHUNK_BYTES };
  }

  /** `attach.chunk { id, offset, data }`: one piece in base64, in any order; a piece sent twice counts once. */
  async chunk(raw: unknown): Promise<UploadProgress> {
    const upload = this.#upload(isRecord(raw) ? raw.id : undefined);
    const offset = isRecord(raw) ? raw.offset : undefined;
    const data = isRecord(raw) ? raw.data : undefined;
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || offset >= upload.size || offset % ATTACH_CHUNK_BYTES !== 0)
      throw new MainlineError("INVALID_ARGUMENT", "offset does not start a piece of this file");
    if (typeof data !== "string") throw new MainlineError("INVALID_ARGUMENT", "data must be base64");
    const bytes = Buffer.from(data, "base64");
    if (bytes.length !== Math.min(ATTACH_CHUNK_BYTES, upload.size - offset) || bytes.toString("base64") !== data)
      throw new MainlineError("INVALID_ARGUMENT", "this piece arrived damaged");
    const piece = offset / ATTACH_CHUNK_BYTES;
    if (!upload.received.has(piece)) {
      const handle = await open(path.join(this.#incoming, upload.id, upload.name), "r+");
      try {
        await handle.write(bytes, 0, bytes.length, offset);
      } finally {
        await handle.close();
      }
      upload.received.add(piece);
    }
    upload.at = this.#now();
    return { received: upload.received.size, done: upload.received.size === upload.pieces };
  }

  /**
   * Moves finished uploads to where they stay, and names them for the child's first message.
   * Every id must be a finished upload of this run; none moves otherwise. Once claimed, they are
   * either `keep`-ed for the child that opened or `unclaim`-ed when it did not.
   */
  async claim(ids: readonly unknown[]): Promise<AttachedFile[]> {
    if (ids.length > ATTACH_MAX_FILES) throw new MainlineError("TOO_MANY_ATTACHMENTS", `at most ${ATTACH_MAX_FILES} files`);
    const uploads = ids.map((id) => this.#upload(id));
    if (new Set(uploads).size !== uploads.length) throw new MainlineError("INVALID_ARGUMENT", "the same file was given twice");
    for (const upload of uploads)
      if (upload.received.size !== upload.pieces) throw new MainlineError("INVALID_ARGUMENT", `${upload.name} has not finished uploading`);
    if (uploads.reduce((sum, upload) => sum + upload.size, 0) > this.#limits.childBytes)
      throw new MainlineError("CHILD_FILES_TOO_LARGE", `the files of one child conversation take at most ${formatSize(this.#limits.childBytes)}`);
    // Taken before anything moves, so a second claim of the same upload fails at once.
    for (const upload of uploads) {
      this.#waiting.delete(upload.id);
      this.#sending.add(upload.id);
    }
    try {
      const files: AttachedFile[] = [];
      for (const upload of uploads) {
        const dir = path.join(this.#root, upload.id);
        await rename(path.join(this.#incoming, upload.id), dir);
        const file = path.join(dir, upload.name);
        files.push({ name: upload.name, path: file, image: await startsLikePicture(file) });
      }
      return files;
    } catch (error) {
      // Half of them moved is of no use to anyone; what stopped the move is what to tell.
      await this.unclaim(uploads.map((upload) => upload.id)).catch(() => undefined);
      throw error;
    }
  }

  /** Claimed uploads went with the child conversation `owner.child`: from now on they are its files. */
  async keep(ids: readonly unknown[], owner: Omit<AttachmentOwner, "at">): Promise<void> {
    const kept = ids.filter((id): id is string => typeof id === "string" && this.#sending.delete(id));
    if (!kept.length) return;
    const at = this.#now();
    await updateOwners(this.#owners, (owners) => {
      for (const id of kept) owners[id] = { child: owner.child, parent: owner.parent, at };
    });
  }

  /**
   * Claimed uploads whose child conversation may or may not have opened (asking codexhost timed
   * out): they stay where its first message would name them, with no record of whose they are, so
   * they count as "owner unknown" and go with clearing all.
   */
  leave(ids: readonly unknown[]): number {
    return ids.filter((id) => typeof id === "string" && this.#sending.delete(id)).length;
  }

  /** Deletes claimed uploads whose child conversation did not open: nobody will read them. */
  async unclaim(ids: readonly unknown[]): Promise<void> {
    const claimed = [...new Set(ids)].filter((id): id is string => typeof id === "string" && this.#sending.delete(id));
    // Wherever each one got to: moved already, or still where it waited.
    await removeAll(claimed.flatMap((id) => [path.join(this.#root, id), path.join(this.#incoming, id)]));
  }

  /** Deletes uploads still waiting that went with an attempt that failed, instead of keeping them an hour. */
  async discard(ids: readonly unknown[]): Promise<void> {
    const waiting = [...new Set(ids)].filter((id): id is string => typeof id === "string" && this.#waiting.delete(id));
    await removeAll(waiting.map((id) => path.join(this.#incoming, id)));
  }

  /** Clears uploads nobody used within the hour, also those an earlier run of the backend left. */
  async sweep(): Promise<number> {
    this.#forgetOld();
    let entries: string[];
    try {
      entries = await readdir(this.#incoming);
    } catch {
      return 0;
    }
    let cleared = 0;
    for (const entry of entries) {
      if (this.#waiting.has(entry) || this.#sending.has(entry)) continue;
      const dir = path.join(this.#incoming, entry);
      const info = await stat(dir).catch(() => undefined);
      if (!info || this.#now() - info.mtimeMs < UNUSED_UPLOAD_MS) continue;
      await rm(dir, { recursive: true, force: true });
      cleared += 1;
    }
    return cleared;
  }

  /**
   * What the kept files take: all of them, those of child conversations that are done, and those
   * no record says whose they are. Counted on request, folder by folder.
   */
  async usage(isDone: IsDone): Promise<AttachmentsUsage> {
    const owners = await readOwners(this.#owners);
    const usage: AttachmentsUsage = { all: nothing(), done: nothing(), unknown: nothing() };
    for (const id of await this.#kept()) {
      const size = await sizeOf(path.join(this.#root, id));
      add(usage.all, size);
      const owner = owners[id];
      if (!owner) add(usage.unknown, size);
      else if (isDone(owner)) add(usage.done, size);
    }
    return usage;
  }

  /**
   * Deletes kept files: those of child conversations that are done, or all of them, also those
   * of no known child and uploads nobody used within the hour. Files of a child being opened right
   * now stay. Returns what was deleted.
   */
  async clear(scope: AttachmentsScope, isDone: IsDone): Promise<FilesSize> {
    const owners = await readOwners(this.#owners);
    const cleared = nothing();
    for (const id of await this.#kept()) {
      const owner = owners[id];
      if (scope === "done" && !(owner && isDone(owner))) continue;
      const dir = path.join(this.#root, id);
      const size = await sizeOf(dir);
      await rm(dir, { recursive: true, force: true });
      add(cleared, size);
    }
    // Records of folders that are gone go too; one left behind does no harm, so this may fail.
    await updateOwners(this.#owners, async (draft) => {
      for (const id of Object.keys(draft)) if (!(await lstat(path.join(this.#root, id)).catch(() => undefined))) delete draft[id];
    }).catch(() => undefined);
    if (scope === "all") await this.sweep();
    return cleared;
  }

  /**
   * The folders of kept files: directories directly under attachments/ named like an upload id,
   * not links, and not being sent. Nothing else there is ever counted or deleted.
   */
  async #kept(): Promise<string[]> {
    const entries = await readdir(this.#root, { withFileTypes: true }).catch(() => []);
    return entries.filter((entry) => entry.isDirectory() && isUploadId(entry.name) && !this.#sending.has(entry.name)).map((entry) => entry.name);
  }

  #forgetOld(): void {
    for (const [id, upload] of this.#waiting) if (this.#now() - upload.at > UNUSED_UPLOAD_MS) this.#waiting.delete(id);
  }

  #upload(id: unknown): Upload {
    const upload = isUploadId(id) ? this.#waiting.get(id) : undefined;
    if (!upload) throw new MainlineError("INVALID_ARGUMENT", "an attachment is no longer there; add it again");
    return upload;
  }
}

const nothing = (): FilesSize => ({ files: 0, bytes: 0 });

function add(total: FilesSize, size: FilesSize): void {
  total.files += size.files;
  total.bytes += size.bytes;
}

/** The files in a folder and the bytes they take, without following links out of it. */
async function sizeOf(dir: string): Promise<FilesSize> {
  const size = nothing();
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const inner = path.join(dir, entry.name);
    if (entry.isDirectory()) add(size, await sizeOf(inner));
    else if (entry.isFile()) {
      const info = await lstat(inner).catch(() => undefined);
      if (info) add(size, { files: 1, bytes: info.size });
    }
  }
  return size;
}

/** Deletes every folder, going on past one that fails; then throws the first failure. */
async function removeAll(dirs: readonly string[]): Promise<void> {
  const failed = (await Promise.allSettled(dirs.map((dir) => rm(dir, { recursive: true, force: true })))).find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
}

async function startsLikePicture(file: string): Promise<boolean> {
  const handle = await open(file, "r");
  try {
    const head = Buffer.alloc(16);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return isPicture(head.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}
