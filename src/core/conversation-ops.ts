/**
 * Edits of a conversation's mainline (v2). Each edits the draft it is given; the caller owns
 * copying, locking and saving. Errors are MainlineError with a code callers can explain.
 */
import {
  cleanTags,
  cleanTitle,
  currentMilestone,
  latestMarks,
  REMOVED_MILESTONES_KEPT,
  V2_LIMITS,
  type Conversation,
  type ConversationStatus,
  type Milestone,
  type MilestoneState,
  type PinnedField,
  type Spinoff,
  type StateV2,
  type SummaryRecord,
  type Task,
} from "./conversation.js";
import { isRemoteHostId } from "./hosts.js";
import { cleanText, isThreadId, MainlineError, newId, requestOf, type Locale } from "./model.js";
import { maskSecrets } from "./redact.js";

export interface V2Context {
  now: number;
  random?: () => number;
}

const DAY = 24 * 60 * 60 * 1000;

/** The conversation's record, never something every object has (`constructor`, `toString`, …). */
function recordOf(state: StateV2, threadId: string): Conversation | undefined {
  return Object.hasOwn(state.conversations, threadId) ? state.conversations[threadId] : undefined;
}

/** A conversation id a record may be filed under or point to. */
function requireThreadId(threadId: string, field = "threadId"): void {
  if (!isThreadId(threadId)) throw new MainlineError("INVALID_ARGUMENT", `${field} is not a conversation id`);
}

export function requireConversation(state: StateV2, threadId: string): Conversation {
  const conversation = recordOf(state, threadId);
  if (!conversation) throw new MainlineError("NO_MAINLINE", "This conversation has no mainline yet");
  return conversation;
}

function touch(conversation: Conversation, now: number): void {
  conversation.updatedAt = now;
}

function takenIds(conversation: Conversation): Set<string> {
  const ids = new Set<string>();
  for (const milestone of conversation.milestones) {
    ids.add(milestone.id);
    for (const task of milestone.tasks) ids.add(task.id);
  }
  for (const spinoff of conversation.spinoffs) ids.add(spinoff.id);
  return ids;
}

function freshId(conversation: Conversation, ctx: V2Context, length = 4): string {
  const taken = takenIds(conversation);
  return newId((id) => taken.has(id), length, ctx.random);
}

function stageName(locale: Locale | undefined, number: number): string {
  return locale === "en" ? `Stage ${number}` : `第 ${number} 阶段`;
}

function findMilestone(conversation: Conversation, milestoneId: string): Milestone {
  const milestone = conversation.milestones.find(({ id }) => id === milestoneId);
  if (!milestone) throw new MainlineError("UNKNOWN_ITEM", `No milestone ${milestoneId}`);
  return milestone;
}

/** Finds a milestone by id, or by its title (exact first, then contained). */
export function resolveMilestone(conversation: Conversation, key: string): Milestone {
  const text = key.trim();
  const byId = conversation.milestones.find(({ id }) => id === text);
  if (byId) return byId;
  const exact = conversation.milestones.find(({ title }) => title === text);
  if (exact) return exact;
  const lower = text.toLowerCase();
  const partial = conversation.milestones.find(({ title }) => title.toLowerCase().includes(lower));
  if (partial) return partial;
  throw new MainlineError("UNKNOWN_ITEM", `No milestone "${key}"`);
}

function findTask(conversation: Conversation, taskId: string): { milestone: Milestone; task: Task } {
  for (const milestone of conversation.milestones) {
    const task = milestone.tasks.find(({ id }) => id === taskId);
    if (task) return { milestone, task };
  }
  throw new MainlineError("UNKNOWN_ITEM", `No task ${taskId}`);
}

/**
 * The milestone new tasks go to. Without a current one, the first planned milestone becomes
 * current; with none left, a new stage is opened. All milestones are reached then: at the cap the
 * oldest reached one makes room (one the user did not add or rename, when there is one), and its
 * unfinished tasks go on in the new stage. Readers keep only the first `V2_LIMITS.milestones`.
 */
