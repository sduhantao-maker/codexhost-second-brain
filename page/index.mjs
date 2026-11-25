// src/core/attachments.ts
var ATTACH_CHUNK_BYTES = 512 * 1024;
var ATTACH_MAX_FILES = 10;
var ATTACH_MAX_FILE_BYTES = 500 * 1024 * 1024;
var ATTACH_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
function formatSize(bytes) {
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  const fixed = (value, digits) => value.toFixed(digits).replace(/\.0$/u, "");
  if (bytes < KB) return `${bytes} B`;
  if (bytes < MB) return `${Math.max(1, Math.round(bytes / KB))} KB`;
  if (bytes < GB) return `${fixed(bytes / MB, bytes < 10 * MB ? 1 : 0)} MB`;
  return `${fixed(bytes / GB, 1)} GB`;
}

// src/core/redact.ts
var MASK = "***";
var KEY = String.raw`[A-Za-z0-9_.-]{0,64}?(?:passw(?:or)?d|secret(?:[_-]?key)?|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)s?`;
var NOT_A_SECRET = /^(?:\d{1,6}|true|false|null|none|nil|undefined|string|number|boolean|bool|str|int|bytes|any|object|optional|required|[$%].*|process\.env\b.*|(?:os\.)?(?:environ|getenv)\b.*)$/iu;
var assigned = (match, keyQuote = "", key = "", separator = "", valueQuote = "", value = "") => NOT_A_SECRET.test(value) || value.includes(MASK) ? match : `${keyQuote}${key}${keyQuote}${separator}${valueQuote}${MASK}${valueQuote}`;
var RULES = [
  // PEM private keys, also when the text was cut off before their last line.
  [/-----BEGIN ([A-Z0-9 ]*?)PRIVATE KEY-----[\s\S]*?(?:-----END \1PRIVATE KEY-----|$)/gu, () => "[private key]"],
  // scheme://user:password@host
  [/\b([a-z][a-z0-9+.-]{0,31}:\/\/[^\s:/?#@]+:)[^\s/?#@]+@/giu, (_match, head = "") => `${head}${MASK}@`],
  // Anthropic, OpenAI and similar keys; a real one has a digit early on.
  [/\bsk-(?=[A-Za-z0-9_-]{0,128}\d)[A-Za-z0-9_-]{16,}/gu, () => `sk-${MASK}`],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/gu, () => `github_pat_${MASK}`],
  [/\b(gh[pousr]_)[A-Za-z0-9]{20,}/gu, (_match, prefix = "") => `${prefix}${MASK}`],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/gu, (_match, prefix = "") => `${prefix}${MASK}`],
  [/\b(xox[a-z])-[A-Za-z0-9-]{10,}/gu, (_match, prefix = "") => `${prefix}-${MASK}`],
  // JSON Web Tokens: base64 of `{"…` twice, then the signature.
  [/\beyJ[A-Za-z0-9_-]{5,512}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/gu, () => `eyJ${MASK}`],
  // A credential after Bearer has a digit; "Bearer authentication" in prose stays.
  [/\b(Bearer)\s+(?=[A-Za-z0-9._~+/-]*\d)[A-Za-z0-9._~+/-]{8,}=*/giu, (_match, word = "") => `${word} ${MASK}`],
  // password="two words", "token": "…"
  [new RegExp(String.raw`(["']?)\b(${KEY})\1(\s*[:=]\s*)(["'])([^"'\n]{3,}?)\4`, "giu"), assigned],
  // PASSWORD=hunter2, api_key: abc123 (the empty group keeps the value where the quoted rule has it)
  [new RegExp(String.raw`(["']?)\b(${KEY})\1(\s*[:=]\s*)()(?!["'])([^\s"'\x60,;&<>()[\]{}]{3,})`, "giu"), assigned],
  [/(密码|口令|密钥|令牌|验证码)(\s*[:：=]\s*)([^\s，。；,;]{3,})/gu, (match, key = "", separator = "", value = "") => value.includes(MASK) ? match : `${key}${separator}${MASK}`]
];

// src/core/model.ts
var STATE_VERSION = 1;
var LIMITS = {
  /** Characters kept from any single piece of text. */
  text: 300,
  /** Done items kept per mainline; the oldest go first. */
  done: 100,
  /** Parked items kept per mainline. */
  parked: 50,
  /**
   * The state file may not grow past this: room for a summarized mainline on thousands of
   * conversations. (How many mainlines are kept is MAX_CONVERSATIONS, core/conversation-ops.ts.)
   */
  stateBytes: 8 * 1024 * 1024
};
var DEFAULT_SETTINGS = {
  driftPolicy: "ask",
  showCapsule: false,
  prAlerts: true,
  autoSummarize: true,
  summarizeModel: "follow",
  summarizeOthers: "none"
};
var ERROR_CODES = [
  /** A request the code does not take; the message says why. */
  "INVALID_ARGUMENT",
  /** A text (a title, a task, a passage) that is empty. */
  "EMPTY_TEXT",
  /** No conversation: none is current (command line), or codexhost does not know it. */
  "NO_THREAD",
  /** The conversation has no mainline, or the user deleted it. */
  "NO_MAINLINE",
  /** Reaching a milestone when there is no current one. */
  "NO_CURRENT_MILESTONE",
  /** A milestone, task, spin-off or saved passage that is not there (any more). */
  "UNKNOWN_ITEM",
  "MILESTONE_EXISTS",
  /** A mainline has at most V2_LIMITS.milestones milestones. */
  "MILESTONE_LIMIT",
  /** Another writer holds the data; trying again in a moment works. */
  "LOCKED",
  /** The state is at its size or at MAX_CONVERSATIONS, and nothing can make room. */
  "STATE_FULL",
  "FAVORITES_FULL",
  /** Another data file of the extension is at its size cap; the message names it. */
  "FILE_FULL",
  /** An answer to a surface would be too large to send. */
  "TOO_LARGE",
  "ATTACHMENT_TOO_LARGE",
  "TOO_MANY_ATTACHMENTS",
  /** Too many uploads, or too many bytes, wait to be sent with a child conversation. */
  "UPLOADS_BUSY",
  "CHILD_FILES_TOO_LARGE",
  /** No model is set for conversations of this agent (`summarizeOthers` is "none"). */
  "NO_SUMMARIZER",
  /** An agent's configuration cannot be read or changed (the agent integration). */
  "UNAVAILABLE",
  /** A data file was written by a newer version of the extension: it is left as it is. */
  "NEWER_VERSION",
  /** codexhost has not answered in time: the child conversation may still open in the background. */
  "PENDING"
];
function isErrorCode(value) {
  return typeof value === "string" && ERROR_CODES.includes(value);
}
var LETTERS = "abcdefghijklmnopqrstuvwxyz";
var ALPHANUMERIC = `${LETTERS}0123456789`;
var THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$/u;
var OBJECT_KEYS = /* @__PURE__ */ new Set(["constructor", "prototype", "toString", "toLocaleString", "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable"]);
function isThreadId(value) {
  return typeof value === "string" && THREAD_ID.test(value) && !OBJECT_KEYS.has(value);
}
var isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var isTime = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
var isText = (value) => typeof value === "string" && value.trim().length > 0;
function readStamp(value) {
  if (!isRecord(value) || !isText(value.text) || !isTime(value.at)) return void 0;
  return { text: value.text, at: value.at };
}
function readItems(value, limit) {
  if (!Array.isArray(value)) return [];
  const items = [];
  for (const raw of value) {
    const stamp = readStamp(raw);
    if (!stamp || !isRecord(raw) || !isText(raw.id)) continue;
    items.push({ id: raw.id, ...stamp, ...isThreadId(raw.threadId) ? { threadId: raw.threadId } : {} });
  }
  return items.slice(-limit);
}
var MAINLINE_ID_PATTERN = /^[a-z][a-z0-9]{2,15}$/u;
function readMainline(id, value) {
  if (!MAINLINE_ID_PATTERN.test(id) || !isRecord(value) || !isText(value.goal)) return void 0;
  const createdAt = isTime(value.createdAt) ? value.createdAt : 0;
  return {
    id,
    goal: value.goal,
    status: value.status === "finished" ? "finished" : "active",
    createdAt,
    updatedAt: isTime(value.updatedAt) ? value.updatedAt : createdAt,
    ...isTime(value.finishedAt) ? { finishedAt: value.finishedAt } : {},
    done: readItems(value.done, LIMITS.done),
    parked: readItems(value.parked, LIMITS.parked)
  };
}
var JOIN_VIA = /* @__PURE__ */ new Set(["agent", "user", "delegation"]);
function readThread(value, mainlines) {
  if (!isRecord(value)) return void 0;
  const entry = { updatedAt: isTime(value.updatedAt) ? value.updatedAt : 0 };
  if (typeof value.mainlineId === "string" && Object.hasOwn(mainlines, value.mainlineId))
    entry.mainlineId = value.mainlineId;
  if (value.detached === true) entry.detached = true;
  if (typeof value.via === "string" && JOIN_VIA.has(value.via))
    entry.via = value.via;
  if (isText(value.title)) entry.title = value.title;
  if (isThreadId(value.parentId)) entry.parentId = value.parentId;
  for (const key of ["doing", "drift", "lastPrompt"]) {
    const stamp = readStamp(value[key]);
    if (stamp) entry[key] = stamp;
  }
  return entry;
}
function normalizeState(raw) {
  if (!isRecord(raw) || raw.version !== STATE_VERSION) throw new Error("Not a mainline state file");
  const state = { version: STATE_VERSION, rev: 0, mainlines: {}, threads: {} };
  state.rev = typeof raw.rev === "number" && Number.isSafeInteger(raw.rev) && raw.rev > 0 ? raw.rev : 0;
  if (raw.locale === "zh-CN" || raw.locale === "en") state.locale = raw.locale;
  if (isRecord(raw.mainlines))
    for (const [id, value] of Object.entries(raw.mainlines)) {
      const mainline = readMainline(id, value);
      if (mainline) state.mainlines[id] = mainline;
    }
  if (isRecord(raw.threads))
    for (const [id, value] of Object.entries(raw.threads)) {
      if (!isThreadId(id)) continue;
      const entry = readThread(value, state.mainlines);
      if (entry) state.threads[id] = entry;
    }
  return state;
}
function localeOf(value) {
  return typeof value === "string" && value.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

// src/core/conversation.ts
var STATE_V2 = 2;
var V2_LIMITS = {
  title: 120,
  tags: 8,
  tag: 24,
  milestones: 30,
  tasks: 60,
  spinoffs: 30
};
var PINNED_FIELDS = ["title", "tags", "status"];
var REMOVED_MILESTONES_KEPT = 20;
var EXCLUDED_KEPT = 2e3;
function latestMarks(marks, limit = EXCLUDED_KEPT) {
  const entries = Object.entries(marks);
  return entries.length <= limit ? { ...marks } : Object.fromEntries(entries.sort(([, a], [, b]) => b - a).slice(0, limit));
}
function emptyStateV2() {
  return { version: STATE_V2, rev: 0, conversations: {}, prompts: {} };
}
function cleanTags(input) {
  const raw = Array.isArray(input) ? input : typeof input === "string" ? input.split(/[,，、\n]/u) : [];
  const seen = /* @__PURE__ */ new Set();
  const tags = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const tag = Array.from(item.replace(/\s+/gu, " ").trim().replace(/^#+/u, "")).slice(0, V2_LIMITS.tag).join("").trim();
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    tags.push(tag);
    if (tags.length === V2_LIMITS.tags) break;
  }
  return tags;
}
function currentMilestone(conversation) {
  return conversation.milestones.find((milestone) => milestone.state === "current");
}
function progressOf(conversation) {
  return {
    done: conversation.milestones.filter((milestone) => milestone.state === "done").length,
    total: conversation.milestones.length
  };
}
var isRecord2 = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var isTime2 = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
var isText2 = (value) => typeof value === "string" && value.trim().length > 0;
function readStamp2(value) {
  return isRecord2(value) && isText2(value.text) && isTime2(value.at) ? { text: value.text, at: value.at } : void 0;
}
function readTask(value) {
  if (!isRecord2(value) || !isText2(value.id) || !isText2(value.text) || !isTime2(value.at)) return void 0;
  return {
    id: value.id,
    text: value.text,
    done: value.done === true,
    at: value.at,
    ...isTime2(value.doneAt) ? { doneAt: value.doneAt } : {},
    ...isThreadId(value.threadId) ? { threadId: value.threadId } : {}
  };
}
function readMilestone(value) {
  if (!isRecord2(value) || !isText2(value.id) || !isText2(value.title)) return void 0;
  const state = value.state === "done" || value.state === "current" ? value.state : "planned";
  return {
    id: value.id,
    title: value.title,
    state,
    ...isTime2(value.doneAt) ? { doneAt: value.doneAt } : {},
    tasks: Array.isArray(value.tasks) ? value.tasks.flatMap((task) => readTask(task) ?? []).slice(-V2_LIMITS.tasks) : [],
    ...value.pinned === true ? { pinned: true } : {}
  };
}
function readSpinoff(value) {
  if (!isRecord2(value) || !isText2(value.id) || !isText2(value.text) || !isTime2(value.at)) return void 0;
  const state = value.state === "spawned" || value.state === "dismissed" ? value.state : "open";
  return { id: value.id, text: value.text, at: value.at, state, ...isThreadId(value.childThreadId) ? { childThreadId: value.childThreadId } : {} };
}
function readConversation(threadId, value) {
  if (!isRecord2(value) || !isText2(value.title)) return void 0;
  const createdAt = isTime2(value.createdAt) ? value.createdAt : 0;
  const milestones = Array.isArray(value.milestones) ? value.milestones.flatMap((milestone) => readMilestone(milestone) ?? []).slice(0, V2_LIMITS.milestones) : [];
  let seenCurrent = false;
  for (const milestone of milestones)
    if (milestone.state === "current") {
      if (seenCurrent) milestone.state = "planned";
      seenCurrent = true;
    }
  const status = value.status === "paused" || value.status === "done" ? value.status : "active";
  const conversation = {
    threadId,
    title: value.title,
    tags: cleanTags(value.tags),
    status,
    milestones,
    spinoffs: Array.isArray(value.spinoffs) ? value.spinoffs.flatMap((item) => readSpinoff(item) ?? []).slice(-V2_LIMITS.spinoffs) : [],
    createdAt,
    updatedAt: isTime2(value.updatedAt) ? value.updatedAt : createdAt
  };
  const now = readStamp2(value.now);
  if (now) conversation.now = now;
  if (isThreadId(value.relatedTo) && value.relatedTo !== threadId) conversation.relatedTo = value.relatedTo;
  if (isThreadId(value.parentId) && value.parentId !== threadId) conversation.parentId = value.parentId;
  if (isRecord2(value.pinned)) {
    const pinned = {};
    for (const field of PINNED_FIELDS) if (value.pinned[field] === true) pinned[field] = true;
    if (Object.keys(pinned).length) conversation.pinned = pinned;
  }
  if (Array.isArray(value.removedMilestones)) {
    const removed = value.removedMilestones.filter(isText2).map((title) => Array.from(title).slice(0, V2_LIMITS.title).join("")).slice(-REMOVED_MILESTONES_KEPT);
    if (removed.length) conversation.removedMilestones = removed;
  }
  if (isRecord2(value.summary) && isTime2(value.summary.at) && isText2(value.summary.model)) {
    const summary = { at: value.summary.at, model: value.summary.model.slice(0, 60) };
    if (isText2(value.summary.threadUpdatedAt)) summary.threadUpdatedAt = value.summary.threadUpdatedAt.slice(0, 40);
    if (typeof value.summary.turns === "number" && Number.isSafeInteger(value.summary.turns) && value.summary.turns >= 0) summary.turns = value.summary.turns;
    if (typeof value.summary.finished === "boolean") summary.finished = value.summary.finished;
    conversation.summary = summary;
  }
  return conversation;
}
function migrateV1(v1) {
  const state = emptyStateV2();
  state.rev = v1.rev;
  if (v1.locale) state.locale = v1.locale;
  for (const [threadId, entry] of Object.entries(v1.threads))
    if (entry.lastPrompt) state.prompts[threadId] = entry.lastPrompt;
  for (const mainline of Object.values(v1.mainlines)) {
    const members = Object.entries(v1.threads).filter(([, entry2]) => entry2.mainlineId === mainline.id).sort(([, a], [, b]) => Number(b.via === "agent") - Number(a.via === "agent") || a.updatedAt - b.updatedAt);
    const [main] = members;
    if (!main) continue;
    const [threadId, entry] = main;
    if (state.conversations[threadId]) continue;
    state.conversations[threadId] = {
      threadId,
      title: mainline.goal,
      tags: [],
      status: mainline.status === "finished" ? "done" : "active",
      milestones: mainline.done.slice(-V2_LIMITS.milestones).map((item) => ({ id: item.id, title: item.text, state: "done", doneAt: item.at, tasks: [] })),
      spinoffs: mainline.parked.slice(-V2_LIMITS.spinoffs).map((item) => ({ id: item.id, text: item.text, at: item.at, state: "open" })),
      createdAt: mainline.createdAt,
      updatedAt: mainline.updatedAt,
      ...entry.doing ? { now: entry.doing } : {},
      ...entry.parentId ? { parentId: entry.parentId } : {}
    };
  }
  return state;
}
function normalizeStateV2(raw) {
  if (isRecord2(raw) && raw.version === 1) return migrateV1(normalizeState(raw));
  if (!isRecord2(raw) || raw.version !== STATE_V2) throw new Error("Not a mainline state file");
  const state = emptyStateV2();
  state.rev = typeof raw.rev === "number" && Number.isSafeInteger(raw.rev) && raw.rev > 0 ? raw.rev : 0;
  if (raw.locale === "zh-CN" || raw.locale === "en") state.locale = raw.locale;
  if (isRecord2(raw.conversations))
    for (const [threadId, value] of Object.entries(raw.conversations)) {
      if (!isThreadId(threadId)) continue;
      const conversation = readConversation(threadId, value);
      if (conversation) state.conversations[threadId] = conversation;
    }
  if (isRecord2(raw.prompts))
    for (const [threadId, value] of Object.entries(raw.prompts)) {
      const stamp = readStamp2(value);
      if (stamp && isThreadId(threadId)) state.prompts[threadId] = stamp;
    }
  if (isRecord2(raw.excluded)) {
    const marks = {};
    for (const [threadId, at] of Object.entries(raw.excluded)) if (isThreadId(threadId) && isTime2(at)) marks[threadId] = at;
    const kept = latestMarks(marks);
    if (Object.keys(kept).length) state.excluded = kept;
  }
  if (isRecord2(raw.jobs) && isRecord2(raw.jobs.backfill) && isTime2(raw.jobs.backfill.requestedAt))
    state.jobs = { backfill: { requestedAt: raw.jobs.backfill.requestedAt } };
  return state;
}

// src/core/conversation-view.ts
var shortId = (threadId) => `#${threadId.slice(0, 8)}`;
var own = (record, threadId) => Object.hasOwn(record, threadId) ? record[threadId] : void 0;
function draftTags(facts) {
  const repos = facts.refs.map((ref) => ref.repo.split("/").pop() ?? ref.repo);
  const numbers = facts.refs.slice(0, 3).map((ref) => `${ref.kind === "pr" ? "PR" : "Issue"} #${ref.number}`);
  return cleanTags([facts.workspace, ...repos, ...numbers].filter(Boolean));
}
function titleOf(threadId, sources) {
  return own(sources.state.conversations, threadId)?.title ?? own(sources.info, threadId)?.title?.trim() ?? sources.draftOf?.(threadId)?.title ?? shortId(threadId);
}
function relatedView(threadId, sources) {
  const conversation = own(sources.state.conversations, threadId);
  const current = conversation ? currentMilestone(conversation) : void 0;
  return {
    threadId,
    title: titleOf(threadId, sources),
    threadStatus: own(sources.info, threadId)?.status ?? "unknown",
    draft: !conversation,
    ...current ? { current: current.title } : {},
    ...conversation && conversation.milestones.length ? { progress: progressOf(conversation) } : {}
  };
}
function parentOf(threadId, sources) {
  return own(sources.parents, threadId) ?? own(sources.state.conversations, threadId)?.parentId;
}
function childrenOf(threadId, sources) {
  const ids = /* @__PURE__ */ new Set();
  for (const [child, parent] of Object.entries(sources.parents)) if (parent === threadId && child !== threadId) ids.add(child);
  for (const conversation of Object.values(sources.state.conversations))
    if (conversation.parentId === threadId && conversation.threadId !== threadId) ids.add(conversation.threadId);
  return [...ids];
}
function milestoneView(conversation, sources) {
  return conversation.milestones.map((milestone) => ({
    id: milestone.id,
    title: milestone.title,
    state: milestone.state,
    ...milestone.doneAt ? { doneAt: milestone.doneAt } : {},
    tasks: milestone.tasks.map((task) => ({
      id: task.id,
      text: task.text,
      done: task.done,
      at: task.at,
      ...task.doneAt ? { doneAt: task.doneAt } : {},
      ...task.threadId ? { threadId: task.threadId, threadTitle: titleOf(task.threadId, sources) } : {}
    }))
  }));
}
function conversationView(threadId, sources) {
  const conversation = own(sources.state.conversations, threadId);
  const parentId = parentOf(threadId, sources);
  const children = childrenOf(threadId, sources).map((child) => relatedView(child, sources)).sort((a, b) => Number(b.threadStatus === "running") - Number(a.threadStatus === "running"));
  const refs = sources.refsOf?.(threadId) ?? [];
  const lastPrompt = own(sources.state.prompts, threadId);
  const common = {
    threadId,
    threadStatus: own(sources.info, threadId)?.status ?? "unknown",
    children,
    refs,
    ...parentId ? { parent: relatedView(parentId, sources) } : {},
    ...lastPrompt ? { lastPrompt } : {}
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
      ...facts.firstPrompt ? { firstPrompt: facts.firstPrompt } : {}
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
    ...current ? { current } : {},
    ...conversation.now ? { now: conversation.now } : {},
    ...conversation.relatedTo ? { related: relatedView(conversation.relatedTo, sources) } : {},
    ...conversation.summary ? { summary: { at: conversation.summary.at, model: conversation.summary.model } } : {},
    ...pinnedView(conversation)
  };
}
function pinnedView(conversation) {
  const milestones = conversation.milestones.filter((milestone) => milestone.pinned).length + (conversation.removedMilestones?.length ?? 0);
  const pinned = {
    ...conversation.pinned?.title ? { title: true } : {},
    ...conversation.pinned?.tags ? { tags: true } : {},
    ...conversation.pinned?.status ? { status: true } : {},
    ...milestones ? { milestones } : {}
  };
  return Object.keys(pinned).length ? { pinned } : {};
}

// src/core/rpc.ts
function errorCodeOf(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /^\[([A-Z_]+)\]/u.exec(message)?.[1];
}
var FAVORITES_PAGE = 100;
var FAVORITES_PAGE_MAX = 300;

// src/ui/dom.ts
function builder(doc) {
  return (tag, props, ...children) => {
    const node = doc.createElement(tag);
    if (props?.class) node.className = props.class;
    if (props?.text !== void 0) node.textContent = props.text;
    if (props?.title) node.title = props.title;
    for (const [name, value] of Object.entries(props?.attrs ?? {}))
      if (value !== void 0) node.setAttribute(name, value);
    for (const [type, listener] of Object.entries(props?.on ?? {}))
      if (listener) node.addEventListener(type, listener);
    for (const child of children)
      if (child !== null && child !== void 0 && child !== false)
        node.append(typeof child === "string" ? doc.createTextNode(child) : child);
    return node;
  };
}
var SVG = "http://www.w3.org/2000/svg";
var ICONS = {
  chevron: ["M3 4.5 6 7.5 9 4.5"],
  pencil: ["M8.6 2.4l3 3L5 12H2v-3z", "M7.4 3.6l3 3"],
  check: ["M2.8 7.4 5.6 10.2 11.2 3.8"],
  close: ["M3.5 3.5l7 7", "M10.5 3.5l-7 7"],
  open: ["M5.5 3H3v8h8V8.5", "M8 2h4v4", "M12 2 6.5 7.5"],
  list: ["M5 3.5h7", "M5 7h7", "M5 10.5h7", "M2.2 3.5h.6", "M2.2 7h.6", "M2.2 10.5h.6"],
  diamond: ["M7 2.5 11.5 7 7 11.5 2.5 7z"],
  plus: ["M7 3v8", "M3 7h8"],
  bell: ["M7 1.9a3.3 3.3 0 0 0-3.3 3.3v2.4L2.4 9.7h9.2L10.3 7.6V5.2A3.3 3.3 0 0 0 7 1.9z", "M5.7 11.4a1.4 1.4 0 0 0 2.6 0"],
  search: ["M6.2 10.4a4.2 4.2 0 1 0 0-8.4 4.2 4.2 0 0 0 0 8.4z", "M9.3 9.3l3.1 3.1"]
};
function icon(doc, name, className) {
  const svg = doc.createElementNS(SVG, "svg");
  const size = name === "chevron" ? "12" : "14";
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  if (className) svg.setAttribute("class", className);
  for (const d of ICONS[name]) {
    const path = doc.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

// src/page/markdown.ts
var FENCE = /^\s*(```|~~~)/u;
var HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/u;
var BULLET = /^(\s*)[-*+]\s+(.*)$/u;
var NUMBERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/u;
var QUOTE = /^\s{0,3}>\s?(.*)$/u;
var TABLE_ROW = /^\s*\|.*\|\s*$/u;
var TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/u;
var RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/u;
function safeHref(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : void 0;
  } catch {
    return void 0;
  }
}
function inline(h, text) {
  const out = [];
  const pattern = /(`+)([^`]+?)\1|\*\*([^*]+?)\*\*|__([^_]+?)__|\*([^*\s][^*]*?)\*|\[([^\]]+)\]\(([^)\s]+)\)/gu;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const [, , code, bold, boldAlt, italic, label, url] = match;
    if (code !== void 0) out.push(h("code", { class: "mlp-md-code", text: code }));
    else if (bold !== void 0 || boldAlt !== void 0) out.push(h("strong", null, ...inline(h, bold ?? boldAlt ?? "")));
    else if (italic !== void 0) out.push(h("em", null, ...inline(h, italic)));
    else if (label !== void 0) {
      const href = safeHref(url ?? "");
      out.push(href ? h("a", { text: label, attrs: { href, target: "_blank", rel: "noopener noreferrer" } }) : label);
    }
    last = at + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
function splitCells(row) {
  const parts = [];
  let start = 0;
  for (let at = 0; at < row.length; at += 1)
    if (row[at] === "|" && row[at - 1] !== "\\") {
      parts.push(row.slice(start, at));
      start = at + 1;
    }
  parts.push(row.slice(start));
  return parts;
}
var cells = (row) => splitCells(
  row.trim().replace(/^\|/u, "").replace(/\|$/u, "")
).map((cell) => cell.trim().replace(/\\\|/gu, "|"));
var MAX_QUOTE_DEPTH = 8;
function renderMarkdown(h, source, depth = 0) {
  const lines = source.replace(/\r\n?/gu, "\n").split("\n");
  const blocks = [];
  let index = 0;
  const paragraph = [];
  const flush = () => {
    if (!paragraph.length) return;
    const children = [];
    paragraph.forEach((line, at) => {
      if (at) children.push(h("br"));
      children.push(...inline(h, line.trim()));
    });
    blocks.push(h("p", null, ...children));
    paragraph.length = 0;
  };
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      flush();
      index += 1;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const body = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").trim().startsWith(fence[1])) body.push(lines[index++] ?? "");
      index += 1;
      blocks.push(h("pre", { class: "mlp-md-pre" }, h("code", { text: body.join("\n") })));
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push(h("p", { class: "mlp-md-heading" }, h("strong", null, ...inline(h, heading[2] ?? ""))));
      index += 1;
      continue;
    }
    if (RULE.test(line)) {
      flush();
      blocks.push(h("hr", { class: "mlp-md-rule" }));
      index += 1;
      continue;
    }
    if (TABLE_ROW.test(line) && TABLE_RULE.test(lines[index + 1] ?? "")) {
      flush();
      const head = cells(line);
      index += 2;
      const rows = [];
      while (index < lines.length && TABLE_ROW.test(lines[index] ?? "")) rows.push(cells(lines[index++] ?? ""));
      blocks.push(
        h(
          "div",
          { class: "mlp-md-table" },
          h(
            "table",
            null,
            h("thead", null, h("tr", null, ...head.map((cell) => h("th", null, ...inline(h, cell))))),
            h("tbody", null, ...rows.map((row) => h("tr", null, ...head.map((_, at) => h("td", null, ...inline(h, row[at] ?? ""))))))
          )
        )
      );
      continue;
    }
    if (depth < MAX_QUOTE_DEPTH && QUOTE.test(line)) {
      flush();
      const quoted = [];
      while (index < lines.length && QUOTE.test(lines[index] ?? "")) quoted.push(QUOTE.exec(lines[index++] ?? "")?.[1] ?? "");
      blocks.push(h("blockquote", { class: "mlp-md-quote" }, ...renderMarkdown(h, quoted.join("\n"), depth + 1)));
      continue;
    }
    if (BULLET.test(line) || NUMBERED.test(line)) {
      flush();
      const ordered = !BULLET.test(line);
      const items = [];
      while (index < lines.length) {
        const current = lines[index] ?? "";
        const item = ordered ? NUMBERED.exec(current) : BULLET.exec(current);
        if (item) {
          const depth2 = Math.min(3, Math.floor((item[1] ?? "").replace(/\t/gu, "  ").length / 2));
          const text = ordered ? item[3] ?? "" : item[2] ?? "";
          items.push(h("li", { attrs: depth2 ? { "data-depth": String(depth2) } : {} }, ...inline(h, text)));
          index += 1;
          continue;
        }
        if (current.trim() && /^\s{2,}\S/u.test(current) && items.length) {
          items[items.length - 1].append(" ", ...inline(h, current.trim()).filter((child) => Boolean(child)));
          index += 1;
          continue;
        }
        break;
      }
      blocks.push(h(ordered ? "ol" : "ul", { class: "mlp-md-list" }, ...items));
      continue;
    }
    paragraph.push(line);
    index += 1;
  }
  flush();
  return blocks;
}

// src/core/conversation-ops.ts
var DAY = 24 * 60 * 60 * 1e3;
var MAX_CONVERSATIONS = 2e3;
var STALE_AFTER_MS = 7 * DAY;

// src/ui/i18n.ts
function errorDetail(message) {
  return message.replace(/^\[[A-Z_]+\]\s*/u, "");
}
var MAX_FILE = formatSize(ATTACH_MAX_FILE_BYTES);
var MAX_TOTAL = formatSize(ATTACH_MAX_TOTAL_BYTES);

// src/page/strings.ts
function relative(at, now, locale) {
  const minutes = Math.round((now - at) / 6e4);
  if (minutes < 1) return locale === "zh-CN" ? "\u521A\u521A" : "just now";
  if (minutes < 60) return locale === "zh-CN" ? `${minutes} \u5206\u949F\u524D` : `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return locale === "zh-CN" ? `${hours} \u5C0F\u65F6\u524D` : `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return locale === "zh-CN" ? `${days} \u5929\u524D` : `${days} d ago`;
  const date = new Date(at);
  return locale === "zh-CN" ? `${date.getMonth() + 1}\u6708${date.getDate()}\u65E5` : date.toLocaleDateString("en", { month: "short", day: "numeric" });
}
var detail = errorDetail;
var MAX_FILE2 = formatSize(ATTACH_MAX_FILE_BYTES);
var MAX_TOTAL2 = formatSize(ATTACH_MAX_TOTAL_BYTES);
var plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
var englishList = (parts) => parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
var ZH_MATCH = {
  ref: "PR/Issue",
  tag: "\u6807\u7B7E",
  title: "\u4E3B\u7EBF\u6807\u9898",
  milestone: "\u91CC\u7A0B\u7891",
  task: "\u652F\u7EBF\u4EFB\u52A1",
  spinoff: "\u5F15\u7533\u95EE\u9898",
  prompt: "\u5F53\u65F6\u7684\u95EE\u9898",
  threadTitle: "\u5BF9\u8BDD\u6807\u9898",
  favorite: "\u6536\u85CF"
};
var EN_MATCH = {
  ref: "PR or issue",
  tag: "tag",
  title: "mainline title",
  milestone: "milestone",
  task: "task",
  spinoff: "spin-off",
  prompt: "request",
  threadTitle: "conversation title",
  favorite: "saved passage"
};
var ZH_ERRORS = {
  INVALID_ARGUMENT: (detail2) => `\u5185\u5BB9\u4E0D\u7B26\u5408\u8981\u6C42\uFF1A${detail2}`,
  EMPTY_TEXT: () => "\u5185\u5BB9\u4E0D\u80FD\u4E3A\u7A7A",
  NO_THREAD: () => "\u627E\u4E0D\u5230\u8FD9\u4E2A\u5BF9\u8BDD",
  NO_MAINLINE: () => "\u8FD9\u4E2A\u5BF9\u8BDD\u8FD8\u6CA1\u6709\u4E3B\u7EBF\uFF0C\u6216\u8005\u4E3B\u7EBF\u5DF2\u7ECF\u5220\u9664",
  NO_CURRENT_MILESTONE: () => "\u6CA1\u6709\u5F53\u524D\u91CC\u7A0B\u7891\u53EF\u4EE5\u6807\u8BB0\u8FBE\u6210",
  UNKNOWN_ITEM: () => "\u8FD9\u4E00\u9879\u5DF2\u7ECF\u4E0D\u5B58\u5728\u4E86",
  MILESTONE_EXISTS: () => "\u8FD9\u4E2A\u91CC\u7A0B\u7891\u5DF2\u7ECF\u6709\u4E86",
  MILESTONE_LIMIT: () => `\u4E00\u6761\u4E3B\u7EBF\u6700\u591A ${V2_LIMITS.milestones} \u4E2A\u91CC\u7A0B\u7891\uFF0C\u8BF7\u5148\u5220\u6389\u4E0D\u7528\u7684\u91CC\u7A0B\u7891`,
  LOCKED: () => "\u4E3B\u7EBF\u6570\u636E\u6B63\u5728\u5199\u5165\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5",
  STATE_FULL: () => "\u4E3B\u7EBF\u6570\u636E\u5DF2\u6EE1\uFF0C\u8BF7\u5220\u9664\u4E0D\u7528\u7684\u4E3B\u7EBF",
  FAVORITES_FULL: () => "\u6536\u85CF\u5DF2\u6EE1\uFF0C\u8BF7\u5220\u9664\u4E0D\u7528\u7684\u6536\u85CF",
  FILE_FULL: (detail2) => `\u6570\u636E\u6587\u4EF6\u5DF2\u6EE1\uFF0C\u8FD9\u6B21\u6CA1\u6709\u4FDD\u5B58\uFF08${detail2}\uFF09`,
  TOO_LARGE: (detail2) => `\u8D85\u51FA\u4E0A\u9650\uFF1A${detail2}`,
  ATTACHMENT_TOO_LARGE: () => `\u5355\u4E2A\u9644\u4EF6\u4E0D\u80FD\u8D85\u8FC7 ${MAX_FILE2}`,
  TOO_MANY_ATTACHMENTS: () => `\u6700\u591A\u9644\u5E26 ${ATTACH_MAX_FILES} \u4E2A\u6587\u4EF6`,
  UPLOADS_BUSY: () => "\u7B49\u7740\u53D1\u9001\u7684\u9644\u4EF6\u592A\u591A\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5",
  CHILD_FILES_TOO_LARGE: () => `\u4E00\u4E2A\u5B50\u5BF9\u8BDD\u7684\u9644\u4EF6\u5408\u8BA1\u4E0D\u80FD\u8D85\u8FC7 ${MAX_TOTAL2}`,
  NO_SUMMARIZER: () => "\u8FD9\u4E2A\u5BF9\u8BDD\u6765\u81EA Claude Code \u548C Codex \u4EE5\u5916\u7684 Agent\u3002\u8BBE\u7F6E\u91CC\u300C\u5176\u4ED6 Agent\uFF08\u5982 pi\u3001DeepSeek\u3001Grok\uFF09\u7684\u5BF9\u8BDD\u300D\u9009\u7684\u662F\u300C\u4E0D\u51DD\u7EC3\uFF0C\u4E0D\u53D1\u7ED9\u4EFB\u4F55\u6A21\u578B\u300D\uFF0C\u6240\u4EE5\u4E0D\u4F1A\u53D1\u7ED9\u6A21\u578B\uFF1B\u8981\u51DD\u7EC3\uFF0C\u8BF7\u5148\u5728\u300C\u8BBE\u7F6E\u300D\u9875\u7B7E\u4E3A\u5B83\u4EEC\u9009\u4E00\u4E2A\u6A21\u578B\u3002",
  UNAVAILABLE: (detail2) => `\u6539\u4E0D\u4E86 Agent \u534F\u4F5C\uFF1A${detail2}`,
  NEWER_VERSION: () => "\u6570\u636E\u6587\u4EF6\u662F\u66F4\u65B0\u7248\u672C\u7684\u7B2C\u4E8C\u5927\u8111\u63D2\u4EF6\u5199\u7684\uFF0C\u8FD9\u91CC\u6CA1\u6709\u6539\u52A8\u5B83\uFF1B\u8BF7\u66F4\u65B0\u63D2\u4EF6",
  PENDING: () => "codexhost \u6CA1\u6709\u53CA\u65F6\u7B54\u590D\uFF0C\u5B50\u5BF9\u8BDD\u53EF\u80FD\u8FD8\u5728\u6253\u5F00\uFF1A\u5F00\u597D\u540E\u4F1A\u51FA\u73B0\u5728\u672C\u5BF9\u8BDD\u4E0B\u65B9\uFF0C\u5148\u4E0D\u8981\u518D\u70B9"
};
var EN_ERRORS = {
  INVALID_ARGUMENT: (detail2) => `Not accepted: ${detail2}`,
  EMPTY_TEXT: () => "The text cannot be empty",
  NO_THREAD: () => "That conversation cannot be found",
  NO_MAINLINE: () => "This conversation has no mainline, or it was deleted",
  NO_CURRENT_MILESTONE: () => "There is no current milestone to mark reached",
  UNKNOWN_ITEM: () => "That item no longer exists",
  MILESTONE_EXISTS: () => "That milestone exists already",
  MILESTONE_LIMIT: () => `A mainline has at most ${V2_LIMITS.milestones} milestones; delete one you no longer need first`,
  LOCKED: () => "The mainline data is being written; try again in a moment",
  STATE_FULL: () => "The mainline data is full; delete mainlines you no longer need",
  FAVORITES_FULL: () => "The saved passages are full; delete ones you no longer need",
  FILE_FULL: (detail2) => `A data file is full; nothing was saved (${detail2})`,
  TOO_LARGE: (detail2) => `Over the limit: ${detail2}`,
  ATTACHMENT_TOO_LARGE: () => `One attachment may be ${MAX_FILE2} at most`,
  TOO_MANY_ATTACHMENTS: () => `At most ${ATTACH_MAX_FILES} files`,
  UPLOADS_BUSY: () => "Too many files are waiting to be sent; try again in a moment",
  CHILD_FILES_TOO_LARGE: () => `The files of one child conversation may add up to ${MAX_TOTAL2} at most`,
  NO_SUMMARIZER: () => "This conversation is run by an agent other than Claude Code and Codex, and the setting \u201CConversations of other agents (pi, DeepSeek, Grok, \u2026)\u201D is \u201CDo not summarize; send them to no model\u201D, so it is not sent to a model. To summarize it, choose a model for them in the Settings tab first.",
  UNAVAILABLE: (detail2) => `The agent integration cannot be changed: ${detail2}`,
  NEWER_VERSION: () => "A data file was written by a newer version of Second Brain and was left as it is; update the extension",
  PENDING: () => "No answer from codexhost yet; the child may still open under this conversation"
};
var AGENT_FILES = {
  claude: { name: "Claude Code", folder: "~/.claude", file: "settings.json" },
  codex: { name: "Codex", folder: "~/.codex", file: "AGENTS.md" }
};
var zh = {
  pageTitle: "\u7B2C\u4E8C\u5927\u8111",
  loading: "\u6B63\u5728\u52A0\u8F7D\u2026",
  close: "\u5173\u95ED",
  confirm: "\u518D\u70B9\u4E00\u6B21\u786E\u8BA4",
  armed: (label) => `${label}\uFF1A3 \u79D2\u5185\u518D\u70B9\u4E00\u6B21\u786E\u8BA4`,
  jump: "\u8DF3\u8F6C",
  cancel: "\u53D6\u6D88",
  time: (at, now) => relative(at, now, "zh-CN"),
  error: (code, message) => isErrorCode(code) ? ZH_ERRORS[code](detail(message)) : `\u64CD\u4F5C\u6CA1\u6709\u6210\u529F\uFF1A${detail(message)}`,
  findLabel: "\u627E\u56DE\u5BF9\u8BDD",
  findPlaceholder: "\u8F93\u5165\u7F16\u53F7\u3001\u94FE\u63A5\u6216\u5173\u952E\u8BCD\u627E\u56DE\u5BF9\u8BDD\uFF0C\u4F8B\u5982 42",
  finding: "\u6B63\u5728\u67E5\u627E\u2026",
  findEmpty: "\u6CA1\u627E\u5230\u3002\u53EF\u4EE5\u6362\u6210 PR \u6216 issue \u7F16\u53F7\u3001\u94FE\u63A5\u91CC\u7684\u4E00\u6BB5\u3001\u6807\u7B7E\uFF0C\u6216\u5F53\u65F6\u95EE\u7684\u8BDD\u3002",
  findFailed: (message) => `\u67E5\u627E\u6CA1\u6709\u6210\u529F\uFF1A${detail(message)}`,
  match: (field, text) => `\u547D\u4E2D${ZH_MATCH[field] ?? "\u5185\u5BB9"}\uFF1A${text}`,
  locate: "\u5728\u5217\u8868\u4E2D\u5C55\u5F00",
  othersIntro: "\u8FD9\u4E9B\u5BF9\u8BDD\u8FD8\u6CA1\u88AB\u6A21\u578B\u51DD\u7EC3\u51FA\u4E3B\u7EBF\u3002\u5C55\u5F00\u540E\u53EF\u4EE5\u770B\u5230\u6309\u5BF9\u8BDD\u6807\u9898\u3001\u5DE5\u4F5C\u533A\u548C\u63D0\u5230\u7684 PR \u62FC\u51FA\u7684\u4E34\u65F6\u5185\u5BB9\uFF0C\u5E76\u5EFA\u7ACB\u4E3B\u7EBF\u3002",
  status: { active: "\u8FDB\u884C\u4E2D", paused: "\u6682\u505C", done: "\u5B8C\u6210" },
  threadStatus: { running: "\u8FD0\u884C\u4E2D", waiting: "\u7B49\u4F60\u5904\u7406", idle: "\u7A7A\u95F2", unknown: "\u72B6\u6001\u672A\u77E5" },
  draft: "\u672A\u51DD\u7EC3",
  progress: (done, total) => `\u25C6 ${done}/${total}`,
  progressLabel: (done, total) => `\u5DF2\u8FBE\u6210 ${done} \u4E2A\u91CC\u7A0B\u7891\uFF0C\u5171 ${total} \u4E2A`,
  current: (title) => `\u5F53\u524D\uFF1A${title}`,
  noMilestones: "\u8FD8\u6CA1\u6709\u91CC\u7A0B\u7891",
  doing: (text) => `\u6B63\u5728\u505A\uFF1A${text}`,
  lastPrompt: (text) => `\u6700\u8FD1\u8BF7\u6C42\uFF1A${text}`,
  firstPrompt: (text) => `\u8D77\u56E0\uFF1A${text}`,
  showAll: (n) => `\u663E\u793A\u5168\u90E8\uFF08${n}\uFF09`,
  showLess: "\u6536\u8D77",
  parent: (title) => `\u7236\u5BF9\u8BDD\uFF1A${title}`,
  related: (title) => `\u5173\u8054\u5230\uFF1A${title}`,
  updated: (time) => `\u66F4\u65B0\u4E8E ${time}`,
  milestones: "\u91CC\u7A0B\u7891",
  milestoneState: { done: "\u5DF2\u8FBE\u6210", current: "\u5F53\u524D", planned: "\u8BA1\u5212" },
  reach: "\u6807\u8BB0\u8FBE\u6210",
  focus: "\u8BBE\u4E3A\u5F53\u524D",
  rename: "\u91CD\u547D\u540D",
  removeMilestone: "\u5220\u9664\u91CC\u7A0B\u7891",
  addTaskTo: "\u5728\u8FD9\u4E2A\u91CC\u7A0B\u7891\u4E0B\u6DFB\u52A0\u652F\u7EBF\u4EFB\u52A1",
  addMilestone: "\u6DFB\u52A0\u91CC\u7A0B\u7891\u2026",
  addTask: "\u6DFB\u52A0\u652F\u7EBF\u4EFB\u52A1\u2026",
  taskDone: "\u5B8C\u6210",
  removeTask: "\u5220\u9664",
  carriedBy: (title) => `\u7531\u5B50\u5BF9\u8BDD\u300C${title}\u300D\u5904\u7406`,
  editDoing: "\u4FEE\u6539\u6B63\u5728\u505A",
  clearDoing: "\u6E05\u9664\u6B63\u5728\u505A",
  doingPlaceholder: "\u6B63\u5728\u505A\u7684\u4E8B\u2026",
  spinoffs: "\u5F15\u7533\u95EE\u9898",
  spinoffsOpen: (n) => `${n} \u4E2A\u5F85\u5904\u7406`,
  spawn: "\u5F00\u5B50\u5BF9\u8BDD",
  spawning: "\u6B63\u5728\u5F00\u5B50\u5BF9\u8BDD\u2026",
  keep: "\u672C\u5BF9\u8BDD\u5904\u7406",
  dismiss: "\u5FFD\u7565",
  spawned: (title) => `\u5DF2\u5F00\u5B50\u5BF9\u8BDD\u300C${title}\u300D`,
  spawnedNotice: (text) => `\u5DF2\u4E3A\u300C${text}\u300D\u5F00\u4E86\u5B50\u5BF9\u8BDD`,
  addSpinoff: "\u8BB0\u4E0B\u4E00\u4E2A\u5F15\u7533\u95EE\u9898\u2026",
  refs: "PR \u4E0E Issue",
  editTitle: "\u4FEE\u6539\u6807\u9898",
  titlePlaceholder: "\u8FD9\u4E2A\u5BF9\u8BDD\u5728\u505A\u4EC0\u4E48\uFF1A\u52A8\u4F5C + \u5BF9\u8C61",
  editTags: "\u4FEE\u6539\u6807\u7B7E",
  tagsPlaceholder: "\u6807\u7B7E\u7528\u9017\u53F7\u5206\u9694\uFF0C\u6700\u591A 8 \u4E2A",
  statusLabel: "\u72B6\u6001",
  deleteMainline: "\u5220\u9664\u4E3B\u7EBF",
  createMainline: "\u5EFA\u7ACB\u4E3B\u7EBF",
  draftIntro: "\u8FD9\u4E2A\u5BF9\u8BDD\u8FD8\u6CA1\u88AB\u6A21\u578B\u51DD\u7EC3\u51FA\u4E3B\u7EBF\u3002\u4E0B\u9762\u662F\u6309\u5BF9\u8BDD\u6807\u9898\u3001\u5DE5\u4F5C\u533A\u548C\u63D0\u5230\u7684 PR \u62FC\u51FA\u7684\u4E34\u65F6\u5185\u5BB9\u3002",
  tabConversations: (n) => `\u5BF9\u8BDD ${n}`,
  tabRefs: (n) => `PR \u4E0E Issue ${n}`,
  tabFavorites: (n) => `\u6536\u85CF ${n}`,
  tabSettings: "\u8BBE\u7F6E",
  statusTabs: { active: "\u8FDB\u884C\u4E2D", paused: "\u6682\u505C", done: "\u5DF2\u5B8C\u6210", others: "\u6CA1\u6709\u4E3B\u7EBF" },
  groupByLabel: "\u5206\u7EC4\u65B9\u5F0F",
  groupBy: { time: "\u6309\u65F6\u95F4", project: "\u6309\u9879\u76EE" },
  timeBuckets: { today: "\u4ECA\u5929", yesterday: "\u6628\u5929", week: "\u672C\u5468", earlier: "\u66F4\u65E9" },
  noWorkspace: "\u5176\u4ED6",
  childrenCount: (n) => `${n} \u4E2A\u5B50\u5BF9\u8BDD`,
  hideChildren: "\u6536\u8D77\u5B50\u5BF9\u8BDD",
  emptyTab: "\u8FD9\u91CC\u8FD8\u6CA1\u6709\u5BF9\u8BDD\u3002",
  summarized: (model, time) => `\u6A21\u578B\u51DD\u7EC3\u4E8E ${time}\uFF08${model}\uFF09`,
  resummarize: "\u91CD\u65B0\u51DD\u7EC3",
  summarizeQueued: "\u5DF2\u8BF7\u6A21\u578B\u51DD\u7EC3\uFF0C\u7A0D\u540E\u66F4\u65B0",
  pinnedNote: (parts) => `\u4F60\u624B\u52A8\u6539\u8FC7${parts.join("\u3001")}\uFF0C\u6A21\u578B\u4E0D\u4F1A\u8986\u76D6\u3002`,
  pinnedParts: { title: "\u6807\u9898", tags: "\u6807\u7B7E", status: "\u72B6\u6001", milestones: (count) => `${count} \u4E2A\u91CC\u7A0B\u7891` },
  unpin: "\u6062\u590D\u81EA\u52A8\u51DD\u7EC3",
  backfillStart: (count) => `\u6574\u7406\u65E7\u5BF9\u8BDD\uFF1A\u6700\u591A\u628A ${count} \u4E2A\u5BF9\u8BDD\u53D1\u7ED9\u6A21\u578B`,
  backfillProgress: (done, total, failed, skipped, full) => `\u6A21\u578B\u6B63\u5728\u6574\u7406\u65E7\u5BF9\u8BDD\uFF1A${done}/${total}${failed ? `\uFF0C${failed} \u4E2A\u6CA1\u6709\u6210\u529F` : ""}${skipped ? `\uFF0C${skipped} \u4E2A\u5176\u4ED6 Agent \u7684\u5BF9\u8BDD\u6309\u8BBE\u7F6E\u4E0D\u53D1\u9001` : ""}${full ? `\uFF0C${full} \u4E2A\u6CA1\u6709\u4E3B\u7EBF\u7684\u5BF9\u8BDD\u56E0\u4E3B\u7EBF\u5DF2\u6EE1 ${MAX_CONVERSATIONS} \u6761\u4E0D\u53D1\u9001` : ""}`,
  backfillStop: "\u505C\u6B62",
  backfillStopped: "\u5DF2\u505C\u6B62\u6574\u7406\u65E7\u5BF9\u8BDD\u3002\u6B63\u5728\u8FDB\u884C\u7684\u51DD\u7EC3\u4F1A\u505A\u5B8C\uFF0C\u5176\u4F59\u4E0D\u518D\u53D1\u7ED9\u6A21\u578B\u3002",
  summarizerBusy: (running, queued) => `\u6A21\u578B\u6B63\u5728\u51DD\u7EC3 ${running} \u4E2A\u5BF9\u8BDD${queued ? `\uFF0C\u8FD8\u6709 ${queued} \u4E2A\u6392\u961F` : ""}`,
  summarizerError: (message) => `\u6700\u8FD1\u4E00\u6B21\u51DD\u7EC3\u6CA1\u6709\u6210\u529F\uFF1A${message}`,
  summaryProblem: {
    CLAUDE_MISSING: "\u6CA1\u6709\u627E\u5230 Claude Code\uFF08claude \u547D\u4EE4\uFF09\uFF1A\u8BF7\u5B89\u88C5\uFF0C\u6216\u5728\u8BBE\u7F6E\u91CC\u6539\u7528 Codex \u51DD\u7EC3",
    CODEX_MISSING: "\u6CA1\u6709\u627E\u5230 Codex\uFF08codex \u547D\u4EE4\uFF09\uFF1A\u8BF7\u5B89\u88C5\uFF0C\u6216\u5728\u8BBE\u7F6E\u91CC\u6539\u7528 Claude Haiku \u51DD\u7EC3",
    MODEL_CALLS_OFF: "\u6A21\u578B\u8C03\u7528\u5DF2\u5173\u95ED\uFF08MAINLINE_NO_MODEL=1\uFF09\uFF0C\u6CA1\u6709\u53D1\u9001\u4EFB\u4F55\u5185\u5BB9"
  },
  summarizerToday: (count, limit, claude, codex) => `\u4ECA\u5929\u81EA\u52A8\u51DD\u7EC3 ${count}/${limit}\uFF08Claude ${claude}\uFF0CCodex ${codex}\uFF09`,
  summarizerAsked: (manual, backfill) => `\u624B\u52A8\u51DD\u7EC3 ${manual}\uFF0C\u6574\u7406\u65E7\u5BF9\u8BDD ${backfill}`,
  autoSummarize: "\u6BCF\u8F6E\u56DE\u590D\u7ED3\u675F\u540E\uFF0C\u7528\u6A21\u578B\u81EA\u52A8\u51DD\u7EC3\u4E3B\u7EBF\uFF08\u6807\u9898\u3001\u6807\u7B7E\u3001\u91CC\u7A0B\u7891\u548C\u72B6\u6001\uFF09",
  summarizeModel: "Claude Code \u548C Codex \u7684\u5BF9\u8BDD\u7528\u54EA\u4E2A\u6A21\u578B\u51DD\u7EC3",
  summarizeModels: { follow: "\u8DDF\u968F\u5BF9\u8BDD\uFF1AClaude Code \u5BF9\u8BDD\u7528 Claude Haiku\uFF0CCodex \u5BF9\u8BDD\u7528 Codex", claude: "\u90FD\u7528 Claude Haiku", codex: "\u90FD\u7528 Codex" },
  summarizeOthers: "\u5176\u4ED6 Agent\uFF08\u5982 pi\u3001DeepSeek\u3001Grok\uFF09\u7684\u5BF9\u8BDD",
  summarizeOthersOptions: {
    none: "\u4E0D\u51DD\u7EC3\uFF0C\u4E0D\u53D1\u7ED9\u4EFB\u4F55\u6A21\u578B",
    claude: "\u7528 Claude Haiku \u51DD\u7EC3\uFF1A\u5BF9\u8BDD\u5185\u5BB9\u53D1\u7ED9\u4F60\u7684 Claude Code \u6240\u7528\u7684\u670D\u52A1\u5546",
    codex: "\u7528 Codex \u51DD\u7EC3\uFF1A\u5BF9\u8BDD\u5185\u5BB9\u53D1\u7ED9\u4F60\u7684 Codex \u6240\u7528\u7684\u670D\u52A1\u5546"
  },
  summarizeOthersHint: "\u9009\u300C\u4E0D\u51DD\u7EC3\u300D\u65F6\uFF0C\u8FD9\u4E9B\u5BF9\u8BDD\u4FDD\u6301\u300C\u672A\u51DD\u7EC3\u300D\uFF0C\u81EA\u52A8\u51DD\u7EC3\u548C\u6574\u7406\u65E7\u5BF9\u8BDD\u90FD\u4F1A\u8DF3\u8FC7\u5B83\u4EEC\u3002",
  refsSection: "PR \u4E0E Issue",
  favoritesSection: "\u6536\u85CF",
  favoritesIntro: "\u5728\u5BF9\u8BDD\u91CC\u9009\u4E2D\u4E00\u6BB5\u6587\u5B57\uFF0C\u70B9\u51FA\u73B0\u7684\u300C\u2605 \u6536\u85CF\u300D\uFF1B\u88C5\u597D Agent \u534F\u4F5C\u540E\uFF0C\u4E5F\u53EF\u4EE5\u5728\u804A\u5929\u91CC\u8BF4\u300C\u6536\u85CF\u4E0A\u4E00\u6761\u56DE\u590D\u300D\u3002\u70B9\u300C\u8DF3\u56DE\u539F\u6587\u300D\u4F1A\u6253\u5F00\u90A3\u4E2A\u5BF9\u8BDD\uFF0C\u5E76\u9AD8\u4EAE\u8FD9\u6BB5\u6587\u5B57\u3002",
  favoritesEmpty: "\u8FD8\u6CA1\u6709\u6536\u85CF\u3002\u5728\u5BF9\u8BDD\u91CC\u9009\u4E2D\u4E00\u6BB5\u6587\u5B57\uFF0C\u70B9\u51FA\u73B0\u7684\u300C\u2605 \u6536\u85CF\u300D\uFF0C\u5C31\u4F1A\u5B58\u5230\u8FD9\u91CC\u3002",
  favoritesPlaceholder: "\u641C\u7D22\u6536\u85CF\uFF1A\u539F\u6587\u3001\u5907\u6CE8\u6216\u5BF9\u8BDD\u6807\u9898",
  favoritesNone: "\u6CA1\u6709\u7B26\u5408\u7684\u6536\u85CF\u3002",
  favoriteRole: { agent: "\u56DE\u590D", user: "\u6211\u7684\u8BDD" },
  favoriteNote: (text) => `\u5907\u6CE8\uFF1A${text}`,
  jumpToPassage: "\u8DF3\u56DE\u539F\u6587",
  openConversation: "\u6253\u5F00\u8FD9\u4E2A\u5BF9\u8BDD",
  openFailed: (reason) => `\u6CA1\u80FD\u6253\u5F00\u8FD9\u4E2A\u5BF9\u8BDD\uFF1A${reason || "codexhost \u6CA1\u6709\u56DE\u5E94"}\u3002\u5B83\u53EF\u80FD\u5728\u53E6\u4E00\u53F0\u673A\u5668\u4E0A\uFF0C\u6216\u5DF2\u88AB\u5220\u9664\u3002`,
  copy: "\u590D\u5236",
  copied: "\u5DF2\u590D\u5236",
  copyFailed: "\u6CA1\u80FD\u590D\u5236\uFF1A\u8FD9\u4E2A\u9875\u9762\u4E0D\u5141\u8BB8\u5199\u526A\u8D34\u677F\uFF0C\u8BF7\u624B\u52A8\u9009\u4E2D\u6587\u5B57\u590D\u5236\u3002",
  addNote: "\u5907\u6CE8",
  editNote: "\u6539\u5907\u6CE8",
  notePlaceholder: "\u5199\u4E00\u53E5\u5907\u6CE8\uFF0CEnter \u4FDD\u5B58\uFF0CEsc \u53D6\u6D88",
  removeFavorite: "\u5220\u9664",
  expandPassage: "\u5C55\u5F00\u5168\u6587",
  foldPassage: "\u6536\u8D77",
  refsIntro: "\u6240\u6709\u5728 codexhost \u5BF9\u8BDD\u91CC\u51FA\u73B0\u8FC7\u7684 GitHub PR \u548C issue\uFF1A\u6765\u81EA\u54EA\u4E2A\u5BF9\u8BDD\u3001\u5F53\u65F6\u4E3A\u4E86\u89E3\u51B3\u4EC0\u4E48\u95EE\u9898\u3002\u6709\u4EBA\u8BC4\u5BA1\u3001\u5408\u5E76\u6216\u8BC4\u8BBA\u65F6\uFF0C\u8FD9\u91CC\u6392\u5728\u6700\u524D\uFF0C\u4FA7\u680F\u91CC\u63D0\u51FA\u5B83\u7684\u5BF9\u8BDD\u884C\u4E0A\u6302 \u{1F514}\uFF08\u8FD9\u4E2A\u5BF9\u8BDD\u5728\u4FA7\u680F\u91CC\u770B\u4E0D\u5230\u65F6\uFF0C\u7B97\u8FDB\u4FA7\u680F\u9876\u90E8\u7684\u300C\u{1F514} N\u300D\uFF09\uFF0C\u60AC\u505C\u5361\u7247\u6700\u4E0A\u9762\u4E5F\u4F1A\u663E\u793A\uFF1B\u6253\u5F00\u4E86\u4E3B\u7EBF\u80F6\u56CA\u65F6\u80F6\u56CA\u4E0A\u4E5F\u4F1A\u63D0\u9192\u3002\u5728\u8FD9\u91CC\u70B9\u300C\u8DF3\u8F6C\u300D\u3001\u5728\u5361\u7247\u91CC\u70B9\u300C\u77E5\u9053\u4E86\u300D\u6216\u5728 \u{1F514} \u663E\u793A\u7740\u65F6\u70B9\u90A3\u4E00\u884C\uFF0C\u{1F514} \u624D\u6D88\u5931\u3002",
  refsEmpty: "\u8FD8\u6CA1\u6709\u627E\u5230 PR \u6216 issue\u3002\u626B\u63CF\u5B8C\u6210\u540E\uFF0C\u8FD9\u91CC\u4F1A\u5217\u51FA\u5BF9\u8BDD\u91CC\u51FA\u73B0\u8FC7\u7684\u94FE\u63A5\u3002",
  findRefs: "\u627E PR / Issue",
  refsPlaceholder: "\u8F93\u5165\u7F16\u53F7\u3001\u94FE\u63A5\u6216\u5173\u952E\u8BCD\uFF0C\u4F8B\u5982 42",
  noResults: "\u6CA1\u627E\u5230\u3002\u7D22\u5F15\u53EA\u6536\u5F55\u5728 codexhost \u5BF9\u8BDD\u91CC\u51FA\u73B0\u8FC7\u7684\u94FE\u63A5\u3002",
  scanStatus: (scanned, listed, done, refs, unreadable = 0) => (done ? `\u5DF2\u626B\u63CF ${scanned} \u4E2A\u5BF9\u8BDD\uFF0C\u627E\u5230 ${refs} \u4E2A PR/Issue` : `\u6B63\u5728\u626B\u63CF\u5BF9\u8BDD\uFF1A\u5DF2\u8BFB ${scanned} \u4E2A\uFF08\u5DF2\u5217\u51FA ${listed} \u4E2A\uFF09\uFF0C\u627E\u5230 ${refs} \u4E2A PR/Issue`) + (unreadable ? `\uFF1B${unreadable} \u4E2A\u5BF9\u8BDD codexhost \u8BFB\u4E0D\u51FA\u6765\uFF0C\u5DF2\u8DF3\u8FC7` : ""),
  githubStatus: (enabled, lastPollAt, error, now, refs) => !enabled ? "GitHub \u56DE\u590D\u63D0\u9192\u5DF2\u5173\u95ED" : error ? `GitHub \u56DE\u590D\u63D0\u9192\u6682\u4E0D\u53EF\u7528\uFF1A${error}` : lastPollAt ? `GitHub \u56DE\u590D\u63D0\u9192\u6B63\u5E38\uFF0C${relative(lastPollAt, now, "zh-CN")}\u68C0\u67E5\u8FC7` : refs ? "GitHub \u56DE\u590D\u63D0\u9192\u5373\u5C06\u5F00\u59CB" : "GitHub \u56DE\u590D\u63D0\u9192\u5DF2\u5F00\u542F\uFF0C\u6709 PR \u6216 issue \u540E\u5F00\u59CB\u68C0\u67E5",
  kind: { pr: "PR", issue: "Issue" },
  refState: { open: "\u8FDB\u884C\u4E2D", closed: "\u5DF2\u5173\u95ED", merged: "\u5DF2\u5408\u5E76" },
  reason: (reason) => ({
    comment: "\u6709\u65B0\u8BC4\u8BBA",
    review: "\u6709\u65B0\u8BC4\u5BA1",
    approved: "\u8BC4\u5BA1\u901A\u8FC7",
    changes_requested: "\u8981\u6C42\u4FEE\u6539",
    merged: "\u5DF2\u5408\u5E76",
    review_requested: "\u8BF7\u4F60 review",
    mention: "\u63D0\u5230\u4E86\u4F60",
    author: "\u6709\u65B0\u52A8\u6001",
    state_change: "\u72B6\u6001\u53D8\u4E86",
    assign: "\u6307\u6D3E\u7ED9\u4F60",
    ci_activity: "CI \u6709\u7ED3\u679C",
    manual: "\u6709\u65B0\u52A8\u6001",
    subscribed: "\u6709\u65B0\u52A8\u6001",
    team_mention: "\u63D0\u5230\u4E86\u4F60\u7684\u56E2\u961F"
  })[reason] ?? "\u6709\u65B0\u52A8\u6001",
  fromWindow: (title) => `\u6765\u6E90\u5BF9\u8BDD\u300C${title}\u300D`,
  turn: (n) => `\u7B2C ${n} \u8F6E`,
  inWindows: (n) => `\u51FA\u73B0\u5728 ${n} \u4E2A\u5BF9\u8BDD`,
  asked: (text) => `\u5F53\u65F6\u7684\u95EE\u9898\uFF1A${text}`,
  noteLabel: (text) => `\u8BF4\u660E\uFF1A${text}`,
  integrations: "Agent \u534F\u4F5C",
  integrationsIntro: "\u88C5\u597D\u540E\uFF0CClaude Code \u5728\u6BCF\u4E2A\u4F1A\u8BDD\u7684\u7B2C\u4E00\u6761\u6D88\u606F\u65F6\u8BFB\u5230\u672C\u5BF9\u8BDD\u7684\u4E3B\u7EBF\u548C\u7EA6\u5B9A\uFF0C\u4E4B\u540E\u53EA\u5728\u6709\u53D8\u5316\u65F6\u6536\u5230\u4E00\u884C\u72B6\u6001\uFF1BCodex \u5728\u5BF9\u8BDD\u7B2C\u4E00\u6761\u6D88\u606F\u65F6\u8FD0\u884C\u4E00\u6B21 mainline show\u3002Agent \u8FB9\u505A\u8FB9\u8BB0\u5F55\u652F\u7EBF\u4EFB\u52A1\uFF08\u5173\u6389\u81EA\u52A8\u51DD\u7EC3\u65F6\u4E5F\u7EF4\u62A4\u6807\u9898\u548C\u91CC\u7A0B\u7891\uFF09\uFF0C\u53D1\u73B0\u4F60\u5728\u540C\u4E00\u5BF9\u8BDD\u91CC\u5F00\u4E86\u65B0\u95EE\u9898\u65F6\u6309\u4E0B\u65B9\u8BBE\u7F6E\u5904\u7406\u3002\u5B89\u88C5\u524D\u4F1A\u663E\u793A\u8981\u6539\u7684\u6587\u4EF6\u548C\u5185\u5BB9\uFF0C\u968F\u65F6\u53EF\u4EE5\u5378\u8F7D\u3002",
  agentName: { claude: "Claude Code", codex: "Codex" },
  integrationState: { installed: "\u5DF2\u5B89\u88C5", missing: "\u672A\u5B89\u88C5", outdated: "\u9700\u8981\u66F4\u65B0", unavailable: "\u4E0D\u53EF\u7528" },
  integrationProblem: (agent, problem, cause) => {
    const { name, folder, file } = AGENT_FILES[agent];
    const why = cause ? `\uFF08${cause}\uFF09` : "";
    switch (problem) {
      case "NOT_SET_UP":
        return `\u6CA1\u6709\u627E\u5230 ${name} \u7684\u914D\u7F6E\uFF08${folder} \u4E0D\u5B58\u5728\uFF09`;
      case "NOT_A_FOLDER":
        return `${folder} \u4E0D\u662F\u6587\u4EF6\u5939`;
      case "FOLDER_UNREADABLE":
        return `\u8BFB\u4E0D\u4E86 ${folder}${why}`;
      case "FILE_UNREADABLE":
        return `\u8BFB\u4E0D\u4E86 ${file}${why}\uFF0C\u8BF7\u5148\u4FEE\u597D\u5B83`;
      case "NOT_JSON":
        return `${file} \u4E0D\u662F\u6709\u6548\u7684 JSON\uFF0C\u8BF7\u5148\u4FEE\u597D\u5B83`;
      case "NOT_AN_OBJECT":
        return `${file} \u4E0D\u662F JSON \u5BF9\u8C61\uFF0C\u8BF7\u5148\u4FEE\u597D\u5B83`;
    }
  },
  preview: "\u67E5\u770B\u6539\u52A8",
  install: "\u5B89\u88C5",
  update: "\u66F4\u65B0",
  uninstall: "\u5378\u8F7D",
  previewTitle: (action, file) => `${action}\uFF1A${file}`,
  previewAction: { create: "\u65B0\u5EFA\u6587\u4EF6", add: "\u8FFD\u52A0\u5185\u5BB9", replace: "\u66FF\u6362\u65E7\u7248\u5185\u5BB9", remove: "\u5220\u9664\u8FD9\u6BB5\u5185\u5BB9", none: "\u65E0\u9700\u6539\u52A8" },
  applyChange: "\u786E\u8BA4\u4FEE\u6539",
  command: (path) => `Agent \u4F7F\u7528\u7684\u547D\u4EE4\uFF1A${path}`,
  migratedNote: (folder) => `\u5DF2\u4ECE\u65E7\u7248\u300C\u4E3B\u7EBF\u4EFB\u52A1\u300D\u590D\u5236\u6570\u636E\u3002\u65E7\u76EE\u5F55 ${folder} \u4ECD\u5728\uFF1A\u786E\u8BA4\u65E0\u8BEF\u540E\u53EF\u4EE5\u624B\u52A8\u5220\u9664\uFF08\u91CC\u9762\u7684 backups/ \u6709\u4F60\u914D\u7F6E\u6587\u4EF6\u7684\u5B8C\u6574\u5907\u4EFD\uFF09\u30020.10 \u4EE5\u524D\u5F00\u7684\u5B50\u5BF9\u8BDD\u4ECD\u4ECE\u8FD9\u91CC\u8BFB\u9644\u4EF6\uFF0C\u5220\u6389\u540E\u5B83\u4EEC\u5C31\u8BFB\u4E0D\u5230\u8FD9\u4E9B\u6587\u4EF6\u4E86\u3002`,
  settings: "\u8BBE\u7F6E",
  driftPolicy: "\u540C\u4E00\u5BF9\u8BDD\u91CC\u51FA\u73B0\u65B0\u95EE\u9898\u65F6",
  driftPolicies: { ask: "\u5148\u95EE\u6211\uFF08\u63A8\u8350\uFF09", note: "\u53EA\u8BB0\u5F55\uFF0C\u4E0D\u6253\u65AD", off: "\u4E0D\u68C0\u67E5" },
  showCapsule: "\u5BF9\u8BDD\u6807\u9898\u680F\u4E5F\u663E\u793A\u4E3B\u7EBF\u80F6\u56CA\uFF08\u5207\u6362\u5230\u8FDB\u884C\u4E2D\u7684\u5BF9\u8BDD\u65F6\u81EA\u52A8\u5C55\u5F00 3 \u79D2\uFF09",
  prAlerts: "\u6211\u7ECF\u624B\u7684 PR \u6216 issue \u5728 GitHub \u4E0A\u6709\u4EBA\u8BC4\u5BA1\u3001\u5408\u5E76\u6216\u8BC4\u8BBA\u65F6\u63D0\u9192\u6211\uFF08\u7528\u5DF2\u767B\u5F55\u7684 gh\uFF0C\u53EA\u8BFB\uFF1B\u6709 Codex Desktop \u6216 codexhost \u7684\u7A97\u53E3\u5F00\u7740\u65F6\u6BCF\u5206\u949F\u67E5\u4E00\u6B21\uFF0C\u5426\u5219\u6BCF 10 \u5206\u949F\uFF09",
  attachmentsSection: "\u9644\u4EF6",
  attachmentsUsage: (files, size) => `\u5F00\u5B50\u5BF9\u8BDD\u65F6\u9644\u5E26\u7684\u6587\u4EF6\uFF1A${files} \u4E2A\uFF0C\u5171 ${size}`,
  attachmentsNone: "\u5F00\u5B50\u5BF9\u8BDD\u65F6\u8FD8\u6CA1\u6709\u9644\u5E26\u8FC7\u6587\u4EF6\u3002",
  attachmentsIntro: "\u5B50\u5BF9\u8BDD\u4EE5\u540E\u8FD8\u53EF\u80FD\u6309\u8DEF\u5F84\u8BFB\u8FD9\u4E9B\u6587\u4EF6\uFF0C\u6240\u4EE5\u4E0D\u4F1A\u81EA\u52A8\u5220\u9664\u3002",
  clearDoneAttachments: (size) => `\u6E05\u7406\u5DF2\u5B8C\u6210\u5B50\u5BF9\u8BDD\u7684\u9644\u4EF6\uFF08\u91CA\u653E ${size}\uFF09`,
  clearAllAttachments: (size) => `\u5168\u90E8\u6E05\u7406\uFF08\u91CA\u653E ${size}\uFF09`,
  clearingAttachments: "\u6B63\u5728\u6E05\u7406\u2026",
  attachmentsCleared: (files, size) => `\u5DF2\u5220\u9664 ${files} \u4E2A\u6587\u4EF6\uFF0C\u91CA\u653E ${size}`,
  favoritesMore: (left) => `\u663E\u793A\u66F4\u591A\uFF08\u8FD8\u6709 ${left} \u6761\uFF09`
};
var en = {
  pageTitle: "Second Brain",
  loading: "Loading\u2026",
  close: "Close",
  confirm: "Click again to confirm",
  armed: (label) => `${label}: click again within 3 seconds to confirm`,
  jump: "Go",
  cancel: "Cancel",
  time: (at, now) => relative(at, now, "en"),
  error: (code, message) => isErrorCode(code) ? EN_ERRORS[code](detail(message)) : `That did not work: ${detail(message)}`,
  findLabel: "Find a conversation",
  findPlaceholder: "Number, link or words, for example 42",
  finding: "Searching\u2026",
  findEmpty: "Nothing found. Try a PR or issue number, part of a link, a tag or words from the request.",
  findFailed: (message) => `Search failed: ${detail(message)}`,
  match: (field, text) => `Matched ${EN_MATCH[field] ?? "text"}: ${text}`,
  locate: "Show in the list",
  othersIntro: "No model has summarized these conversations into a mainline yet. Expand one to see what its title, workspace and the PRs it mentions suggest, and create a mainline from it.",
  status: { active: "Active", paused: "Paused", done: "Done" },
  threadStatus: { running: "Running", waiting: "Needs you", idle: "Idle", unknown: "Unknown" },
  draft: "Not summarized",
  progress: (done, total) => `\u25C6 ${done}/${total}`,
  progressLabel: (done, total) => `${done} of ${total} milestones reached`,
  current: (title) => `Now: ${title}`,
  noMilestones: "No milestones yet",
  doing: (text) => `Doing: ${text}`,
  lastPrompt: (text) => `Last request: ${text}`,
  firstPrompt: (text) => `Started with: ${text}`,
  showAll: (n) => `Show all (${n})`,
  showLess: "Show less",
  parent: (title) => `Delegated from: ${title}`,
  related: (title) => `Linked to: ${title}`,
  updated: (time) => `Updated ${time}`,
  milestones: "Milestones",
  milestoneState: { done: "Reached", current: "Current", planned: "Planned" },
  reach: "Mark reached",
  focus: "Make current",
  rename: "Rename",
  removeMilestone: "Delete milestone",
  addTaskTo: "Add a task to this milestone",
  addMilestone: "Add a milestone\u2026",
  addTask: "Add a task\u2026",
  taskDone: "Done",
  removeTask: "Delete",
  carriedBy: (title) => `Handled in child conversation "${title}"`,
  editDoing: "Edit what is being done",
  clearDoing: "Clear what is being done",
  doingPlaceholder: "What is being done\u2026",
  spinoffs: "Spin-offs",
  spinoffsOpen: (n) => `${n} open`,
  spawn: "Open child conversation",
  spawning: "Opening\u2026",
  keep: "Handle here",
  dismiss: "Dismiss",
  spawned: (title) => `Child conversation "${title}"`,
  spawnedNotice: (text) => `Opened a child conversation for "${text}"`,
  addSpinoff: "Note a spin-off\u2026",
  refs: "PRs and issues",
  editTitle: "Edit title",
  titlePlaceholder: "What this conversation does: action + object",
  editTags: "Edit tags",
  tagsPlaceholder: "Tags separated by commas, up to 8",
  statusLabel: "Status",
  deleteMainline: "Delete mainline",
  createMainline: "Create mainline",
  draftIntro: "No model has summarized this conversation into a mainline yet. Below is what its title, workspace and the PRs it mentions suggest.",
  tabConversations: (n) => `Conversations ${n}`,
  tabRefs: (n) => `PRs and issues ${n}`,
  tabFavorites: (n) => `Favorites ${n}`,
  tabSettings: "Settings",
  statusTabs: { active: "Active", paused: "Paused", done: "Done", others: "No mainline" },
  groupByLabel: "Group by",
  groupBy: { time: "By time", project: "By project" },
  timeBuckets: { today: "Today", yesterday: "Yesterday", week: "This week", earlier: "Earlier" },
  noWorkspace: "Other",
  childrenCount: (n) => `${n} child conversation${n === 1 ? "" : "s"}`,
  hideChildren: "Hide child conversations",
  emptyTab: "Nothing here yet.",
  summarized: (model, time) => `Summarized by a model ${time} (${model})`,
  resummarize: "Summarize again",
  summarizeQueued: "Asked the model; this updates shortly",
  pinnedNote: (parts) => `You changed ${englishList(parts)} by hand; the model leaves ${parts.length === 1 ? "it" : "them"} alone.`,
  pinnedParts: { title: "the title", tags: "the tags", status: "the status", milestones: (count) => `${count} milestone${count === 1 ? "" : "s"}` },
  unpin: "Summarize automatically again",
  backfillStart: (count) => `Summarize older conversations: send up to ${count} to the model`,
  backfillProgress: (done, total, failed, skipped, full) => `Summarizing older conversations: ${done}/${total}${failed ? `, ${failed} did not work` : ""}${skipped ? `, ${skipped} from other agents not sent, per the settings` : ""}${full ? `, ${full} without a mainline not sent: the mainlines are at their cap of ${MAX_CONVERSATIONS.toLocaleString("en")}` : ""}`,
  backfillStop: "Stop",
  backfillStopped: "Stopped summarizing older conversations. Summaries in progress finish; nothing else is sent to the model.",
  summarizerBusy: (running, queued) => `Summarizing ${running} conversation${running === 1 ? "" : "s"}${queued ? `, ${queued} waiting` : ""}`,
  summarizerError: (message) => `The last summary did not work: ${message}`,
  summaryProblem: {
    CLAUDE_MISSING: "Claude Code (the claude command) was not found on this computer: install it, or choose Codex for summaries in the settings",
    CODEX_MISSING: "Codex (the codex command) was not found on this computer: install it, or choose Claude Haiku for summaries in the settings",
    MODEL_CALLS_OFF: "Model calls are turned off (MAINLINE_NO_MODEL=1): nothing was sent"
  },
  summarizerToday: (count, limit, claude, codex) => `Automatic summaries today: ${count}/${limit} (Claude ${claude}, Codex ${codex})`,
  summarizerAsked: (manual, backfill) => `asked for: ${manual}, older conversations: ${backfill}`,
  autoSummarize: "After each reply, let a model summarize the mainline (title, tags, milestones and status)",
  summarizeModel: "Model for Claude Code and Codex conversations",
  summarizeModels: { follow: "Follow the conversation: Claude Haiku for Claude Code, Codex for Codex", claude: "Claude Haiku for both", codex: "Codex for both" },
  summarizeOthers: "Conversations of other agents (pi, DeepSeek, Grok, \u2026)",
  summarizeOthersOptions: {
    none: "Do not summarize; send them to no model",
    claude: "Claude Haiku: the conversation text goes to the provider your Claude Code uses",
    codex: "Codex: the conversation text goes to the provider your Codex uses"
  },
  summarizeOthersHint: "With \u201CDo not summarize\u201D, these conversations stay \u201CNot summarized\u201D: automatic summaries and the backfill skip them.",
  refsSection: "PRs and issues",
  favoritesSection: "Favorites",
  favoritesIntro: "Select text in a conversation and click the \u201C\u2605 Save\u201D button that appears; with the agent integration installed, you can also say \u201Csave the last reply\u201D in the chat. \u201CGo to passage\u201D opens its conversation and highlights it.",
  favoritesEmpty: "Nothing saved yet. Select text in a conversation and click \u201C\u2605 Save\u201D; it is kept here.",
  favoritesPlaceholder: "Search saved passages, notes or conversation titles",
  favoritesNone: "No saved passage matches.",
  favoriteRole: { agent: "reply", user: "your message" },
  favoriteNote: (text) => `Note: ${text}`,
  jumpToPassage: "Go to passage",
  openConversation: "Open this conversation",
  openFailed: (reason) => `Could not open this conversation: ${reason || "codexhost did not answer"}. It may be on another machine, or deleted.`,
  copy: "Copy",
  copied: "Copied",
  copyFailed: "Could not copy: this page may not write to the clipboard; select the text and copy it instead.",
  addNote: "Note",
  editNote: "Edit note",
  notePlaceholder: "A short note; Enter saves, Esc cancels",
  removeFavorite: "Delete",
  expandPassage: "Show all",
  foldPassage: "Show less",
  refsIntro: "Every GitHub PR and issue that came up in a codexhost conversation: which conversation it came from and what it was for. When someone reviews, merges or comments, it moves to the top here, the conversation's sidebar row gets a \u{1F514} (counted in the \u{1F514} N at the top of the sidebar when the sidebar does not show that conversation) and its hover card shows the news first; the capsule shows it too when it is on. The \u{1F514} goes away once you select Go here, Got it in the card, or the row while its \u{1F514} shows.",
  refsEmpty: "No PRs or issues found yet. Once the scan finishes, the links from your conversations show here.",
  findRefs: "Find a PR or issue",
  refsPlaceholder: "Number, link or words, for example 42",
  noResults: "Nothing found. The index holds links that appeared in codexhost conversations.",
  scanStatus: (scanned, listed, done, refs, unreadable = 0) => (done ? `Read ${scanned} conversations, found ${refs} PRs and issues` : `Reading conversations: ${scanned} read (${listed} listed), ${refs} PRs and issues found`) + (unreadable ? `; skipped ${unreadable} that codexhost cannot read` : ""),
  githubStatus: (enabled, lastPollAt, error, now, refs) => !enabled ? "GitHub reply alerts are off" : error ? `GitHub reply alerts unavailable: ${error}` : lastPollAt ? `GitHub reply alerts on, last checked ${relative(lastPollAt, now, "en")}` : refs ? "GitHub reply alerts start shortly" : "GitHub reply alerts on; checking starts once a PR or issue shows up",
  kind: { pr: "PR", issue: "Issue" },
  refState: { open: "Open", closed: "Closed", merged: "Merged" },
  reason: (reason) => ({
    comment: "New comment",
    review: "New review",
    approved: "Approved",
    changes_requested: "Changes requested",
    merged: "Merged",
    review_requested: "Review requested",
    mention: "You were mentioned",
    author: "New activity",
    state_change: "State changed",
    assign: "Assigned to you",
    ci_activity: "CI finished",
    manual: "New activity",
    subscribed: "New activity",
    team_mention: "Your team was mentioned"
  })[reason] ?? "New activity",
  fromWindow: (title) => `From "${title}"`,
  turn: (n) => `turn ${n}`,
  inWindows: (n) => `In ${n} conversations`,
  asked: (text) => `Asked then: ${text}`,
  noteLabel: (text) => `Note: ${text}`,
  integrations: "Agent integration",
  integrationsIntro: "Once installed, Claude Code reads the conversation's mainline and rules with the first message of each session, and afterwards gets one status line only when something changed; Codex runs mainline show once at the first message of a conversation. Agents record tasks as they work (and keep the title and milestones when automatic summaries are off), and handle a new problem in the same conversation as set below. You see the exact change before it is made, and can remove it at any time.",
  agentName: { claude: "Claude Code", codex: "Codex" },
  integrationState: { installed: "Installed", missing: "Not installed", outdated: "Needs update", unavailable: "Unavailable" },
  integrationProblem: (agent, problem, cause) => {
    const { name, folder, file } = AGENT_FILES[agent];
    const why = cause ? ` (${cause})` : "";
    switch (problem) {
      case "NOT_SET_UP":
        return `${name} is not set up (${folder} is missing)`;
      case "NOT_A_FOLDER":
        return `${folder} is not a folder`;
      case "FOLDER_UNREADABLE":
        return `${folder} cannot be read${why}`;
      case "FILE_UNREADABLE":
        return `${file} cannot be read${why}; fix it first`;
      case "NOT_JSON":
        return `${file} is not valid JSON; fix it first`;
      case "NOT_AN_OBJECT":
        return `${file} is not a JSON object; fix it first`;
    }
  },
  preview: "Show change",
  install: "Install",
  update: "Update",
  uninstall: "Remove",
  previewTitle: (action, file) => `${action}: ${file}`,
  previewAction: { create: "Create the file", add: "Add", replace: "Replace the old version", remove: "Remove this section", none: "Nothing to change" },
  applyChange: "Apply",
  command: (path) => `Command agents use: ${path}`,
  migratedNote: (folder) => `Copied the data over from the earlier version, \u201CMainline\u201D. The old folder ${folder} is still there: once everything looks right, you can delete it by hand (its backups/ folder holds full copies of your configuration files). Child conversations opened before 0.10 read their attachments from there; deleting it takes those files away from them.`,
  settings: "Settings",
  driftPolicy: "When a new problem shows up in the same conversation",
  driftPolicies: { ask: "Ask me first (recommended)", note: "Note it, keep going", off: "Do not check" },
  showCapsule: "Also show the mainline capsule in the conversation header (it opens for 3 seconds when you switch to an active conversation)",
  prAlerts: "Alert me when someone reviews, merges or comments on a PR or issue I worked on (uses your gh login, read only; checks every minute while a Codex Desktop or codexhost window is open, every 10 minutes otherwise)",
  attachmentsSection: "Attachments",
  attachmentsUsage: (files, size) => `Files sent along with child conversations: ${plural(files, "file")}, ${size}`,
  attachmentsNone: "No files have been sent along with child conversations.",
  attachmentsIntro: "Child conversations may read these files again from their paths, so they are not deleted automatically.",
  clearDoneAttachments: (size) => `Clear files of child conversations marked done (frees ${size})`,
  clearAllAttachments: (size) => `Clear all (frees ${size})`,
  clearingAttachments: "Clearing\u2026",
  attachmentsCleared: (files, size) => `Deleted ${plural(files, "file")}, freed ${size}`,
  favoritesMore: (left) => `Show more (${left} left)`
};
function pageStrings(locale) {
  return locale === "zh-CN" ? zh : en;
}

// src/page/tree.ts
var MAX_DEPTH = 24;
var live = (status) => status === "running" || status === "waiting";
function activityOf(threadId, sources) {
  return sources.state.conversations[threadId]?.updatedAt ?? sources.state.prompts[threadId]?.at ?? 0;
}
function latest(node, sources) {
  return node.children.reduce((max, child) => Math.max(max, latest(child, sources)), activityOf(node.threadId, sources));
}
function groupOf(node) {
  let paused = false;
  const visit = (current) => {
    const status = current.conversation?.status;
    if (status === "active") return true;
    if (status === "paused") paused = true;
    return current.children.some(visit);
  };
  if (visit(node)) return "active";
  return paused ? "paused" : "done";
}
function buildForest(sources) {
  const { state, info, parents } = sources;
  const records = Object.keys(state.conversations);
  const shown = new Set(records);
  const kids = /* @__PURE__ */ new Map();
  for (const threadId of /* @__PURE__ */ new Set([...Object.keys(parents), ...records])) {
    const parent = parentOf(threadId, sources);
    if (!parent || parent === threadId) continue;
    const list = kids.get(parent);
    if (list) list.push(threadId);
    else kids.set(parent, [threadId]);
  }
  for (const threadId of records) {
    let parent = parentOf(threadId, sources);
    for (let depth = 0; parent && !shown.has(parent) && depth < MAX_DEPTH; depth += 1) {
      shown.add(parent);
      parent = parentOf(parent, sources);
    }
  }
  const visited = /* @__PURE__ */ new Set();
  const queue = [...records];
  while (queue.length) {
    const threadId = queue.pop();
    if (visited.has(threadId)) continue;
    visited.add(threadId);
    shown.add(threadId);
    queue.push(...kids.get(threadId) ?? []);
  }
  const byActivity = (a, b) => activityOf(b, sources) - activityOf(a, sources);
  const byLiveThenActivity = (a, b) => Number(live(info[b]?.status)) - Number(live(info[a]?.status)) || byActivity(a, b);
  const placed = /* @__PURE__ */ new Set();
  const build = (threadId, depth) => {
    placed.add(threadId);
    const conversation = state.conversations[threadId];
    const children = [];
    if (depth < MAX_DEPTH) {
      for (const child of [...kids.get(threadId) ?? []].sort(byLiveThenActivity))
        if (shown.has(child) && !placed.has(child)) children.push(build(child, depth + 1));
    }
    return { threadId, ...conversation ? { conversation } : {}, children };
  };
  const roots = [...shown].filter((threadId) => {
    const parent = parentOf(threadId, sources);
    return !parent || parent === threadId || !shown.has(parent);
  });
  const trees = roots.sort(byActivity).map((threadId) => build(threadId, 0));
  for (const threadId of [...shown].sort(byActivity)) if (!placed.has(threadId)) trees.push(build(threadId, 0));
  trees.sort((a, b) => latest(b, sources) - latest(a, sources));
  const forest = { active: [], paused: [], done: [], others: [], count: records.length, byStatus: { active: 0, paused: 0, done: 0 } };
  for (const tree of trees) forest[groupOf(tree)].push(tree);
  for (const conversation of Object.values(state.conversations)) forest.byStatus[conversation.status] += 1;
  forest.others = [.../* @__PURE__ */ new Set([...Object.keys(state.prompts), ...Object.keys(info)])].filter((threadId) => !shown.has(threadId)).sort(byActivity);
  return forest;
}

// src/page/index.ts
var POLL_MS = 3e3;
var REFS_POLL_MS = 15e3;
var REFS_FRESH_MS = 6e4;
var SEARCH_DELAY_MS = 250;
var CONFIRM_MS = 3e3;
var NOTICE_MS = 1e4;
var FLASH_MS = 1600;
var OTHERS_SHOWN = 30;
var MAX_DEPTH2 = 24;
var OPEN_EVENT = "codexhost-mainline:open-thread";
var TABS = ["conversations", "favorites", "refs", "settings"];
var MARK = { done: "\u2713", current: "\u25CF", planned: "\u25CB" };
var STATUSES = ["active", "paused", "done"];
var THREAD_STATUSES = /* @__PURE__ */ new Set(["running", "waiting", "idle", "unknown"]);
var TEXT_INPUTS = /* @__PURE__ */ new Set(["text", "search", ""]);
var PASSAGE_FOLD_CHARS = 360;
var PASSAGE_FOLD_LINES = 6;
var COPIED_MS = 1500;
var DAY_MS = 24 * 60 * 60 * 1e3;
var beside = (items, index) => [items[index + 1], items[index - 1]].filter((item) => item !== void 0);
var detailId = (threadId) => `mlp-detail-${threadId}`;
var isRecord3 = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var messageOf = (error) => error instanceof Error ? error.message : String(error);
var shortId2 = (threadId) => `#${threadId.slice(0, 8)}`;
async function mount(root, api) {
  const page = new OverviewPage(root, api);
  await page.start();
  return () => page.stop();
}
var OverviewPage = class {
  #root;
  #api;
  #doc;
  #h;
  #t;
  /** The page's language as the host last reported it. */
  #locale;
  #data = null;
  #forest = null;
  #groups = /* @__PURE__ */ new Map();
  #settings = { ...DEFAULT_SETTINGS };
  #storageValues = {};
  #integrations = [];
  #preview = null;
  #refs = null;
  #refQuery = "";
  #refsList;
  #favorites = null;
  #favoriteQuery = "";
  #favoritesList;
  /** The search the loaded passages answer (the backend searches their whole text). */
  #favoritesFor = null;
  /** How many passages the tab shows: a page, and one more for each "show more". */
  #favoritesWanted = FAVORITES_PAGE;
  /** Only the answer to the latest request is shown. */
  #favoritesSeq = 0;
  /** Whole texts of passages the list sent cut short, once read. */
  #fullTexts = /* @__PURE__ */ new Map();
  /** Long passages opened in full. */
  #openPassages = /* @__PURE__ */ new Set();
  /** The passage just copied, to say so on its button for a moment. */
  #copied = null;
  /** What the files sent along with child conversations take, as last counted. */
  #attachments = null;
  #clearingAttachments = false;
  /** A failed poll clears itself once the backend answers again; a failed action waits to be read. */
  #error = null;
  #notice = null;
  #pending = false;
  #stopped = false;
  #localeSent = false;
  #pollSeq = 0;
  #query = "";
  #results = null;
  #searching = false;
  #searchError = "";
  #searchSeq = 0;
  /** Which results were in the list when they were drawn; titles become links once they are. */
  #resultsShape = "";
  #editing = null;
  /** An editor that just opened: its text is selected once, when it first gets the focus. */
  #freshEditor = null;
  /**
   * Where the focus goes after the next redraw: the first of these keys (`data-key`) still on the
   * page. Set by an action when it is done, so the focus lands on the control that started it, or
   * on the next sensible one when that control went away with what it acted on.
   */
  #focusKeys = [];
  #allOthers = false;
  #expanded = /* @__PURE__ */ new Set();
  /** The page's tab, the conversation list's status tab, and how the list is grouped. */
  #tab = "conversations";
  #statusTab = "active";
  #grouping = "time";
  #allChildren = /* @__PURE__ */ new Set();
  /** Text typed into the always-visible fields, kept across redraws. */
  #drafts = /* @__PURE__ */ new Map();
  /** Full views from the backend (clues, draft facts), by conversation. */
  #views = /* @__PURE__ */ new Map();
  #viewLoading = /* @__PURE__ */ new Set();
  #viewStale = /* @__PURE__ */ new Set();
  #spawning = /* @__PURE__ */ new Set();
  #confirming = /* @__PURE__ */ new Map();
  #resetters = /* @__PURE__ */ new WeakMap();
  #cleanup = [];
  #timer;
  #refsTimer;
  /** When the PR tab last asked for fresh PR states. */
  #refsFreshAt = Number.NEGATIVE_INFINITY;
  #searchTimer;
  #noticeTimer;
  #copiedTimer;
  #container;
  #titleEl;
  #messages;
  /** Says what a two-click button waits for, for screen readers. */
  #live;
  #findInput;
  #findResults;
  /** Everything below the search; redrawn as a whole, so the search box keeps its focus. */
  #body;
  constructor(root, api) {
    this.#root = root;
    this.#api = api;
    this.#doc = root.ownerDocument;
    this.#locale = api.locale;
    this.#t = pageStrings(localeOf(api.locale));
    const h = this.#h = builder(this.#doc);
    this.#titleEl = h("h1");
    this.#messages = h("div", { class: "mlp-messages" });
    this.#live = h("div", { class: "mlp-sr-only", attrs: { role: "status", "aria-live": "polite" } });
    this.#findInput = h("input", { class: "mlp-input mlp-find-input", attrs: { type: "search", autocomplete: "off", spellcheck: "false" } });
    this.#findResults = h("div", { class: "mlp-find-results", attrs: { "aria-live": "polite" } });
    this.#findResults.hidden = true;
    this.#body = h("div", { class: "mlp-body" });
    this.#container = h(
      "div",
      // The palette follows the host's light or dark scheme (page/style.css).
      { class: "mlp", attrs: { "data-scheme": api.colorScheme === "dark" ? "dark" : "light" } },
      h("header", { class: "mlp-header" }, this.#titleEl),
      this.#messages,
      this.#live,
      h("section", { class: "mlp-find", attrs: { role: "search" } }, h("div", { class: "mlp-find-box" }, icon(this.#doc, "search", "mlp-find-icon"), this.#findInput), this.#findResults),
      this.#body
    );
    this.#findInput.addEventListener("input", () => this.#onQuery());
    this.#findInput.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      if (event.key === "Enter") {
        event.preventDefault();
        clearTimeout(this.#searchTimer);
        void this.#search(this.#findInput.value);
      } else if (event.key === "Escape" && this.#findInput.value) {
        event.preventDefault();
        this.#findInput.value = "";
        this.#onQuery();
      }
    });
    root.replaceChildren(this.#container);
  }
  async start() {
    this.#cleanup.push(
      this.#api.onLocaleChange((locale) => {
        this.#locale = locale;
        this.#t = pageStrings(localeOf(locale));
        this.#localeSent = false;
        this.#render(true);
        this.#fillFind();
        void this.#poll();
      }),
      this.#api.storage.onChange((values) => {
        this.#storageValues = values;
        this.#settings = { ...DEFAULT_SETTINGS, ...pickSettings(values) };
        this.#render();
      }),
      this.#api.onColorSchemeChange((scheme) => this.#container.setAttribute("data-scheme", scheme === "dark" ? "dark" : "light"))
    );
    const focusout = () => setTimeout(() => {
      if (this.#pending && !this.#typing()) this.#render();
    }, 0);
    this.#container.addEventListener("focusout", focusout);
    this.#cleanup.push(() => this.#container.removeEventListener("focusout", focusout));
    const signal = this.#api.signal;
    if (signal) {
      const abort = () => this.stop();
      signal.addEventListener("abort", abort, { once: true });
      this.#cleanup.push(() => signal.removeEventListener("abort", abort));
    }
    const visibility = () => {
      if (this.#hidden()) return;
      void this.#loadRefs();
      void this.#poll();
    };
    this.#doc.addEventListener("visibilitychange", visibility);
    this.#cleanup.push(() => this.#doc.removeEventListener("visibilitychange", visibility));
    this.#render(true);
    await Promise.all([this.#loadSettings(), this.#loadIntegrations(), this.#poll(), this.#loadRefs(), this.#loadFavorites()]);
  }
  stop() {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const timer of [this.#timer, this.#refsTimer, this.#searchTimer, this.#noticeTimer, this.#copiedTimer, ...this.#confirming.values()]) clearTimeout(timer);
    this.#confirming.clear();
    for (const stop of this.#cleanup.splice(0)) stop();
  }
  // -------------------------------------------------------------------------------------------
  // Loading
  /** The page is not on screen (another tab, a minimized window): its polls pause. */
  #hidden() {
    return this.#doc.visibilityState === "hidden";
  }
  async #poll() {
    if (this.#stopped) return;
    const seq = ++this.#pollSeq;
    clearTimeout(this.#timer);
    if (this.#hidden()) return;
    if (this.#tab === "refs" && this.#refsFreshDue()) void this.#loadRefs();
    try {
      const params = {
        ...this.#data ? { version: this.#data.version } : {},
        ...this.#localeSent ? {} : { locale: localeOf(this.#locale), localeSource: "page" }
      };
      const result = await this.#api.backend.invoke("snapshot", params);
      if (this.#stopped || seq !== this.#pollSeq) return;
      this.#localeSent = true;
      if (result?.state) this.#applySnapshot(result);
    } catch (error) {
      if (this.#stopped || seq !== this.#pollSeq) return;
      this.#error = { kind: "poll", text: this.#message(error) };
      this.#render();
    }
    if (!this.#stopped && seq === this.#pollSeq && !this.#hidden()) this.#timer = setTimeout(() => void this.#poll(), POLL_MS);
  }
  #refsFreshDue() {
    return Date.now() - this.#refsFreshAt >= REFS_FRESH_MS;
  }
  #applySnapshot(result) {
    let state;
    try {
      state = normalizeStateV2(result.state);
    } catch (error) {
      this.#error = { kind: "poll", text: this.#message(error) };
      this.#render();
      return;
    }
    const saved = typeof result.favorites === "number" && Number.isFinite(result.favorites) ? result.favorites : 0;
    const savedBefore = this.#data?.favorites;
    this.#data = {
      state,
      info: readInfo(result.info),
      parents: readParents(result.parents),
      version: String(result.version),
      ...typeof result.command === "string" && result.command ? { command: result.command } : {},
      ...readSummarizer(result.summarizer),
      workspaces: readWorkspaces(result.workspaces),
      favorites: saved,
      outline: readOutline(result.outline),
      ...isRecord3(result.migration) && typeof result.migration.oldFolder === "string" && result.migration.oldFolder ? { oldFolder: result.migration.oldFolder } : {}
    };
    if (this.#tab === "favorites" || savedBefore !== saved) void this.#loadFavorites();
    if (this.#error?.kind === "poll") this.#error = null;
    for (const threadId of this.#expanded) void this.#loadView(threadId);
    this.#render();
  }
  /** The backend's full view adds what the snapshot lacks: clues, and the facts behind a draft. */
  async #loadView(threadId) {
    if (this.#stopped) return;
    if (this.#viewLoading.has(threadId)) {
      this.#viewStale.add(threadId);
      return;
    }
    this.#viewLoading.add(threadId);
    try {
      const view = await this.#api.backend.invoke("conversation", { threadId });
      if (isView(view, threadId)) {
        this.#views.set(threadId, view);
        if (this.#expanded.has(threadId)) this.#render();
      }
    } catch {
    } finally {
      this.#viewLoading.delete(threadId);
    }
    if (this.#viewStale.delete(threadId)) void this.#loadView(threadId);
  }
  async #loadRefs() {
    if (this.#stopped) return;
    clearTimeout(this.#refsTimer);
    if (this.#hidden()) return;
    const fresh = this.#tab === "refs" && this.#refsFreshDue();
    if (fresh) this.#refsFreshAt = Date.now();
    try {
      const next = await this.#api.backend.invoke("refs.list", ...fresh ? [{ fresh: true }] : []);
      if (next && Array.isArray(next.refs) && next.status?.conversations && next.status.github) {
        const changed = JSON.stringify(next) !== JSON.stringify(this.#refs);
        this.#refs = next;
        if (changed) this.#render();
      }
    } catch {
    }
    clearTimeout(this.#refsTimer);
    if (!this.#stopped && !this.#hidden()) this.#refsTimer = setTimeout(() => void this.#loadRefs(), REFS_POLL_MS);
  }
  /**
   * The passages for the current search, a page at a time, each cut short where long (`truncated`):
   * as many as the tab shows so far, again from the start, so a change anywhere keeps the list
   * as long as it was; with `more`, one page more.
   */
  async #loadFavorites(more = false) {
    if (this.#stopped) return;
    const query = this.#favoriteQuery.trim();
    if (more) this.#favoritesWanted += FAVORITES_PAGE;
    else if (query !== this.#favoritesFor) this.#favoritesWanted = FAVORITES_PAGE;
    const wanted = this.#favoritesWanted;
    const seq = ++this.#favoritesSeq;
    try {
      let list;
      for (let round = 0; round < 20 && (!list || list.nextOffset !== void 0 && list.items.length < wanted); round += 1) {
        const params = { ...query ? { query } : {}, ...list?.nextOffset ? { offset: list.nextOffset } : {}, limit: Math.min(FAVORITES_PAGE_MAX, wanted - (list?.items.length ?? 0)) };
        const page = await this.#api.backend.invoke("favorites.list", params);
        if (seq !== this.#favoritesSeq || this.#stopped || !isFavoritesList(page)) return;
        const { nextOffset: _next, ...rest } = page;
        list = list ? { ...rest, items: [...list.items, ...page.items], titles: { ...list.titles, ...page.titles }, ...page.nextOffset !== void 0 ? { nextOffset: page.nextOffset } : {} } : page;
      }
      if (!list) return;
      if (more) this.#focusKeys = ["more:favorites", "favorites-search"];
      const changed = JSON.stringify(list) !== JSON.stringify(this.#favorites) || this.#favoritesFor !== query;
      this.#favorites = list;
      this.#favoritesFor = query;
      if (changed) this.#render();
    } catch {
    }
  }
  /** A passage's whole text: as listed, or read from the backend when the list cut it short. */
  async #fullText(item) {
    if (!item.truncated) return item.text;
    const known = this.#fullTexts.get(item.id);
    if (known !== void 0) return known;
    const result = await this.#api.backend.invoke("favorites.get", { id: item.id });
    const text = isRecord3(result) && isRecord3(result.favorite) && typeof result.favorite.text === "string" ? result.favorite.text : void 0;
    if (text === void 0) throw new Error(this.#t.error(void 0, "?"));
    this.#fullTexts.set(item.id, text);
    return text;
  }
  async #loadSettings() {
    try {
      this.#storageValues = await this.#api.storage.get();
      this.#settings = { ...DEFAULT_SETTINGS, ...pickSettings(this.#storageValues) };
      this.#render();
    } catch {
    }
  }
  async #loadIntegrations() {
    try {
      const result = await this.#api.backend.invoke("integration.status");
      this.#integrations = Array.isArray(result) ? result : [];
      this.#render();
    } catch (error) {
      this.#error = { kind: "action", text: this.#message(error) };
      this.#render();
    }
  }
  // -------------------------------------------------------------------------------------------
  // Actions
  #message(error) {
    return this.#t.error(errorCodeOf(error), messageOf(error));
  }
  /**
   * Runs an edit, then shows its outcome: fresh data and search results, or why it failed. `focus`
   * names where the focus goes then (see `#focusKeys`); without it, it stays where it is.
   */
  async #act(action, focus) {
    try {
      await action();
    } catch (error) {
      if (this.#stopped) return false;
      this.#error = { kind: "action", text: this.#message(error) };
      if (focus) this.#focusKeys = [...focus];
      this.#render(true);
      return false;
    }
    if (this.#error?.kind === "action") this.#error = null;
    await this.#poll();
    if (this.#query.trim()) void this.#search(this.#query, true);
    if (focus) this.#focusKeys = [...focus];
    this.#render(true);
    return true;
  }
  #mutate(params, focus) {
    return this.#act(() => this.#api.backend.invoke("mutate", params), focus);
  }
  async #spawn(threadId, spinoff, focus) {
    const key = `${threadId}:${spinoff.id}`;
    if (this.#spawning.has(key)) return;
    this.#spawning.add(key);
    this.#render(true);
    const opened = {};
    const ok = await this.#act(async () => {
      try {
        const result = await this.#api.backend.invoke("spawn", { threadId, spinoffId: spinoff.id });
        if (typeof result?.childThreadId === "string" && result.childThreadId) opened.child = result.childThreadId;
      } catch (error) {
        if (errorCodeOf(error) !== "PENDING") throw error;
        opened.pending = this.#message(error);
      }
    }, focus);
    this.#spawning.delete(key);
    if (ok) this.#showNotice(opened.pending ?? this.#t.spawnedNotice(spinoff.text), opened.child);
    this.#render(true);
  }
  async #saveSettings(patch) {
    const next = { ...this.#storageValues, ...this.#settings, ...patch };
    this.#settings = { ...this.#settings, ...patch };
    this.#render(true);
    try {
      this.#storageValues = await this.#api.storage.set(next);
    } catch (error) {
      this.#error = { kind: "action", text: this.#t.error(void 0, messageOf(error)) };
      this.#render(true);
    }
  }
  /** Shows what installing or removing would change, and moves the focus to it; `opener` gets it back after. */
  async #showPreview(agent, removing, opener) {
    try {
      const preview = await this.#api.backend.invoke("integration.preview", { agent, removing });
      this.#preview = { ...preview, removing, opener };
      this.#focusKeys = ["integration:apply", "integration:cancel"];
    } catch (error) {
      this.#error = { kind: "action", text: this.#message(error) };
    }
    this.#render(true);
  }
  async #applyIntegration(agent, removing) {
    const back = this.#previewFocus(agent);
    try {
      await this.#api.backend.invoke(removing ? "integration.uninstall" : "integration.install", { agent });
      this.#preview = null;
      this.#focusKeys = back;
      await this.#loadIntegrations();
    } catch (error) {
      let text = this.#message(error);
      if (errorCodeOf(error) === "UNAVAILABLE") {
        await this.#loadIntegrations();
        const status = this.#integrations.find((item) => item.agent === agent);
        if (status?.problem) text = this.#t.error("UNAVAILABLE", this.#t.integrationProblem(agent, status.problem, status.cause));
      }
      this.#error = { kind: "action", text };
      this.#focusKeys = ["integration:apply", ...back];
      this.#render(true);
    }
  }
  /** Where the focus goes once a preview closes: the button that opened it, else another of the agent's. */
  #previewFocus(agent) {
    const opener = this.#preview?.opener;
    return [...opener ? [opener] : [], `integration:${agent}:preview`, `integration:${agent}:install`, `integration:${agent}:uninstall`];
  }
  #openThread(threadId) {
    const detail2 = { threadId };
    const view = this.#doc.defaultView;
    view?.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: detail2 }));
    detail2.result?.catch((error) => {
      if (this.#stopped) return;
      this.#error = { kind: "action", text: this.#t.openFailed(messageOf(error).replace(/^\[[A-Z_]+\]\s*/u, "")) };
      this.#render(true);
    });
    if (detail2.handled || this.#api.hostTarget !== "web" || !view) return;
    const url = new URL(view.location.href);
    url.searchParams.set("session", threadId);
    view.location.assign(url.href);
  }
  #showNotice(text, threadId) {
    clearTimeout(this.#noticeTimer);
    this.#notice = { text, ...threadId ? { threadId } : {} };
    this.#renderMessages();
    this.#noticeTimer = setTimeout(() => this.#clearNotice(), NOTICE_MS);
  }
  #clearNotice() {
    clearTimeout(this.#noticeTimer);
    this.#notice = null;
    if (!this.#stopped) this.#renderMessages();
  }
  #toggle(threadId) {
    if (this.#expanded.delete(threadId)) {
      if (this.#editing?.includes(threadId)) this.#editing = null;
    } else {
      this.#expanded.add(threadId);
      void this.#loadView(threadId);
    }
    this.#render(true);
  }
  #edit(key) {
    this.#editing = key;
    this.#freshEditor = key;
    this.#drafts.delete(`edit:${key}`);
    this.#render(true);
  }
  /** Opens a search result in the list: unfolds its group, expands it and scrolls to it. */
  #locate(threadId) {
    const data = this.#data;
    const group = this.#groups.get(threadId);
    if (!data || !group) return;
    this.#tab = "conversations";
    this.#statusTab = group;
    if (group === "others" && (this.#forest?.others.indexOf(threadId) ?? 0) >= OTHERS_SHOWN) this.#allOthers = true;
    const sources = this.#sources(data);
    let parent = parentOf(threadId, sources);
    for (let depth = 0; parent && depth < MAX_DEPTH2; depth += 1) {
      this.#allChildren.add(parent);
      parent = parentOf(parent, sources);
    }
    if (!this.#expanded.has(threadId)) {
      this.#expanded.add(threadId);
      void this.#loadView(threadId);
    }
    this.#focusKeys = [`row:${threadId}`];
    this.#render(true);
    const node = [...this.#body.querySelectorAll(".mlp-node")].find((element) => element.dataset.threadId === threadId);
    if (!node) return;
    const still = this.#doc.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    node.scrollIntoView?.({ block: "center", behavior: still ? "auto" : "smooth" });
    node.setAttribute("data-flash", "");
    setTimeout(() => node.removeAttribute("data-flash"), FLASH_MS);
  }
  // -------------------------------------------------------------------------------------------
  // Search
  #onQuery() {
    this.#query = this.#findInput.value;
    clearTimeout(this.#searchTimer);
    if (!this.#query.trim()) {
      this.#searchSeq += 1;
      this.#results = null;
      this.#searching = false;
      this.#searchError = "";
      this.#fillFind();
      return;
    }
    this.#searchTimer = setTimeout(() => void this.#search(this.#query), SEARCH_DELAY_MS);
  }
  /** `quiet` refreshes results after an edit without flashing "searching". */
  async #search(query, quiet = false) {
    const text = query.trim();
    if (!text || this.#stopped) return;
    const seq = ++this.#searchSeq;
    if (!quiet) {
      this.#searching = true;
      this.#searchError = "";
      this.#fillFind();
    }
    let results = [];
    let error = "";
    try {
      results = readResults(await this.#api.backend.invoke("search", { query: text }));
    } catch (failure) {
      error = this.#t.findFailed(messageOf(failure));
    }
    if (seq !== this.#searchSeq || this.#stopped) return;
    this.#searching = false;
    this.#results = results;
    this.#searchError = error;
    this.#fillFind();
  }
  /** Redraws only the results, so typing in the search box is never interrupted. */
  #fillFind() {
    const h = this.#h;
    const t = this.#t;
    const results = this.#results;
    const nodes = [];
    if (this.#query.trim()) {
      if (this.#searching) nodes.push(h("div", { class: "mlp-meta", text: t.finding }));
      if (this.#searchError) nodes.push(h("div", { class: "mlp-meta mlp-warn", text: this.#searchError }));
      else if (results?.length) nodes.push(...results.map((result) => this.#hit(result)));
      else if (results && !this.#searching) nodes.push(h("p", { class: "mlp-muted", text: t.findEmpty }));
    }
    this.#resultsShape = this.#shapeOf(results);
    this.#findResults.replaceChildren(...nodes);
    this.#findResults.hidden = nodes.length === 0;
  }
  #shapeOf(results) {
    return (results ?? []).map((result) => this.#groups.has(result.threadId) ? "1" : "0").join("");
  }
  #hit(result) {
    const h = this.#h;
    const t = this.#t;
    const status = this.#liveStatus(result.threadId, result.threadStatus);
    const { done, total } = result.progress;
    const title = this.#groups.has(result.threadId) ? h("button", { class: "mlp-link mlp-hit-title", text: result.title, title: t.locate, attrs: { type: "button" }, on: { click: () => this.#locate(result.threadId) } }) : h("span", { class: "mlp-hit-title", text: result.title });
    return h(
      "article",
      { class: "mlp-hit", attrs: { "data-thread-id": result.threadId } },
      h(
        "div",
        { class: "mlp-hit-head" },
        this.#statusDot(status),
        title,
        result.draft ? h("span", { class: "mlp-badge mlp-draft", text: t.draft }) : this.#statusBadge(result.status),
        h("span", { class: "mlp-spacer" }),
        h("span", { class: "mlp-meta mlp-live", text: t.threadStatus[status] }),
        this.#button(t.jump, () => this.#openThread(result.threadId), "mlp-btn-sm")
      ),
      result.tags.length ? this.#tags(result.tags) : null,
      h(
        "div",
        { class: "mlp-hit-meta" },
        total ? h("span", { class: "mlp-progress", text: t.progress(done, total), title: t.progressLabel(done, total) }) : null,
        result.current ? h("span", { class: "mlp-current", text: t.current(result.current) }) : null,
        result.updatedAt ? h("span", { class: "mlp-meta", text: t.time(result.updatedAt, Date.now()) }) : null
      ),
      h("div", { class: "mlp-match", text: t.match(result.match.field, result.match.text) })
    );
  }
  // -------------------------------------------------------------------------------------------
  // Drawing
  /** The focused element below the search, if any. */
  #active() {
    const rootNode = this.#root.getRootNode();
    const active = typeof ShadowRoot !== "undefined" && rootNode instanceof ShadowRoot ? rootNode.activeElement : this.#doc.activeElement;
    return active && this.#body.contains(active) ? active : void 0;
  }
  /**
   * The user has the focus somewhere the page must not take it from: typing in the search box, or
   * outside the overview altogether.
   */
  #focusElsewhere() {
    const rootNode = this.#root.getRootNode();
    const shadow = typeof ShadowRoot !== "undefined" && rootNode instanceof ShadowRoot ? rootNode : null;
    const active = shadow ? shadow.activeElement : this.#doc.activeElement;
    const nothing = (element) => !element || element === this.#doc.body || element === this.#doc.documentElement;
    if (shadow && !active) return !nothing(this.#doc.activeElement);
    if (nothing(active)) return false;
    return active === this.#findInput || !this.#container.contains(active);
  }
  #typing() {
    const active = this.#active();
    if (!active) return false;
    if (active.tagName === "SELECT" || active.tagName === "TEXTAREA") return true;
    return active.tagName === "INPUT" && TEXT_INPUTS.has(active.type);
  }
  #render(force = false) {
    if (this.#stopped) return;
    if (!force && this.#typing()) {
      this.#pending = true;
      return;
    }
    this.#pending = false;
    const t = this.#t;
    this.#titleEl.textContent = t.pageTitle;
    this.#findInput.placeholder = t.findPlaceholder;
    this.#findInput.setAttribute("aria-label", t.findLabel);
    this.#renderMessages();
    this.#forest = this.#data ? buildForest(this.#sources(this.#data)) : null;
    this.#groups = this.#forest ? groupsOf(this.#forest) : /* @__PURE__ */ new Map();
    const focused = this.#active()?.getAttribute("data-key") ?? void 0;
    const elsewhere = this.#focusElsewhere();
    const scroll = this.#root.scrollTop;
    const content = this.#tab === "refs" ? [this.#refsSection()] : this.#tab === "favorites" ? [this.#favoritesSection()] : this.#tab === "settings" ? [this.#migrationNote(), this.#integrationSection(), this.#settingsSection(), this.#attachmentsSection()] : [this.#conversationsSection()];
    const panel = this.#h(
      "div",
      { class: "mlp-tabpanel", attrs: { role: "tabpanel", id: this.#tabPanelId, "aria-labelledby": this.#tabId(this.#tab) } },
      ...content
    );
    this.#body.replaceChildren(this.#tabs(), panel);
    this.#root.scrollTop = scroll;
    if (elsewhere) this.#focusKeys = [];
    else this.#restoreFocus(focused);
    if (this.#shapeOf(this.#results) !== this.#resultsShape) this.#fillFind();
  }
  /**
   * Puts the focus back after a redraw: on the control asked for (`#focusKeys`: where an action
   * sends it), else on the control that had it, else on an editor that just opened. Controls are
   * found by their `data-key`, which stays the same across redraws.
   */
  #restoreFocus(focused) {
    const wanted = this.#focusKeys;
    this.#focusKeys = [];
    const keyed = [...this.#body.querySelectorAll("[data-key]")].filter((element) => !element.hasAttribute("disabled"));
    const byKey = (key) => keyed.find((element) => element.dataset.key === key);
    const editor = () => keyed.find((element) => element.hasAttribute("data-autofocus") && element.dataset.key === this.#editing);
    let target;
    for (const key of wanted) if (target = byKey(key)) break;
    if (!target && this.#freshEditor !== null && this.#freshEditor === this.#editing) target = editor();
    const kept = !target && focused !== void 0 ? byKey(focused) : void 0;
    target ??= kept ?? editor();
    if (!target) return;
    target.focus(kept ? { preventScroll: true } : void 0);
    if (target.tagName === "INPUT" && target.dataset.key === this.#freshEditor) {
      this.#freshEditor = null;
      target.select();
    }
  }
  #renderMessages() {
    const h = this.#h;
    const t = this.#t;
    const nodes = [];
    if (this.#error)
      nodes.push(
        h(
          "div",
          { class: "mlp-error", attrs: { role: "alert" } },
          h("span", { class: "mlp-main", text: this.#error.text }),
          this.#iconButton("close", t.close, () => {
            this.#error = null;
            this.#renderMessages();
          })
        )
      );
    const notice = this.#notice;
    if (notice) {
      const child = notice.threadId;
      nodes.push(
        h(
          "div",
          { class: "mlp-notice", attrs: { role: "status" } },
          h("span", { class: "mlp-main", text: notice.text }),
          child ? this.#button(t.jump, () => this.#openThread(child), "mlp-btn-sm") : null,
          this.#iconButton("close", t.close, () => this.#clearNotice())
        )
      );
    }
    this.#messages.replaceChildren(...nodes);
  }
  #sources(data) {
    return { state: data.state, info: data.info, parents: data.parents };
  }
  #liveStatus(threadId, fallback) {
    const status = this.#data?.info[threadId]?.status ?? fallback;
    return status && THREAD_STATUSES.has(status) ? status : "unknown";
  }
  /**
   * The snapshot gives the mainline itself, always current; the backend's view adds the clues and,
   * for a draft, the title, tags and first request it was made from.
   */
  #viewOf(threadId, data) {
    const local = conversationView(threadId, this.#sources(data));
    const remote = this.#views.get(threadId);
    if (!remote) return local;
    if (data.outline[threadId] && !remote.draft) return remote;
    return {
      ...local,
      refs: remote.refs,
      // The snapshot may cut the last request short; the backend's view has all of it.
      ...remote.lastPrompt ? { lastPrompt: remote.lastPrompt } : {},
      ...local.draft && remote.draft ? { title: remote.title, tags: remote.tags, ...remote.firstPrompt ? { firstPrompt: remote.firstPrompt } : {} } : {}
    };
  }
  // Conversation tree -----------------------------------------------------------------------
  get #tabPanelId() {
    return `mlp-${this.#api.id}-tabpanel`;
  }
  #tabId(tab) {
    return `mlp-${this.#api.id}-tab-${tab}`;
  }
  #selectTab(tab, focus = false) {
    this.#tab = tab;
    if (tab === "favorites") void this.#loadFavorites();
    if (tab === "settings") void this.#loadAttachments();
    if (focus) this.#focusKeys = [`tab:${tab}`];
    this.#render(true);
  }
  /**
   * Conversations, favorites, PRs and issues, settings: one at a time, so none is buried under the
   * others. One tab stop; the arrow keys, Home and End move between the tabs.
   */
  #tabs() {
    const h = this.#h;
    const t = this.#t;
    const labels = {
      conversations: t.tabConversations(this.#forest?.count ?? 0),
      favorites: t.tabFavorites(this.#favorites?.total ?? this.#data?.favorites ?? 0),
      refs: t.tabRefs(this.#refs?.refs.length ?? 0),
      settings: t.tabSettings
    };
    return h(
      "nav",
      { class: "mlp-tabs", attrs: { role: "tablist", "aria-label": t.pageTitle } },
      ...TABS.map((key, index) => {
        const selected = this.#tab === key;
        return h("button", {
          class: "mlp-tab",
          text: labels[key],
          attrs: {
            type: "button",
            role: "tab",
            id: this.#tabId(key),
            "aria-selected": String(selected),
            "aria-controls": this.#tabPanelId,
            tabindex: selected ? "0" : "-1",
            "data-tab": key,
            "data-key": `tab:${key}`
          },
          on: {
            click: () => this.#selectTab(key),
            keydown: (event) => {
              const { key: pressed } = event;
              const last = TABS.length - 1;
              const next = pressed === "ArrowRight" ? index === last ? 0 : index + 1 : pressed === "ArrowLeft" ? index === 0 ? last : index - 1 : pressed === "Home" ? 0 : pressed === "End" ? last : -1;
              const tab = TABS[next];
              if (!tab) return;
              event.preventDefault();
              this.#selectTab(tab, true);
            }
          }
        });
      })
    );
  }
  #conversationsSection() {
    const h = this.#h;
    const t = this.#t;
    const data = this.#data;
    const forest = this.#forest;
    if (!data || !forest) return h("section", { class: "mlp-section mlp-conversations" }, h("p", { class: "mlp-muted", text: t.loading }));
    const counts = { ...forest.byStatus, others: forest.others.length };
    const statuses = ["active", "paused", "done", ...forest.others.length ? ["others"] : []];
    if (!statuses.includes(this.#statusTab)) this.#statusTab = "active";
    const toolbar = h(
      "div",
      { class: "mlp-toolbar" },
      h(
        "div",
        { class: "mlp-segmented", attrs: { role: "group", "aria-label": t.statusLabel } },
        ...statuses.map(
          (status) => h(
            "button",
            {
              class: "mlp-seg",
              attrs: { type: "button", "aria-pressed": String(this.#statusTab === status), "data-status-tab": status, "data-key": `status-tab:${status}` },
              on: {
                click: () => {
                  this.#statusTab = status;
                  this.#render(true);
                }
              }
            },
            h("span", { text: t.statusTabs[status] }),
            h("span", { class: "mlp-seg-count", text: String(counts[status]) })
          )
        )
      ),
      h("span", { class: "mlp-spacer" }),
      this.#statusTab === "others" ? null : h(
        "div",
        { class: "mlp-segmented mlp-grouping", attrs: { role: "group", "aria-label": t.groupByLabel } },
        ...["time", "project"].map(
          (grouping) => h("button", {
            class: "mlp-seg",
            text: t.groupBy[grouping],
            attrs: { type: "button", "aria-pressed": String(this.#grouping === grouping), "data-grouping": grouping, "data-key": `grouping:${grouping}` },
            on: {
              click: () => {
                this.#grouping = grouping;
                this.#render(true);
              }
            }
          })
        )
      )
    );
    const busy = data.summarizer && (data.summarizer.backfill || data.summarizer.running || data.summarizer.queued) ? this.#summarizerLine(data, false) : null;
    let list;
    if (this.#statusTab === "others") list = this.#others(forest.others, data);
    else {
      const trees = forest[this.#statusTab];
      list = trees.length ? this.#buckets(trees, data).map(([label, nodes]) => this.#bucket(label, nodes, data)) : [h("p", { class: "mlp-muted", text: t.emptyTab })];
    }
    return h("section", { class: "mlp-section mlp-conversations" }, toolbar, busy, ...list);
  }
  /** Trees in groups: by when they last moved (today, yesterday, this week, earlier) or by project. */
  #buckets(trees, data) {
    const t = this.#t;
    const sources = this.#sources(data);
    const buckets = /* @__PURE__ */ new Map();
    const put = (label, node) => {
      const list = buckets.get(label);
      if (list) list.push(node);
      else buckets.set(label, [node]);
    };
    if (this.#grouping === "project") {
      const sorted = [...trees].sort((a, b) => latest(b, sources) - latest(a, sources));
      for (const node of sorted) put(data.workspaces[node.threadId] ?? t.noWorkspace, node);
      return [...buckets];
    }
    const now = /* @__PURE__ */ new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const order = [t.timeBuckets.today, t.timeBuckets.yesterday, t.timeBuckets.week, t.timeBuckets.earlier];
    for (const label of order) buckets.set(label, []);
    for (const node of trees) {
      const at = latest(node, sources);
      put(at >= today ? order[0] : at >= today - DAY_MS ? order[1] : at >= today - 6 * DAY_MS ? order[2] : order[3], node);
    }
    return [...buckets].filter(([, nodes]) => nodes.length);
  }
  #bucket(label, nodes, data) {
    const h = this.#h;
    return h(
      "div",
      { class: "mlp-bucket" },
      h("div", { class: "mlp-bucket-title" }, h("span", { text: label }), h("span", { class: "mlp-bucket-count", text: String(nodes.length) })),
      h("div", { class: "mlp-tree" }, ...nodes.map((node) => this.#node(node, 0, data)))
    );
  }
  #others(ids, data) {
    const h = this.#h;
    const t = this.#t;
    const shown = this.#allOthers ? ids : ids.slice(0, OTHERS_SHOWN);
    return [
      h("p", { class: "mlp-intro", text: t.othersIntro }),
      h("div", { class: "mlp-tree" }, ...shown.map((threadId) => this.#node({ threadId, children: [] }, 0, data))),
      ids.length > OTHERS_SHOWN ? this.#more(
        this.#allOthers ? t.showLess : t.showAll(ids.length),
        () => {
          this.#allOthers = !this.#allOthers;
          this.#render(true);
        },
        "more:others"
      ) : null
    ];
  }
  #more(label, onClick, key) {
    return this.#h("button", { class: "mlp-link mlp-more", text: label, attrs: { type: "button", "data-key": key }, on: { click: onClick } });
  }
  /** A conversation: one line, its details when opened, and its child conversations folded under a count. */
  #node(node, depth, data) {
    const h = this.#h;
    const t = this.#t;
    const threadId = node.threadId;
    const expanded = this.#expanded.has(threadId);
    const element = h(
      "div",
      {
        class: "mlp-node",
        attrs: { "data-thread-id": threadId, "data-depth": String(depth), "data-draft": node.conversation ? void 0 : "", "data-expanded": expanded ? "" : void 0 }
      },
      this.#line(node, data, expanded),
      expanded ? this.#detail(this.#viewOf(threadId, data), data, detailId(threadId)) : null
    );
    if (node.children.length) {
      const open = this.#allChildren.has(threadId);
      element.append(
        h("button", {
          class: "mlp-children-toggle",
          text: open ? t.hideChildren : t.childrenCount(node.children.length),
          attrs: { type: "button", "aria-expanded": String(open), "data-key": `children:${threadId}` },
          on: {
            click: () => {
              if (open) this.#allChildren.delete(threadId);
              else this.#allChildren.add(threadId);
              this.#render(true);
            }
          }
        })
      );
      if (open) element.append(h("div", { class: "mlp-children" }, ...node.children.map((child) => this.#node(child, depth + 1, data))));
    }
    return element;
  }
  /**
   * One line: live state, title, current milestone, progress and when it last moved. The title is
   * the button that opens the details (a click anywhere else on the line does too); "Go" beside it
   * opens the conversation.
   */
  #line(node, data, expanded) {
    const h = this.#h;
    const t = this.#t;
    const threadId = node.threadId;
    const conversation = node.conversation;
    const sources = this.#sources(data);
    const title = conversation?.title ?? titleOf(threadId, sources);
    const current = conversation ? currentMilestone(conversation) : void 0;
    const outlined = data.outline[threadId];
    const { done, total } = outlined ? { done: outlined[0], total: outlined[1] } : conversation ? progressOf(conversation) : { done: 0, total: 0 };
    const at = latest(node, sources);
    const jump = h("button", { class: "mlp-icon mlp-row-open", title: t.jump, attrs: { type: "button", "aria-label": t.jump, "data-key": `jump:${threadId}` } }, icon(this.#doc, "open"));
    jump.addEventListener("click", (event) => {
      event.stopPropagation();
      this.#openThread(threadId);
    });
    const toggle = h(
      "button",
      {
        class: "mlp-row-toggle",
        title,
        attrs: { type: "button", "aria-expanded": String(expanded), "aria-controls": expanded ? detailId(threadId) : void 0, "data-key": `row:${threadId}` }
      },
      h("span", { class: "mlp-row-title", text: title }),
      conversation ? null : h("span", { class: "mlp-badge mlp-draft", text: t.draft })
    );
    const line = h(
      "div",
      { class: "mlp-row" },
      this.#statusDot(this.#liveStatus(threadId)),
      toggle,
      h("span", { class: "mlp-row-current", text: current?.title ?? "" }),
      total ? h("span", { class: "mlp-row-progress", text: t.progress(done, total), title: t.progressLabel(done, total) }) : null,
      at ? h("span", { class: "mlp-row-time", text: t.time(at, Date.now()) }) : null,
      jump,
      h("span", { class: "mlp-row-chevron", attrs: { "aria-hidden": "true" } }, icon(this.#doc, "chevron"))
    );
    line.addEventListener("click", () => this.#toggle(threadId));
    return line;
  }
  // Expanded conversation -------------------------------------------------------------------
  #detail(view, data, id) {
    const h = this.#h;
    const t = this.#t;
    const threadId = view.threadId;
    const now = Date.now();
    const titleKey = `title:${threadId}`;
    const tagsKey = `tags:${threadId}`;
    const parts = [];
    const leaving = () => [`row:${threadId}`, ...this.#besideRow(threadId), `status-tab:${this.#statusTab}`];
    const prompt = view.lastPrompt ?? data.state.prompts[threadId];
    parts.push(
      h(
        "div",
        { class: "mlp-detail-meta" },
        h("span", { class: "mlp-id", text: shortId2(threadId) }),
        view.updatedAt ? h("span", { class: "mlp-meta", text: t.updated(t.time(view.updatedAt, now)) }) : null,
        view.parent ? this.#threadLink(t.parent(view.parent.title), view.parent.threadId, "", `parent:${threadId}`) : null,
        view.related ? this.#threadLink(t.related(view.related.title), view.related.threadId, "", `related:${threadId}`) : null,
        view.summary ? h("span", { class: "mlp-meta", text: t.summarized(view.summary.model, t.time(view.summary.at, now)) }) : null,
        h("span", { class: "mlp-spacer" }),
        this.#button(t.jump, () => this.#openThread(threadId), "mlp-btn-sm mlp-primary", `detail-jump:${threadId}`),
        this.#button(t.resummarize, () => void this.#summarize(threadId), "mlp-btn-sm mlp-quiet", `resummarize:${threadId}`),
        view.draft ? null : this.#button(t.editTitle, () => this.#edit(titleKey), "mlp-btn-sm mlp-quiet", `open:${titleKey}`),
        view.draft ? null : this.#button(t.editTags, () => this.#edit(tagsKey), "mlp-btn-sm mlp-quiet", `open:${tagsKey}`)
      ),
      this.#pinnedNote(view),
      !view.draft && view.tags.length && this.#editing !== tagsKey ? h("div", { class: "mlp-detail-tags" }, this.#tags(view.tags)) : null,
      prompt ? h("div", { class: "mlp-oneline mlp-muted", text: t.lastPrompt(prompt.text), title: prompt.text }) : null
    );
    if (this.#editing === titleKey)
      parts.push(
        h(
          "div",
          { class: "mlp-detail-title" },
          view.draft ? this.#editor(
            titleKey,
            view.title,
            t.titlePlaceholder,
            t.createMainline,
            (text, focus) => void this.#mutate({ op: "create", threadId, title: text, ...view.tags.length ? { tags: view.tags } : {} }, focus),
            { commitUnchanged: true, commitOnBlur: false }
          ) : this.#editor(titleKey, view.title, t.titlePlaceholder, t.editTitle, (text, focus) => void this.#mutate({ op: "title", threadId, title: text }, focus))
        )
      );
    if (this.#editing === tagsKey)
      parts.push(
        h(
          "div",
          { class: "mlp-detail-tags" },
          this.#editor(tagsKey, view.tags.join(", "), t.tagsPlaceholder, t.editTags, (text, focus) => void this.#mutate({ op: "tags", threadId, tags: cleanTags(text) }, focus), {
            allowEmpty: true
          })
        )
      );
    if (view.draft) {
      parts.push(
        // A draft's tags come from the backend's view, so the row cannot show them.
        view.tags.length ? h("div", { class: "mlp-detail-tags" }, this.#tags(view.tags)) : null,
        h("p", { class: "mlp-intro", text: t.draftIntro }),
        view.firstPrompt ? h("div", { class: "mlp-asked", text: t.firstPrompt(view.firstPrompt) }) : null,
        ...this.#clues(view.refs),
        // The same key as "Edit title": once the mainline exists, the focus lands there.
        this.#editing === titleKey ? null : h("div", { class: "mlp-detail-foot" }, this.#button(t.createMainline, () => this.#edit(titleKey), "mlp-primary", `open:${titleKey}`))
      );
      return h("div", { class: "mlp-detail", attrs: { id } }, ...parts);
    }
    parts.push(h("h3", { text: t.milestones }));
    if (view.milestones.length)
      parts.push(h("ol", { class: "mlp-milestones" }, ...view.milestones.map((milestone, index) => this.#milestone(view, milestone, now, beside(view.milestones, index)))));
    else parts.push(h("p", { class: "mlp-meta", text: t.noMilestones }));
    if (!view.current && view.now) parts.push(this.#doingRow(view));
    if (!view.milestones.length) parts.push(this.#adder(`taskAdd:${threadId}:`, t.addTask, (text) => this.#mutate({ op: "taskAdd", threadId, text })));
    parts.push(this.#adder(`msAdd:${threadId}`, t.addMilestone, (text) => this.#mutate({ op: "milestoneAdd", threadId, title: text })));
    const open = view.spinoffs.filter((spinoff) => spinoff.state === "open");
    const spinoffs = [...open, ...view.spinoffs.filter((spinoff) => spinoff.state !== "open")];
    parts.push(h("h3", { text: open.length ? `${t.spinoffs} \xB7 ${t.spinoffsOpen(open.length)}` : t.spinoffs }));
    if (spinoffs.length)
      parts.push(
        h("div", { class: "mlp-spins" }, ...spinoffs.map((spinoff) => this.#spinoff(view, spinoff, data, now, beside(open, open.indexOf(spinoff)).map(({ id: other }) => `confirm:spawn:${threadId}:${other}`))))
      );
    parts.push(this.#adder(`spinAdd:${threadId}`, t.addSpinoff, (text) => this.#mutate({ op: "spinoffAdd", threadId, text })));
    parts.push(...this.#clues(view.refs));
    parts.push(
      h(
        "div",
        { class: "mlp-detail-foot" },
        h("span", { class: "mlp-label", text: t.statusLabel }),
        h(
          "div",
          { class: "mlp-segmented", attrs: { role: "group", "aria-label": t.statusLabel } },
          ...STATUSES.map(
            (status) => h("button", {
              class: "mlp-seg",
              text: t.status[status],
              attrs: { type: "button", "aria-pressed": String(view.status === status), "data-status": status, "data-key": `status:${threadId}:${status}` },
              on: {
                click: () => {
                  if (view.status !== status) void this.#mutate({ op: "status", threadId, status }, [`status:${threadId}:${status}`, ...leaving()]);
                }
              }
            })
          )
        ),
        h("span", { class: "mlp-spacer" }),
        this.#confirm(`delete:${threadId}`, t.deleteMainline, () => void this.#mutate({ op: "delete", threadId }, [`confirm:delete:${threadId}`, ...leaving()]), { className: "mlp-danger" })
      )
    );
    return h("div", { class: "mlp-detail", attrs: { id } }, ...parts);
  }
  /** Keys of the lines next to a conversation's in the list, nearest first, as drawn now. */
  #besideRow(threadId) {
    const rows = [...this.#body.querySelectorAll(".mlp-row-toggle")].map((row) => row.dataset.key ?? "");
    const at = rows.indexOf(`row:${threadId}`);
    return at < 0 ? [] : [rows[at + 1], rows[at - 1]].filter((key) => Boolean(key));
  }
  /** `neighbours`: the milestones beside this one, nearest first, for the focus once it is deleted. */
  #milestone(view, milestone, now, neighbours) {
    const h = this.#h;
    const t = this.#t;
    const threadId = view.threadId;
    const milestoneId = milestone.id;
    const key = `${threadId}:${milestoneId}`;
    const renameKey = `msRename:${key}`;
    const addKey = `taskAdd:${key}`;
    const current = milestone.state === "current";
    const removeKey = `confirm:msRemove:${key}`;
    const remove = () => void this.#mutate({ op: "milestoneRemove", threadId, milestoneId }, [
      removeKey,
      ...neighbours.map((other) => `open:msRename:${threadId}:${other.id}`),
      `msAdd:${threadId}`
    ]);
    const head = this.#editing === renameKey ? [this.#editor(renameKey, milestone.title, t.rename, t.rename, (text, focus) => void this.#mutate({ op: "milestoneRename", threadId, milestoneId, title: text }, focus))] : [
      // One block of text that wraps as a whole, so the actions keep to the first line.
      h(
        "div",
        { class: "mlp-ms-text" },
        h("span", { class: "mlp-ms-title", text: milestone.title }),
        h("span", { class: "mlp-badge", attrs: { "data-ms-state": milestone.state }, text: t.milestoneState[milestone.state] }),
        milestone.doneAt ? h("span", { class: "mlp-meta", text: t.time(milestone.doneAt, now) }) : null
      ),
      h(
        "div",
        { class: "mlp-row-actions" },
        // Only the current milestone has "Mark reached"; once reached, the next current one has it.
        current ? this.#button(t.reach, () => void this.#mutate({ op: "milestoneReach", threadId, milestoneId }, [`reach:${threadId}`, `focus:${key}`, `msAdd:${threadId}`]), "mlp-btn-sm", `reach:${threadId}`) : this.#button(t.focus, () => void this.#mutate({ op: "milestoneFocus", threadId, milestoneId }, [`focus:${key}`, `reach:${threadId}`]), "mlp-btn-sm", `focus:${key}`),
        milestone.state === "planned" ? this.#iconButton("plus", t.addTaskTo, () => this.#edit(addKey), `open:${addKey}`) : null,
        this.#iconButton("pencil", t.rename, () => this.#edit(renameKey), `open:${renameKey}`),
        // Deleting cannot be undone, so it asks once more: its done tasks go with it, unfinished ones move to the current milestone.
        this.#confirm(`msRemove:${key}`, t.removeMilestone, remove, { icon: "close" })
      )
    ];
    return h(
      "li",
      { class: "mlp-ms", attrs: { "data-state": milestone.state, "data-milestone-id": milestoneId } },
      h("div", { class: "mlp-ms-head" }, h("span", { class: "mlp-ms-mark", text: MARK[milestone.state], attrs: { "aria-hidden": "true" } }), ...head),
      milestone.tasks.length ? h(
        "ul",
        { class: "mlp-tasks" },
        ...milestone.tasks.map(
          (task, index) => this.#task(view, task, [...beside(milestone.tasks, index).map((other) => `confirm:taskRemove:${threadId}:${other.id}`), addKey, `open:${renameKey}`])
        )
      ) : null,
      current && view.now ? this.#doingRow(view) : null,
      current ? this.#adder(addKey, t.addTask, (text) => this.#mutate({ op: "taskAdd", threadId, text, milestoneId })) : null,
      !current && this.#editing === addKey ? h("div", { class: "mlp-ms-add" }, this.#editor(addKey, "", t.addTask, t.addTaskTo, (text, focus) => void this.#mutate({ op: "taskAdd", threadId, text, milestoneId }, focus))) : null
    );
  }
  /** `after`: where the focus goes once the task is deleted. */
  #task(view, task, after) {
    const h = this.#h;
    const t = this.#t;
    const threadId = view.threadId;
    const child = task.threadId;
    const removeKey = `confirm:taskRemove:${threadId}:${task.id}`;
    return h(
      "li",
      { class: "mlp-task", attrs: { "data-task-id": task.id, "data-done": task.done ? "" : void 0 } },
      h("span", { class: "mlp-task-mark", text: task.done ? "\u2713" : "\u25CB", attrs: { "aria-hidden": "true" } }),
      h(
        "div",
        { class: "mlp-main" },
        h("span", { class: "mlp-task-text", text: task.text }),
        child ? this.#threadLink(t.carriedBy(task.threadTitle ?? shortId2(child)), child, "mlp-carried", `carried:${threadId}:${task.id}`) : null
      ),
      h(
        "div",
        { class: "mlp-row-actions" },
        task.done ? null : this.#iconButton("check", t.taskDone, () => void this.#mutate({ op: "taskDone", threadId, taskId: task.id }, [`taskDone:${threadId}:${task.id}`, removeKey]), `taskDone:${threadId}:${task.id}`),
        // Deleting cannot be undone: a second click within three seconds.
        this.#confirm(`taskRemove:${threadId}:${task.id}`, t.removeTask, () => void this.#mutate({ op: "taskRemove", threadId, taskId: task.id }, [removeKey, ...after]), { icon: "close" })
      )
    );
  }
  #doingRow(view) {
    const h = this.#h;
    const t = this.#t;
    const threadId = view.threadId;
    const key = `doing:${threadId}`;
    const text = view.now?.text ?? "";
    const gone = [`taskAdd:${threadId}:${view.current?.id ?? ""}`, `msAdd:${threadId}`];
    if (this.#editing === key)
      return h(
        "div",
        { class: "mlp-doing-row" },
        this.#editor(key, text, t.doingPlaceholder, t.editDoing, (next, focus) => void this.#mutate({ op: "doing", threadId, text: next || null }, [...focus, ...gone]), {
          allowEmpty: true
        })
      );
    return h(
      "div",
      { class: "mlp-doing-row" },
      h("span", { class: "mlp-doing", text: t.doing(text) }),
      h(
        "div",
        { class: "mlp-row-actions" },
        this.#iconButton("pencil", t.editDoing, () => this.#edit(key), `open:${key}`),
        this.#iconButton("close", t.clearDoing, () => void this.#mutate({ op: "doing", threadId, text: null }, [`doingClear:${threadId}`, ...gone]), `doingClear:${threadId}`)
      )
    );
  }
  /** `after`: where the focus goes once this spin-off is no longer open (the next open one's button). */
  #spinoff(view, spinoff, data, now, after) {
    const h = this.#h;
    const t = this.#t;
    const threadId = view.threadId;
    const key = `${threadId}:${spinoff.id}`;
    const child = spinoff.childThreadId;
    const next = [...after, `spinAdd:${threadId}`];
    let actions = null;
    if (spinoff.state === "spawned")
      actions = child ? this.#threadLink(t.spawned(titleOf(child, this.#sources(data))), child, "", `spawned:${key}`) : h("span", { class: "mlp-meta", text: t.spawned("\u2026") });
    else if (spinoff.state === "open")
      actions = h(
        "div",
        { class: "mlp-spin-actions" },
        this.#spawning.has(key) ? h("button", { class: "mlp-btn mlp-btn-sm", text: t.spawning, attrs: { type: "button", disabled: "" } }) : this.#confirm(`spawn:${key}`, t.spawn, () => void this.#spawn(threadId, spinoff, [`confirm:spawn:${key}`, ...next]), { className: "mlp-btn-sm mlp-primary" }),
        this.#button(t.keep, () => void this.#mutate({ op: "spinoffKeep", threadId, spinoffId: spinoff.id }, [`keep:${key}`, ...next]), "mlp-btn-sm", `keep:${key}`),
        // A dismissed spin-off cannot be brought back: a second click within three seconds.
        this.#confirm(`dismiss:${key}`, t.dismiss, () => void this.#mutate({ op: "spinoffDismiss", threadId, spinoffId: spinoff.id }, [`confirm:dismiss:${key}`, ...next]), { className: "mlp-btn-sm" })
      );
    return h(
      "div",
      { class: "mlp-spin", attrs: { "data-spinoff-id": spinoff.id, "data-state": spinoff.state } },
      h("span", { class: "mlp-spin-mark", text: "\u21B3", attrs: { "aria-hidden": "true" } }),
      h("div", { class: "mlp-main" }, h("div", { text: spinoff.text }), h("div", { class: "mlp-meta", text: t.time(spinoff.at, now) })),
      actions
    );
  }
  #clues(refs) {
    if (!refs.length) return [];
    const h = this.#h;
    const t = this.#t;
    return [
      h("h3", { text: t.refs }),
      h(
        "div",
        { class: "mlp-clues" },
        ...refs.map(
          (ref) => h(
            "div",
            { class: "mlp-clue" },
            h("a", { class: "mlp-ref-link", text: `${t.kind[ref.kind]} #${ref.number}${ref.title ? ` ${ref.title}` : ""}`, attrs: { href: safeUrl(ref.url), target: "_blank", rel: "noopener noreferrer" } }),
            ref.state ? h("span", { class: "mlp-badge", attrs: { "data-ref-state": ref.state }, text: t.refState[ref.state] }) : null,
            h("span", { class: "mlp-meta", text: ref.repo })
          )
        )
      )
    ];
  }
  // Small parts -------------------------------------------------------------------------------
  #tags(tags) {
    const h = this.#h;
    return h("div", { class: "mlp-tags" }, ...tags.map((tag) => h("span", { class: "mlp-tag", text: tag })));
  }
  #statusDot(status) {
    const label = this.#t.threadStatus[status];
    return this.#h("span", { class: "mlp-status", title: label, attrs: { "data-status": status, role: "img", "aria-label": label } });
  }
  #statusBadge(status) {
    return this.#h("span", { class: "mlp-badge", attrs: { "data-conv-status": status }, text: this.#t.status[status] });
  }
  /** `key` (here and below): the control's `data-key`, by which the focus finds it again after a redraw. */
  #threadLink(text, threadId, className = "", key) {
    return this.#h("button", { class: `mlp-link ${className}`.trim(), text, attrs: { type: "button", "data-key": key }, on: { click: () => this.#openThread(threadId) } });
  }
  #button(label, onClick, className = "", key) {
    return this.#h("button", { class: `mlp-btn ${className}`.trim(), text: label, attrs: { type: "button", "data-key": key }, on: { click: onClick } });
  }
  #iconButton(name, label, onClick, key) {
    const button = this.#h("button", { class: "mlp-icon", title: label, attrs: { type: "button", "aria-label": label, "data-key": key }, on: { click: onClick } });
    button.append(icon(this.#doc, name));
    return button;
  }
  /**
   * A button that acts on the second click within three seconds. The armed state lives outside
   * the button, so a redraw in between keeps it (and the focus, by its key); screen readers hear
   * that it waits.
   */
  #confirm(key, label, onConfirm, options = {}) {
    const button = this.#h("button", { title: label, attrs: { type: "button", "data-confirm-key": key, "data-key": `confirm:${key}` } });
    const idle = () => {
      button.removeAttribute("data-confirm");
      if (options.icon) {
        button.className = "mlp-icon";
        button.setAttribute("aria-label", label);
        button.replaceChildren(icon(this.#doc, options.icon));
      } else {
        button.className = `mlp-btn ${options.className ?? ""}`.trim();
        button.textContent = label;
      }
    };
    const armed = () => {
      button.setAttribute("data-confirm", "");
      button.className = `mlp-btn ${options.icon ? "mlp-btn-sm" : options.className ?? ""}`.trim();
      button.removeAttribute("aria-label");
      button.textContent = this.#t.confirm;
    };
    if (this.#confirming.has(key)) armed();
    else idle();
    this.#resetters.set(button, idle);
    button.addEventListener("click", () => {
      const timer = this.#confirming.get(key);
      const waiting = this.#t.armed(label);
      if (timer !== void 0) {
        clearTimeout(timer);
        this.#confirming.delete(key);
        if (this.#live.textContent === waiting) this.#live.textContent = "";
        idle();
        onConfirm();
        return;
      }
      this.#confirming.set(
        key,
        setTimeout(() => {
          this.#confirming.delete(key);
          if (this.#live.textContent === waiting) this.#live.textContent = "";
          for (const other of this.#container.querySelectorAll("[data-confirm-key]"))
            if (other.getAttribute("data-confirm-key") === key) this.#resetters.get(other)?.();
        }, CONFIRM_MS)
      );
      armed();
      this.#live.textContent = waiting;
    });
    return button;
  }
  /**
   * A field that edits one value in place: Enter saves, Escape cancels. Closed from the keyboard,
   * it hands the focus back to the button that opened it (`open:<key>`); `onCommit` gets that
   * target to pass on to the edit. Left by Tab or a click, the focus goes where the user sent it.
   */
  #editor(key, value, placeholder, label, onCommit, options = {}) {
    const input = this.#h("input", { class: "mlp-input mlp-editor", attrs: { type: "text", placeholder, "aria-label": label, "data-autofocus": "", "data-key": key } });
    const draftKey = `edit:${key}`;
    input.value = this.#drafts.get(draftKey) ?? value;
    input.addEventListener("input", () => this.#drafts.set(draftKey, input.value));
    let settled = false;
    const finish = (commit, byKeyboard) => {
      if (settled) return;
      settled = true;
      this.#drafts.delete(draftKey);
      if (this.#editing === key) this.#editing = null;
      const text = input.value.trim();
      const focus = byKeyboard ? [`open:${key}`] : [];
      if (commit && (text || options.allowEmpty) && (options.commitUnchanged || text !== value.trim())) onCommit(text, focus);
      else {
        this.#focusKeys = focus;
        this.#render(true);
      }
    };
    input.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      if (event.key === "Enter") {
        event.preventDefault();
        finish(true, true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(false, true);
      }
    });
    input.addEventListener("blur", () => {
      if (input.isConnected) finish(options.commitOnBlur !== false, false);
    });
    return input;
  }
  /** An always-visible field that adds an item on Enter and keeps its text across redraws. */
  #adder(key, placeholder, onCommit) {
    const input = this.#h("input", { class: "mlp-input mlp-adder", attrs: { type: "text", placeholder, "aria-label": placeholder.replace(/…$/u, ""), "data-key": key } });
    input.value = this.#drafts.get(key) ?? "";
    input.addEventListener("input", () => {
      if (input.value) this.#drafts.set(key, input.value);
      else this.#drafts.delete(key);
    });
    input.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      if (event.key === "Enter") {
        event.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        input.value = "";
        this.#drafts.delete(key);
        this.#focusKeys = [key];
        void onCommit(text).then((ok) => {
          if (ok || this.#drafts.has(key)) return;
          this.#drafts.set(key, text);
          this.#focusKeys = [key];
          this.#render(true);
        });
      } else if (event.key === "Escape" && input.value) {
        event.preventDefault();
        input.value = "";
        this.#drafts.delete(key);
      }
    });
    return input;
  }
  // Favorites -----------------------------------------------------------------------------------
  #favoritesSection() {
    const h = this.#h;
    const t = this.#t;
    const list = h("div", { class: "mlp-favorites" });
    this.#favoritesList = list;
    const search = h("input", {
      class: "mlp-input mlp-refs-search",
      attrs: { type: "search", placeholder: t.favoritesPlaceholder, "aria-label": t.favoritesPlaceholder, "data-key": "favorites-search" }
    });
    search.value = this.#favoriteQuery;
    search.addEventListener("input", () => {
      this.#favoriteQuery = search.value;
      this.#fillFavorites();
      void this.#loadFavorites();
    });
    const section = h(
      "section",
      { class: "mlp-section mlp-favorites-section" },
      h("h2", { text: t.favoritesSection }),
      h("p", { class: "mlp-intro", text: t.favoritesIntro }),
      search,
      list
    );
    this.#fillFavorites();
    return section;
  }
  /** The title of the conversation a passage came from: as it is now, else as it was when saved. */
  #favoriteTitle(item) {
    return this.#favorites?.titles[item.threadId] ?? item.threadTitle ?? shortId2(item.threadId);
  }
  /** Redraws only the list, so typing in the search box keeps its focus. */
  #fillFavorites() {
    const list = this.#favoritesList;
    if (!list) return;
    const h = this.#h;
    const t = this.#t;
    if (!this.#favorites) {
      list.replaceChildren(h("p", { class: "mlp-muted", text: t.loading }));
      return;
    }
    const all = this.#favorites.items;
    const words = this.#favoriteQuery.trim().toLowerCase().split(/\s+/u).filter(Boolean);
    const narrowing = words.length > 0 && this.#favoritesFor !== this.#favoriteQuery.trim();
    const shown = narrowing ? all.filter((item) => {
      const haystack = [item.text, item.note ?? "", this.#favoriteTitle(item)].join("\n").toLowerCase();
      return words.every((word) => haystack.includes(word));
    }) : all;
    const left = (this.#favorites.matched ?? all.length) - all.length;
    list.replaceChildren(
      ...shown.length ? shown.map((item) => this.#favoriteItem(item)) : [h("p", { class: "mlp-muted", text: all.length || this.#favorites.total ? t.favoritesNone : t.favoritesEmpty })],
      ...!narrowing && this.#favorites.nextOffset !== void 0 && left > 0 ? [this.#more(t.favoritesMore(left), () => void this.#loadFavorites(true), "more:favorites")] : []
    );
  }
  #favoriteItem(item) {
    const h = this.#h;
    const t = this.#t;
    const now = Date.now();
    const body = this.#fullTexts.get(item.id) ?? item.text;
    const cut = item.truncated === true && !this.#fullTexts.has(item.id);
    const long = cut || body.length > PASSAGE_FOLD_CHARS || body.split("\n").length > PASSAGE_FOLD_LINES;
    const open = this.#openPassages.has(item.id);
    const noteKey = `favorite-note:${item.id}`;
    const editingNote = this.#editing === noteKey;
    const where = [item.turn ? t.turn(item.turn) : "", item.role ? t.favoriteRole[item.role] : "", t.time(item.createdAt, now)].filter(Boolean).join(" \xB7 ");
    const title = this.#threadLink(this.#favoriteTitle(item), item.threadId, "mlp-favorite-title", `favorite-title:${item.id}`);
    title.title = t.openConversation;
    return h(
      "article",
      { class: "mlp-favorite", attrs: { "data-favorite": item.id } },
      h(
        "div",
        { class: "mlp-favorite-head" },
        title,
        h("span", { class: "mlp-meta", text: where }),
        h("span", { class: "mlp-spacer" }),
        this.#button(t.jumpToPassage, () => void this.#revealFavorite(item), "mlp-btn-sm mlp-primary", `favorite-jump:${item.id}`)
      ),
      // A reply the agent saved is its Markdown source: shown formatted, as it read in the conversation.
      item.source === "chat" ? h("div", { class: "mlp-favorite-text mlp-md", attrs: { "data-folded": long && !open ? "" : void 0 } }, ...renderMarkdown(h, body)) : h("div", { class: "mlp-favorite-text", attrs: { "data-folded": long && !open ? "" : void 0 } }, body),
      long ? this.#more(open ? t.foldPassage : t.expandPassage, () => {
        if (open) this.#openPassages.delete(item.id);
        else {
          this.#openPassages.add(item.id);
          if (cut)
            void this.#fullText(item).then(
              () => this.#render(true),
              (error) => {
                this.#error = { kind: "action", text: this.#message(error) };
                this.#render(true);
              }
            );
        }
        this.#render(true);
      }, `favorite-fold:${item.id}`) : null,
      editingNote ? this.#editor(noteKey, item.note ?? "", t.notePlaceholder, t.editNote, (note, focus) => void this.#noteFavorite(item, note, focus), { allowEmpty: true }) : item.note ? h("div", { class: "mlp-asked", text: t.favoriteNote(item.note) }) : null,
      h(
        "div",
        { class: "mlp-actions mlp-favorite-actions" },
        this.#button(this.#copied === item.id ? t.copied : t.copy, () => void this.#copyFavorite(item), "mlp-btn-sm", `favorite-copy:${item.id}`),
        editingNote ? null : this.#button(item.note ? t.editNote : t.addNote, () => this.#edit(noteKey), "mlp-btn-sm", `open:${noteKey}`),
        this.#confirm(`favorite-remove:${item.id}`, t.removeFavorite, () => void this.#removeFavorite(item), { className: "mlp-btn-sm mlp-danger" })
      )
    );
  }
  /** Opens the passage's conversation; the conversation finds the passage and highlights it (the backend has its whole text). */
  async #revealFavorite(item) {
    try {
      const result = await this.#api.backend.invoke("favorites.reveal", { id: item.id });
      this.#openThread(typeof result?.threadId === "string" ? result.threadId : item.threadId);
    } catch (error) {
      this.#error = { kind: "action", text: this.#message(error) };
      this.#render(true);
    }
  }
  async #noteFavorite(item, note, focus) {
    if (await this.#act(() => this.#api.backend.invoke("favorites.note", { id: item.id, note }), focus)) await this.#loadFavorites();
  }
  async #removeFavorite(item) {
    if (await this.#act(() => this.#api.backend.invoke("favorites.remove", { id: item.id }))) await this.#loadFavorites();
  }
  /** Copies the whole passage, read from the backend first when the list cut it short. */
  async #copyFavorite(item) {
    let text;
    try {
      text = await this.#fullText(item);
    } catch (error) {
      this.#error = { kind: "action", text: this.#message(error) };
      this.#render(true);
      return;
    }
    let copied = false;
    try {
      await this.#doc.defaultView?.navigator.clipboard.writeText(text);
      copied = Boolean(this.#doc.defaultView?.navigator.clipboard);
    } catch {
      copied = false;
    }
    if (!copied) copied = this.#copyByHand(text);
    if (!copied) {
      this.#error = { kind: "action", text: this.#t.copyFailed };
      this.#render(true);
      return;
    }
    this.#copied = item.id;
    this.#render(true);
    clearTimeout(this.#copiedTimer);
    this.#copiedTimer = setTimeout(() => {
      this.#copied = null;
      this.#render();
    }, COPIED_MS);
  }
  /** Copies through a hidden field, for pages where the clipboard API is not allowed. */
  #copyByHand(text) {
    const area = this.#h("textarea", { attrs: { readonly: "", "aria-hidden": "true" } });
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    area.style.pointerEvents = "none";
    this.#container.append(area);
    area.select();
    let copied = false;
    try {
      copied = this.#doc.execCommand("copy");
    } catch {
      copied = false;
    }
    area.remove();
    return copied;
  }
  // PRs and issues ------------------------------------------------------------------------------
  #refsSection() {
    const h = this.#h;
    const t = this.#t;
    const refs = this.#refs;
    const now = Date.now();
    const list = h("div", { class: "mlp-refs" });
    this.#refsList = list;
    const search = h("input", { class: "mlp-input mlp-refs-search", attrs: { type: "search", placeholder: t.refsPlaceholder, "aria-label": t.findRefs, "data-key": "refs-search" } });
    search.value = this.#refQuery;
    search.addEventListener("input", () => {
      this.#refQuery = search.value;
      this.#fillRefs();
    });
    const status = refs ? [
      h("div", {
        class: "mlp-meta",
        text: t.scanStatus(refs.status.conversations.scanned, refs.status.conversations.listed, refs.status.conversations.done, refs.status.refs, refs.status.conversations.unreadable)
      }),
      h("div", {
        class: refs.status.github.error ? "mlp-meta mlp-warn" : "mlp-meta",
        text: t.githubStatus(refs.status.github.enabled, refs.status.github.lastPollAt, refs.status.github.error, now, refs.status.refs)
      })
    ] : [h("div", { class: "mlp-meta", text: t.loading })];
    const section = h("section", { class: "mlp-section mlp-refs-section" }, h("h2", { text: t.refsSection }), h("p", { class: "mlp-intro", text: t.refsIntro }), ...status, search, list);
    this.#fillRefs();
    return section;
  }
  /** Redraws only the list, so typing in the search box keeps its focus. */
  #fillRefs() {
    const list = this.#refsList;
    if (!list) return;
    const t = this.#t;
    const all = this.#refs?.refs ?? [];
    const query = this.#refQuery.trim().toLowerCase();
    const digits = /^[^\d]*#?(\d+)$/u.exec(query)?.[1];
    const shown = !query ? all : all.filter(
      (ref) => digits ? String(ref.number) === digits : [ref.key, ref.title, ref.note, ref.origin?.title, ref.origin?.prompt].filter(Boolean).join(" ").toLowerCase().includes(query)
    );
    list.replaceChildren(
      ...shown.length ? shown.slice(0, 200).map((ref) => this.#refItem(ref)) : [this.#h("p", { class: "mlp-muted", text: all.length ? t.noResults : t.refsEmpty })]
    );
  }
  #refItem(ref) {
    const h = this.#h;
    const t = this.#t;
    const now = Date.now();
    const origin = ref.origin;
    const unseen = ref.activity?.unseen === true;
    const jump = origin ? this.#button(
      t.jump,
      () => {
        if (unseen) void this.#api.backend.invoke("refs.seen", { key: ref.key }).then(() => this.#loadRefs());
        this.#openThread(origin.threadId);
      },
      "",
      `ref-jump:${ref.key}`
    ) : null;
    return h(
      "article",
      { class: "mlp-ref", attrs: { "data-unseen": unseen ? "" : void 0 } },
      h(
        "div",
        { class: "mlp-ref-head" },
        h("a", { class: "mlp-ref-link", text: `#${ref.number}${ref.title ? ` ${ref.title}` : ""}`, attrs: { href: safeUrl(ref.url), target: "_blank", rel: "noopener noreferrer" } }),
        h("span", { class: "mlp-badge", attrs: { "data-ref-state": ref.state }, text: `${t.kind[ref.kind]}${ref.state ? ` \xB7 ${t.refState[ref.state]}` : ""}` }),
        h("span", { class: "mlp-meta", text: ref.repo }),
        h("span", { class: "mlp-spacer" }),
        jump
      ),
      h(
        "div",
        { class: "mlp-ref-meta" },
        unseen && ref.activity ? h("span", { class: "mlp-news", text: `${t.reason(ref.activity.reason)} \xB7 ${t.time(ref.activity.at, now)}` }) : null,
        origin ? h("span", { class: "mlp-meta", text: `${t.fromWindow(origin.title ?? origin.threadId.slice(0, 8))}${origin.turn ? ` ${t.turn(origin.turn)}` : ""}` }) : null,
        ref.windows > 1 ? h("span", { class: "mlp-meta", text: t.inWindows(ref.windows) }) : null
      ),
      origin?.prompt ? h("div", { class: "mlp-asked", text: t.asked(origin.prompt) }) : null,
      ref.note ? h("div", { class: "mlp-asked", text: t.noteLabel(ref.note) }) : null
    );
  }
  // Agent integration ---------------------------------------------------------------------------
  #integrationSection() {
    const h = this.#h;
    const t = this.#t;
    const rows = this.#integrations.map((status) => {
      const agent = status.agent;
      const busy = status.state === "unavailable";
      return h(
        "div",
        { class: "mlp-integration" },
        h(
          "div",
          { class: "mlp-main" },
          h("strong", { text: t.agentName[agent] }),
          h("div", { class: "mlp-meta", text: status.problem ? t.integrationProblem(agent, status.problem, status.cause) : status.detail ?? status.file })
        ),
        h("span", { class: "mlp-badge", attrs: { "data-state": status.state }, text: t.integrationState[status.state] }),
        busy ? null : this.#button(t.preview, () => void this.#showPreview(agent, false, `integration:${agent}:preview`), "", `integration:${agent}:preview`),
        busy || status.state === "installed" ? null : this.#button(status.state === "outdated" ? t.update : t.install, () => void this.#showPreview(agent, false, `integration:${agent}:install`), "mlp-primary", `integration:${agent}:install`),
        busy || status.state === "missing" ? null : this.#button(t.uninstall, () => void this.#showPreview(agent, true, `integration:${agent}:uninstall`), "", `integration:${agent}:uninstall`)
      );
    });
    const preview = this.#preview;
    return h(
      "section",
      { class: "mlp-section mlp-integrations" },
      h("h2", { text: t.integrations }),
      h("p", { class: "mlp-intro", text: t.integrationsIntro }),
      ...rows,
      preview ? h(
        "div",
        { class: "mlp-preview" },
        h("div", { class: "mlp-preview-title", text: t.previewTitle(t.previewAction[preview.action], preview.file) }),
        preview.problem ? h("p", { class: "mlp-meta", text: t.integrationProblem(preview.agent, preview.problem, preview.cause) }) : h("pre", { class: "mlp-pre", text: preview.snippet }),
        h(
          "div",
          { class: "mlp-actions" },
          preview.action === "none" ? null : this.#button(t.applyChange, () => void this.#applyIntegration(preview.agent, preview.removing), "mlp-primary", "integration:apply"),
          this.#button(
            t.cancel,
            () => {
              this.#focusKeys = this.#previewFocus(preview.agent);
              this.#preview = null;
              this.#render(true);
            },
            "",
            "integration:cancel"
          )
        )
      ) : null,
      this.#data?.command ? h("p", { class: "mlp-meta", text: t.command(this.#data.command) }) : null
    );
  }
  // Settings ------------------------------------------------------------------------------------
  /** After the data of the extension's earlier name was copied over: its old folder is still there, and may go. */
  #migrationNote() {
    const folder = this.#data?.oldFolder;
    return folder ? this.#h("p", { class: "mlp-intro mlp-migrated", attrs: { role: "note" }, text: this.#t.migratedNote(folder) }) : null;
  }
  #settingsSection() {
    const h = this.#h;
    const t = this.#t;
    const name = `mlp-drift-${this.#api.id}`;
    const radios = ["ask", "note", "off"].map((policy) => {
      const input = h("input", { attrs: { type: "radio", name, value: policy, "data-key": `setting:driftPolicy:${policy}` } });
      input.checked = this.#settings.driftPolicy === policy;
      input.addEventListener("change", () => {
        if (input.checked) void this.#saveSettings({ driftPolicy: policy });
      });
      return h("label", { class: "mlp-choice" }, input, h("span", { text: t.driftPolicies[policy] }));
    });
    const capsule = h("input", { attrs: { type: "checkbox", name: "showCapsule", "data-key": "setting:showCapsule" } });
    capsule.checked = this.#settings.showCapsule;
    capsule.addEventListener("change", () => void this.#saveSettings({ showCapsule: capsule.checked }));
    const alerts = h("input", { attrs: { type: "checkbox", name: "prAlerts", "data-key": "setting:prAlerts" } });
    alerts.checked = this.#settings.prAlerts;
    alerts.addEventListener("change", () => void this.#saveSettings({ prAlerts: alerts.checked }));
    const auto = h("input", { attrs: { type: "checkbox", name: "autoSummarize", "data-key": "setting:autoSummarize" } });
    auto.checked = this.#settings.autoSummarize;
    auto.addEventListener("change", () => void this.#saveSettings({ autoSummarize: auto.checked }));
    const model = h("select", { class: "mlp-select", attrs: { name: "summarizeModel", "aria-label": t.summarizeModel, "data-key": "setting:summarizeModel" } });
    for (const value of ["follow", "claude", "codex"]) {
      const option = h("option", { text: t.summarizeModels[value], attrs: { value } });
      option.selected = this.#settings.summarizeModel === value;
      model.append(option);
    }
    model.addEventListener("change", () => {
      const value = model.value;
      if (value === "follow" || value === "claude" || value === "codex") void this.#saveSettings({ summarizeModel: value });
    });
    const others = h("select", { class: "mlp-select", attrs: { name: "summarizeOthers", "aria-label": t.summarizeOthers, "data-key": "setting:summarizeOthers" } });
    for (const value of ["none", "claude", "codex"]) {
      const option = h("option", { text: t.summarizeOthersOptions[value], attrs: { value } });
      option.selected = this.#settings.summarizeOthers === value;
      others.append(option);
    }
    others.addEventListener("change", () => {
      const value = others.value;
      if (value === "none" || value === "claude" || value === "codex") void this.#saveSettings({ summarizeOthers: value });
    });
    return h(
      "section",
      { class: "mlp-section mlp-settings" },
      h("h2", { text: t.settings }),
      h("fieldset", { class: "mlp-field mlp-fieldset" }, h("legend", { class: "mlp-label", text: t.driftPolicy }), h("div", { class: "mlp-choices" }, ...radios)),
      h("div", { class: "mlp-field" }, h("label", { class: "mlp-choice" }, capsule, h("span", { text: t.showCapsule }))),
      h("div", { class: "mlp-field" }, h("label", { class: "mlp-choice" }, alerts, h("span", { text: t.prAlerts }))),
      h("div", { class: "mlp-field" }, h("label", { class: "mlp-choice" }, auto, h("span", { text: t.autoSummarize }))),
      h("div", { class: "mlp-field" }, h("div", { class: "mlp-label", text: t.summarizeModel }), model),
      h("div", { class: "mlp-field" }, h("div", { class: "mlp-label", text: t.summarizeOthers }), others, h("div", { class: "mlp-meta", text: t.summarizeOthersHint })),
      this.#data ? this.#summarizerLine(this.#data) : null
    );
  }
  // Files sent along with child conversations -------------------------------------------------
  /** How much they take, and clearing them with two clicks; a button that would free nothing is left out. */
  #attachmentsSection() {
    const h = this.#h;
    const t = this.#t;
    const usage = this.#attachments;
    const parts = [h("h2", { text: t.attachmentsSection })];
    if (!usage) parts.push(h("p", { class: "mlp-muted", text: t.loading }));
    else if (!usage.all.files) parts.push(h("p", { class: "mlp-muted", text: t.attachmentsNone }));
    else
      parts.push(
        h("p", { class: "mlp-intro", text: t.attachmentsIntro }),
        h("div", { class: "mlp-attachments-usage", text: t.attachmentsUsage(usage.all.files, formatSize(usage.all.bytes)) }),
        h(
          "div",
          { class: "mlp-actions" },
          ...this.#clearingAttachments ? [h("span", { class: "mlp-meta", text: t.clearingAttachments })] : [
            usage.done.files ? this.#confirm("attachments:done", t.clearDoneAttachments(formatSize(usage.done.bytes)), () => void this.#clearAttachments("done"), { className: "mlp-btn-sm" }) : null,
            this.#confirm("attachments:all", t.clearAllAttachments(formatSize(usage.all.bytes)), () => void this.#clearAttachments("all"), { className: "mlp-btn-sm mlp-danger" })
          ]
        )
      );
    return h("section", { class: "mlp-section mlp-attachments" }, ...parts);
  }
  /** Counts them when the settings tab opens: reading every folder is too much for each snapshot. */
  async #loadAttachments() {
    if (this.#stopped) return;
    try {
      const usage = readUsage(await this.#api.backend.invoke("attachments.usage"));
      if (this.#stopped || !usage) return;
      this.#attachments = usage;
    } catch (error) {
      if (this.#stopped) return;
      this.#error = { kind: "action", text: this.#message(error) };
    }
    this.#render();
  }
  async #clearAttachments(scope) {
    if (this.#clearingAttachments) return;
    this.#clearingAttachments = true;
    this.#render(true);
    const focus = [`confirm:attachments:${scope}`, "confirm:attachments:all", "tab:settings"];
    try {
      const result = await this.#api.backend.invoke("attachments.clear", { scope });
      const cleared = isRecord3(result) ? readFilesSize(result.cleared) : void 0;
      const usage = isRecord3(result) ? readUsage(result.usage) : void 0;
      if (usage) this.#attachments = usage;
      if (cleared && !this.#stopped) this.#showNotice(this.#t.attachmentsCleared(cleared.files, formatSize(cleared.bytes)));
    } catch (error) {
      if (!this.#stopped) {
        this.#error = { kind: "action", text: this.#message(error) };
        void this.#loadAttachments();
      }
    } finally {
      this.#clearingAttachments = false;
    }
    this.#focusKeys = focus;
    this.#render(true);
  }
  // Model summaries ---------------------------------------------------------------------------
  /**
   * What the model is doing, with a button that stops the backfill. In full (the settings): also
   * today's counts, and the button that starts the backfill after a second click, saying how many
   * conversations it sends at most.
   */
  #summarizerLine(data, full = true) {
    const h = this.#h;
    const t = this.#t;
    const status = data.summarizer;
    if (!status) return null;
    const parts = [];
    if (status.backfill)
      parts.push(
        h("span", { text: t.backfillProgress(status.backfill.done, status.backfill.total, status.backfill.failed, status.backfill.skipped, status.backfill.full ?? 0) }),
        this.#button(t.backfillStop, () => void this.#stopBackfill(), "mlp-btn-sm mlp-quiet", "backfill:stop")
      );
    else if (status.running || status.queued) parts.push(h("span", { text: t.summarizerBusy(status.running, status.queued) }));
    if (full) {
      const { calls } = status.today;
      parts.push(h("span", { text: t.summarizerToday(status.today.count, status.today.limit, calls.claude.auto, calls.codex.auto) }));
      const manual = calls.claude.manual + calls.codex.manual;
      const backfill = calls.claude.backfill + calls.codex.backfill;
      if (manual || backfill) parts.push(h("span", { text: t.summarizerAsked(manual, backfill) }));
    }
    if (status.lastError) parts.push(h("span", { class: "mlp-error-text", text: t.summarizerError(this.#lastErrorText(status)) }));
    if (full && !status.backfill && status.toBackfill)
      parts.push(
        this.#confirm("backfill:start", t.backfillStart(status.toBackfill), () => void this.#act(() => this.#api.backend.invoke("summarize.backfill"), ["backfill:stop", "confirm:backfill:start", "tab:settings"]), {
          className: "mlp-btn-sm mlp-quiet"
        })
      );
    return parts.length ? h("div", { class: "mlp-summarizer mlp-meta" }, ...parts) : null;
  }
  /** Why the last summary failed, in the page's language where the backend gives a code for it. */
  #lastErrorText(status) {
    const code = status.lastErrorCode;
    const message = status.lastError ?? "";
    if (code !== void 0 && Object.hasOwn(this.#t.summaryProblem, code)) return this.#t.summaryProblem[code];
    return isErrorCode(code) ? this.#t.error(code, message) : message;
  }
  async #stopBackfill() {
    if (await this.#act(() => this.#api.backend.invoke("summarize.cancel"), ["confirm:backfill:start", "backfill:stop", "tab:settings"])) this.#showNotice(this.#t.backfillStopped);
  }
  async #summarize(threadId) {
    if (await this.#act(() => this.#api.backend.invoke("summarize", { threadId }))) this.#showNotice(this.#t.summarizeQueued);
  }
  /** "You changed … by hand", with the way back to automatic summaries. */
  #pinnedNote(view) {
    const pinned = view.pinned;
    if (!pinned) return null;
    const t = this.#t;
    const parts = [
      pinned.title ? t.pinnedParts.title : null,
      pinned.tags ? t.pinnedParts.tags : null,
      pinned.status ? t.pinnedParts.status : null,
      pinned.milestones ? t.pinnedParts.milestones(pinned.milestones) : null
    ].filter((part) => part !== null);
    return this.#h(
      "div",
      { class: "mlp-pinned mlp-meta" },
      this.#h("span", { text: t.pinnedNote(parts) }),
      this.#button(t.unpin, () => void this.#mutate({ op: "unpin", threadId: view.threadId }, [`unpin:${view.threadId}`, `resummarize:${view.threadId}`]), "mlp-btn-sm mlp-quiet", `unpin:${view.threadId}`)
    );
  }
};
function readSummarizer(value) {
  if (typeof value !== "object" || value === null) return {};
  const raw = value;
  if (typeof raw.running !== "number" || typeof raw.queued !== "number") return {};
  const count = (item) => typeof item === "number" && Number.isFinite(item) && item >= 0 ? item : 0;
  const backfill = raw.backfill && typeof raw.backfill.done === "number" && typeof raw.backfill.total === "number" ? raw.backfill : void 0;
  const today = isRecord3(raw.today) ? raw.today : {};
  const calls = isRecord3(today.calls) ? today.calls : {};
  const engineCalls = (engine) => {
    const reasons = isRecord3(calls[engine]) ? calls[engine] : {};
    return { auto: count(reasons.auto), manual: count(reasons.manual), backfill: count(reasons.backfill) };
  };
  return {
    summarizer: {
      running: raw.running,
      queued: raw.queued,
      today: { count: count(today.count), limit: count(today.limit), calls: { claude: engineCalls("claude"), codex: engineCalls("codex") } },
      ...backfill ? { backfill: { done: backfill.done, total: backfill.total, failed: count(backfill.failed), skipped: count(backfill.skipped), ...count(backfill.full) ? { full: count(backfill.full) } : {} } } : {},
      ...typeof raw.toBackfill === "number" && Number.isSafeInteger(raw.toBackfill) && raw.toBackfill >= 0 ? { toBackfill: raw.toBackfill } : {},
      ...typeof raw.lastError === "string" ? { lastError: raw.lastError.slice(0, 200) } : {},
      ...typeof raw.lastErrorCode === "string" ? { lastErrorCode: raw.lastErrorCode } : {}
    }
  };
}
function pickSettings(values) {
  const result = {};
  if (values.driftPolicy === "ask" || values.driftPolicy === "note" || values.driftPolicy === "off") result.driftPolicy = values.driftPolicy;
  if (typeof values.showCapsule === "boolean") result.showCapsule = values.showCapsule;
  if (typeof values.autoSummarize === "boolean") result.autoSummarize = values.autoSummarize;
  if (values.summarizeModel === "follow" || values.summarizeModel === "claude" || values.summarizeModel === "codex") result.summarizeModel = values.summarizeModel;
  if (values.summarizeOthers === "none" || values.summarizeOthers === "claude" || values.summarizeOthers === "codex") result.summarizeOthers = values.summarizeOthers;
  if (typeof values.prAlerts === "boolean") result.prAlerts = values.prAlerts;
  return result;
}
function readInfo(value) {
  const info = {};
  if (!isRecord3(value)) return info;
  for (const [threadId, entry] of Object.entries(value)) {
    if (!isRecord3(entry)) continue;
    const status = typeof entry.status === "string" && THREAD_STATUSES.has(entry.status) ? entry.status : "unknown";
    info[threadId] = {
      status,
      ...typeof entry.title === "string" && entry.title.trim() ? { title: entry.title } : {},
      ...typeof entry.harnessId === "string" ? { harnessId: entry.harnessId } : {}
    };
  }
  return info;
}
function readParents(value) {
  const parents = {};
  if (isRecord3(value)) {
    for (const [child, parent] of Object.entries(value)) if (typeof parent === "string" && parent && parent !== child) parents[child] = parent;
  }
  return parents;
}
function readResults(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item) => isRecord3(item) && typeof item.threadId === "string" && typeof item.title === "string" && Array.isArray(item.tags) && isRecord3(item.progress) && isRecord3(item.match) && typeof item.match.text === "string"
  );
}
function isView(value, threadId) {
  return isRecord3(value) && value.threadId === threadId && Array.isArray(value.refs) && Array.isArray(value.tags) && typeof value.title === "string";
}
function safeUrl(url) {
  return /^https?:\/\//iu.test(url) ? url : "#";
}
function groupsOf(forest) {
  const groups = /* @__PURE__ */ new Map();
  const mark = (nodes, group) => {
    for (const node of nodes) {
      groups.set(node.threadId, group);
      mark(node.children, group);
    }
  };
  mark(forest.active, "active");
  mark(forest.paused, "paused");
  mark(forest.done, "done");
  for (const threadId of forest.others) groups.set(threadId, "others");
  return groups;
}
function isFavoritesList(value) {
  return isRecord3(value) && Array.isArray(value.items) && isRecord3(value.titles) && typeof value.total === "number";
}
function readFilesSize(value) {
  if (!isRecord3(value)) return void 0;
  const { files, bytes } = value;
  return typeof files === "number" && Number.isSafeInteger(files) && files >= 0 && typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0 ? { files, bytes } : void 0;
}
function readUsage(value) {
  if (!isRecord3(value)) return void 0;
  const all = readFilesSize(value.all);
  const done = readFilesSize(value.done);
  const unknown = readFilesSize(value.unknown);
  return all && done && unknown ? { all, done, unknown } : void 0;
}
function readOutline(value) {
  const out = {};
  if (!isRecord3(value)) return out;
  const count = (item) => typeof item === "number" && Number.isSafeInteger(item) && item >= 0 ? item : 0;
  for (const [threadId, progress] of Object.entries(value)) if (Array.isArray(progress)) out[threadId] = [count(progress[0]), count(progress[1])];
  return out;
}
function readWorkspaces(value) {
  if (typeof value !== "object" || value === null) return {};
  const out = {};
  for (const [threadId, name] of Object.entries(value)) if (typeof name === "string" && name) out[threadId] = name.slice(0, 80);
  return out;
}
export {
  mount
};
