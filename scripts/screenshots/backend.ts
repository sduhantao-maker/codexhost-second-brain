/**
 * A stand-in for the extension's backend, answering the browser entries from the demo data with
 * the extension's own pure functions (views, search, the PR index, favorites), the way
 * src/backend/index.ts answers them from the files on disk. Nothing is written anywhere.
 */
import { conversationView, type DraftFacts, type ViewSources } from "../../src/core/conversation-view.js";
import { searchFavorites, type Favorite } from "../../src/core/favorites.js";
import { alerts, folderName, refsForThread, refView, type RefIndex } from "../../src/core/refs.js";
import {
  FAVORITE_EXCERPT_CHARS,
  type AttachmentsUsage,
  type FavoriteExcerpt,
  type FavoritesList,
  type IntegrationStatus,
  type RefsList,
  type SnapshotParams,
  type SnapshotResultV2,
  type SummarizerStatus,
} from "../../src/core/rpc.js";
import { searchConversations } from "../../src/core/search.js";
import type { Demo } from "./demo.js";

const VERSION = "demo-1";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const textOf = (params: unknown, key: string): string => (isRecord(params) && typeof params[key] === "string" ? params[key] : "");

function excerptOf(favorite: Favorite): FavoriteExcerpt {
  const chars = Array.from(favorite.text);
  return chars.length > FAVORITE_EXCERPT_CHARS ? { ...favorite, text: chars.slice(0, FAVORITE_EXCERPT_CHARS).join(""), truncated: true } : favorite;
}

export type Invoke = (method: string, params?: unknown) => Promise<unknown>;

export function demoBackend(demo: Demo): Invoke {
  const { state, info, parents, index, favorites, now } = demo;
  const titleOf = (threadId: string): string | undefined => state.conversations[threadId]?.title ?? info[threadId]?.title ?? index.threads[threadId]?.title;
  const refsOf = (threadId: string) => refsForThread(index, threadId).map((ref) => refView(index, ref, titleOf));
  const sources: ViewSources = {
    state,
    info,
    parents,
    refsOf,
    draftOf: (threadId): DraftFacts | undefined => {
      const record = index.threads[threadId];
      const title = info[threadId]?.title ?? record?.title;
      if (!record && !title) return undefined;
      return {
        refs: refsOf(threadId),
        ...(title ? { title } : {}),
        ...(record?.firstPrompt ? { firstPrompt: record.firstPrompt } : {}),
        ...(record?.cwd ? { workspace: folderName(record.cwd) } : {}),
      };
    },
  };
  const workspaces: Record<string, string> = {};
  for (const [threadId, record] of Object.entries(index.threads)) if (record.cwd) workspaces[threadId] = folderName(record.cwd);
  const summarizer: SummarizerStatus = {
    running: 0,
    queued: 0,
    today: { count: 14, limit: 200, calls: { claude: { auto: 9, manual: 1, backfill: 0 }, codex: { auto: 5, manual: 0, backfill: 0 } } },
  };
  const integrations: IntegrationStatus[] = [
    { agent: "claude", file: "~/.claude/settings.json", state: "installed" },
    { agent: "codex", file: "~/.codex/AGENTS.md", state: "installed" },
  ];
  const noFiles = { files: 0, bytes: 0 };
  const usage: AttachmentsUsage = { all: noFiles, done: noFiles, unknown: noFiles };

  const snapshot = (params: unknown): SnapshotResultV2 => {
    if (isRecord(params) && (params as SnapshotParams).version === VERSION) return { version: VERSION };
    return {
      version: VERSION,
      state,
      info,
      settings: demo.settings,
      command: "~/.codexhost/host-extension-data/second-brain/bin/mainline",
      alerts: alerts(index).map((ref) => refView(index, ref, titleOf)),
      parents,
      summarizer,
      workspaces,
      favorites: favorites.length,
    };
  };

  const refsList = (): RefsList => {
    const all = Object.values(index.refs).sort(
      (a, b) =>
        Number(Boolean(b.activity?.unseen)) - Number(Boolean(a.activity?.unseen)) ||
        Math.max(b.lastMentionAt, b.activity?.at ?? 0) - Math.max(a.lastMentionAt, a.activity?.at ?? 0),
    );
    return {
      status: {
        conversations: { scanned: index.crawl.listed, listed: index.crawl.listed, done: true, unreadable: 0 },
        refs: all.length,
        github: { enabled: true, lastPollAt: index.github.lastPollAt ?? now },
      },
      refs: all.map((ref) => refView(index, ref, titleOf)),
    };
  };

  const favoritesList = (params: unknown): FavoritesList => {
    const matched = searchFavorites([...favorites].sort((a, b) => b.createdAt - a.createdAt), textOf(params, "query"), titleOf);
    const titles: Record<string, string> = {};
    for (const item of matched) {
      const title = titleOf(item.threadId) ?? item.threadTitle;
      if (title) titles[item.threadId] = title;
    }
    return { items: matched.map(excerptOf), titles, total: favorites.length, matched: matched.length };
  };

  const answer = (method: string, params: unknown): unknown => {
    switch (method) {
      case "snapshot":
        return snapshot(params);
      case "conversation":
        return conversationView(textOf(params, "threadId"), sources);
      case "search":
        return searchConversations({ sources, index, query: textOf(params, "query"), favorites });
      case "refs.list":
        return refsList();
      case "favorites.list":
        return favoritesList(params);
      case "favorites.get": {
        const favorite = favorites.find((item) => item.id === textOf(params, "id"));
        if (!favorite) throw new Error("[UNKNOWN_ITEM] No such saved passage");
        return { favorite };
      }
      case "favorites.add": {
        const threadId = textOf(params, "threadId");
        const favorite: Favorite = { id: "fav-new", threadId, text: textOf(params, "text"), source: "select", createdAt: now };
        return { favorite, added: true };
      }
      case "favorites.reveal":
        return { threadId: favorites.find((item) => item.id === textOf(params, "id"))?.threadId };
      case "integration.status":
        return integrations;
      case "attachments.usage":
        return usage;
      default:
        return { ok: true };
    }
  };

  return async (method, params) => answer(method, params);
}