export function ensureCurrent(state: StateV2, conversation: Conversation, ctx: V2Context): Milestone {
  const current = currentMilestone(conversation);
  if (current) return current;
  const planned = conversation.milestones.find(({ state: s }) => s === "planned");
  if (planned) {
    planned.state = "current";
    return planned;
  }
  // Drawn while every id is still there, the carried tasks' too.
  const id = freshId(conversation, ctx);
  const carried: Task[] = [];
  while (conversation.milestones.length >= V2_LIMITS.milestones) {
    const [dropped] = conversation.milestones.splice(conversation.milestones.indexOf(oldestReached(conversation.milestones)), 1);
    carried.push(...(dropped?.tasks.filter((task) => !task.done) ?? []));
  }
  const milestone: Milestone = { id, title: newStageTitle(state.locale, conversation), state: "current", tasks: carried.slice(-V2_LIMITS.tasks) };
  conversation.milestones.push(milestone);
  return milestone;
}

/** The reached milestone to drop first: the earliest reached, of those the user did not add or rename when there are any. */
function oldestReached(milestones: readonly Milestone[]): Milestone {
  const reached = milestones.filter(({ state }) => state === "done");
  const unpinned = reached.filter((milestone) => !milestone.pinned);
  const pool = unpinned.length ? unpinned : reached.length ? reached : milestones;
  return pool.reduce((oldest, milestone) => ((milestone.doneAt ?? 0) < (oldest.doneAt ?? 0) ? milestone : oldest));
}

/** "Stage n" for the next stage, with a number no milestone has as its title yet. */
function newStageTitle(locale: Locale | undefined, conversation: Conversation): string {
  let number = conversation.milestones.length + 1;
  while (conversation.milestones.some(({ title }) => title === stageName(locale, number))) number += 1;
  return stageName(locale, number);
}

/** Drops the oldest tasks past the cap, as adding a task does. */
function capTasks(milestone: Milestone): void {
  milestone.tasks.splice(0, Math.max(0, milestone.tasks.length - V2_LIMITS.tasks));
}

function pushMilestones(conversation: Conversation, titles: readonly string[], ctx: V2Context): Milestone[] {
  const added: Milestone[] = [];
  for (const raw of titles) {
    const title = cleanTitle(raw);
    if (conversation.milestones.some((milestone) => milestone.title === title)) continue;
    if (conversation.milestones.length >= V2_LIMITS.milestones)
      throw new MainlineError("MILESTONE_LIMIT", `At most ${V2_LIMITS.milestones} milestones`);
    const milestone: Milestone = { id: freshId(conversation, ctx), title, state: "planned", tasks: [] };
    conversation.milestones.push(milestone);
    added.push(milestone);
  }
  if (!currentMilestone(conversation)) {
    const next = conversation.milestones.find(({ state: s }) => s === "planned");
    if (next) next.state = "current";
  }
  return added;
}

/**
 * Creates the mainline, or refines it when it exists: the title and tags change, new milestones are
 * added. A mainline asked for again after the user deleted it lifts that mark, so model summaries
 * may update it again; `keepExcluded` keeps the mark, for a record made only to hold something
 * (a link to a child conversation) that is not the user asking for the mainline.
 */
export function createConversation(
  state: StateV2,
  threadId: string,
  input: { title: string; tags?: readonly string[] | string; milestones?: readonly string[] },
  ctx: V2Context,
  options: { keepExcluded?: boolean } = {},
): Conversation {
  requireThreadId(threadId);
  const title = cleanTitle(input.title);
  let conversation = recordOf(state, threadId);
  if (!conversation) {
    conversation = { threadId, title, tags: [], status: "active", milestones: [], spinoffs: [], createdAt: ctx.now, updatedAt: ctx.now };
    state.conversations[threadId] = conversation;
  }
  if (!options.keepExcluded) includeInSummaries(state, threadId);
  conversation.title = title;
  if (input.tags !== undefined) conversation.tags = cleanTags(input.tags);
  if (input.milestones?.length) pushMilestones(conversation, input.milestones, ctx);
  if (conversation.status === "done") conversation.status = "active";
  touch(conversation, ctx.now);
  return conversation;
}

