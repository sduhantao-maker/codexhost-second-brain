/**
 * Views of a conversation's mainline for the sidebar hover card, the in-conversation card and the
 * overview page. Every surface shows these; none of them assembles state by itself.
 */
import { cleanTags, currentMilestone, progressOf, type Conversation, type ConversationStatus, type MilestoneState, type Spinoff, type StateV2 } from "./conversation.js";
import type { Stamp, ThreadInfo, ThreadStatus } from "./model.js";
import type { RefView } from "./refs.js";

export interface TaskView {
  id: string;
  text: string;
  done: boolean;
  at: number;
  doneAt?: number;
  /** A child conversation carries this task. */
  threadId?: string;
  threadTitle?: string;
}

export interface MilestoneView {
  id: string;
  title: string;
  state: MilestoneState;
  doneAt?: number;
  tasks: TaskView[];
}

/** Another conversation shown beside this one: its parent, its children, a linked one. */
export interface RelatedView {
  threadId: string;
  title: string;
  threadStatus: ThreadStatus;
  draft: boolean;
  /** Title of its current milestone. */
  current?: string;
  progress?: { done: number; total: number };
}

export interface ConversationView {
  threadId: string;
  title: string;
  tags: string[];
  status: ConversationStatus;
  /** No mainline yet: the view is put together from the conversation's title, links and first request. */
  draft: boolean;
  milestones: MilestoneView[];
  current?: MilestoneView;
  progress: { done: number; total: number };
  now?: Stamp;
  lastPrompt?: Stamp;
  /** What started the conversation (drafts). */
  firstPrompt?: string;
  spinoffs: Spinoff[];
  parent?: RelatedView;
  related?: RelatedView;
  children: RelatedView[];
  refs: RefView[];
  threadStatus: ThreadStatus;
  updatedAt?: number;
  /** The last model summary: when and by which model. */
  summary?: { at: number; model: string };
  /** What the user fixed by hand, which model summaries leave alone. */
  pinned?: { title?: true; tags?: true; status?: true; milestones?: number };
}

/** Facts a draft is made from, gathered by the backend from codexhost and the link index. */
export interface DraftFacts {
  title?: string;
  firstPrompt?: string;
  /** Last folder of the conversation's workspace. */
  workspace?: string;
  refs: RefView[];
}

export interface ViewSources {
  state: StateV2;
  info: Readonly<Record<string, ThreadInfo>>;
  /** Known delegation links, child to parent. */
  parents: Readonly<Record<string, string>>;
  refsOf?(threadId: string): RefView[];
  draftOf?(threadId: string): DraftFacts | undefined;
}

const shortId = (threadId: string) => `#${threadId.slice(0, 8)}`;
/** What a record holds under a conversation id: its own entry only, never what every object has (`constructor`, …). */
const own = <T>(record: Readonly<Record<string, T>>, threadId: string): T | undefined => (Object.hasOwn(record, threadId) ? record[threadId] : undefined);

/** Tags a draft gets: the workspace, the repositories it touched and up to three PR or issue numbers. */
export function draftTags(facts: DraftFacts): string[] {
  const repos = facts.refs.map((ref) => ref.repo.split("/").pop() ?? ref.repo);
  const numbers = facts.refs.slice(0, 3).map((ref) => `${ref.kind === "pr" ? "PR" : "Issue"} #${ref.number}`);
  return cleanTags([facts.workspace, ...repos, ...numbers].filter(Boolean));
}

export function titleOf(threadId: string, sources: ViewSources): string {
  return (
    own(sources.state.conversations, threadId)?.title ??
    own(sources.info, threadId)?.title?.trim() ??
    sources.draftOf?.(threadId)?.title ??
    shortId(threadId)
  );
}

export function relatedView(threadId: string, sources: ViewSources): RelatedView {
  const conversation = own(sources.state.conversations, threadId);
  const current = conversation ? currentMilestone(conversation) : undefined;
  return {
    threadId,
    title: titleOf(threadId, sources),
    threadStatus: own(sources.info, threadId)?.status ?? "unknown",
    draft: !conversation,
    ...(current ? { current: current.title } : {}),
    ...(conversation && conversation.milestones.length ? { progress: progressOf(conversation) } : {}),
  };
}

