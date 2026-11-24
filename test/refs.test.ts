import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitHubWatcher, LOOKS_AT_ONCE, type RunGh } from "../src/backend/github.js";
import { HttpError, type ApiTurn, type ExternalApi, type ListedThread } from "../src/backend/external-api.js";
import { Scanner } from "../src/backend/scanner.js";
import {
  addMention,
  alerts,
  applyActivity,
  emptyIndex,
  extractLinks,
  linkFromApiUrl,
  markSeenForThread,
  newsAfter,
  normalizeIndex,
  noteNotified,
  origin,
  refsForThread,
  searchRefs,
  setNote,
  type GitHubEvent,
} from "../src/core/refs.js";
import { readIndex, refsPaths, updateIndex } from "../src/node/refs-store.js";

const silent = { info: () => undefined, error: () => undefined };

describe("refs model", () => {
  it("extracts each PR and issue link once", () => {
    const links = extractLinks(
      "PR: https://github.com/acme/widgets/pull/42 and again https://github.com/acme/widgets/pull/42/files, issue https://github.com/o/r/issues/7 and a commit https://github.com/o/r/commit/abc",
    );
    expect(links.map(({ key, kind }) => [key, kind])).toEqual([
      ["acme/widgets#42", "pr"],
      ["o/r#7", "issue"],
    ]);
    expect(linkFromApiUrl("https://api.github.com/repos/o/r/pulls/12", "PullRequest")?.url).toBe("https://github.com/o/r/pull/12");
    expect(linkFromApiUrl("https://example.com/x")).toBeUndefined();
  });

  it("keeps the earliest mention per window and picks the origin", () => {
    const index = emptyIndex();
    const [link] = extractLinks("https://github.com/o/r/pull/1");
    addMention(index, link!, { threadId: "later", turn: 3, at: 2000, role: "agent", prompt: "later work" });
    addMention(index, link!, { threadId: "first", turn: 5, at: 1000, role: "agent", prompt: "fix the sidechat draft" });
    addMention(index, link!, { threadId: "first", turn: 9, at: 3000, role: "user" });
    const ref = index.refs["o/r#1"]!;
    expect(ref.mentions.map(({ threadId, turn }) => [threadId, turn])).toEqual([
      ["first", 5],
      ["later", 3],
    ]);
    expect(origin(ref)?.prompt).toBe("fix the sidechat draft");
    expect(ref.lastMentionAt).toBe(3000);
    addMention(index, link!, { threadId: "first", turn: 5, at: 1000, role: "agent", prompt: "a better reading of that request" });
    expect(origin(ref)?.prompt).toBe("a better reading of that request");
    setNote(index, link!, "first", "keeps the cart when switching pages", 4000);
    expect(searchRefs(index, "switching")[0]?.key).toBe("o/r#1");
    expect(refsForThread(index, "later").map(({ key }) => key)).toEqual(["o/r#1"]);
  });

  it("finds refs by number, repo and number, link or words", () => {
    const index = emptyIndex();
    for (const [url, thread, prompt] of [
      ["https://github.com/a/widgets/pull/1081", "t1", "购物车切换页面时丢商品"],
      ["https://github.com/b/other/issues/1081", "t2", "unrelated"],
      ["https://github.com/a/widgets/pull/200", "t3", "order grouping"],
    ] as const) {
      const [link] = extractLinks(url);
      addMention(index, link!, { threadId: thread, turn: 1, at: 1, role: "agent", prompt });
    }
    expect(searchRefs(index, "1081").map(({ key }) => key).sort()).toEqual(["a/widgets#1081", "b/other#1081"]);
    expect(searchRefs(index, "#1081").length).toBe(2);
    expect(searchRefs(index, "widgets#1081").map(({ key }) => key)).toEqual(["a/widgets#1081"]);
    expect(searchRefs(index, "https://github.com/a/widgets/pull/200").map(({ key }) => key)).toEqual(["a/widgets#200"]);
    expect(searchRefs(index, "购物车").map(({ key }) => key)).toEqual(["a/widgets#1081"]);
    expect(searchRefs(index, "grouping", (id) => (id === "t3" ? "分组" : undefined)).map(({ key }) => key)).toEqual(["a/widgets#200"]);
  });

  it("flags news once and clears it when the source window is opened", () => {
    const index = emptyIndex();
    const [link] = extractLinks("https://github.com/o/r/pull/5");
    addMention(index, link!, { threadId: "src", turn: 2, at: 1, role: "agent" });
    expect(applyActivity(index, "o/r#5", { at: 100, reason: "comment", title: "Fix it" }, true)).toBe(true);
    expect(applyActivity(index, "o/r#5", { at: 100, reason: "comment" }, true)).toBe(false);
    expect(index.refs["o/r#5"]?.title).toBe("Fix it");
    expect(alerts(index).map(({ key }) => key)).toEqual(["o/r#5"]);
    expect(markSeenForThread(index, "elsewhere")).toEqual([]);
    expect(markSeenForThread(index, "src")).toEqual(["o/r#5"]);
    expect(alerts(index)).toEqual([]);
    expect(applyActivity(index, "o/missing#1", { at: 1, reason: "x" }, true)).toBe(false);
  });

  it("reads back what it writes and drops what is malformed", () => {
    const index = emptyIndex();
    const [link] = extractLinks("https://github.com/o/r/issues/3");
    addMention(index, link!, { threadId: "t", turn: 1, at: 5, role: "user", prompt: "p" });
    index.refs.bad = { nope: true } as never;
    const back = normalizeIndex(JSON.parse(JSON.stringify(index)));
    expect(Object.keys(back.refs)).toEqual(["o/r#3"]);
    expect(() => normalizeIndex({ version: 9 })).toThrow();
  });

  it("counts a person's review, merge or new comment as news, never a bot's or the user's own", () => {
    const minute = (n: number) => n * 60_000;
    const noise: GitHubEvent[] = [
      { kind: "comment", at: minute(1), login: "coderabbitai", bot: true },
      { kind: "review", at: minute(2), state: "COMMENTED", login: "coderabbitai", bot: true },
      { kind: "comment", at: minute(3), login: "Me", bot: false },
    ];
    expect(newsAfter(noise, 0, "me")).toBeUndefined();
    const reply: GitHubEvent = { kind: "comment", at: minute(4), login: "maintainer", bot: false };
    expect(newsAfter([...noise, reply], 0, "me")).toEqual({ at: minute(4), reason: "comment" });
    // Only what came after counts.
    expect(newsAfter([...noise, reply], minute(4), "me")).toBeUndefined();
    // The weightiest names the news, the latest dates it.
    const review: GitHubEvent = { kind: "review", at: minute(5), state: "CHANGES_REQUESTED", login: "maintainer", bot: false };
    expect(newsAfter([review, { ...reply, at: minute(6) }], 0)).toEqual({ at: minute(6), reason: "changes_requested" });
    expect(newsAfter([{ ...review, state: "APPROVED" }], 0)).toEqual({ at: minute(5), reason: "approved" });
    expect(newsAfter([{ ...review, state: "COMMENTED" }], 0)).toEqual({ at: minute(5), reason: "review" });
    // A merge counts whoever merged, a merge queue too, unless it was the user.
    expect(newsAfter([{ kind: "merged", at: minute(7), login: "github-merge-queue", bot: true }, review], 0, "me")).toEqual({ at: minute(7), reason: "merged" });
    expect(newsAfter([{ kind: "merged", at: minute(7), login: "me", bot: false }], 0, "me")).toBeUndefined();
    // Someone GitHub no longer knows was a person.
    expect(newsAfter([{ kind: "comment", at: minute(8), bot: false }], 0, "me")).toEqual({ at: minute(8), reason: "comment" });
  });

  it("knows how far notifications were looked into, in files written before too, and keeps a bell until it is seen", () => {
    const pr = (number: number, more: object) => ({ repo: "o/r", number, kind: "pr", url: `https://github.com/o/r/pull/${number}`, mentions: [], lastMentionAt: 1, ...more });
    const index = normalizeIndex({
      version: 1,
      refs: {
        // Written before 0.5.4: the activity was the notification itself.
        "o/r#1": pr(1, { activity: { at: 50, reason: "author", unseen: false } }),
        "o/r#2": pr(2, { notifiedAt: 70, activity: { at: 60, reason: "comment", unseen: true } }),
        "o/r#3": pr(3, {}),
      },
    });
    expect(index.refs["o/r#1"]?.notifiedAt).toBe(50);
    expect(index.refs["o/r#2"]?.notifiedAt).toBe(70);
    expect(normalizeIndex(JSON.parse(JSON.stringify(index))).refs["o/r#2"]?.notifiedAt).toBe(70);
    // A notification already looked into is skipped; news is what came after the last one.
    expect(noteNotified(index, "o/r#1", { at: 50 }, 0)).toBeUndefined();
    expect(noteNotified(index, "o/r#1", { at: 80 }, 0)).toBe(50);
    expect(index.refs["o/r#1"]?.notifiedAt).toBe(80);
    // Never notified before: from the given time.
    expect(noteNotified(index, "o/r#3", { at: 90, title: "Three" }, 40)).toBe(40);
    expect(index.refs["o/r#3"]).toMatchObject({ notifiedAt: 90, title: "Three" });
    // Later news that does not ring leaves an unseen bell on.
    expect(applyActivity(index, "o/r#2", { at: 100, reason: "author" }, false)).toBe(false);
    expect(index.refs["o/r#2"]?.activity).toEqual({ at: 100, reason: "author", unseen: true });
  });
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "mainline-refs-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fakeApi(pages: ListedThread[][], conversations: Record<string, ApiTurn[]>) {
  const calls: string[] = [];
  const api = {
    async listThreads(options: { cursor?: string; limit?: number } = {}) {
      calls.push(`list:${options.cursor ?? "start"}:${options.limit}`);
      const page = Number(options.cursor ?? 0);
      return { threads: pages[page] ?? [], nextCursor: page + 1 < pages.length ? String(page + 1) : null };
    },
    async readTurns(threadId: string, range?: { from: number; to: number }) {
      calls.push(`read:${threadId}:${range ? `${range.from}-${range.to}` : "latest"}`);
      const turns = conversations[threadId] ?? [];
      const total = turns.length;
      if (range) {
        if (range.to - range.from + 1 > 50) throw new Error("over 50 turns");
        return { totalTurns: total, turns: turns.filter((turn) => turn.turnNumber >= range.from && turn.turnNumber <= range.to) };
      }
      return { totalTurns: total, turns: turns.slice(-10).reverse() };
    },
  };
  return { api: api as unknown as ExternalApi, calls };
}

const turn = (turnNumber: number, user: string, agent = "", status = "completed"): ApiTurn => ({
  turnNumber,
  status,
  messages: [
    { role: "user", text: user },
    ...(agent ? [{ role: "agent" as const, text: agent }] : []),
  ],
});

describe("scanner", () => {
  it("walks every conversation in pages, reads long ones in chunks and indexes links with the asked question", async () => {
    const long = Array.from({ length: 65 }, (_, i) => turn(i + 1, `step ${i + 1}`));
    long[2] = turn(3, "购物车切换页面时商品丢了，修一下", "已提交 https://github.com/a/widgets/pull/1081");
    const conversations = {
      long,
      short: [turn(1, "看看 https://github.com/a/widgets/pull/1081 的进展"), turn(2, "再开个 issue", "https://github.com/a/widgets/issues/1046")],
    };
    const { api, calls } = fakeApi(
      [[{ threadId: "long", updatedAt: "u1", createdAt: "2026-11-01T00:00:00Z", title: "购物车修复" }], [{ threadId: "short", updatedAt: "u2", createdAt: "2026-11-20T00:00:00Z", title: "跟进 PR" }]],
      conversations,
    );
    const paths = refsPaths(dir);
    const scanner = new Scanner(api, paths, silent, { recentEveryMs: () => 60_000, pauseMs: 0, now: () => 1_000_000 });
    for (let i = 0; i < 4; i += 1) await scanner.tick();
    scanner.stop();
    const index = await readIndex(paths);
    expect(index.crawl).toMatchObject({ done: true, listed: 2 });
    expect(index.threads.long).toMatchObject({ turns: 65, title: "购物车修复" });
    expect(calls).toContain("read:long:1-50");
    expect(calls).toContain("read:long:51-55");
    const pr = index.refs["a/widgets#1081"]!;
    expect(origin(pr)).toMatchObject({ threadId: "long", turn: 3, prompt: "购物车切换页面时商品丢了，修一下" });
    expect(pr.mentions.map(({ threadId }) => threadId)).toEqual(["long", "short"]);
    expect(index.refs["a/widgets#1046"]?.kind).toBe("issue");
  });

  it("reads only new turns of updated conversations and rereads an unfinished turn", async () => {
    const conversations: Record<string, ApiTurn[]> = { t: [turn(1, "hi"), turn(2, "working", "", "running")] };
    const pages = [[{ threadId: "t", updatedAt: "v1", title: "T" }]];
    const { api, calls } = fakeApi(pages, conversations);
    const paths = refsPaths(dir);
    let now = 1000;
    const scanner = new Scanner(api, paths, silent, { recentEveryMs: () => 0, pauseMs: 0, now: () => now });
    for (let i = 0; i < 4; i += 1) await scanner.tick();
    expect((await readIndex(paths)).threads.t?.turns).toBe(1);
    conversations.t = [turn(1, "hi"), turn(2, "working", "done: https://github.com/o/r/pull/9"), turn(3, "thanks")];
    pages[0] = [{ threadId: "t", updatedAt: "v2", title: "T" }];
    now = 5000;
    for (let i = 0; i < 3; i += 1) await scanner.tick();
    scanner.stop();
    const index = await readIndex(paths);
    expect(index.threads.t?.turns).toBe(3);
    expect(origin(index.refs["o/r#9"]!)).toMatchObject({ threadId: "t", turn: 2, prompt: "working" });
    expect(calls.filter((call) => call.startsWith("read:t")).length).toBe(2);
  });
});

describe("scanner full passes", () => {
  it("lists everything again on start and reads conversations an earlier pass missed", async () => {
    const pages = [[{ threadId: "a", updatedAt: "v1" }]];
    const conversations: Record<string, ApiTurn[]> = { a: [turn(1, "x")], b: [turn(1, "y https://github.com/o/r/pull/8")] };
    const { api } = fakeApi(pages, conversations);
    const paths = refsPaths(dir);
    const first = new Scanner(api, paths, silent, { recentEveryMs: () => 60_000, pauseMs: 0 });
    for (let i = 0; i < 3; i += 1) await first.tick();
    expect((await readIndex(paths)).crawl.done).toBe(true);
    // "b" existed but the first pass missed it; a new process lists everything again.
    pages[0] = [{ threadId: "a", updatedAt: "v1" }, { threadId: "b", updatedAt: "v1" }, { threadId: "a", updatedAt: "v1" }];
    const second = new Scanner(api, paths, silent, { recentEveryMs: () => 60_000, pauseMs: 0 });
    for (let i = 0; i < 3; i += 1) await second.tick();
    const index = await readIndex(paths);
    expect(index.refs["o/r#8"]).toBeDefined();
    expect(index.crawl).toMatchObject({ done: true, listed: 2 });
  });
});

describe("scanner retries", () => {
  it("retries a conversation whose read failed, and gives up after three attempts", async () => {
    const { api } = fakeApi(
      [[{ threadId: "slow", updatedAt: "v1" }, { threadId: "broken", updatedAt: "v1" }, { threadId: "gone", updatedAt: "v1" }]],
      { slow: [turn(1, "x https://github.com/o/r/pull/3")] },
    );
    let slowFailures = 1;
    const read = api.readTurns.bind(api);
    (api as unknown as { readTurns: typeof read }).readTurns = async (threadId, range) => {
      if (threadId === "broken") throw new Error("always fails");
      if (threadId === "gone") throw new HttpError(400, "External Native Session is unavailable");
      if (threadId === "slow" && slowFailures-- > 0) throw new Error("timeout");
      return read(threadId, range);
    };
    const paths = refsPaths(dir);
    const errors: string[] = [];
    const scanner = new Scanner(api, paths, { info: () => undefined, error: (message) => errors.push(message) }, { recentEveryMs: () => 60_000, pauseMs: 0 });
    for (let i = 0; i < 12; i += 1) await scanner.tick();
    const index = await readIndex(paths);
    expect(index.refs["o/r#3"]).toBeDefined();
    expect(index.threads.broken).toBeUndefined();
    expect(index.threads.gone).toMatchObject({ unreadable: true, updatedAt: "v1" });
    expect(errors.some((message) => message.includes("broken"))).toBe(true);
    expect(index.crawl.done).toBe(true);
  });
});

describe("GitHub watcher", () => {
  const DAY = 24 * 60 * 60_000;

  async function seed() {
    const paths = refsPaths(dir);
    await updateIndex(paths, (index) => {
      for (const url of ["https://github.com/o/r/pull/1", "https://github.com/o/r/issues/2"]) {
        const [link] = extractLinks(url);
        addMention(index, link!, { threadId: "t", turn: 1, at: 1, role: "agent" });
      }
    });
    return paths;
  }

  /** A GitHub notification on o/r#number. */
  const notice = (number: number, updatedAt: string, more: object = {}) => ({
    unread: true,
    reason: "author",
    updated_at: updatedAt,
    subject: { type: "PullRequest", title: "Fix one", url: `https://api.github.com/repos/o/r/pulls/${number}` },
    ...more,
  });

  type Who = "person" | "bot" | "me";
  const author = (who: Who) => ({ __typename: who === "bot" ? "Bot" : "User", login: { person: "maintainer", bot: "coderabbitai", me: "Me" }[who] });
  interface Pr {
    state?: "OPEN" | "CLOSED" | "MERGED";
    title?: string;
    comments?: [Who, string][];
    reviews?: [Who, string, string][];
    merged?: [Who, string];
  }
  /** What GitHub's GraphQL answers about a PR, as the user "me". */
  const prNews = (pr: Pr) =>
    JSON.stringify({
      data: {
        viewer: { login: "me" },
        repository: {
          issueOrPullRequest: {
            title: pr.title ?? "Fix one",
            state: pr.state ?? (pr.merged ? "MERGED" : "OPEN"),
            mergedAt: pr.merged?.[1] ?? null,
            mergedBy: pr.merged ? author(pr.merged[0]) : null,
            comments: { nodes: (pr.comments ?? []).map(([who, createdAt]) => ({ createdAt, author: author(who) })) },
            reviews: { nodes: (pr.reviews ?? []).map(([who, state, submittedAt]) => ({ submittedAt, state, author: author(who) })) },
          },
        },
      },
    });

  it("treats the first poll as a baseline except for unread news, then rings for what came after", async () => {
    const paths = await seed();
    let notifications: unknown[] = [
      notice(1, "2026-11-23T01:00:00Z", { reason: "comment", last_read_at: "2026-11-23T00:30:00Z" }),
      { unread: false, reason: "author", updated_at: "2026-11-23T01:00:00Z", subject: { type: "Issue", title: "Two", url: "https://api.github.com/repos/o/r/issues/2" } },
      { unread: true, reason: "comment", updated_at: "2026-11-23T01:00:00Z", subject: { type: "PullRequest", title: "Not ours", url: "https://api.github.com/repos/x/y/pulls/9" } },
    ];
    let answer = prNews({ comments: [["person", "2026-11-23T00:20:00Z"], ["person", "2026-11-23T00:50:00Z"]] });
    const asked: string[][] = [];
    const runGh: RunGh = async (args) => {
      asked.push(args);
      if (args[1] === "-X") return JSON.stringify(notifications);
      if (args[1] === "graphql") return answer;
      throw new Error(`unexpected gh ${args.join(" ")}`);
    };
    let now = Date.parse("2026-11-23T02:00:00Z");
    const watcher = new GitHubWatcher(paths, silent, runGh, () => now);
    expect(await watcher.poll()).toBe(1);
    let index = await readIndex(paths);
    // The comment after it was last read on GitHub is the news; the one before is not.
    expect(alerts(index).map(({ key }) => key)).toEqual(["o/r#1"]);
    expect(index.refs["o/r#1"]).toMatchObject({ state: "open", checkedAt: now, activity: { at: Date.parse("2026-11-23T00:50:00Z"), reason: "comment" } });
    // Read on GitHub already: the baseline, not looked into.
    expect(index.refs["o/r#2"]).toMatchObject({ notifiedAt: Date.parse("2026-11-23T01:00:00Z") });
    expect(index.refs["o/r#2"]?.activity).toBeUndefined();
    expect(index.refs["x/y#9"]).toBeUndefined();
    expect(asked[0]).toEqual(expect.arrayContaining(["notifications", "all=true"]));
    expect(asked.filter((args) => args[1] === "graphql").map((args) => args.at(-1))).toEqual(["number=1"]);

    now = Date.parse("2026-11-23T03:30:00Z");
    notifications = [{ unread: false, reason: "comment", updated_at: "2026-11-23T03:00:00Z", subject: { type: "Issue", url: "https://api.github.com/repos/o/r/issues/2" } }];
    answer = prNews({ title: "Two", comments: [["person", "2026-11-23T02:59:00Z"]] });
    expect(await watcher.poll()).toBe(1);
    index = await readIndex(paths);
    expect(alerts(index).map(({ key }) => key).sort()).toEqual(["o/r#1", "o/r#2"]);
  });

  it("rings for a person's comment, review or merge, never for bots, edited comments or the user's own actions", async () => {
    const paths = await seed();
    let now = Date.parse("2026-11-23T14:10:00Z");
    await updateIndex(paths, (index) => {
      index.github.baselineAt = now - DAY;
      index.github.lastPollAt = now - 3 * 60_000;
    });
    let notifications: unknown[] = [];
    let pr: Pr = {};
    let looked = 0;
    const runGh: RunGh = async (args) => {
      if (args[1] === "-X") return JSON.stringify(notifications);
      if (args[1] === "graphql") {
        looked += 1;
        return prNews(pr);
      }
      throw new Error(`unexpected gh ${args.join(" ")}`);
    };
    const watcher = new GitHubWatcher(paths, silent, runGh, () => now);
    const pollAt = async (time: string, updatedAt: string) => {
      now = Date.parse(time);
      notifications = [notice(1, updatedAt)];
      return watcher.poll();
    };
    const activity = async () => (await readIndex(paths)).refs["o/r#1"]?.activity;

    // CodeRabbit posts a placeholder, then edits it into its summary: GitHub notifies twice.
    pr = { comments: [["bot", "2026-11-23T14:13:57Z"]] };
    expect(await pollAt("2026-11-23T14:15:00Z", "2026-11-23T14:13:59Z")).toBe(0);
    expect(await pollAt("2026-11-23T14:20:00Z", "2026-11-23T14:18:31Z")).toBe(0);
    // A bot's review and the user's own comment do not ring either.
    pr = { comments: [["bot", "2026-11-23T14:13:57Z"], ["me", "2026-11-23T14:25:00Z"]], reviews: [["bot", "COMMENTED", "2026-11-23T14:26:00Z"]] };
    expect(await pollAt("2026-11-23T14:30:00Z", "2026-11-23T14:26:02Z")).toBe(0);
    let index = await readIndex(paths);
    expect(alerts(index)).toEqual([]);
    expect(index.refs["o/r#1"]?.activity).toBeUndefined();
    expect(index.refs["o/r#1"]).toMatchObject({ state: "open", notifiedAt: Date.parse("2026-11-23T14:26:02Z") });

    // The maintainer's comment rings.
    pr = { ...pr, comments: [...pr.comments!, ["person", "2026-11-23T15:00:00Z"]] };
    expect(await pollAt("2026-11-23T15:02:00Z", "2026-11-23T15:00:02Z")).toBe(1);
    const reply = { at: Date.parse("2026-11-23T15:00:00Z"), reason: "comment", unseen: true };
    expect(await activity()).toEqual(reply);
    // The bot editing its summary afterwards leaves that bell as it was.
    expect(await pollAt("2026-11-23T15:06:00Z", "2026-11-23T15:05:00Z")).toBe(0);
    expect(await activity()).toEqual(reply);
    // Once seen, another edit brings no bell back.
    await updateIndex(paths, (draft) => void markSeenForThread(draft, "t"));
    expect(await pollAt("2026-11-23T15:12:00Z", "2026-11-23T15:10:00Z")).toBe(0);
    expect(alerts(await readIndex(paths))).toEqual([]);

    // A review rings, and so does the merge.
    pr = { ...pr, reviews: [...pr.reviews!, ["person", "APPROVED", "2026-11-23T15:20:00Z"]] };
    expect(await pollAt("2026-11-23T15:22:00Z", "2026-11-23T15:20:03Z")).toBe(1);
    expect(await activity()).toEqual({ at: Date.parse("2026-11-23T15:20:00Z"), reason: "approved", unseen: true });
    pr = { ...pr, comments: [...pr.comments!, ["person", "2026-11-23T15:30:05Z"]], merged: ["person", "2026-11-23T15:30:00Z"] };
    expect(await pollAt("2026-11-23T15:32:00Z", "2026-11-23T15:30:07Z")).toBe(1);
    index = await readIndex(paths);
    expect(index.refs["o/r#1"]).toMatchObject({ state: "merged", activity: { at: Date.parse("2026-11-23T15:30:05Z"), reason: "merged", unseen: true } });

    // Each notification is looked into once, even when the next poll lists it again.
    expect(looked).toBe(8);
    expect(await pollAt("2026-11-23T15:35:00Z", "2026-11-23T15:30:07Z")).toBe(0);
    expect(looked).toBe(8);
  });

  it("rings as before when what happened cannot be looked up", async () => {
    const paths = await seed();
    const now = Date.parse("2026-11-23T14:00:00Z");
    await updateIndex(paths, (index) => {
      index.github.baselineAt = now - DAY;
      index.github.lastPollAt = now - 3 * 60_000;
    });
    const asked: string[] = [];
    const runGh: RunGh = async (args) => {
      if (args[1] === "-X") return JSON.stringify([notice(1, "2026-11-23T13:59:42Z")]);
      asked.push(args[1]!);
      if (args[1] === "graphql") throw new Error("HTTP 502");
      return JSON.stringify({ title: "Fix one", state: "closed", merged: true });
    };
    expect(await new GitHubWatcher(paths, silent, runGh, () => now).poll()).toBe(1);
    const index = await readIndex(paths);
    expect(index.refs["o/r#1"]).toMatchObject({ state: "merged", activity: { at: Date.parse("2026-11-23T13:59:42Z"), reason: "author", unseen: true } });
    // The plain lookup still brings the state.
    expect(asked).toEqual(["graphql", "repos/o/r/issues/1"]);
  });

  it("brings a PR's state as soon as GitHub reports news on it, and leaves the others alone", async () => {
    const paths = await seed();
    const now = Date.parse("2026-11-23T14:00:00Z");
    // Both were looked up 16 minutes ago (inside the 30-minute round) and were open.
    await updateIndex(paths, (index) => {
      for (const key of ["o/r#1", "o/r#2"]) Object.assign(index.refs[key]!, { state: "open", title: "Old title", checkedAt: now - 16 * 60_000 });
      index.github.baselineAt = now - DAY;
      index.github.lastPollAt = now - 3 * 60_000;
    });
    const lookups: string[] = [];
    const runGh: RunGh = async (args) => {
      if (args[1] === "-X") return JSON.stringify([notice(1, "2026-11-23T13:59:42Z")]);
      lookups.push(`${args[1]} ${args.at(-1)}`);
      return prNews({ state: "CLOSED", comments: [["bot", "2026-11-23T13:59:40Z"]] });
    };
    const watcher = new GitHubWatcher(paths, silent, runGh, () => now);
    // Closed with only a bot's comment: no bell, but the state is current.
    expect(await watcher.poll()).toBe(0);
    const index = await readIndex(paths);
    expect(index.refs["o/r#1"]).toMatchObject({ state: "closed", title: "Fix one", checkedAt: now });
    // No news on #2: not looked up again before its round.
    expect(lookups).toEqual(["graphql number=1"]);
    expect(index.refs["o/r#2"]).toMatchObject({ state: "open", checkedAt: now - 16 * 60_000 });
  });

  it("looks a PR someone looks at up after a minute, and rewrites the index for an unchanged answer only every ten minutes", async () => {
    const paths = await seed();
    let now = Date.parse("2026-11-23T14:00:00Z");
    await updateIndex(paths, (index) => {
      Object.assign(index.refs["o/r#1"]!, { state: "open", title: "Fix one", checkedAt: now - 2 * 60_000 });
    });
    let state = "open";
    const asked: string[] = [];
    const runGh: RunGh = async (args) => {
      asked.push(args[1]!);
      return JSON.stringify({ title: "Fix one", state, merged: false });
    };
    const watcher = new GitHubWatcher(paths, silent, runGh, () => now);
    const rev = async () => (await readIndex(paths)).rev;
    const before = await rev();
    // Same answer, and the index's time is two minutes old: looked up, the file left alone.
    expect(await watcher.freshen(["o/r#1"])).toBe(1);
    expect(await rev()).toBe(before);
    // Within the minute it is not looked up again, though the file still has the older time.
    now += 30_000;
    expect(await watcher.freshen(["o/r#1"])).toBe(0);
    expect(asked).toHaveLength(1);
    // Nor by the 30-minute round (which does look up #2, never looked up before).
    await watcher.enrich();
    expect(asked).toEqual(["repos/o/r/issues/1", "repos/o/r/issues/2"]);
    // A minute on, again; ten minutes after the time in the file, an unchanged answer is written too.
    const afterRound = await rev();
    now += 60_000;
    expect(await watcher.freshen(["o/r#1"])).toBe(1);
    expect(await rev()).toBe(afterRound);
    now += 8 * 60_000;
    expect(await watcher.freshen(["o/r#1"])).toBe(1);
    expect((await readIndex(paths)).refs["o/r#1"]?.checkedAt).toBe(now);
    // A changed answer is written at once.
    state = "closed";
    now += 61_000;
    expect(await watcher.freshen(["o/r#1"])).toBe(1);
    expect((await readIndex(paths)).refs["o/r#1"]).toMatchObject({ state: "closed", checkedAt: now });
  });

  it("looks into every PR with news, a few at a time", async () => {
    const paths = refsPaths(dir);
    await updateIndex(paths, (index) => {
      for (let number = 1; number <= 10; number += 1) {
        const [link] = extractLinks(`https://github.com/o/r/pull/${number}`);
        addMention(index, link!, { threadId: "t", turn: 1, at: 1, role: "agent" });
      }
      index.github.baselineAt = 1;
      index.github.lastPollAt = Date.parse("2026-11-23T13:55:00Z");
    });
    let lookups = 0;
    let running = 0;
    let most = 0;
    const runGh: RunGh = async (args) => {
      if (args[1] === "-X") return JSON.stringify(Array.from({ length: 10 }, (_, i) => notice(i + 1, `2026-11-23T13:5${i}:00Z`)));
      lookups += 1;
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return prNews({ comments: [["bot", "2026-11-23T13:50:00Z"]] });
    };
    expect(await new GitHubWatcher(paths, silent, runGh, () => Date.parse("2026-11-23T14:00:00Z")).poll()).toBe(0);
    expect(lookups).toBe(10);
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(LOOKS_AT_ONCE);
    const index = await readIndex(paths);
    expect(Object.values(index.refs).every((ref) => ref.checkedAt !== undefined && ref.activity === undefined)).toBe(true);
  });

  it("records why GitHub could not be read", async () => {
    const paths = await seed();
    const watcher = new GitHubWatcher(paths, silent, async () => {
      throw new Error("gh: not logged in");
    });
    expect(await watcher.poll()).toBe(0);
    expect((await readIndex(paths)).github.error).toBe("gh: not logged in");
  });
});