export function setTitle(state: StateV2, threadId: string, title: string, ctx: V2Context): void {
  const conversation = requireConversation(state, threadId);
  conversation.title = cleanTitle(title);
  touch(conversation, ctx.now);
}

export function setTags(state: StateV2, threadId: string, tags: readonly string[] | string, ctx: V2Context): void {
  const conversation = requireConversation(state, threadId);
  conversation.tags = cleanTags(tags);
  touch(conversation, ctx.now);
}

export function addTags(state: StateV2, threadId: string, tags: readonly string[] | string, ctx: V2Context): void {
  const conversation = requireConversation(state, threadId);
  conversation.tags = cleanTags([...conversation.tags, ...cleanTags(tags)]);
  touch(conversation, ctx.now);
}

export function removeTags(state: StateV2, threadId: string, tags: readonly string[] | string, ctx: V2Context): void {
  const conversation = requireConversation(state, threadId);
  const drop = new Set(cleanTags(tags).map((tag) => tag.toLowerCase()));
  conversation.tags = conversation.tags.filter((tag) => !drop.has(tag.toLowerCase()));
  touch(conversation, ctx.now);
}

export function setStatus(state: StateV2, threadId: string, status: ConversationStatus, ctx: V2Context): void {
  const conversation = requireConversation(state, threadId);
  conversation.status = status;
  if (status === "done") delete conversation.now;
  touch(conversation, ctx.now);
}

export function planMilestones(state: StateV2, threadId: string, titles: readonly string[], ctx: V2Context): Milestone[] {
  const conversation = requireConversation(state, threadId);
  const added = pushMilestones(conversation, titles, ctx);
  touch(conversation, ctx.now);
  return added;
}

export function addMilestone(state: StateV2, threadId: string, title: string, ctx: V2Context, index?: number): Milestone {
  const conversation = requireConversation(state, threadId);
  const [milestone] = pushMilestones(conversation, [title], ctx);
  if (!milestone) throw new MainlineError("MILESTONE_EXISTS", "That milestone exists already");
  if (index !== undefined && index >= 0 && index < conversation.milestones.length - 1) {
    conversation.milestones.splice(conversation.milestones.indexOf(milestone), 1);
    conversation.milestones.splice(index, 0, milestone);
  }
  touch(conversation, ctx.now);
  return milestone;
}

export function renameMilestone(state: StateV2, threadId: string, milestoneId: string, title: string, ctx: V2Context): void {
  const conversation = requireConversation(state, threadId);
  findMilestone(conversation, milestoneId).title = cleanTitle(title);
  touch(conversation, ctx.now);
}

/** Removes a milestone. Its unfinished tasks move to the current milestone so nothing is lost. */
export function removeMilestone(state: StateV2, threadId: string, milestoneId: string, ctx: V2Context): void {
  const conversation = requireConversation(state, threadId);
  const milestone = findMilestone(conversation, milestoneId);
  conversation.milestones.splice(conversation.milestones.indexOf(milestone), 1);
  const open = milestone.tasks.filter((task) => !task.done);
  if (open.length) {
    const target = ensureCurrent(state, conversation, ctx);
    target.tasks.push(...open);
    capTasks(target);
  } else if (milestone.state === "current" && conversation.milestones.length) {
    const next = conversation.milestones.find(({ state: s }) => s === "planned");
    if (next) next.state = "current";
  }
  touch(conversation, ctx.now);
}

