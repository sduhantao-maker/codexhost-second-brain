/**
 * Finds conversations by any clue: a PR or issue number or link, a tag, words from the mainline,
 * its milestones and tasks, the codexhost title, or what was asked. Drafts take part too.
 */
import { conversationView, draftTags, type DraftFacts, type ViewSources } from "./conversation-view.js";
import { flatten, type Favorite } from "./favorites.js";
import { extractLinks, origin, type Ref, type RefIndex } from "./refs.js";
import type { SearchField, SearchResult } from "./rpc.js";

const WEIGHT: Record<SearchField, number> = {
  ref: 100,
  tag: 60,
  title: 50,
  favorite: 45,
  threadTitle: 40,
  milestone: 35,
  task: 30,
  spinoff: 25,
  prompt: 20,
};

const LIMIT = 20;
/** Bounds on one result, so an answer stays small however much a conversation holds. */
const RESULT_REFS = 20;
const MATCH_CHARS = 300;

interface Field {
  field: SearchField;
  text: string;
}

export interface SearchInput {
  sources: ViewSources;
  index: RefIndex;
  query: string;
  limit?: number;
  /** Saved passages: a conversation comes up when one of its saved passages matches. */
  favorites?: readonly Favorite[];
}

const refLabel = (ref: Ref) => `${ref.kind === "pr" ? "PR" : "Issue"} #${ref.number}${ref.title ? ` ${ref.title}` : ""}`;
/** What a record holds under a key: its own entry only, never what every object has (`constructor`, …). */
const own = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined => (Object.hasOwn(record, key) ? record[key] : undefined);

/** Every searchable piece of text of one conversation, labelled with where it came from. */
function fieldsOf(threadId: string, input: SearchInput, refs: readonly Ref[], facts: DraftFacts | undefined): Field[] {
  const { sources } = input;
  const conversation = own(sources.state.conversations, threadId);
  const fields: Field[] = [];
  for (const ref of refs) fields.push({ field: "ref", text: `${ref.key} ${refLabel(ref)}` });
  const tags = conversation?.tags ?? (facts ? draftTags(facts) : []);
  for (const tag of tags) fields.push({ field: "tag", text: tag });
  if (conversation) {
    fields.push({ field: "title", text: conversation.title });
    for (const milestone of conversation.milestones) {
      fields.push({ field: "milestone", text: milestone.title });
      for (const task of milestone.tasks) fields.push({ field: "task", text: task.text });
    }
    for (const spinoff of conversation.spinoffs) fields.push({ field: "spinoff", text: spinoff.text });
  }
  const threadTitle = own(sources.info, threadId)?.title ?? own(input.index.threads, threadId)?.title ?? facts?.title;
  if (threadTitle) fields.push({ field: "threadTitle", text: threadTitle });
  for (const favorite of input.favorites ?? [])
    if (favorite.threadId === threadId) fields.push({ field: "favorite", text: [favorite.text, favorite.note ?? ""].join("\n") });
  if (facts?.firstPrompt) fields.push({ field: "prompt", text: facts.firstPrompt });
  const prompt = own(sources.state.prompts, threadId);
  if (prompt) fields.push({ field: "prompt", text: prompt.text });
  for (const ref of refs)
    for (const mention of ref.mentions) if (mention.threadId === threadId && mention.prompt) fields.push({ field: "prompt", text: mention.prompt });
  return fields;
}

const AROUND = 60;

/** About AROUND characters of a long text around the first word found in it. */
function around(text: string, words: readonly string[]): string {
  const flat = flatten(text);
  const chars = Array.from(flat);
  if (chars.length <= AROUND) return flat;
  const lower = flat.toLowerCase();
  const at = Math.max(0, Math.min(...words.map((word) => lower.indexOf(word)).filter((index) => index >= 0)));
  // indexOf counts UTF-16 units; close enough to place the window for display.
  const start = Math.max(0, Math.min(at - 15, chars.length - AROUND));
  return `${start > 0 ? "…" : ""}${chars.slice(start, start + AROUND).join("")}${start + AROUND < chars.length ? "…" : ""}`;
}

