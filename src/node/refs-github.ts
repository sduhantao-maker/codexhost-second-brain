/**
 * Titles and states of indexed PRs and issues, from GitHub through the user's `gh`. Read-only.
 * The backend uses it every 30 minutes and whenever a PR is looked at; the command line uses it
 * when an agent looks one up in a chat.
 */
import type { GitHubEvent, Ref, RefState } from "../core/refs.js";
import type { RunGh } from "./gh.js";
import { readIndex, updateIndex, type RefsPaths } from "./refs-store.js";

export interface RefFacts {
  title?: string;
  state?: RefState;
}

/** A PR or issue as it stands, and what was done on it lately. */
export interface RefNews {
  facts: RefFacts;
  /** The `gh` user: what they did themselves is never news. */
  viewer?: string;
  events: GitHubEvent[];
}

// The latest comments and reviews are plenty: news is looked into within minutes.
const NEWS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    issueOrPullRequest(number: $number) {
      ... on PullRequest {
        title state mergedAt mergedBy { __typename login }
        comments(last: 50) { nodes { createdAt author { __typename login } } }
        reviews(last: 50) { nodes { submittedAt state author { __typename login } } }
      }
      ... on Issue {
        title state
        comments(last: 50) { nodes { createdAt author { __typename login } } }
      }
    }
  }
}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const nodes = (connection: unknown): Record<string, unknown>[] =>
  isRecord(connection) && Array.isArray(connection.nodes) ? connection.nodes.filter(isRecord) : [];
const timeOf = (value: unknown): number => (typeof value === "string" ? Date.parse(value) : Number.NaN);

/** Who did it: GitHub names apps `Bot`, and their REST logins end in `[bot]`. */
function actor(raw: unknown): Pick<GitHubEvent, "login" | "bot"> {
  if (!isRecord(raw) || typeof raw.login !== "string") return { bot: false };
  return { login: raw.login, bot: raw.__typename === "Bot" || /\[bot\]$/iu.test(raw.login) };
}

/**
 * Looks up a PR or issue with its latest comments (by when they were posted, so edits do not
 * show), reviews (by when they were submitted) and merge. Nothing when it cannot be read.
 */
export async function lookUpNews(runGh: RunGh, ref: Pick<Ref, "repo" | "number">): Promise<RefNews | undefined> {
  const [owner = "", name = ""] = ref.repo.split("/");
  let raw: unknown;
  try {
    raw = JSON.parse(
      await runGh(["api", "graphql", "-f", `query=${NEWS_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${ref.number}`]),
    );
  } catch {
    return undefined;
  }
  const data = isRecord(raw) && isRecord(raw.data) ? raw.data : undefined;
  const item = data && isRecord(data.repository) && isRecord(data.repository.issueOrPullRequest) ? data.repository.issueOrPullRequest : undefined;
  if (!data || !item) return undefined;
  const events: GitHubEvent[] = [];
  for (const comment of nodes(item.comments)) {
    const at = timeOf(comment.createdAt);
    if (Number.isFinite(at)) events.push({ kind: "comment", at, ...actor(comment.author) });
  }
  // A review still pending has no submittedAt, and no one else can see it yet.
  for (const review of nodes(item.reviews)) {
    const at = timeOf(review.submittedAt);
    if (Number.isFinite(at)) events.push({ kind: "review", at, ...(typeof review.state === "string" ? { state: review.state } : {}), ...actor(review.author) });
  }
  const mergedAt = timeOf(item.mergedAt);
  if (Number.isFinite(mergedAt)) events.push({ kind: "merged", at: mergedAt, ...actor(item.mergedBy) });
  const state: RefState | undefined =
    item.state === "MERGED" || Number.isFinite(mergedAt) ? "merged" : item.state === "CLOSED" ? "closed" : item.state === "OPEN" ? "open" : undefined;
  const viewer = isRecord(data.viewer) && typeof data.viewer.login === "string" ? data.viewer.login : undefined;
  return {
    facts: { ...(typeof item.title === "string" ? { title: item.title } : {}), ...(state ? { state } : {}) },
    ...(viewer ? { viewer } : {}),
    events,
  };
}

/** Looks a PR or issue up; nothing when it cannot be read (private, moved or deleted). */
export async function lookUpRef(runGh: RunGh, ref: Pick<Ref, "repo" | "number">): Promise<RefFacts> {
  try {
    const raw = JSON.parse(
      await runGh(["api", `repos/${ref.repo}/issues/${ref.number}`, "--jq", "{title: .title, state: .state, merged: (.pull_request.merged_at != null)}"]),
    ) as { title?: unknown; state?: unknown; merged?: unknown };
    return {
      ...(typeof raw.title === "string" ? { title: raw.title } : {}),
      state: raw.merged === true ? "merged" : raw.state === "closed" ? "closed" : "open",
    };
  } catch {
    return {};
  }
}

/** What is known of a PR is fresh for this long when someone looks at it. */
export const FRESH_MS = 60_000;
/** PRs looked up at once for one look. */
export const FRESHEN_LIMIT = 6;
/**
 * A lookup that found nothing new is written to the index only once the index's time of the last
 * lookup is this old. The caller that passes `checked` keeps the newer time itself; the rounds that
 * go by the index's time (every 30 minutes and more) lose at most this much by it.
 */
export const CHECK_WRITTEN_AFTER_MS = 10 * 60_000;

/**
 * Looks up the given PRs and issues last looked up longer than `maxAgeMs` ago, and saves what it
 * finds. `checked` remembers, across calls in one process, when each was looked up: with it, an
 * answer that changes nothing does not rewrite the index every minute.
 */
export async function freshenRefs(
  paths: RefsPaths,
  keys: readonly string[],
  runGh: RunGh,
  options: { now: number; maxAgeMs?: number; limit?: number; checked?: Map<string, number> },
): Promise<number> {
  if (!keys.length) return 0;
  const index = await readIndex(paths);
  const maxAge = options.maxAgeMs ?? FRESH_MS;
  const { checked } = options;
  const lastCheck = (ref: Ref) => Math.max(ref.checkedAt ?? 0, checked?.get(ref.key) ?? 0);
  const stale = [...new Set(keys)]
    .map((key) => index.refs[key])
    .filter((ref): ref is Ref => ref !== undefined && (!lastCheck(ref) || options.now - lastCheck(ref) > maxAge))
    .slice(0, options.limit ?? FRESHEN_LIMIT);
  if (!stale.length) return 0;
  const found = await Promise.all(stale.map(async (ref) => [ref.key, await lookUpRef(runGh, ref)] as const));
  for (const [key] of found) checked?.set(key, options.now);
  await updateIndex(paths, (draft) => {
    for (const [key, facts] of found) {
      const ref = draft.refs[key];
      if (!ref) continue;
      const title = facts.title ? facts.title.slice(0, 200) : undefined;
      const same = (title === undefined || title === ref.title) && (facts.state === undefined || facts.state === ref.state);
      // Nothing new, and the index's time is recent enough: the file stays as it is.
      if (same && checked && ref.checkedAt !== undefined && options.now - ref.checkedAt < CHECK_WRITTEN_AFTER_MS) continue;
      ref.checkedAt = options.now;
      if (title) ref.title = title;
      if (facts.state) ref.state = facts.state;
    }
  });
  return stale.length;
}