/** Marks the current milestone (or the given one) as reached; the next planned one becomes current. */
export function reachMilestone(
  state: StateV2,
  threadId: string,
  ctx: V2Context,
  key?: string,
): { reached: Milestone; next?: Milestone } {
  const conversation = requireConversation(state, threadId);
  const reached = key ? resolveMilestone(conversation, key) : currentMilestone(conversation);
  if (!reached) throw new MainlineError("NO_CURRENT_MILESTONE", "There is no current milestone to reach");
  const wasCurrent = reached.state === "current";
  reached.state = "done";
  reached.doneAt = ctx.now;
  let next: Milestone | undefined;
  if (wasCurrent) {
    const after = conversation.milestones.slice(conversation.milestones.indexOf(reached) + 1);
    next = after.find(({ state: s }) => s === "planned") ?? conversation.milestones.find(({ state: s }) => s === "planned");
    const open = reached.tasks.filter((task) => !task.done);
    if (next) {
      next.state = "current";
      // Unfinished tasks go on with the work instead of staying behind in a reached stage.
      reached.tasks = reached.tasks.filter((task) => task.done);
      for (const task of open) if (!next.tasks.some((other) => !other.done && other.text === task.text)) next.tasks.push(task);
      capTasks(next);
    } else if (conversation.now && reached.tasks.some((task) => task.text === conversation.now?.text)) delete conversation.now;
  }
  touch(conversation, ctx.now);
  return { reached, ...(next ? { next } : {}) };
}

/** Makes a milestone the current one; a reached milestone opens again. */
export function focusMilestone(state: StateV2, threadId: string, milestoneId: string, ctx: V2Context): void {
  const conversation = requireConversation(state, threadId);
  const target = findMilestone(conversation, milestoneId);
  for (const milestone of conversation.milestones) if (milestone.state === "current" && milestone !== target) milestone.state = "planned";
  target.state = "current";
  delete target.doneAt;
  touch(conversation, ctx.now);
}

export function addTask(state: StateV2, threadId: string, text: string, ctx: V2Context, milestoneId?: string): Task {
  const conversation = requireConversation(state, threadId);
  const milestone = milestoneId ? findMilestone(conversation, milestoneId) : ensureCurrent(state, conversation, ctx);
  const clean = cleanText(text);
  const existing = milestone.tasks.find((task) => !task.done && task.text === clean);
  if (existing) return existing;
  const task: Task = { id: freshId(conversation, ctx, 5), text: clean, done: false, at: ctx.now };
  milestone.tasks.push(task);
  capTasks(milestone);
  touch(conversation, ctx.now);
  return task;
}

/** Sets what the conversation is doing now; the text also becomes a task of the current milestone. */
export function setDoing(state: StateV2, threadId: string, text: string | null, ctx: V2Context): void {
  const conversation = requireConversation(state, threadId);
  if (text === null) delete conversation.now;
  else {
    const task = addTask(state, threadId, text, ctx);
    conversation.now = { text: task.text, at: ctx.now };
  }
  touch(conversation, ctx.now);
}

/**
 * Marks a task done, found by id or by text. Done work that was never recorded as a task is added
 * as a finished task of the current milestone.
 */
export function completeTask(state: StateV2, threadId: string, ctx: V2Context, target: { taskId?: string; text?: string }): Task {
  const conversation = requireConversation(state, threadId);
  let task: Task | undefined;
  if (target.taskId) task = findTask(conversation, target.taskId).task;
  else if (target.text !== undefined) {
    const clean = cleanText(target.text);
    for (const milestone of [...conversation.milestones].reverse()) {
      task = milestone.tasks.find((item) => !item.done && item.text === clean);
      if (task) break;
    }
    task ??= addTask(state, threadId, clean, ctx);
  } else if (conversation.now) {
    task = completeTask(state, threadId, ctx, { text: conversation.now.text });
    return task;
  } else throw new MainlineError("INVALID_ARGUMENT", "Which task? Give its text");
  task.done = true;
  task.doneAt = ctx.now;
  if (conversation.now?.text === task.text) delete conversation.now;
  touch(conversation, ctx.now);
  return task;
}

export function removeTask(state: StateV2, threadId: string, taskId: string, ctx: V2Context): void {
  const conversation = requireConversation(state, threadId);
  const { milestone, task } = findTask(conversation, taskId);
  milestone.tasks.splice(milestone.tasks.indexOf(task), 1);
  if (conversation.now?.text === task.text && !task.done) delete conversation.now;
  touch(conversation, ctx.now);
}

