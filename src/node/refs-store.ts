/**
 * The PR and issue index on disk (`refs.json`), with its own lock so it never waits on the state.
 * A damaged file is set aside before a write replaces it (the index is then rebuilt by scanning
 * again, but notes and bells live only here); one a newer version wrote is never replaced, and
 * reading it fails with NEWER_VERSION.
 */
import path from "node:path";
import { emptyIndex, normalizeIndex, pruneIndex, REFS_VERSION, type RefIndex } from "../core/refs.js";
import { newerVersionError, readStoredJson, setAside, withLock, writeJsonFile, type StoredJson } from "./store.js";

const MAX_BYTES = 4 * 1024 * 1024;

export interface RefsPaths {
  dir: string;
  file: string;
  lock: string;
}

export function refsPaths(dir: string): RefsPaths {
  return { dir, file: path.join(dir, "refs.json"), lock: path.join(dir, "refs.lock") };
}

function indexOf(paths: RefsPaths, stored: StoredJson): RefIndex {
  if (stored.kind === "newer") throw newerVersionError(paths.file, stored.version, REFS_VERSION);
  // Missing or damaged: the index is rebuilt by scanning again.
  return stored.kind === "ok" ? normalizeIndex(stored.raw) : emptyIndex();
}

export async function readIndex(paths: RefsPaths): Promise<RefIndex> {
  return indexOf(paths, await readStoredJson(paths.file, [REFS_VERSION]));
}

export async function updateIndex<T>(
  paths: RefsPaths,
  mutate: (index: RefIndex) => T,
  timeoutMs?: number,
): Promise<{ index: RefIndex; result: T; changed: boolean }> {
  return withLock(
    paths,
    async (lease) => {
      const stored = await readStoredJson(paths.file, [REFS_VERSION]);
      const current = indexOf(paths, stored);
      const draft = structuredClone(current);
      const result = mutate(draft);
      pruneIndex(draft);
      if (JSON.stringify(draft) === JSON.stringify(current)) return { index: current, result, changed: false };
      draft.rev = current.rev + 1;
      await lease.check();
      if (stored.kind === "damaged") await setAside(paths.file);
      // Compact JSON: the index is machine-written and can hold thousands of entries.
      await writeJsonFile(paths.file, draft, MAX_BYTES);
      return { index: draft, result, changed: true };
    },
    timeoutMs,
  );
}
