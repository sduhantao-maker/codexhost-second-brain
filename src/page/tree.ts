/**
 * The conversation tree of the overview page. It holds every conversation with a mainline, the
 * conversations each one delegated (with or without a mainline of their own), and the
 * conversations that delegated it, so a child always sits under its parent. Trees are grouped by
 * how far their work has got.
 */
import type { Conversation, ConversationStatus } from "../core/conversation.js";
import { parentOf, type ViewSources } from "../core/conversation-view.js";
import type { ThreadStatus } from "../core/model.js";

export interface TreeNode {
  threadId: string;
  /** Missing for a conversation without a mainline: it is shown as a draft. */
  conversation?: Conversation;
  children: TreeNode[];
}

export interface Forest {
  /** Trees with a conversation in progress, latest activity first. */
  active: TreeNode[];
  /** Trees whose conversations are paused (none in progress). */
  paused: TreeNode[];
  /** Trees whose conversations are all done. */
  done: TreeNode[];
  /** Recent conversations without a mainline that sit in no tree, latest first. */
  others: string[];
  /** Conversations with a mainline. */
  count: number;
  /** Conversations with a mainline, by status. */
  byStatus: Record<ConversationStatus, number>;
}

/** Deeper delegation chains than this are cut; it also stops runaway loops in bad data. */
const MAX_DEPTH = 24;

const live = (status: ThreadStatus | undefined) => status === "running" || status === "waiting";

/** When the conversation last moved: its mainline's last change, or else its latest request. */
export function activityOf(threadId: string, sources: ViewSources): number {
  return sources.state.conversations[threadId]?.updatedAt ?? sources.state.prompts[threadId]?.at ?? 0;
}

/** The latest activity anywhere in a tree. */
export function latest(node: TreeNode, sources: ViewSources): number {
  return node.children.reduce((max, child) => Math.max(max, latest(child, sources)), activityOf(node.threadId, sources));
}

function groupOf(node: TreeNode): ConversationStatus {
  let paused = false;
  const visit = (current: TreeNode): boolean => {
    const status = current.conversation?.status;
    if (status === "active") return true;
    if (status === "paused") paused = true;
    return current.children.some(visit);
  };
  if (visit(node)) return "active";
  return paused ? "paused" : "done";
}

export function buildForest(sources: ViewSources): Forest {
  const { state, info, parents } = sources;
  const records = Object.keys(state.conversations);
  const shown = new Set<string>(records);

  // Who delegated whom, by each conversation's one effective parent.
  const kids = new Map<string, string[]>();
  for (const threadId of new Set([...Object.keys(parents), ...records])) {
    const parent = parentOf(threadId, sources);
    if (!parent || parent === threadId) continue;
    const list = kids.get(parent);
    if (list) list.push(threadId);
    else kids.set(parent, [threadId]);
  }

  // The conversations that delegated one with a mainline give it its context.
  for (const threadId of records) {
    let parent = parentOf(threadId, sources);
    for (let depth = 0; parent && !shown.has(parent) && depth < MAX_DEPTH; depth += 1) {
      shown.add(parent);
      parent = parentOf(parent, sources);
    }
  }
  // Everything a conversation with a mainline delegated, however deep.
  const visited = new Set<string>();
  const queue = [...records];
  while (queue.length) {
    const threadId = queue.pop()!;
    if (visited.has(threadId)) continue;
    visited.add(threadId);
    shown.add(threadId);
    queue.push(...(kids.get(threadId) ?? []));
  }

  const byActivity = (a: string, b: string) => activityOf(b, sources) - activityOf(a, sources);
  const byLiveThenActivity = (a: string, b: string) => Number(live(info[b]?.status)) - Number(live(info[a]?.status)) || byActivity(a, b);
  const placed = new Set<string>();
  const build = (threadId: string, depth: number): TreeNode => {
    placed.add(threadId);
    const conversation = state.conversations[threadId];
    const children: TreeNode[] = [];
    if (depth < MAX_DEPTH)
      for (const child of [...(kids.get(threadId) ?? [])].sort(byLiveThenActivity))
        if (shown.has(child) && !placed.has(child)) children.push(build(child, depth + 1));
    return { threadId, ...(conversation ? { conversation } : {}), children };
  };

  const roots = [...shown].filter((threadId) => {
    const parent = parentOf(threadId, sources);
    return !parent || parent === threadId || !shown.has(parent);
  });
  const trees = roots.sort(byActivity).map((threadId) => build(threadId, 0));
  // Conversations caught in a delegation loop have no root; start from the latest one.
  for (const threadId of [...shown].sort(byActivity)) if (!placed.has(threadId)) trees.push(build(threadId, 0));
  trees.sort((a, b) => latest(b, sources) - latest(a, sources));

  const forest: Forest = { active: [], paused: [], done: [], others: [], count: records.length, byStatus: { active: 0, paused: 0, done: 0 } };
  for (const tree of trees) forest[groupOf(tree)].push(tree);
  for (const conversation of Object.values(state.conversations)) forest.byStatus[conversation.status] += 1;
  forest.others = [...new Set([...Object.keys(state.prompts), ...Object.keys(info)])].filter((threadId) => !shown.has(threadId)).sort(byActivity);
  return forest;
}

/** Conversations with a mainline in these trees. */
export function countRecords(trees: readonly TreeNode[]): number {
  return trees.reduce((sum, tree) => sum + (tree.conversation ? 1 : 0) + countRecords(tree.children), 0);
}