export function addSpinoff(state: StateV2, threadId: string, text: string, ctx: V2Context): Spinoff {
  const conversation = requireConversation(state, threadId);
  const clean = cleanText(text);
  const existing = conversation.spinoffs.find((spinoff) => spinoff.state === "open" && spinoff.text === clean);
  if (existing) return existing;
  const spinoff: Spinoff = { id: freshId(conversation, ctx), text: clean, at: ctx.now, state: "open" };
  conversation.spinoffs.push(spinoff);
  conversation.spinoffs.splice(0, Math.max(0, conversation.spinoffs.length - V2_LIMITS.spinoffs));
  touch(conversation, ctx.now);
  return spinoff;
}

function findSpinoff(conversation: Conversation, key: string): Spinoff {
  const spinoff =
    conversation.spinoffs.find(({ id }) => id === key) ??
    conversation.spinoffs.find((item) => item.state === "open" && item.text.includes(key.trim()));
  if (!spinoff) throw new MainlineError("UNKNOWN_ITEM", `No spin-off "${key}"`);
  return spinoff;
}

export function dismissSpinoff(state: StateV2, threadId: string, spinoffId: string, ctx: V2Context): void {
  const conversation = requireConversation(state, threadId);
  findSpinoff(conversation, spinoffId).state = "dismissed";
  touch(conversation, ctx.now);
}

/** Handles a spin-off here after all: it turns into a task of the current milestone. */
export function keepSpinoff(state: StateV2, threadId: string, spinoffId: string, ctx: V2Context): Task {
  const conversation = requireConversation(state, threadId);
  const spinoff = findSpinoff(conversation, spinoffId);
  conversation.spinoffs.splice(conversation.spinoffs.indexOf(spinoff), 1);
  return addTask(state, threadId, spinoff.text, ctx);
}

export function spinoffOf(state: StateV2, threadId: string, key: string): Spinoff {
  return findSpinoff(requireConversation(state, threadId), key);
}

/**
 * Records that a child conversation now handles a spin-off. The child gets a mainline right away,
 * named after the problem, so it reads clearly in the sidebar before its agent refines it; when
 * the mainlines are at their cap and none can make room, only the link is recorded (the child is
 * open already by then).
 */
export function linkSpinoff(state: StateV2, threadId: string, spinoffId: string, childThreadId: string, ctx: V2Context): void {
  requireThreadId(childThreadId, "childThreadId");
  const conversation = requireConversation(state, threadId);
  const spinoff = findSpinoff(conversation, spinoffId);
  spinoff.state = "spawned";
  spinoff.childThreadId = childThreadId;
  touch(conversation, ctx.now);
  if (!recordOf(state, childThreadId) && hasRoomForMainline(state))
    state.conversations[childThreadId] = {
      threadId: childThreadId,
      title: cleanTitle(spinoff.text),
      tags: conversation.tags.slice(0, 3),
      status: "active",
      milestones: [],
      spinoffs: [],
      parentId: threadId,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    };
}

export function relate(state: StateV2, threadId: string, toThreadId: string | null, ctx: V2Context): void {
  const conversation = requireConversation(state, threadId);
  if (toThreadId === null) delete conversation.relatedTo;
  else if (toThreadId === threadId) throw new MainlineError("INVALID_ARGUMENT", "A conversation cannot be linked to itself");
  else {
    requireThreadId(toThreadId, "toThreadId");
    conversation.relatedTo = toThreadId;
  }
  touch(conversation, ctx.now);
}

/**
 * Deletes a conversation's mainline, and its last request with it. The conversation is marked so
 * that automatic summaries and the backfill do not bring the mainline back; asking for a summary
 * or a mainline again clears the mark.
 */
export function deleteConversation(state: StateV2, threadId: string, ctx: V2Context): void {
  requireConversation(state, threadId);
  delete state.conversations[threadId];
  delete state.prompts[threadId];
  state.excluded = latestMarks({ ...state.excluded, [threadId]: ctx.now });
}

/** True when the user deleted this conversation's mainline and has not asked for one since. */
export function isExcluded(state: Pick<StateV2, "excluded">, threadId: string): boolean {
  return state.excluded !== undefined && Object.hasOwn(state.excluded, threadId);
}

