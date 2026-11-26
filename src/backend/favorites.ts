/**
 * Saved passages, for the backend. Saving answers at once; where the passage sits in its
 * conversation (turn and speaker) is looked up from codexhost afterwards and filled in.
 */
import { addFavorite, emptyFavorites, locatePassage, noteFavorite, removeFavorite, type Favorite, type FavoritesFile, type NewFavorite } from "../core/favorites.js";
import { readFavorites, updateFavorites, type FavoritesPaths } from "../node/favorites-store.js";
import { fileSignature } from "../node/store.js";
import type { ExternalApi } from "./external-api.js";
import type { Log } from "./log.js";

/** Turns read at a time, and how far back past the latest ones a passage is looked for. */
const CHUNK = 20;
const LOOK_BACK = 60;

export class FavoritesService {
  #cached: { signature: string; file: FavoritesFile } = { signature: "", file: emptyFavorites() };
  readonly #pending = new Set<Promise<void>>();

  constructor(
    private readonly paths: FavoritesPaths,
    private readonly api: Pick<ExternalApi, "readTurns">,
    private readonly log: Log,
    private readonly now: () => number = Date.now,
    /** The remote host a conversation runs on, for one the passage did not name a host for. */
    private readonly hostOf: (threadId: string) => string | undefined = () => undefined,
  ) {}

  /** Changes whenever the file is replaced. */
  signature(): Promise<string> {
    return fileSignature(this.paths.file);
  }

  async current(): Promise<FavoritesFile> {
    const signature = await this.signature();
    if (signature !== this.#cached.signature) this.#cached = { signature, file: await readFavorites(this.paths) };
    return this.#cached.file;
  }

  /** The favorites known from the last read, without touching the disk. */
  cached(): readonly Favorite[] {
    return this.#cached.file.items;
  }

  async add(input: NewFavorite): Promise<{ favorite: Favorite; added: boolean }> {
    const { result } = await updateFavorites(this.paths, (file) => addFavorite(file, input, this.now()));
    if (result.added && result.favorite.turn === undefined) this.#track(this.#locate(result.favorite));
    return result;
  }

  async remove(id: string): Promise<boolean> {
    return (await updateFavorites(this.paths, (file) => removeFavorite(file, id))).result;
  }

  async note(id: string, note: string): Promise<Favorite | undefined> {
    return (await updateFavorites(this.paths, (file) => noteFavorite(file, id, note))).result;
  }

  /** Waits for lookups still running (stopping the backend). */
  async settle(): Promise<void> {
    await Promise.allSettled([...this.#pending]);
  }

  #track(work: Promise<void>): void {
    const tracked = work.catch((error: unknown) => this.log.error("find where a saved passage is", error));
    this.#pending.add(tracked);
    void tracked.finally(() => this.#pending.delete(tracked));
  }

  /** Looks through the latest turns, then further back, and notes the turn and speaker found. On its remote host for a conversation on another computer. */
  async #locate(favorite: Favorite): Promise<void> {
    const hostId = favorite.hostId ?? this.hostOf(favorite.threadId);
    const latest = await this.api.readTurns(favorite.threadId, undefined, hostId);
    let found = locatePassage(favorite.text, latest.turns);
    const oldest = latest.turns.reduce((min, turn) => Math.min(min, turn.turnNumber), Number.POSITIVE_INFINITY);
    for (let to = oldest - 1; !found && Number.isFinite(to) && to >= 1 && oldest - to <= LOOK_BACK; to -= CHUNK) {
      const from = Math.max(1, to - CHUNK + 1);
      found = locatePassage(favorite.text, (await this.api.readTurns(favorite.threadId, { from, to }, hostId)).turns);
    }
    if (!found) return;
    const where = found;
    await updateFavorites(this.paths, (file) => {
      const item = file.items.find(({ id }) => id === favorite.id);
      if (!item || item.turn !== undefined) return;
      item.turn = where.turn;
      item.role ??= where.role;
    });
  }
}