function refsMentioning(index: RefIndex): Map<string, Ref[]> {
  const byThread = new Map<string, Ref[]>();
  for (const ref of Object.values(index.refs))
    for (const mention of ref.mentions) {
      const list = byThread.get(mention.threadId) ?? [];
      if (!list.includes(ref)) list.push(ref);
      byThread.set(mention.threadId, list);
    }
  return byThread;
}

/** A PR or issue asked for by link, `#42`, `42` or `widgets#42`. */
function refQuery(query: string, index: RefIndex): Ref[] | undefined {
  const [link] = extractLinks(query);
  if (link) {
    const ref = own(index.refs, link.key);
    return ref ? [ref] : [];
  }
  const numbered = /^(?:([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?)#)?#?(\d{1,9})$/u.exec(query.replace(/\s+/gu, ""));
  if (!numbered) return undefined;
  const [, repo, digits] = numbered;
  const number = Number(digits);
  return Object.values(index.refs).filter((ref) => ref.number === number && (!repo || ref.repo.toLowerCase().endsWith(repo.toLowerCase())));
}

function activity(threadId: string, input: SearchInput): number {
  return (
    own(input.sources.state.conversations, threadId)?.updatedAt ??
    own(input.sources.state.prompts, threadId)?.at ??
    (Date.parse(own(input.index.threads, threadId)?.updatedAt ?? "") || 0)
  );
}

export function searchConversations(input: SearchInput): SearchResult[] {
  const query = input.query.trim();
  if (!query) return [];
  const { sources, index } = input;
  const byThread = refsMentioning(index);
  const scored = new Map<string, { score: number; match: Field }>();
  const consider = (threadId: string, score: number, match: Field) => {
    const previous = scored.get(threadId);
    if (!previous || score > previous.score) scored.set(threadId, { score, match });
  };

  const wantedRefs = refQuery(query, index);
  if (wantedRefs) {
    for (const ref of wantedRefs) {
      const first = origin(ref)?.threadId;
      for (const mention of ref.mentions)
        consider(mention.threadId, WEIGHT.ref + (mention.threadId === first ? 10 : 0), { field: "ref", text: refLabel(ref) });
    }
  }

  const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
  const candidates = new Set([
    ...Object.keys(sources.state.conversations),
    ...Object.keys(index.threads),
    ...Object.keys(sources.state.prompts),
    ...(input.favorites ?? []).map((favorite) => favorite.threadId),
  ]);
  for (const threadId of candidates) {
    const refs = byThread.get(threadId) ?? [];
    const fields = fieldsOf(threadId, input, refs, sources.draftOf?.(threadId));
    const haystack = fields.map(({ text }) => text.toLowerCase()).join("\n");
    if (!words.every((word) => haystack.includes(word))) continue;
    // The best field that contains the first word explains the match.
    let best: Field | undefined;
    let fieldsHit = 0;
    for (const field of fields) {
      const text = field.text.toLowerCase();
      if (!words.some((word) => text.includes(word))) continue;
      fieldsHit += 1;
      if (!best || WEIGHT[field.field] > WEIGHT[best.field]) best = field;
    }
    // A saved passage can be long: show the words around the match. Anything else is cut short.
    if (best?.field === "favorite") best = { field: "favorite", text: around(best.text, words) };
    else if (best && Array.from(best.text).length > MATCH_CHARS) best = { field: best.field, text: `${Array.from(best.text).slice(0, MATCH_CHARS - 1).join("")}…` };
    if (best) consider(threadId, WEIGHT[best.field] + Math.min(fieldsHit, 5), best);
  }

  return [...scored.entries()]
    .sort(([a, x], [b, y]) => y.score - x.score || activity(b, input) - activity(a, input))
    .slice(0, input.limit ?? LIMIT)
    .map(([threadId, { match }]) => {
      const view = conversationView(threadId, sources);
      return {
        threadId,
        title: view.title,
        tags: view.tags,
        status: view.status,
        draft: view.draft,
        progress: view.progress,
        match: { field: match.field, text: match.text },
        refs: (byThread.get(threadId) ?? []).slice(0, RESULT_REFS).map((ref) => ref.key),
        threadStatus: view.threadStatus,
        updatedAt: activity(threadId, input),
        ...(view.current ? { current: view.current.title } : {}),
      };
    });
}