/** Lets model summaries write this conversation's mainline again. Returns whether it was excluded. */
export function includeInSummaries(state: StateV2, threadId: string): boolean {
  if (!isExcluded(state, threadId)) return false;
  const { [threadId]: _cleared, ...rest } = state.excluded!;
  if (Object.keys(rest).length) state.excluded = rest;
  else delete state.excluded;
  return true;
}

/** Remembers the latest user message of a window, without attachment lists or secrets. Returns false for empty messages. */
export function recordPromptV2(state: StateV2, threadId: string, text: string, ctx: V2Context): boolean {
  if (!isThreadId(threadId)) return false;
  let clean: string;
  try {
    // requestOf masks secrets before the text is cut to length here, so no part of one is kept;
    // it masks only the start of a long message, far more than is kept, so the lock is not held long.
    clean = cleanText(requestOf(text));
  } catch {
    return false;
  }
  state.prompts[threadId] = { text: clean, at: ctx.now };
  return true;
}

/**
 * Masks secrets in the stored last requests, as `recordPromptV2` masks them now; states written
 * before that kept them as said. Returns how many changed.
 */
export function maskStoredPrompts(state: StateV2): number {
  let masked = 0;
  for (const stamp of Object.values(state.prompts)) {
    const text = maskSecrets(stamp.text);
    if (text === stamp.text) continue;
    stamp.text = text;
    masked += 1;
  }
  return masked;
}

/** Writes known delegation parents into existing records. Returns whether anything changed. */
export function noteParents(state: StateV2, parents: ReadonlyMap<string, string>): boolean {
  let changed = false;
  for (const [child, parent] of parents) {
    const conversation = recordOf(state, child);
    if (conversation && isThreadId(parent) && parent !== child && conversation.parentId !== parent) {
      conversation.parentId = parent;
      changed = true;
    }
  }
  return changed;
}

/**
 * Writes the remote host each conversation runs on into its record, where the backend learned it
 * (from codexhost Web's sidebar or a host's list), so that it is read on that host after a restart
 * too. Anything that is no remote host id is left out. Returns whether anything changed.
 */
export function noteHosts(state: StateV2, hosts: Iterable<readonly [string, string]>): boolean {
  let changed = false;
  for (const [threadId, hostId] of hosts) {
    const conversation = recordOf(state, threadId);
    if (conversation && isRemoteHostId(hostId) && conversation.hostId !== hostId) {
      conversation.hostId = hostId;
      changed = true;
    }
  }
  return changed;
}

/** Mainlines kept at most. */
export const MAX_CONVERSATIONS = 2000;

/**
 * Mainlines the cap never removes: those the user edited by hand (a title, tags or status set by
 * hand, a milestone added, renamed or removed) and those with work still open (a task in progress
 * or not done yet).
 */
export function keptByCap(conversation: Conversation): boolean {
  if (conversation.pinned && Object.keys(conversation.pinned).length) return true;
  if (conversation.removedMilestones?.length || conversation.now) return true;
  return conversation.milestones.some((milestone) => milestone.pinned || milestone.tasks.some((task) => !task.done));
}

/**
 * Whether a new mainline in progress (active, changed now) can be added: below the cap, or with a
 * mainline the cap may remove to make room. Callers can ask before starting work a refusal would
 * leave half done.
 */
export function hasRoomForMainline(state: StateV2): boolean {
  const all = Object.values(state.conversations);
  return all.length < MAX_CONVERSATIONS || all.some((conversation) => !keptByCap(conversation));
}

/**
 * Drops stale prompts and keeps the number of mainlines bounded. Past `MAX_CONVERSATIONS`, the
 * mainlines the cap may remove (see `keptByCap`) go, finished ones first, then the oldest. Records
 * that `created` names (made by the change being saved) are not removed to make room: when one of
 * them would be the next to go, or nothing else can go, the change is refused with STATE_FULL
 * instead, so that a new mainline never silently replaces one the user edited or still works on.
 */
