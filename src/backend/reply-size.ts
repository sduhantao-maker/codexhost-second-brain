/**
 * How big the backend's answers get. codexhost refuses a message over 2 MiB from the backend
 * ("Backend IPC message exceeds 2 MiB"), so no answer may be over REPLY_LIMIT_BYTES, however much
 * is saved: the snapshot sends an outline of the conversations that do not fit in full, lists come
 * in pages or newest first up to the limit, and anything else over it is refused with TOO_LARGE.
 */
import { currentMilestone, progressOf, type Conversation, type StateV2 } from "../core/conversation.js";
import type { ConversationView } from "../core/conversation-view.js";
import { MainlineError, type Stamp } from "../core/model.js";
import type { SnapshotResultV2 } from "../core/rpc.js";

/** The most any answer may take, as JSON in UTF-8, with room to spare under codexhost's 2 MiB. */
export const REPLY_LIMIT_BYTES = 1.5 * 1024 * 1024;
/**
 * What a snapshot aims at: it goes to every surface each time anything shown changes, so past this
 * it sends outlines rather than fill the limit.
 */
export const SNAPSHOT_TARGET_BYTES = 1024 * 1024;
/** Last requests cut to this many characters when the snapshot is short of room. */
const PROMPT_CUT = 60;

export const byteSize = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? "null");

/** Plain JSON (codexhost rejects undefined fields), and never over the limit: refused with TOO_LARGE instead. */
export function clean<T>(value: T, limit = REPLY_LIMIT_BYTES): T {
  if (value === undefined) return null as T;
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > limit) throw new MainlineError("TOO_LARGE", `The answer would be over ${Math.round(limit / 1024)} KiB`);
  return JSON.parse(text) as T;
}

/**
 * How many of `items`, in order, fit in `budget` bytes with `base` taken already (at least none,
 * at most all). `size` gives what one item adds.
 */
export function fitting<T>(items: readonly T[], base: number, size: (item: T) => number, budget = REPLY_LIMIT_BYTES): number {
  let total = base;
  for (let count = 0; count < items.length; count += 1) {
    total += size(items[count]!) + 1;
    if (total > budget) return count;
  }
  return items.length;
}

/** A conversation as an outline: what reading the state (normalizeStateV2) fills in is left out. */
export type Outline = Pick<Conversation, "title" | "status" | "updatedAt" | "parentId" | "relatedTo"> & { milestones?: Array<{ id: string; title: string; state: "current" }> };

/**
 * A conversation as the overview's list needs it: its title, status, last change, links, and its
 * current milestone without tasks; nothing a reader of the state fills in (tags, spin-offs, tasks
 * and the first date come back empty). Its progress goes in the snapshot's `outline`; the page
 * reads the rest with `conversation` when it opens the row.
 */
export function outlineOf(conversation: Conversation): Outline {
  const current = currentMilestone(conversation);
  return {
    title: conversation.title,
    status: conversation.status,
    updatedAt: conversation.updatedAt,
    ...(current ? { milestones: [{ id: current.id, title: current.title, state: "current" as const }] } : {}),
    ...(conversation.parentId ? { parentId: conversation.parentId } : {}),
    ...(conversation.relatedTo ? { relatedTo: conversation.relatedTo } : {}),
  };
}

const progressTuple = (conversation: Conversation): [number, number] => {
  const { done, total } = progressOf(conversation);
  return [done, total];
};

const cutStamp = (stamp: Stamp): Stamp => {
  const chars = Array.from(stamp.text);
  return chars.length > PROMPT_CUT ? { text: `${chars.slice(0, PROMPT_CUT - 1).join("")}…`, at: stamp.at } : stamp;
};

/** Everything a snapshot holds, before it is fitted. */
export type SnapshotParts = SnapshotResultV2 & { state: StateV2; info: NonNullable<SnapshotResultV2["info"]>; workspaces: Record<string, string>; parents: Record<string, string> };

/** Finished first, then paused, then active; the oldest first within each: what the overview needs least. */
function leastNeededFirst(records: readonly Conversation[]): Conversation[] {
  const rank = { done: 0, paused: 1, active: 2 } as const;
  return [...records].sort((a, b) => rank[a.status] - rank[b.status] || a.updatedAt - b.updatedAt);
}

/**
 * The snapshot to send. When it all fits, the whole state goes, as before. Otherwise last requests
 * are cut short (a page shows them in one line, and the backend's view has them whole), then
 * conversations are sent as outlines (finished ones first, the oldest first) until it fits, with
 * their progress in `outline`; and if even that is too much, the oldest entries are left out
 * (`omitted` says how many) so that the answer always arrives.
 */
