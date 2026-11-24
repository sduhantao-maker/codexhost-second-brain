import { describe, expect, it } from "vitest";
import {
  addFavorite,
  cleanPassage,
  emptyFavorites,
  FAVORITE_LIMITS,
  lastReply,
  locatePassage,
  needlesOf,
  normalizeFavorites,
  noteFavorite,
  removeFavorite,
  searchFavorites,
  skeleton,
  type Favorite,
} from "../src/core/favorites.js";

const reply = [
  "**原因**：铃铛本来要放在行右侧按钮的左边。",
  "",
  "1. 找行内按钮时，超过 8 个字的文字不再当成按钮",
  "2. 悬停时的 ◆ 进度也更稳了",
  "",
  "详见 [codexhost 文档](https://example.com/docs) 里的说明。",
  "```ts",
  "const gutter = 40;",
  "```",
].join("\n");

const turns = [
  { turnNumber: 1, messages: [{ role: "user" as const, text: "铃铛压在标题上了" }, { role: "agent" as const, text: "我先看看位置规则。" }] },
  { turnNumber: 2, messages: [{ role: "user" as const, text: "改到图标左边" }, { role: "agent" as const, text: reply }] },
];

describe("matching a passage on screen with the reply's Markdown", () => {
  it("drops emphasis, list numbers, link targets and code fences", () => {
    expect(skeleton("**原因**：铃铛本来要放在行右侧按钮的左边。")).toBe(skeleton("原因：铃铛本来要放在行右侧按钮的左边。"));
    expect(skeleton("详见 [codexhost 文档](https://example.com/docs) 里的说明。")).toBe(skeleton("详见 codexhost 文档 里的说明。"));
    expect(skeleton("```ts\nconst gutter = 40;\n```")).toBe(skeleton("const gutter = 40;"));
  });

  it("finds the turn and speaker of text selected on screen", () => {
    // As the browser gives a selection: no list numbers, no Markdown.
    const selected = "找行内按钮时，超过 8 个字的文字不再当成按钮\n悬停时的 ◆ 进度也更稳了";
    expect(locatePassage(selected, turns)).toEqual({ turn: 2, role: "agent" });
    expect(locatePassage("codexhost 文档 里的说明", turns)).toEqual({ turn: 2, role: "agent" });
    expect(locatePassage("铃铛压在标题上了", turns)).toEqual({ turn: 1, role: "user" });
    expect(locatePassage("完全没有出现过的一句话", turns)).toBeUndefined();
    // Too short to tell where it is.
    expect(needlesOf("好的")).toEqual([]);
  });

  it("takes the previous reply while the current turn is still running, without annotation marks", () => {
    const running = [
      ...turns,
      { turnNumber: 3, status: "running", messages: [{ role: "user" as const, text: "收藏上一条回复" }] },
    ];
    expect(lastReply(running)).toEqual({ turn: 2, text: reply });
    const annotated = [{ turnNumber: 4, status: "completed", messages: [{ role: "agent" as const, text: ':codex-annotation{index="1" id="d71a"} 结论：用 A 方案。' }] }];
    expect(lastReply(annotated)).toEqual({ turn: 4, text: "结论：用 A 方案。" });
    expect(cleanPassage(':codex-annotation{index="1" id="x"} 你好')).toBe("你好");
    expect(lastReply([{ turnNumber: 1, status: "running", messages: [] }])).toBeUndefined();
  });
});

describe("favorites", () => {
  it("saves a passage once per conversation, however it is wrapped", () => {
    const file = emptyFavorites();
    const first = addFavorite(file, { threadId: "t1", text: "  结论：用 A 方案\n因为更快  ", source: "select" }, 100);
    expect(first).toMatchObject({ added: true, favorite: { threadId: "t1", text: "结论：用 A 方案\n因为更快", createdAt: 100, source: "select" } });
    expect(addFavorite(file, { threadId: "t1", text: "结论：用 A 方案 因为更快", source: "chat" }, 200)).toEqual({ favorite: first.favorite, added: false });
    expect(addFavorite(file, { threadId: "t2", text: "结论：用 A 方案 因为更快", source: "chat" }, 300).added).toBe(true);
    expect(() => addFavorite(file, { threadId: "t1", text: "   ", source: "select" }, 400)).toThrow();
    expect(file.items).toHaveLength(2);
  });

  it("keeps the newest when full, and edits notes", () => {
    const file = emptyFavorites();
    file.items = Array.from({ length: FAVORITE_LIMITS.items }, (_, index): Favorite => ({ id: `f${index}`, threadId: "t", text: `passage ${index}`, source: "select", createdAt: index }));
    const { favorite } = addFavorite(file, { threadId: "t", text: "the newest", source: "select" }, 10_000);
    expect(file.items).toHaveLength(FAVORITE_LIMITS.items);
    expect(file.items[0]!.id).toBe("f1");
    expect(noteFavorite(file, favorite.id, "  重要：发布前看  ")?.note).toBe("重要：发布前看");
    expect(noteFavorite(file, favorite.id, "  ")?.note).toBeUndefined();
    expect(noteFavorite(file, "missing", "x")).toBeUndefined();
    expect(removeFavorite(file, favorite.id)).toBe(true);
    expect(removeFavorite(file, favorite.id)).toBe(false);
  });

  it("finds saved passages by their words, note or conversation title, the newest first", () => {
    const file = emptyFavorites();
    addFavorite(file, { threadId: "t1", text: "用 vitest 跑测试", source: "select", threadTitle: "测试框架选型" }, 1);
    const later = addFavorite(file, { threadId: "t2", text: "发布步骤：先打 tag", source: "chat" }, 2).favorite;
    noteFavorite(file, later.id, "release checklist");
    expect(searchFavorites(file.items, "").map(({ threadId }) => threadId)).toEqual(["t2", "t1"]);
    expect(searchFavorites(file.items, "RELEASE").map(({ threadId }) => threadId)).toEqual(["t2"]);
    expect(searchFavorites(file.items, "选型").map(({ threadId }) => threadId)).toEqual(["t1"]);
    expect(searchFavorites(file.items, "框架", (threadId) => (threadId === "t2" ? "发布框架" : undefined)).map(({ threadId }) => threadId)).toEqual(["t2", "t1"]);
  });

  it("reads only well-formed items from disk", () => {
    const file = normalizeFavorites({
      version: 1,
      rev: 3,
      items: [
        { id: "a", threadId: "t", text: "ok", source: "chat", createdAt: 1, turn: 2, role: "agent" },
        { id: "b", threadId: "t", text: "", source: "chat", createdAt: 1 },
        { id: "c", threadId: "t", text: "no time" },
        { id: "d", threadId: "t", text: "odd fields", source: "weird", createdAt: 1, turn: -1, role: "robot" },
      ],
    });
    expect(file.rev).toBe(3);
    expect(file.items).toEqual([
      { id: "a", threadId: "t", text: "ok", source: "chat", createdAt: 1, turn: 2, role: "agent" },
      { id: "d", threadId: "t", text: "odd fields", source: "select", createdAt: 1 },
    ]);
    expect(normalizeFavorites({ version: 2, items: [] }).items).toEqual([]);
  });
});
