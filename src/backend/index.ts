/**
 * The extension's single backend process, run by codexhost's shared Host. It owns nothing the
 * command line cannot also read: the state file and the link index are the source of truth.
 *
 * codexhost gives every call 10 seconds and stopping 1 second, kills a backend that overruns, and
 * refuses an answer over 2 MiB. So no call here waits more than HANDLER_BUDGET_MS in all (longer
 * work goes on in the background and shows in the next snapshot), no answer is over
 * REPLY_LIMIT_BYTES, and stopping cuts off every request to codexhost and gh under way.
 */
import { createHash } from "node:crypto";
import { readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { currentMilestone, emptyStateV2, type Spinoff, type StateV2 } from "../core/conversation.js";
import { addSpinoff, createConversation, isExcluded, linkSpinoff, maskStoredPrompts, noteParents, spinoffOf } from "../core/conversation-ops.js";
import { conversationView, type DraftFacts, type ViewSources } from "../core/conversation-view.js";
import { cleanText, DEFAULT_SETTINGS, isThreadId, localeOf, MainlineError, readSettingsValues, type Settings } from "../core/model.js";
import { searchFavorites, type Favorite, type FavoriteRole } from "../core/favorites.js";
import {
  alerts,
  emptyIndex,
  folderName,
  markSeen,
  markSeenForThread,
  maskIndexText,
  refsForThread,
  refView,
  searchRefs,
  shownContent,
  type RefIndex,
} from "../core/refs.js";
import {
  FAVORITE_EXCERPT_CHARS,
  FAVORITES_PAGE,
  FAVORITES_PAGE_MAX,
  type AgentId,
  type AttachmentsCleared,
  type FavoriteAdded,
  type FavoriteExcerpt,
  type FavoriteGot,
  type FavoritesList,
  type Reveal,
  type RefsList,
  type RefsStatus,
  type SnapshotParams,
  type SnapshotResultV2,
  type SpawnResult,
  type TreeReport,
} from "../core/rpc.js";
import { searchConversations } from "../core/search.js";
import type { BackendContext } from "../host/types.js";
import { spawnChild, type DelegationApi } from "../node/delegate.js";
import { favoritesPaths } from "../node/favorites-store.js";
import { commandPath } from "../node/paths.js";
import { readIndex, refsPaths, updateIndex } from "../node/refs-store.js";
import { fileSignature, readState, stateSignature, storePaths, updateState } from "../node/store.js";
import { DeadlineError, HANDLER_BUDGET_MS, isStopped, leftOf, StoppedError, untilAborted, within } from "./deadline.js";
import { ApiNotReachedError, ExternalApi, HttpError, type ApiThread } from "./external-api.js";
import { FavoritesService } from "./favorites.js";
import { createGhRunner, GitHubWatcher, type RunGh } from "./github.js";
import { installCli } from "./install-cli.js";
import { Integrations } from "./integrations.js";
import { createLog, type Log } from "./log.js";
import { describeMigration, migrateFromMainline, oldDataDir } from "./migrate-from-mainline.js";
import { byteSize, clean, fitSnapshot, fitting, fitView } from "./reply-size.js";
import { applyMutationV2, parseMutationV2 } from "./mutate-v2.js";
import { Scanner } from "./scanner.js";
import { createModelRunner, type RunModel } from "./models.js";
import { Summarizer } from "./summarizer.js";
import { ThreadInfoService } from "./threads.js";
import { Uploads, type IsDone } from "./uploads.js";

const MAINTAIN_EVERY_MS = 30_000;
const ACTIVE_WINDOW_MS = 60_000;
const SETTINGS_TTL_MS = 3_000;
/**
 * The extension counts as in use for this long after a surface last asked for something. Every
 * Desktop window and codexhost page polls the snapshot every few seconds while it is on screen
 * (not minimized, not a background tab), so it is in use while any is open, and this long after.
 */
const RECENTLY_USED_MS = 10 * 60_000;
/** GitHub is asked this often while the extension is in use, and every IDLE_EVERY_MS otherwise. */
const GITHUB_EVERY_MS = 60_000;
const IDLE_EVERY_MS = 10 * 60_000;
/** A surface's id for itself (`SnapshotParams.client`): random letters, digits and dashes. */
const CLIENT_ID = /^[A-Za-z0-9-]{8,64}$/u;
/** The open conversation of at most this many surfaces is kept. */
const FOCUS_LIMIT = 64;
/**
 * Unseen news sent with a snapshot, the newest first. A bell stays until the user acts on it, so
 * news can pile up: each piece not sent would lose its bell (and its place in "🔔 N") unseen.
 */
const ALERTS_SHOWN = 50;
/** A passage asked to be shown again is waited for this long by the conversation it is in. */
const REVEAL_MS = 2 * 60_000;
/** Attachments nobody opened a child conversation with are looked for this often. */
const SWEEP_UPLOADS_MS = 10 * 60_000;
/** Stopping waits this long at most for what is under way to write down what it found (codexhost allows 1 s). */
const STOP_WAIT_MS = 700;
/** Opening a child for a conversation without a mainline waits this long at most for its live title. */
const SPAWN_REFRESH_MS = 2_000;
/** Whether the earlier extension's folder is still there is looked at this often at most. */
const OLD_FOLDER_EVERY_MS = 30_000;

/** A path as the settings tab shows it: the home folder as ~. */
function homeAsTilde(file: string, home = os.homedir()): string {
  return home && (file === home || file.startsWith(`${home}${path.sep}`)) ? `~${file.slice(home.length)}` : file;
}

declare const __VERSION__: string;
const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "dev";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/** A record's own entry under a conversation id, never what every object has. */
const own = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined => (Object.hasOwn(record, key) ? record[key] : undefined);

/** A short fingerprint of what a file holds, for the snapshot version. */
const contentKey = (value: unknown): string => createHash("sha1").update(JSON.stringify(value)).digest("base64url").slice(0, 16);

/**
 * What a page shows of the state: everything but the revision and the backend's own jobs, which
 * only the backend reads. The snapshot version follows this, not the file, so that a write that
 * changes nothing shown does not make every page load the whole snapshot again.
 */
const stateKey = (state: StateV2): string => {
  const { rev: _rev, jobs: _jobs, ...shown } = state;
  return contentKey(shown);
};

/** Copies earlier versions kept when they moved the data over; nothing reads them any more. */
const LEFTOVER = /^(?:refs|state)\.before-\d+\.\d+\.\d+\.json$/u;

/** Errors reach the browser as text; a `[CODE]` prefix lets it explain them. */
function rethrow(error: unknown): never {
  if (error instanceof MainlineError) throw new Error(`[${error.code}] ${error.message}`);
  throw error instanceof Error ? error : new Error(String(error));
}

function parseAgent(params: unknown): AgentId {
  const agent = isRecord(params) ? params.agent : undefined;
  if (agent !== "claude" && agent !== "codex") throw new MainlineError("INVALID_ARGUMENT", "agent must be claude or codex");
  return agent;
}

/** What a surface saw of the delegation tree; rows whose ids are no conversation ids are left out. */
function parseTree(params: unknown): TreeReport {
  if (!isRecord(params) || !isRecord(params.nodes) || !isRecord(params.parents)) throw new MainlineError("INVALID_ARGUMENT", "bad tree");
  const nodes: TreeReport["nodes"] = {};
  for (const [id, raw] of Object.entries(params.nodes)) {
    if (!isThreadId(id) || !isRecord(raw)) continue;
    const status = raw.status === "running" || raw.status === "waiting" || raw.status === "idle" ? raw.status : "unknown";
    nodes[id] = {
      status,
      ...(typeof raw.title === "string" ? { title: raw.title } : {}),
      ...(typeof raw.harnessId === "string" ? { harnessId: raw.harnessId } : {}),
    };
  }
  const parents: TreeReport["parents"] = {};
  for (const [child, parent] of Object.entries(params.parents)) if (isThreadId(child) && isThreadId(parent)) parents[child] = parent;
  return { nodes, parents };
}

/** Live states are refreshed for active conversations that moved this recently, at most this many. */
const LIVE_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
const LIVE_LIMIT = 30;

const text = (raw: unknown, key: string) => (isRecord(raw) && typeof raw[key] === "string" ? (raw[key] as string) : "");
/**
 * A conversation id from the call's parameters. Ids are keys of plain objects throughout, so anything
 * else (`__proto__`, `constructor`, …) is refused with INVALID_ARGUMENT before it gets near one.
 */
const threadIdOf = (raw: unknown, key = "threadId"): string => {
  const value = text(raw, key);
  if (!value) throw new MainlineError("INVALID_ARGUMENT", `${key} is required`);
  if (!isThreadId(value)) throw new MainlineError("INVALID_ARGUMENT", `${key} is not a conversation id`);
  return value;
};
/** A whole number of at least 0 from the call's parameters, else `fallback`. */
const count = (raw: unknown, key: string, fallback: number) => {
  const value = isRecord(raw) ? raw[key] : undefined;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
};

/** What a call says when codexhost has not answered in time and the child conversation goes on opening in the background; the surfaces say it in their language. */
const PENDING = "No answer from codexhost yet; the child may still open under this conversation";

/** A saved passage as listed: its first FAVORITE_EXCERPT_CHARS characters. */
function excerptOf(favorite: Favorite): FavoriteExcerpt {
  const chars = Array.from(favorite.text);
  return chars.length > FAVORITE_EXCERPT_CHARS ? { ...favorite, text: chars.slice(0, FAVORITE_EXCERPT_CHARS).join(""), truncated: true } : favorite;
}

export interface BackendOptions {
  /** Runs the summarizing model; tests pass a stand-in. */
  runModel?: RunModel;
  /** Runs gh; tests pass a stand-in so no test reaches GitHub. */
  runGh?: RunGh;
  /** How long a call may wait in all (HANDLER_BUDGET_MS); tests make it short. */
  budgetMs?: number;
  /** Told how long until the next GitHub round each time one is set; tests follow the rounds with it. */
  githubScheduled?: (delayMs: number) => void;
}

export async function activate(ctx: BackendContext, options: BackendOptions = {}) {
  const fileLog = createLog(ctx.dataDir);
  /** Aborts when the backend stops: every request to codexhost and gh under way ends at once. */
  const stopping = new AbortController();
  // What stopping cut off is no error worth a line.
  const log: Log = {
    info: (message) => fileLog.info(message),
    error: (message, error) => {
      if (!(stopping.signal.aborted && isStopped(error))) fileLog.error(message, error);
    },
  };
  log.info(`backend starting: second-brain ${VERSION}, Node ${process.version}, ${process.platform} ${process.arch}`);
  // The data the extension kept under its earlier name (Mainline), copied over once, before
  // anything here reads or writes data. A copy that fails is tried again at the next start.
  let migrated = false;
  try {
    const outcome = await migrateFromMainline({ dataDir: ctx.dataDir, settings: { read: () => ctx.readSettings(), write: (values) => ctx.writeSettings(values) } });
    if (outcome.kind === "migrated") log.info(describeMigration(outcome.record));
    migrated = outcome.kind !== "none";
  } catch (error) {
    log.error("copy the data of the earlier Mainline extension (tried again at the next start)", error);
  }
  const oldFolder = oldDataDir(ctx.dataDir);
  let oldFolderSeen = { at: 0, left: false };
  /** Where the earlier extension's folder is (home as ~), while it is still there after its data was copied. */
  const oldFolderLeft = async (): Promise<string | undefined> => {
    if (!migrated) return undefined;
    if (Date.now() - oldFolderSeen.at > OLD_FOLDER_EVERY_MS)
      oldFolderSeen = { at: Date.now(), left: await stat(oldFolder).then((info) => info.isDirectory(), () => false) };
    return oldFolderSeen.left ? `${homeAsTilde(oldFolder)}${path.sep}` : undefined;
  };
  const budget = options.budgetMs ?? HANDLER_BUDGET_MS;
  const paths = storePaths(ctx.dataDir);
  const dataRoot = path.resolve(ctx.dataDir, "..", "..");
  let command = commandPath(ctx.dataDir);
  try {
    command = await installCli(ctx.extensionDir, ctx.dataDir, process.execPath);
  } catch (error) {
    log.error("install the mainline command", error);
  }
  const credentials = path.join(dataRoot, "cli-credentials.json");
  const api = new ExternalApi(credentials, 3000, fetch, stopping.signal);
  // Reading a long conversation or starting a delegation can take a while.
  const slowApi = new ExternalApi(credentials, 20_000, fetch, stopping.signal);
  const threads = new ThreadInfoService(api, log);
  const integrations = new Integrations({ home: os.homedir(), dataDir: ctx.dataDir, command });
  const refs = refsPaths(ctx.dataDir);
  let lastUsedAt = Date.now();
  const recentlyUsed = () => Date.now() - lastUsedAt < RECENTLY_USED_MS;
  const scanner = new Scanner(slowApi, refs, log, {
    recentEveryMs: () => (recentlyUsed() ? 60_000 : IDLE_EVERY_MS),
    // A conversation with a mainline, a last request or a saved passage keeps its title and project
    // in the index even once codexhost no longer lists it.
    keep: async () => {
      const state = await currentState();
      const saved = await favorites.current();
      return [...Object.keys(state.conversations), ...Object.keys(state.prompts), ...saved.items.map((item) => item.threadId)];
    },
  });
  const github = new GitHubWatcher(refs, log, untilAborted(options.runGh ?? createGhRunner(), stopping.signal), Date.now, stopping.signal);
  const favorites = new FavoritesService(favoritesPaths(ctx.dataDir), slowApi, log);
  const uploads = new Uploads(ctx.dataDir);
  /** A saved passage the overview asked to show in its conversation, until a surface showed it. */
  let reveal: (Reveal & { at: number }) | undefined;
  const pendingReveal = () => (reveal && Date.now() - reveal.at < REVEAL_MS ? reveal : undefined);

  // Each file is read again only when it was replaced; its key (what pages show of it) goes with it.
  let cached: { signature: string; state: StateV2; key: string } = { signature: "", state: emptyStateV2(), key: "" };
  let cachedIndex: { signature: string; index: RefIndex; key: string } = { signature: "", index: emptyIndex(), key: "" };
  let settings: { at: number; value: Settings } = { at: 0, value: { ...DEFAULT_SETTINGS } };
  let lastSnapshotAt = 0;
  /**
   * The conversation open in each window or page (by the id it sends, else by its kind of surface),
   * and when it last said so; the longest quiet first.
   */
  const focus = new Map<string, { threadId: string; at: number }>();
  /** Conversations open on a surface that still polls; a closed window stops counting after a minute. */
  const focusIds = () => [...focus.values()].filter((item) => Date.now() - item.at < ACTIVE_WINDOW_MS).map((item) => item.threadId);
  /** Forgets the windows and pages quiet for a minute, and the quietest beyond FOCUS_LIMIT. */
  const forgetClosed = () => {
    for (const [key, item] of focus) if (Date.now() - item.at >= ACTIVE_WINDOW_MS || focus.size > FOCUS_LIMIT) focus.delete(key);
  };
  let soon: ReturnType<typeof setTimeout> | undefined;
  let maintaining: Promise<void> | undefined;

  const currentState = async (): Promise<StateV2> => {
    const signature = await stateSignature(paths);
    if (signature !== cached.signature) {
      const state = await readState(paths);
      cached = { signature, state, key: stateKey(state) };
    }
    return cached.state;
  };
  const currentIndex = async (): Promise<RefIndex> => {
    const signature = await fileSignature(refs.file);
    if (signature !== cachedIndex.signature) {
      const index = await readIndex(refs);
      cachedIndex = { signature, index, key: contentKey(shownContent(index)) };
    }
    return cachedIndex.index;
  };
  // The keys of exactly what a snapshot sends, even when a newer read replaced the cache meanwhile.
  const keyOfState = (state: StateV2) => (cached.state === state ? cached.key : stateKey(state));
  const keyOfIndex = (index: RefIndex) => (cachedIndex.index === index ? cachedIndex.key : contentKey(shownContent(index)));
  // One read at a time: the host allows only a few pending settings reads per extension.
  let settingsRead: Promise<Settings> | undefined;
  const currentSettings = async (): Promise<Settings> => {
    if (Date.now() - settings.at < SETTINGS_TTL_MS) return settings.value;
    settingsRead ??= (async () => {
      try {
        settings = { at: Date.now(), value: readSettingsValues(await ctx.readSettings()) };
      } catch (error) {
        log.error("read settings", error);
        settings = { at: Date.now(), value: settings.value };
      } finally {
        settingsRead = undefined;
      }
      return settings.value;
    })();
    return settingsRead;
  };

  /** The best title known for a conversation: its mainline, live facts, then the index. */
  const titleOf = (threadId: string): string | undefined =>
    own(cached.state.conversations, threadId)?.title ?? threads.get(threadId)?.title ?? own(cachedIndex.index.threads, threadId)?.title;

  /** Everything a view needs, from the state, live facts, delegation links and the link index. */
  const sources = (state: StateV2, index: RefIndex): ViewSources => {
    const refsOf = (threadId: string) => refsForThread(index, threadId).map((ref) => refView(index, ref, titleOf));
    return {
      state,
      info: threads.all(),
      parents: Object.fromEntries(threads.parentMap()),
      refsOf,
      draftOf: (threadId): DraftFacts | undefined => {
        const record = own(index.threads, threadId);
        const title = threads.get(threadId)?.title ?? record?.title;
        if (!record && !title) return undefined;
        return {
          refs: refsOf(threadId),
          ...(title ? { title } : {}),
          ...(record?.firstPrompt ? { firstPrompt: record.firstPrompt } : {}),
          ...(record?.cwd ? { workspace: folderName(record.cwd) } : {}),
        };
      },
    };
  };

  /**
   * Conversations whose live state is worth keeping fresh: active ones that moved in the last two
   * days, the most recent first. With hundreds of summarized conversations, refreshing them all
   * would flood codexhost.
   */
  const activeIds = (state: StateV2): string[] =>
    Object.values(state.conversations)
      .filter((conversation) => conversation.status === "active" && Date.now() - conversation.updatedAt < LIVE_WINDOW_MS)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, LIVE_LIMIT)
      .map((conversation) => conversation.threadId);

  const refsStatus = async (index: RefIndex): Promise<RefsStatus> => {
    const value = await currentSettings();
    const lastPollAt = await github.lastPollAt();
    return {
      conversations: {
        scanned: Object.keys(index.threads).length,
        listed: index.crawl.listed,
        done: index.crawl.done,
        unreadable: Object.values(index.threads).filter((record) => record.unreadable).length,
      },
      refs: Object.keys(index.refs).length,
      github: {
        enabled: value.prAlerts,
        ...(lastPollAt ? { lastPollAt } : {}),
        ...(index.github.error ? { error: index.github.error } : {}),
      },
    };
  };

  /** Keeps titles, states and delegation parents of mainline conversations current. */
  const maintain = () =>
    (maintaining ??= (async () => {
      try {
        const state = await currentState();
        const open = focusIds();
        await threads.refresh(activeIds(state), open);
        for (const threadId of open) await threads.lookupChildren(threadId);
        const parents = threads.parentMap();
        if ([...parents].some(([child, parent]) => state.conversations[child] && state.conversations[child]!.parentId !== parent))
          await updateState(paths, (draft) => noteParents(draft, parents));
      } catch (error) {
        log.error("maintain", error);
      } finally {
        maintaining = undefined;
      }
    })());

  const maintainSoon = () => {
    clearTimeout(soon);
    soon = setTimeout(() => void maintain(), 1500);
    soon.unref?.();
  };

  // Working folders of model calls a previous backend left behind when it was stopped mid-call.
  const modelRuns = path.join(ctx.dataDir, "model-runs");
  await rm(modelRuns, { recursive: true, force: true }).catch(() => undefined);
  const summarizer = new Summarizer({
    api: slowApi,
    runModel: options.runModel ?? createModelRunner(modelRuns),
    paths,
    log,
    state: currentState,
    index: currentIndex,
    settings: currentSettings,
    changed: maintainSoon,
  });
  /** Background lookups still running; stopping the backend waits for them. */
  const lookups = new Set<Promise<void>>();
  /**
   * Looks the PRs and issues being viewed up on GitHub again (when gh may be used), in the
   * background: the view answers at once, and a changed state reaches it with the next snapshot.
   */
  const freshenRefs = (keys: readonly string[]) => {
    if (!keys.length) return;
    const lookup = (async () => {
      if ((await currentSettings()).prAlerts) await github.freshen(keys);
    })().catch((error: unknown) => log.error("look up PR states", error));
    lookups.add(lookup);
    void lookup.finally(() => lookups.delete(lookup));
  };

  /** Everything the overview shows of the summaries (progress, today's counts, the last error), so it sees them change. */
  const summarizerKey = () => JSON.stringify(summarizer.status());

  ctx.handle("snapshot", async (raw: unknown) => {
    try {
      const params = (isRecord(raw) ? raw : {}) as SnapshotParams;
      lastSnapshotAt = Date.now();
      lastUsedAt = Date.now();
      // A surface's current conversation; one whose id is no conversation id is ignored, not trusted.
      // Opening a conversation marks none of its news seen: only the user acting on the bell does
      // (`refs.seen`, `refs.seenForThread`).
      const focused = isRecord(params.focus) && isThreadId(params.focus.threadId) ? params.focus : undefined;
      if (focused && (focused.surface === "desktop" || focused.surface === "web")) {
        // Each window and page on its own: two on different conversations are no change each time they take turns.
        const client = typeof params.client === "string" && CLIENT_ID.test(params.client) ? params.client : undefined;
        const key = client ? `${focused.surface}:${client}` : focused.surface;
        const before = focus.get(key)?.threadId;
        focus.delete(key);
        focus.set(key, { threadId: focused.threadId, at: Date.now() });
        forgetClosed();
        if (before !== focused.threadId) maintainSoon();
      }
      let state = await currentState();
      if (params.locale !== undefined) {
        const locale = localeOf(params.locale);
        // A guess from a capsule only fills in a missing language; the page's answer wins.
        if (state.locale !== locale && (params.localeSource === "page" || state.locale === undefined)) {
          await updateState(paths, (draft) => {
            draft.locale = locale;
          });
          state = await currentState();
        }
      }
      // One shared list of recent conversations answers most; reads only where it cannot tell.
      const open = focusIds();
      void threads.refresh(activeIds(state), focused ? [focused.threadId, ...open] : open);
      const value = await currentSettings();
      const index = await currentIndex();
      const parents = Object.fromEntries(threads.parentMap());
      const saved = await favorites.current();
      // Only the surface showing the passage's conversation gets it; the version says so, so that
      // a surface switching to that conversation after the request still sees a new snapshot.
      const pending = pendingReveal();
      const shown = pending && focused?.threadId === pending.threadId ? pending : undefined;
      const left = await oldFolderLeft();
      // From what pages show, not from the files: rewriting bookkeeping (when a conversation or a PR
      // was last read, how far a scan got) sends no page the whole snapshot again.
      const version = [
        keyOfState(state),
        threads.version,
        keyOfIndex(index),
        Object.keys(parents).length,
        // Every setting: the settings tab shows them all, and several change what the cards say.
        contentKey(value),
        summarizerKey(),
        `${saved.rev}.${saved.items.length}`,
        shown?.id ?? "-",
        left ?? "-",
      ].join("|");
      if (params.version === version) return { version } satisfies SnapshotResultV2;
      const watched = new Set([...Object.keys(state.conversations), ...open, ...(focused ? [focused.threadId] : []), ...Object.keys(parents), ...Object.values(parents)]);
      const news = alerts(index)
        .slice(0, ALERTS_SHOWN)
        .map((ref) => refView(index, ref, titleOf));
      // Which project each conversation belongs to, for the overview's "by project" grouping.
      const workspaces: Record<string, string> = {};
      for (const threadId of new Set([...Object.keys(state.conversations), ...Object.keys(state.prompts)])) {
        const cwd = index.threads[threadId]?.cwd;
        const name = cwd ? folderName(cwd) : "";
        // A folder codexhost made for one conversation ("thread-<id>") is no project.
        if (name && !/^thread-[0-9a-f]{8}-/iu.test(name)) workspaces[threadId] = name;
      }
      // All of it when it fits in one answer; else outlines of the conversations least needed in full.
      return fitSnapshot({
        version,
        state,
        info: threads.snapshot(watched),
        settings: value,
        command,
        alerts: news,
        parents,
        summarizer: summarizer.status(),
        workspaces,
        favorites: saved.items.length,
        ...(shown ? { reveal: { id: shown.id, threadId: shown.threadId, text: shown.text } } : {}),
        ...(left ? { migration: { oldFolder: left } } : {}),
      });
    } catch (error) {
      rethrow(error);
    }
  });

  ctx.handle("conversation", async (raw: unknown) => {
    try {
      lastUsedAt = Date.now();
      const threadId = threadIdOf(raw);
      const [state, index] = [await currentState(), await currentIndex()];
      const view = conversationView(threadId, sources(state, index));
      // Fill in what is missing for the next look: live states and delegated children.
      void threads.refresh([threadId, ...view.children.map((child) => child.threadId), ...(view.parent ? [view.parent.threadId] : [])]);
      void threads.lookupChildren(threadId).then((changed) => {
        if (changed) maintainSoon();
      });
      // What the card shows about its PRs and issues is looked up again when it is over a minute old.
      freshenRefs(view.refs.map((ref) => ref.key));
      return clean(fitView(view));
    } catch (error) {
      rethrow(error);
    }
  });

  ctx.handle("search", async (raw: unknown) => {
    try {
      lastUsedAt = Date.now();
      const [state, index] = [await currentState(), await currentIndex()];
      const found = searchConversations({ sources: sources(state, index), index, query: text(raw, "query"), favorites: (await favorites.current()).items });
      freshenRefs(found.flatMap((item) => item.refs));
      return clean(found);
    } catch (error) {
      rethrow(error);
    }
  });

  ctx.handle("mutate", async (raw: unknown) => {
    try {
      const params = parseMutationV2(raw);
      const { result } = await updateState(paths, (draft, opCtx) => applyMutationV2(draft, params, opCtx));
      maintainSoon();
      return clean({ ok: true, result: result ?? null });
    } catch (error) {
      rethrow(error);
    }
  });

  /**
   * Opens a child conversation for a spin-off: the files sent along move to where they stay, codexhost
   * is asked to start the child, and the spin-off is linked to it. Without `spinoff` (the user deleted
   * the parent's mainline) the parent's mainline is made only now, from `seed`, keeping that mark.
   */
  const openChild = async (ask: {
    threadId: string;
    state: StateV2;
    spinoff: Spinoff | undefined;
    problem: string;
    seed: { title: string; tags: string[] } | undefined;
    attached: unknown[];
  }): Promise<SpawnResult> => {
    const { threadId, state, spinoff, seed, attached } = ask;
    const conversation = state.conversations[threadId];
    const problem = spinoff?.text ?? cleanText(ask.problem);
    const current = conversation ? currentMilestone(conversation) : undefined;
    // The files move to where they stay first: the child's first message names their paths. Files of
    // a try that fails here (one not finished uploading) do not wait an hour either.
    const attachments = attached.length
      ? await uploads.claim(attached).catch(async (error: unknown) => {
          await uploads.discard(attached).catch((failure: unknown) => log.error("delete the files of a failed child conversation", failure));
          throw error;
        })
      : [];
    // Whether codexhost was asked to start the child: from then on, only its answer tells it did not.
    let asked = false;
    // The parent is read once, for its agent and its working folder.
    const reads = new Map<string, Promise<ApiThread | undefined>>();
    const readOnce = (id: string) => {
      const read = reads.get(id) ?? slowApi.readThread(id);
      reads.set(id, read);
      return read;
    };
    const delegation: DelegationApi = {
      readThread: readOnce,
      threadCwd: async (id) => (await readOnce(id))?.cwd,
      startDelegation: (body) => {
        asked = true;
        return slowApi.startDelegation(body);
      },
    };
    let childThreadId: string;
    try {
      childThreadId = await spawnChild(delegation, {
        parentThreadId: threadId,
        problem,
        parentTitle: conversation?.title ?? seed?.title ?? `#${threadId.slice(0, 8)}`,
        locale: state.locale ?? "zh-CN",
        ...(current ? { currentMilestone: current.title } : {}),
        ...(threads.get(threadId)?.harnessId ? { harnessId: threads.get(threadId)!.harnessId! } : {}),
        ...(attachments.length ? { attachments } : {}),
      });
    } catch (error) {
      if (attachments.length) {
        if (asked && !(error instanceof HttpError) && !(error instanceof ApiNotReachedError)) {
          // No answer in time: the child may have opened, its first message naming these files. They
          // stay, without an owner on record: "owner unknown", cleared with everything.
          const left = uploads.leave(attached);
          log.info(`kept ${left} attached files: no answer whether the child conversation of ${threadId.slice(0, 8)} opened (${error instanceof Error ? error.message : String(error)})`);
        } else {
          // codexhost said no, or was never asked: nobody will read them. The card sends them again with its next try.
          await uploads.unclaim(attached).catch((failure: unknown) => log.error("delete the files of a failed child conversation", failure));
        }
      }
      throw error;
    }
    // The child is open: from now on the files are its own, whatever happens next. The record says
    // whose, so they can be cleared once it is done.
    const kept = attachments.length
      ? uploads.keep(attached, { child: childThreadId, parent: threadId }).catch((error: unknown) => log.error("note which child conversation the files went with", error))
      : undefined;
    try {
      await updateState(paths, (draft, opCtx) => {
        let id = spinoff?.id;
        if (id === undefined) {
          // The user deleted the parent's mainline: it comes back only now, to hold the link, and model
          // summaries keep leaving it alone (unless the user made it again meanwhile).
          if (!draft.conversations[threadId])
            createConversation(draft, threadId, seed ?? { title: `#${threadId.slice(0, 8)}`, tags: [] }, opCtx, { keepExcluded: true });
          id = addSpinoff(draft, threadId, problem, opCtx).id;
        }
        linkSpinoff(draft, threadId, id, childThreadId, opCtx);
      });
    } catch (error) {
      log.error(`note child conversation ${childThreadId.slice(0, 8)} opened for a spin-off of ${threadId.slice(0, 8)}`, error);
      throw error;
    } finally {
      await kept;
    }
    log.info(`opened child conversation ${childThreadId.slice(0, 8)} for a spin-off of ${threadId.slice(0, 8)}${attachments.length ? ` with ${attachments.length} attached files` : ""}`);
    maintainSoon();
    return { childThreadId };
  };

  /** Child conversations being opened, by what was asked: a second try joins the first instead of opening another child. */
  const opening = new Map<string, Promise<SpawnResult>>();

  ctx.handle("spawn", async (raw: unknown) => {
    const startedAt = Date.now();
    // Upload ids of the files sent along: they go with the child that opens, and none of them stays
    // when codexhost says it did not (or was never asked).
    const attached: unknown[] = isRecord(raw) && Array.isArray(raw.attachments) ? raw.attachments : [];
    /** Whether the files sent along went to a child being opened, which then takes care of them. */
    let handedOver = false;
    try {
      const threadId = threadIdOf(raw);
      const problem = isRecord(raw) && typeof raw.text === "string" ? raw.text.trim() : "";
      const spinoffId = text(raw, "spinoffId");
      if (!spinoffId && !problem) throw new MainlineError("INVALID_ARGUMENT", "spinoffId or text is required");
      if (isRecord(raw) && raw.attachments !== undefined && !Array.isArray(raw.attachments))
        throw new MainlineError("INVALID_ARGUMENT", "attachments must be a list of upload ids");
      let state = await currentState();
      let spinoff: Spinoff | undefined;
      let seed: { title: string; tags: string[] } | undefined;
      // The same problem opened already, perhaps in the background after an earlier try ran out of time: that child.
      const opened = problem ? state.conversations[threadId]?.spinoffs.find((item) => item.state === "spawned" && item.childThreadId && item.text === cleanText(problem)) : undefined;
      if (spinoffId) spinoff = spinoffOf(state, threadId, spinoffId);
      else if (opened) spinoff = opened;
      else {
        if (!state.conversations[threadId]) {
          // Without a mainline the conversation gets its draft as one: its live title, as far as codexhost tells in time.
          await within(threads.refresh([threadId]), Math.min(SPAWN_REFRESH_MS, budget / 4)).catch(() => undefined);
          const draft = conversationView(threadId, sources(await currentState(), await currentIndex()));
          seed = { title: draft.title, tags: draft.tags };
        }
        // A new problem is noted as a spin-off first, so a child that does not open leaves it there to
        // try again. Not where the user deleted the mainline: nothing comes back unless the child opens.
        const noted = await updateState(paths, (next, opCtx) => {
          if (!next.conversations[threadId]) {
            if (isExcluded(next, threadId)) return undefined;
            createConversation(next, threadId, seed ?? { title: `#${threadId.slice(0, 8)}`, tags: [] }, opCtx);
          }
          return addSpinoff(next, threadId, problem, opCtx);
        });
        spinoff = noted.result;
        state = await currentState();
      }
      if (spinoff?.state === "spawned" && spinoff.childThreadId) {
        // Opened already (a second click, or a try that crossed the first): the files sent along are of no use.
        if (attached.length) await uploads.discard(attached).catch((failure: unknown) => log.error("delete the files sent with a child conversation opened before", failure));
        return clean({ childThreadId: spinoff.childThreadId } satisfies SpawnResult);
      }
      const key = spinoff ? `${threadId}\n${spinoff.id}` : `${threadId}\n\n${cleanText(problem)}`;
      let job = opening.get(key);
      if (job) {
        // Being opened already: this try waits for that one, and its own files are of no use.
        if (attached.length) await uploads.discard(attached).catch((failure: unknown) => log.error("delete the files sent with a child conversation being opened", failure));
      } else {
        const started = openChild({ threadId, state, spinoff, problem, seed, attached });
        handedOver = true;
        job = started;
        opening.set(key, started);
        void started.then(
          () => opening.delete(key),
          (error: unknown) => {
            opening.delete(key);
            // Nobody waits for it any more: the log keeps what became of it.
            if (Date.now() - startedAt >= budget) log.error(`open a child conversation of ${threadId.slice(0, 8)} in the background`, error);
          },
        );
      }
      try {
        return clean(await within(job, leftOf(startedAt, budget)));
      } catch (error) {
        // codexhost has not answered in time: the child goes on opening in the background, and the
        // next snapshot shows it linked. A second click meanwhile joins this one.
        if (error instanceof DeadlineError) throw new MainlineError("PENDING", PENDING);
        throw error;
      }
    } catch (error) {
      // Files of a failed attempt that were never claimed do not wait an hour either (once handed to a
      // child being opened, that child takes care of them).
      if (attached.length && !handedOver) await uploads.discard(attached).catch((failure: unknown) => log.error("delete the files of a failed child conversation", failure));
      rethrow(error);
    }
  });

  // Photos, videos and other files for a new child conversation, sent piece by piece.
  ctx.handle("attach.begin", async (raw: unknown) => {
    try {
      return clean(await uploads.begin(raw));
    } catch (error) {
      rethrow(error);
    }
  });
  ctx.handle("attach.chunk", async (raw: unknown) => {
    try {
      return clean(await uploads.chunk(raw));
    } catch (error) {
      rethrow(error);
    }
  });

  // What the files kept for child conversations take, and clearing them. Counted only when the
  // overview's settings ask, never with a snapshot: it reads every folder.
  /** Whether the child conversation a folder went with is done, by its mainline now. */
  const doneByState = async (): Promise<IsDone> => {
    const state = await currentState();
    return (owner) => state.conversations[owner.child]?.status === "done";
  };
  ctx.handle("attachments.usage", async () => {
    try {
      return clean(await uploads.usage(await doneByState()));
    } catch (error) {
      rethrow(error);
    }
  });
  ctx.handle("attachments.clear", async (raw: unknown) => {
    try {
      const scope = isRecord(raw) ? raw.scope : undefined;
      if (scope !== "done" && scope !== "all") throw new MainlineError("INVALID_ARGUMENT", "scope must be done or all");
      const isDone = await doneByState();
      const cleared = await uploads.clear(scope, isDone);
      log.info(`cleared ${cleared.files} attached files (${scope})`);
      return clean({ cleared, usage: await uploads.usage(isDone) } satisfies AttachmentsCleared);
    } catch (error) {
      rethrow(error);
    }
  });

  ctx.handle("reportTree", async (raw: unknown) => {
    try {
      const report = parseTree(raw);
      const surface = isRecord(raw) && raw.surface === "web" ? "web" : "desktop";
      const changed = surface === "web" ? threads.reportWebParents(report.parents) : threads.reportTree(report);
      if (changed) maintainSoon();
      return { ok: true };
    } catch (error) {
      rethrow(error);
    }
  });

  const diagnosed = new Map<string, { text: string; at: number }>();
  ctx.handle("diagnose", async (raw: unknown) => {
    const surface = isRecord(raw) && typeof raw.surface === "string" ? raw.surface.slice(0, 16) : "unknown";
    const report = JSON.stringify(isRecord(raw) ? raw.report : null).slice(0, 2000);
    const previous = diagnosed.get(surface);
    if (previous?.text !== report && Date.now() - (previous?.at ?? 0) > 4000) {
      diagnosed.set(surface, { text: report, at: Date.now() });
      log.info(`surface ${surface}: ${report}`);
    }
    return { ok: true };
  });

  /** As many of these as fit in one answer next to `base` bytes, in order. */
  const fittingViews = (index: RefIndex, refs: ReturnType<typeof refsForThread>, base: number) => {
    const views = refs.map((ref) => refView(index, ref, titleOf));
    return views.slice(0, fitting(views, base, byteSize));
  };
  ctx.handle("refs.forThread", async (raw: unknown) => {
    try {
      const threadId = threadIdOf(raw);
      const index = await currentIndex();
      const refs = refsForThread(index, threadId);
      freshenRefs(refs.slice(0, 20).map((ref) => ref.key));
      return clean(fittingViews(index, refs, 2));
    } catch (error) {
      rethrow(error);
    }
  });
  ctx.handle("refs.search", async (raw: unknown) => {
    const index = await currentIndex();
    const refs = searchRefs(index, text(raw, "query"), titleOf);
    freshenRefs(refs.map((ref) => ref.key));
    return clean(refs.map((ref) => refView(index, ref, titleOf)));
  });
  ctx.handle("refs.list", async (raw: unknown) => {
    lastUsedAt = Date.now();
    const index = await currentIndex();
    const all = Object.values(index.refs).sort(
      (a, b) =>
        Number(Boolean(b.activity?.unseen)) - Number(Boolean(a.activity?.unseen)) ||
        Math.max(b.lastMentionAt, b.activity?.at ?? 0) - Math.max(a.lastMentionAt, a.activity?.at ?? 0),
    );
    // The overview's PR tab shows the newest first and asks (`fresh`) while it is on screen: those
    // are looked up again when they are over a minute old. Its other polls only count them.
    if (isRecord(raw) && raw.fresh === true) freshenRefs(all.slice(0, 6).map((ref) => ref.key));
    const status = await refsStatus(index);
    // The newest first, as many as fit in one answer.
    const shown = fittingViews(index, all, byteSize({ status, refs: [], omitted: all.length }));
    return clean({ status, refs: shown, ...(shown.length < all.length ? { omitted: all.length - shown.length } : {}) } satisfies RefsList);
  });
  ctx.handle("refs.status", async () => clean(await refsStatus(await currentIndex())));

  // Model summaries: one conversation now, or every conversation once (it goes on in the background
  // until it is done or stopped). A conversation no model is set for is refused with NO_SUMMARIZER.
  /**
   * Waits for `work` as long as the call's budget allows; past it, the call answers and the work
   * goes on, its failure logged as `what`.
   */
  const inBudget = async (work: Promise<void>, startedAt: number, what: string): Promise<void> => {
    try {
      await within(work, leftOf(startedAt, budget));
    } catch (error) {
      if (!(error instanceof DeadlineError)) throw error;
      work.catch((failure: unknown) => log.error(what, failure));
    }
  };
  ctx.handle("summarize", async (raw: unknown) => {
    const startedAt = Date.now();
    try {
      const threadId = threadIdOf(raw);
      await inBudget(summarizer.request(threadId), startedAt, `ask for a summary of ${threadId.slice(0, 8)}`);
      return { queued: true };
    } catch (error) {
      rethrow(error);
    }
  });
  ctx.handle("summarize.backfill", async () => {
    const startedAt = Date.now();
    try {
      await inBudget(summarizer.startBackfill(), startedAt, "start the backfill");
      return clean(summarizer.status());
    } catch (error) {
      rethrow(error);
    }
  });
  ctx.handle("summarize.cancel", async () => {
    try {
      await summarizer.cancelBackfill();
      return clean(summarizer.status());
    } catch (error) {
      rethrow(error);
    }
  });
  ctx.handle("refs.seen", async (raw: unknown) => {
    const key = text(raw, "key");
    await updateIndex(refs, (draft) => markSeen(draft, key));
    return { ok: true };
  });
  // The user opened a conversation from its sidebar row while its bell (or its card's news) showed:
  // the news of every PR and issue it started is seen.
  ctx.handle("refs.seenForThread", async (raw: unknown) => {
    try {
      const threadId = threadIdOf(raw);
      const { result } = await updateIndex(refs, (draft) => markSeenForThread(draft, threadId));
      return clean({ ok: true, keys: result });
    } catch (error) {
      rethrow(error);
    }
  });

  // Favorites: passages saved from conversations, listed on the overview, shown again where they are.
  ctx.handle("favorites.add", async (raw: unknown) => {
    try {
      lastUsedAt = Date.now();
      const threadId = threadIdOf(raw);
      const passage = text(raw, "text");
      if (!passage.trim()) throw new MainlineError("INVALID_ARGUMENT", "text is required");
      const turn = isRecord(raw) && typeof raw.turn === "number" && Number.isSafeInteger(raw.turn) && raw.turn > 0 ? raw.turn : undefined;
      const role: FavoriteRole | undefined = isRecord(raw) && (raw.role === "agent" || raw.role === "user") ? raw.role : undefined;
      await currentState();
      await currentIndex();
      const title = titleOf(threadId);
      const result = await favorites.add({
        threadId,
        text: passage,
        source: "select",
        ...(turn ? { turn } : {}),
        ...(role ? { role } : {}),
        ...(title ? { threadTitle: title } : {}),
      });
      return clean(result satisfies FavoriteAdded);
    } catch (error) {
      rethrow(error);
    }
  });
  // A page of the saved passages matching the query, each cut to its first FAVORITE_EXCERPT_CHARS
  // characters (`truncated`): 5000 passages of 20,000 characters would never fit in one answer.
  ctx.handle("favorites.list", async (raw: unknown) => {
    try {
      lastUsedAt = Date.now();
      await currentState();
      await currentIndex();
      const file = await favorites.current();
      const matched = searchFavorites(file.items, text(raw, "query"), titleOf);
      const offset = Math.min(count(raw, "offset", 0), matched.length);
      const limit = Math.max(1, Math.min(count(raw, "limit", FAVORITES_PAGE), FAVORITES_PAGE_MAX));
      const titleFor = (item: Favorite) => titleOf(item.threadId) ?? item.threadTitle;
      const page = matched.slice(offset, offset + limit).map(excerptOf);
      // Fewer when they would not fit: the next page starts where this one stops.
      const items = page.slice(0, Math.max(Math.min(page.length, 1), fitting(page, byteSize({ items: [], titles: {}, total: file.items.length, matched: matched.length, nextOffset: matched.length }), (item) => byteSize(item) + byteSize(titleFor(item) ?? "") + byteSize(item.threadId) + 2)));
      const titles: Record<string, string> = {};
      for (const item of items) {
        const title = titleFor(item);
        if (title) titles[item.threadId] = title;
      }
      const next = offset + items.length;
      return clean({ items, titles, total: file.items.length, matched: matched.length, ...(next < matched.length ? { nextOffset: next } : {}) } satisfies FavoritesList);
    } catch (error) {
      rethrow(error);
    }
  });
  // One saved passage in full: for "show all" and "copy" of one the list cut short.
  ctx.handle("favorites.get", async (raw: unknown) => {
    try {
      const id = text(raw, "id");
      const favorite = (await favorites.current()).items.find((item) => item.id === id);
      if (!favorite) throw new MainlineError("UNKNOWN_ITEM", "No such saved passage");
      return clean({ favorite } satisfies FavoriteGot);
    } catch (error) {
      rethrow(error);
    }
  });
  ctx.handle("favorites.remove", async (raw: unknown) => {
    try {
      return { ok: true, removed: await favorites.remove(text(raw, "id")) };
    } catch (error) {
      rethrow(error);
    }
  });
  ctx.handle("favorites.note", async (raw: unknown) => {
    try {
      const favorite = await favorites.note(text(raw, "id"), text(raw, "note"));
      if (!favorite) throw new MainlineError("UNKNOWN_ITEM", "No such saved passage");
      return clean({ favorite });
    } catch (error) {
      rethrow(error);
    }
  });
  // The overview asks for a passage to be shown; the surface showing its conversation does it.
  ctx.handle("favorites.reveal", async (raw: unknown) => {
    try {
      const id = text(raw, "id");
      const favorite = (await favorites.current()).items.find((item) => item.id === id);
      if (!favorite) throw new MainlineError("UNKNOWN_ITEM", "No such saved passage");
      reveal = { id: favorite.id, threadId: favorite.threadId, text: favorite.text, at: Date.now() };
      return clean({ threadId: favorite.threadId });
    } catch (error) {
      rethrow(error);
    }
  });
  ctx.handle("favorites.revealed", async (raw: unknown) => {
    if (reveal?.id === text(raw, "id")) reveal = undefined;
    return { ok: true };
  });

  ctx.handle("integration.status", async () => clean(await integrations.status()));
  ctx.handle("integration.preview", async (raw: unknown) => {
    const removing = isRecord(raw) && raw.removing === true;
    return clean(await integrations.preview(parseAgent(raw), removing));
  });
  ctx.handle("integration.install", async (raw: unknown) => {
    const agent = parseAgent(raw);
    const status = await integrations.install(agent);
    log.info(`installed the ${agent} integration`);
    return clean(status);
  });
  ctx.handle("integration.uninstall", async (raw: unknown) => {
    const agent = parseAgent(raw);
    const status = await integrations.uninstall(agent);
    log.info(`removed the ${agent} integration`);
    return clean(status);
  });

  const timer = setInterval(() => {
    if (Date.now() - lastSnapshotAt < ACTIVE_WINDOW_MS) void maintain();
  }, MAINTAIN_EVERY_MS);
  timer.unref?.();
  const sweepUploads = () =>
    void uploads.sweep().then(
      (cleared) => cleared && log.info(`cleared ${cleared} unused attachments`),
      (error: unknown) => log.error("clear unused attachments", error),
    );
  sweepUploads();
  const sweepTimer = setInterval(sweepUploads, SWEEP_UPLOADS_MS);
  sweepTimer.unref?.();

  try {
    await updateIndex(refs, (draft) => {
      // Version 0.2.0 stored attachment headers instead of the request; read those windows again.
      let reread = false;
      for (const ref of Object.values(draft.refs))
        for (const mention of ref.mentions)
          if (mention.prompt && /^#\s*Files mentioned by the user/iu.test(mention.prompt) && draft.threads[mention.threadId]) {
            delete draft.threads[mention.threadId];
            reread = true;
          }
      if (reread) draft.crawl.done = false;
      // Earlier versions kept each conversation's full working folder; its last folder is all any view uses.
      for (const record of Object.values(draft.threads)) {
        if (!record.cwd) continue;
        const name = folderName(record.cwd);
        if (name) record.cwd = name;
        else delete record.cwd;
      }
    });
  } catch (error) {
    log.error("repair the PR index", error);
  }
  // What users said, as versions before 0.8 stored it: secrets are masked now when it is recorded,
  // and once here in what was kept before. Written only when something changed; the log gets counts.
  try {
    // Tried on copies first, so that nothing is locked or written when there is nothing to mask.
    let prompts = maskStoredPrompts(await readState(paths));
    if (prompts) prompts = (await updateState(paths, (draft) => maskStoredPrompts(draft))).result;
    let inIndex = maskIndexText(await readIndex(refs));
    if (inIndex.requests || inIndex.firstPrompts) inIndex = (await updateIndex(refs, (draft) => maskIndexText(draft))).result;
    if (prompts || inIndex.requests || inIndex.firstPrompts)
      log.info(`masked secrets in stored text: ${prompts} last requests, ${inIndex.requests} requests and ${inIndex.firstPrompts} first requests in the link index`);
  } catch (error) {
    log.error("mask secrets in stored text", error);
  }
  // Copies of the state and the index that earlier versions kept when they moved the data over.
  try {
    const leftovers = (await readdir(ctx.dataDir)).filter((name) => LEFTOVER.test(name));
    for (const name of leftovers) await rm(path.join(ctx.dataDir, name), { force: true });
    if (leftovers.length) log.info(`deleted copies earlier versions left behind: ${leftovers.join(", ")}`);
  } catch (error) {
    log.error("delete copies earlier versions left behind", error);
  }
  scanner.start(3000);
  summarizer.start();
  let githubTimer: ReturnType<typeof setTimeout> | undefined;
  /** The GitHub round under way, which stopping waits for (briefly). */
  let githubRound: Promise<void> | undefined;
  let stopped = false;
  const watchGitHub = async () => {
    try {
      if ((await currentSettings()).prAlerts && Object.keys((await currentIndex()).refs).length) {
        if ((await github.poll()) > 0) scanner.refreshSoon();
        await github.enrich();
      }
    } catch (error) {
      log.error("watch GitHub", error);
    } finally {
      if (!stopped) {
        const delay = recentlyUsed() ? GITHUB_EVERY_MS : IDLE_EVERY_MS;
        githubTimer = setTimeout(() => void (githubRound = watchGitHub()), delay);
        githubTimer.unref?.();
        options.githubScheduled?.(delay);
      }
    }
  };
  githubTimer = setTimeout(() => void (githubRound = watchGitHub()), 20_000);
  githubTimer.unref?.();
  // The home folder is written as ~ (logSafe): no user name in the log.
  log.info(`backend started; command at ${command}`);

  /**
   * Stops within codexhost's 1 second: every request to codexhost and gh under way is cut off at
   * once, then what is under way gets a moment to write down what it found (writes replace whole
   * files, so one cut short leaves the old file). Calls to a model are not waited for.
   */
  return async () => {
    stopped = true;
    clearInterval(timer);
    clearInterval(sweepTimer);
    clearTimeout(soon);
    clearTimeout(githubTimer);
    stopping.abort(new StoppedError());
    const scanned = scanner.stop();
    const summarized = summarizer.stop();
    // What the scanner held back, and what a summarizer round found, are written before the backend goes.
    const settled = Promise.allSettled([maintaining, githubRound, ...lookups, favorites.settle(), scanned, summarized, ...opening.values()]);
    await within(settled, STOP_WAIT_MS).catch(() => undefined);
    await within(fileLog.flush(), 100).catch(() => undefined);
  };
}