export function pruneV2(state: StateV2, ctx: V2Context, created: ReadonlySet<string> = new Set()): void {
  for (const [threadId, stamp] of Object.entries(state.prompts)) if (ctx.now - stamp.at > 14 * DAY) delete state.prompts[threadId];
  const all = Object.values(state.conversations);
  let excess = all.length - MAX_CONVERSATIONS;
  if (excess <= 0) return;
  const removable = all
    .filter((conversation) => !keptByCap(conversation))
    .sort((a, b) => Number(a.status !== "done") - Number(b.status !== "done") || a.updatedAt - b.updatedAt);
  for (const conversation of removable) {
    if (excess <= 0 || created.has(conversation.threadId)) break;
    delete state.conversations[conversation.threadId];
    excess -= 1;
  }
  if (excess > 0 && [...created].some((threadId) => recordOf(state, threadId)))
    throw new MainlineError(
      "STATE_FULL",
      `At most ${MAX_CONVERSATIONS} mainlines are kept, and none of the others can make room (they were edited by hand, have work still open or are newer); delete mainlines you no longer need in the overview`,
    );
}

// ---------------------------------------------------------------------------------------------
// Model summaries

/** What a model read out of a conversation. */
export interface SummaryInput {
  title: string;
  tags: readonly string[];
  milestones: ReadonlyArray<{ title: string; state: MilestoneState }>;
  /** The conversation's goal looks reached, or the work was dropped. */
  finished: boolean;
}

export interface SummaryContext extends V2Context {
  /** When the conversation itself last changed (from codexhost); new records take it as their dates. */
  activityAt?: number;
}

/** Conversations quiet longer than this get a summary status (paused or done) instead of active. */
export const STALE_AFTER_MS = 7 * DAY;

const sameTitle = (a: string, b: string) => a.replace(/\s+/gu, "").toLowerCase() === b.replace(/\s+/gu, "").toLowerCase();

/**
 * Applies a model summary. Parts the user edited by hand (pinned) stay as they are. Milestones keep
 * their ids, tasks and dates when the model keeps their titles; tasks of milestones the model
 * dropped move on with the work. A conversation without a mainline gets one; an old one is marked
 * paused or done. The task in progress, spin-offs and links stay the agent's.
 */
export function applySummary(
  state: StateV2,
  threadId: string,
  input: SummaryInput,
  record: SummaryRecord,
  ctx: SummaryContext,
): Conversation {
  const activityAt = ctx.activityAt ?? ctx.now;
  const stale = ctx.now - activityAt > STALE_AFTER_MS;
  requireThreadId(threadId);
  let conversation = recordOf(state, threadId);
  if (!conversation) {
    conversation = {
      threadId,
      title: cleanTitle(input.title),
      tags: [],
      status: "active",
      milestones: [],
      spinoffs: [],
      createdAt: activityAt,
      updatedAt: activityAt,
    };
    state.conversations[threadId] = conversation;
  } else if (!conversation.pinned?.title) conversation.title = cleanTitle(input.title);
  if (!conversation.pinned?.tags) conversation.tags = cleanTags([...input.tags]);
  mergeMilestones(conversation, input.milestones, ctx);
  // Work that goes on always has a current stage: the next planned one, when the model named none.
  if (!input.finished && !currentMilestone(conversation)) {
    const next = conversation.milestones.find(({ state }) => state === "planned");
    if (next) next.state = "current";
  }
  // The status follows the model's reading (done when the goal is reached, paused when long
  // quiet), unless the user set it by hand or an agent is in the middle of a task.
  if (!conversation.pinned?.status && !conversation.now)
    conversation.status = input.finished ? "done" : stale ? "paused" : "active";
  conversation.summary = { ...record, finished: input.finished };
  return conversation;
}

