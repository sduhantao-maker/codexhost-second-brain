/**
 * Favorites on disk (`favorites.json`), with their own lock so saving never waits on the state.
 * A damaged file is set aside before a save replaces it; one a newer version wrote is never
 * replaced, and reading it fails with NEWER_VERSION.
 */
import path from "node:path";
import { emptyFavorites, FAVORITES_VERSION, normalizeFavorites, type FavoritesFile } from "../core/favorites.js";
import { MainlineError } from "../core/model.js";
import { newerVersionError, readStoredJson, setAside, withLock, writeJsonFile, type StoredJson } from "./store.js";

const MAX_BYTES = 16 * 1024 * 1024;

export interface FavoritesPaths {
  dir: string;
  file: string;
  lock: string;
}

export function favoritesPaths(dir: string): FavoritesPaths {
  return { dir, file: path.join(dir, "favorites.json"), lock: path.join(dir, "favorites.lock") };
}

function favoritesOf(paths: FavoritesPaths, stored: StoredJson): FavoritesFile {
  if (stored.kind === "newer") throw newerVersionError(paths.file, stored.version, FAVORITES_VERSION);
  return stored.kind === "ok" ? normalizeFavorites(stored.raw) : emptyFavorites();
}

/** The favorites; none when the file is missing or damaged. */
export async function readFavorites(paths: FavoritesPaths): Promise<FavoritesFile> {
  return favoritesOf(paths, await readStoredJson(paths.file, [FAVORITES_VERSION]));
}

export async function updateFavorites<T>(paths: FavoritesPaths, mutate: (file: FavoritesFile) => T): Promise<{ file: FavoritesFile; result: T }> {
  return withLock(paths, async (lease) => {
    const stored = await readStoredJson(paths.file, [FAVORITES_VERSION]);
    const current = favoritesOf(paths, stored);
    const draft = structuredClone(current);
    const result = mutate(draft);
    if (JSON.stringify(draft) !== JSON.stringify(current)) {
      draft.rev = current.rev + 1;
      await lease.check();
      if (stored.kind === "damaged") await setAside(paths.file);
      // Compact, like the state: the file is machine-written and can hold thousands of passages.
      await writeJsonFile(paths.file, draft, MAX_BYTES).catch((error: unknown) => {
        if (error instanceof MainlineError && error.code === "FILE_FULL")
          throw new MainlineError("FAVORITES_FULL", "favorites.json is full; delete saved passages you no longer need in the overview");
        throw error;
      });
    }
    return { file: draft, result };
  });
}