export function parentOf(threadId: string, sources: ViewSources): string | undefined {
  return own(sources.parents, threadId) ?? own(sources.state.conversations, threadId)?.parentId;
}

/** Children from delegation links and from records that name this conversation as parent. */
export function childrenOf(threadId: string, sources: ViewSources): string[] {
  const ids = new Set<string>();
  for (const [child, parent] of Object.entries(sources.parents)) if (parent === threadId && child !== threadId) ids.add(child);
  for (const conversation of Object.values(sources.state.conversations))
    if (conversation.parentId === threadId && conversation.threadId !== threadId) ids.add(conversation.threadId);
  return [...ids];
}

function milestoneView(conversation: Conversation, sources: ViewSources): MilestoneView[] {
  return conversation.milestones.map((milestone) => ({
    id: milestone.id,
    title: milestone.title,
    state: milestone.state,
    ...(milestone.doneAt ? { doneAt: milestone.doneAt } : {}),
    tasks: milestone.tasks.map((task) => ({
      id: task.id,
      text: task.text,
      done: task.done,
      at: task.at,
      ...(task.doneAt ? { doneAt: task.doneAt } : {}),
      ...(task.threadId ? { threadId: task.threadId, threadTitle: titleOf(task.threadId, sources) } : {}),
    })),
  }));
}

export function conversationView(threadId: string, sources: ViewSources): ConversationView {
  const conversation = own(sources.state.conversations, threadId);
  const parentId = parentOf(threadId, sources);
  const children = childrenOf(threadId, sources)
    .map((child) => relatedView(child, sources))
    .sort((a, b) => Number(b.threadStatus === "running") - Number(a.threadStatus === "running"));
  const refs = sources.refsOf?.(threadId) ?? [];
  const lastPrompt = own(sources.state.prompts, threadId);
  const common = {
    threadId,
    threadStatus: own(sources.info, threadId)?.status ?? ("unknown" as ThreadStatus),
    children,
    refs,
    ...(parentId ? { parent: relatedView(parentId, sources) } : {}),
    ...(lastPrompt ? { lastPrompt } : {}),
  };
  if (!conversation) {
    const facts = sources.draftOf?.(threadId) ?? { refs };
    return {
      ...common,
      title: titleOf(threadId, sources),
      tags: draftTags({ ...facts, refs: facts.refs.length ? facts.refs : refs }),
      status: "active",
      draft: true,
      milestones: [],
      progress: { done: 0, total: 0 },
      spinoffs: [],
      ...(facts.firstPrompt ? { firstPrompt: facts.firstPrompt } : {}),
    };
  }
  const milestones = milestoneView(conversation, sources);
  const current = milestones.find((milestone) => milestone.state === "current");
  return {
    ...common,
    title: conversation.title,
    tags: conversation.tags,
    status: conversation.status,
    draft: false,
    milestones,
    progress: progressOf(conversation),
    spinoffs: conversation.spinoffs.filter((spinoff) => spinoff.state !== "dismissed"),
    updatedAt: conversation.updatedAt,
    ...(current ? { current } : {}),
    ...(conversation.now ? { now: conversation.now } : {}),
    ...(conversation.relatedTo ? { related: relatedView(conversation.relatedTo, sources) } : {}),
    ...(conversation.summary ? { summary: { at: conversation.summary.at, model: conversation.summary.model } } : {}),
    ...pinnedView(conversation),
  };
}

function pinnedView(conversation: Conversation): Pick<ConversationView, "pinned"> {
  const milestones = conversation.milestones.filter((milestone) => milestone.pinned).length + (conversation.removedMilestones?.length ?? 0);
  const pinned: NonNullable<ConversationView["pinned"]> = {
    ...(conversation.pinned?.title ? { title: true as const } : {}),
    ...(conversation.pinned?.tags ? { tags: true as const } : {}),
    ...(conversation.pinned?.status ? { status: true as const } : {}),
    ...(milestones ? { milestones } : {}),
  };
  return Object.keys(pinned).length ? { pinned } : {};
}