export function fitSnapshot(parts: SnapshotParts, budget = SNAPSHOT_TARGET_BYTES): SnapshotResultV2 {
  const { state } = parts;
  const records = Object.values(state.conversations);
  const keySize = (threadId: string) => byteSize(threadId) + 2;
  const base = byteSize({ ...parts, state: { ...state, conversations: {}, prompts: {} } });
  const full = new Map(records.map((conversation) => [conversation.threadId, keySize(conversation.threadId) + byteSize(conversation)]));
  const promptsSize = (cut: boolean) =>
    Object.entries(state.prompts).reduce((sum, [threadId, stamp]) => sum + keySize(threadId) + byteSize(cut ? cutStamp(stamp) : stamp), 0);
  let total = base + [...full.values()].reduce((sum, size) => sum + size, 0) + promptsSize(false);
  if (total <= budget) {
    const text = JSON.stringify(parts);
    if (Buffer.byteLength(text) <= budget) return JSON.parse(text) as SnapshotResultV2;
  }
  // Last requests cut short, then outlines, the least needed first, until the estimate fits.
  total += promptsSize(true) - promptsSize(false) + byteSize({ outline: {} });
  const outlined = new Set<string>();
  for (const conversation of leastNeededFirst(records)) {
    if (total <= budget) break;
    const id = conversation.threadId;
    total += keySize(id) + byteSize(outlineOf(conversation)) + keySize(id) + byteSize(progressTuple(conversation)) - full.get(id)!;
    outlined.add(id);
  }
  let text = build(parts, outlined, true, new Set());
  if (Buffer.byteLength(text) <= budget) return JSON.parse(text) as SnapshotResultV2;
  // Still too much: everything as an outline, requests cut, and the oldest entries left out, more each round.
  const all = new Set(records.map((conversation) => conversation.threadId));
  const order = [
    // Conversations without a mainline (only a last request) first, the oldest first.
    ...Object.entries(state.prompts)
      .filter(([threadId]) => !state.conversations[threadId])
      .sort(([, a], [, b]) => a.at - b.at)
      .map(([threadId]) => threadId),
    ...leastNeededFirst(records).map((conversation) => conversation.threadId),
  ];
  const leaving = (count: number) => build(parts, all, true, new Set(order.slice(0, count)), count > 0 && count >= order.length);
  text = leaving(0);
  if (Buffer.byteLength(text) <= budget) return JSON.parse(text) as SnapshotResultV2;
  // Twice as many each round until it fits, then halving back to the fewest that fit.
  let fits = 0;
  let short = 0;
  for (let count = Math.max(1, Math.ceil(order.length / 32)); ; count = Math.min(order.length, count * 2)) {
    text = leaving(count);
    if (Buffer.byteLength(text) <= budget) {
      fits = count;
      break;
    }
    if (count >= order.length) throw new MainlineError("TOO_LARGE", "The snapshot does not fit in an answer");
    short = count;
  }
  while (fits - short > Math.max(1, Math.ceil(order.length / 256))) {
    const middle = Math.floor((short + fits) / 2);
    const candidate = leaving(middle);
    if (Buffer.byteLength(candidate) <= budget) {
      fits = middle;
      text = candidate;
    } else short = middle;
  }
  return JSON.parse(text) as SnapshotResultV2;
}

/** The snapshot as JSON text: `outlined` as outlines, last requests `cut`, `dropped` left out (and with `bare`, every id no kept entry needs). */
function build(parts: SnapshotParts, outlined: ReadonlySet<string>, cut: boolean, dropped: ReadonlySet<string>, bare = false): string {
  const { state } = parts;
  const conversations: Record<string, Conversation | Outline> = {};
  const outline: Record<string, [number, number]> = {};
  for (const conversation of Object.values(state.conversations)) {
    const id = conversation.threadId;
    if (dropped.has(id)) continue;
    if (outlined.has(id)) {
      conversations[id] = outlineOf(conversation);
      outline[id] = progressTuple(conversation);
    } else conversations[id] = conversation;
  }
  const prompts: Record<string, Stamp> = {};
  for (const [threadId, stamp] of Object.entries(state.prompts)) if (!dropped.has(threadId)) prompts[threadId] = cut ? cutStamp(stamp) : stamp;
  let { info, workspaces, parents } = parts;
  if (dropped.size) {
    // Facts of what is still sent, and of the conversations those came from.
    const needed = new Set([...Object.keys(conversations), ...Object.keys(prompts)]);
    for (const conversation of Object.values(conversations)) if (conversation.parentId) needed.add(conversation.parentId);
    if (!bare) for (const [child, parent] of Object.entries(parents)) if (needed.has(child)) needed.add(parent);
    const keep = <T>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).filter(([threadId]) => needed.has(threadId)));
    info = keep(info);
    workspaces = keep(workspaces);
    parents = Object.fromEntries(Object.entries(parents).filter(([child, parent]) => needed.has(child) && needed.has(parent)));
  }
  return JSON.stringify({
    ...parts,
    state: { ...state, conversations, prompts },
    info,
    workspaces,
    parents,
    ...(Object.keys(outline).length ? { outline } : {}),
    ...(dropped.size ? { omitted: dropped.size } : {}),
  });
}

/**
 * A conversation's full view, fitted: in the rare case it would be over the limit, the tasks of
 * reached milestones go first, then the oldest PRs and issues beyond what fits, then every task and
 * spin-off text is cut short.
 */
export function fitView(view: ConversationView, budget = REPLY_LIMIT_BYTES): ConversationView {
  if (byteSize(view) <= budget) return view;
  let lighter: ConversationView = { ...view, milestones: view.milestones.map((milestone) => (milestone.state === "done" ? { ...milestone, tasks: [] } : milestone)) };
  if (byteSize(lighter) <= budget) return lighter;
  lighter = { ...lighter, refs: lighter.refs.slice(0, fitting(lighter.refs, byteSize({ ...lighter, refs: [] }), byteSize, budget)) };
  if (byteSize(lighter) <= budget) return lighter;
  const short = (text: string) => (Array.from(text).length > 80 ? `${Array.from(text).slice(0, 79).join("")}…` : text);
  return {
    ...lighter,
    milestones: lighter.milestones.map((milestone) => ({ ...milestone, tasks: milestone.tasks.map((task) => ({ ...task, text: short(task.text) })) })),
    spinoffs: lighter.spinoffs.map((spinoff) => ({ ...spinoff, text: short(spinoff.text) })),
  };
}