function mergeMilestones(conversation: Conversation, proposed: SummaryInput["milestones"], ctx: SummaryContext): void {
  const old = [...conversation.milestones];
  // Reached milestones are history: they stay, in their order, whatever the model says.
  const history = old.filter((milestone) => milestone.state === "done");
  const removed = conversation.removedMilestones ?? [];
  const used = new Set<Milestone>(history);
  const fresh: Milestone[] = [];
  for (const item of proposed.slice(0, V2_LIMITS.milestones)) {
    let title: string;
    try {
      title = cleanTitle(item.title);
    } catch {
      continue;
    }
    if (removed.some((gone) => sameTitle(gone, title))) continue;
    if (history.some((milestone) => sameTitle(milestone.title, title)) || fresh.some((milestone) => sameTitle(milestone.title, title))) continue;
    const kept = old.find((milestone) => !used.has(milestone) && sameTitle(milestone.title, title));
    if (kept) used.add(kept);
    const milestone: Milestone = kept ?? { id: "", title, state: "planned", tasks: [] };
    if (!milestone.pinned) milestone.title = title;
    milestone.state = item.state;
    // Reached somewhere in the conversation: by its last change at the latest.
    if (milestone.state === "done") milestone.doneAt ??= ctx.activityAt ?? ctx.now;
    fresh.push(milestone);
  }
  // Milestones the user added or renamed stay even when the model left them out, where they were.
  old.forEach((milestone, index) => {
    if (used.has(milestone) || !milestone.pinned) return;
    used.add(milestone);
    const after = old.slice(index + 1).find((later) => fresh.includes(later));
    fresh.splice(after ? fresh.indexOf(after) : fresh.length, 0, milestone);
  });
  if (!fresh.length && !history.length) return;
  // A timeline reads reached, then current, then planned; the order within each stays.
  const rank: Record<MilestoneState, number> = { done: 0, current: 1, planned: 2 };
  const next = [...history, ...fresh.sort((a, b) => rank[a.state] - rank[b.state])];
  // One current milestone at most: the first the model named.
  let current = false;
  for (const milestone of next)
    if (milestone.state === "current") {
      if (current) milestone.state = "planned";
      current = true;
    }
  conversation.milestones = next.slice(-V2_LIMITS.milestones);
  for (const milestone of conversation.milestones) if (!milestone.id) milestone.id = freshId(conversation, ctx);
  // Tasks of milestones the model left out move on with the work: open ones to the current
  // milestone, done ones to the last reached milestone (else the first).
  const dropped = old.filter((milestone) => !conversation.milestones.includes(milestone));
  const list = conversation.milestones;
  const home = currentMilestone(conversation) ?? list.find(({ state }) => state === "planned") ?? list[list.length - 1]!;
  const reached = [...list].reverse().find(({ state }) => state === "done") ?? list[0]!;
  for (const milestone of dropped)
    for (const task of milestone.tasks) {
      const target = task.done ? reached : home;
      if (!target.tasks.some((other) => other.done === task.done && other.text === task.text)) target.tasks.push(task);
    }
  for (const milestone of list) milestone.tasks.splice(0, Math.max(0, milestone.tasks.length - V2_LIMITS.tasks));
}

/** Marks the title or tags as edited by hand, so model summaries leave them alone. */
export function pin(state: StateV2, threadId: string, fields: readonly PinnedField[]): void {
  const conversation = recordOf(state, threadId);
  if (!conversation || !fields.length) return;
  conversation.pinned = { ...conversation.pinned };
  for (const field of fields) conversation.pinned[field] = true;
}

/** Marks a milestone as the user's own: model summaries keep its title and never drop it. */
export function pinMilestone(state: StateV2, threadId: string, milestoneId: string): void {
  const milestone = recordOf(state, threadId)?.milestones.find(({ id }) => id === milestoneId);
  if (milestone) milestone.pinned = true;
}

/** Remembers a milestone the user removed, so a model summary does not bring it back. */
export function rememberRemoved(state: StateV2, threadId: string, title: string): void {
  const conversation = recordOf(state, threadId);
  if (!conversation) return;
  const removed = (conversation.removedMilestones ?? []).filter((gone) => !sameTitle(gone, title));
  removed.push(title);
  conversation.removedMilestones = removed.slice(-REMOVED_MILESTONES_KEPT);
}

/** Lets model summaries update everything again: title, tags and milestones. */
export function unpin(state: StateV2, threadId: string): void {
  const conversation = requireConversation(state, threadId);
  delete conversation.pinned;
  delete conversation.removedMilestones;
  for (const milestone of conversation.milestones) delete milestone.pinned;
}
