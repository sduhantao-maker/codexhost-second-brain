/**
 * Favorites: passages the user wants to find again, saved from a conversation with where they came
 * from. Plain data and pure functions; the store, the backend and the surfaces use them.
 */
import { isThreadId, MainlineError, newId } from "./model.js";

export const FAVORITES_VERSION = 1;
export const FAVORITE_LIMITS = { text: 20_000, note: 500, items: 5000, title: 120 } as const;

export type FavoriteSource = "select" | "chat";
export type FavoriteRole = "agent" | "user";

export interface Favorite {
  id: string;
  threadId: string;
  /** The saved passage, as it was. */
  text: string;
  /** Who said it, when known. */
  role?: FavoriteRole;
  /** Which turn of the conversation it is in (1-based), when found. */
  turn?: number;
  /** The conversation's title when it was saved, for when the conversation is gone. */
  threadTitle?: string;
  note?: string;
  source: FavoriteSource;
  createdAt: number;
}

export interface FavoritesFile {
  version: typeof FAVORITES_VERSION;
  rev: number;
  items: Favorite[];
}

export function emptyFavorites(): FavoritesFile {
  return { version: FAVORITES_VERSION, rev: 0, items: [] };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const clip = (text: string, max: number) => {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
};

/** Whitespace folded, so a passage compares equal however it was wrapped. */
export function flatten(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** Marks Codex puts into replies the user annotated; they are not part of what was said. */
const ANNOTATION = /:{1,2}codex-annotation\{[^}]*\}[ \t]*/gu;

/** A reply as the user should keep it: without annotation marks and outer blank lines. */
export function cleanPassage(text: string): string {
  return text.replace(ANNOTATION, "").trim();
}

/**
 * Letters and digits only, lower case. A passage selected on screen (rendered) and the same passage
 * in a reply's Markdown source have the same skeleton: emphasis, list markers, punctuation, link
 * targets and code fences drop out.
 */
export function skeleton(text: string): string {
  let out = "";
  const source = text
    .replace(ANNOTATION, "")
    .replace(/^\s*(?:```|~~~)[^\n]*$/gmu, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1");
  for (const char of source) if (KEPT.test(char)) out += char.toLowerCase();
  return out;
}

/** The characters a skeleton keeps; a page builds the skeleton of its text one character at a time. */
export const KEPT = /[\p{L}\p{N}]/u;

const NEEDLE_MIN = 6;
const NEEDLE_MAX = 40;

/**
 * Short pieces of a passage to look for, the most distinctive first: the skeletons of its longest
 * lines. Each line is one block on screen (paragraph, list item, table row), so a piece never spans
 * a list number or table border the screen does not show.
 */
export function needlesOf(text: string, count = 3): string[] {
  const lines = cleanPassage(text)
    .split(/\n+/u)
    .map((line) => skeleton(line))
    .filter((line) => line.length >= NEEDLE_MIN)
    .sort((a, b) => b.length - a.length)
    .map((line) => line.slice(0, NEEDLE_MAX));
  const whole = skeleton(text);
  if (!lines.length && whole.length >= NEEDLE_MIN) lines.push(whole.slice(0, NEEDLE_MAX));
  return [...new Set(lines)].slice(0, count);
}

function readFavorite(value: unknown): Favorite | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || !isThreadId(value.threadId) || typeof value.text !== "string" || !value.text.trim()) return undefined;
  if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) return undefined;
  return {
    id: value.id,
    threadId: value.threadId,
    text: clip(value.text, FAVORITE_LIMITS.text),
    ...(value.role === "agent" || value.role === "user" ? { role: value.role } : {}),
    ...(typeof value.turn === "number" && Number.isSafeInteger(value.turn) && value.turn > 0 ? { turn: value.turn } : {}),
    ...(typeof value.threadTitle === "string" && value.threadTitle ? { threadTitle: clip(value.threadTitle, FAVORITE_LIMITS.title) } : {}),
    ...(typeof value.note === "string" && value.note.trim() ? { note: clip(value.note.trim(), FAVORITE_LIMITS.note) } : {}),
    source: value.source === "chat" ? "chat" : "select",
    createdAt: value.createdAt,
  };
}

export function normalizeFavorites(raw: unknown): FavoritesFile {
  const file = emptyFavorites();
  if (!isRecord(raw) || raw.version !== FAVORITES_VERSION) return file;
  file.rev = typeof raw.rev === "number" && Number.isSafeInteger(raw.rev) && raw.rev > 0 ? raw.rev : 0;
  if (Array.isArray(raw.items)) file.items = raw.items.flatMap((item) => readFavorite(item) ?? []).slice(-FAVORITE_LIMITS.items);
  return file;
}

export interface NewFavorite {
  threadId: string;
  text: string;
  role?: FavoriteRole;
  turn?: number;
  threadTitle?: string;
  source: FavoriteSource;
}

/**
 * Saves a passage. Saving the same passage of the same conversation again gives back the one
 * already there (`added: false`) instead of a copy.
 */
export function addFavorite(file: FavoritesFile, input: NewFavorite, now: number, random?: () => number): { favorite: Favorite; added: boolean } {
  if (!isThreadId(input.threadId)) throw new MainlineError("INVALID_ARGUMENT", "A conversation is required");
  const text = cleanPassage(input.text);
  if (!text) throw new MainlineError("EMPTY_TEXT", "Nothing to save");
  const existing = file.items.find((item) => item.threadId === input.threadId && flatten(item.text) === flatten(text));
  if (existing) return { favorite: existing, added: false };
  const taken = new Set(file.items.map(({ id }) => id));
  const favorite: Favorite = {
    id: newId((id) => taken.has(id), 6, random),
    threadId: input.threadId,
    text: clip(text, FAVORITE_LIMITS.text),
    ...(input.role ? { role: input.role } : {}),
    ...(input.turn && Number.isSafeInteger(input.turn) && input.turn > 0 ? { turn: input.turn } : {}),
    ...(input.threadTitle ? { threadTitle: clip(input.threadTitle, FAVORITE_LIMITS.title) } : {}),
    source: input.source,
    createdAt: now,
  };
  file.items.push(favorite);
  file.items.splice(0, Math.max(0, file.items.length - FAVORITE_LIMITS.items));
  return { favorite, added: true };
}

export function removeFavorite(file: FavoritesFile, id: string): boolean {
  const index = file.items.findIndex((item) => item.id === id);
  if (index < 0) return false;
  file.items.splice(index, 1);
  return true;
}

export function noteFavorite(file: FavoritesFile, id: string, note: string): Favorite | undefined {
  const item = file.items.find((favorite) => favorite.id === id);
  if (!item) return undefined;
  const text = note.trim();
  if (text) item.note = clip(text, FAVORITE_LIMITS.note);
  else delete item.note;
  return item;
}

/** Favorites with every word of the query in their text, note or source title; the newest first. */
export function searchFavorites(items: readonly Favorite[], query: string, titleOf?: (threadId: string) => string | undefined): Favorite[] {
  const words = flatten(query).toLowerCase().split(" ").filter(Boolean);
  const newest = [...items].sort((a, b) => b.createdAt - a.createdAt);
  if (!words.length) return newest;
  return newest.filter((item) => {
    const haystack = [item.text, item.note ?? "", item.threadTitle ?? "", titleOf?.(item.threadId) ?? ""].join("\n").toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

export interface PassageTurn {
  turnNumber: number;
  messages: ReadonlyArray<{ role: FavoriteRole; text: string }>;
}

/** The turn and speaker of a passage, found in a conversation's turns (the latest first). */
export function locatePassage(text: string, turns: readonly PassageTurn[]): { turn: number; role: FavoriteRole } | undefined {
  const needles = needlesOf(text);
  if (!needles.length) return undefined;
  const latestFirst = [...turns].sort((a, b) => b.turnNumber - a.turnNumber);
  const messages = latestFirst.flatMap((turn) => turn.messages.map((message) => ({ turn: turn.turnNumber, role: message.role, skeleton: skeleton(message.text) })));
  for (const needle of needles) {
    const hit = messages.find((message) => message.skeleton.includes(needle));
    if (hit) return { turn: hit.turn, role: hit.role };
  }
  return undefined;
}

/** The final reply of the latest finished turn: what "the last reply" means while a turn runs. */
export function lastReply(turns: ReadonlyArray<PassageTurn & { status?: string }>): { turn: number; text: string } | undefined {
  const latestFirst = [...turns].sort((a, b) => b.turnNumber - a.turnNumber);
  for (const turn of latestFirst) {
    if (/^(running|inprogress|in_progress)$/iu.test(turn.status ?? "")) continue;
    const replies = turn.messages.filter((message) => message.role === "agent" && cleanPassage(message.text));
    const reply = replies[replies.length - 1];
    if (reply) return { turn: turn.turnNumber, text: cleanPassage(reply.text) };
  }
  return undefined;
}
