/**
 * The hover card's content, built from a ConversationView: title and tags, where it came from,
 * the milestone timeline with the tasks of the current milestone, child conversations and the
 * main PRs or issues. Pure rendering; the caller owns the card element and its placement.
 */
import { formatSize, type AttachmentKind } from "../../core/attachments.js";
import type { ConversationView, MilestoneView, RelatedView, TaskView } from "../../core/conversation-view.js";
import type { RefView } from "../../core/refs.js";
import type { Builder, Child } from "../dom.js";
import type { HoverStrings } from "./strings.js";

/** Done milestones before the current one shown before the rest fold into "N earlier milestones". */
export const DONE_MILESTONES_SHOWN = 3;
/** Done tasks of the current milestone shown before the older ones fold away. */
export const DONE_TASKS_SHOWN = 3;
export const CHILDREN_SHOWN = 6;
export const REFS_SHOWN = 3;

export type Expandable = "milestones" | "tasks" | "children" | "refs";

export type CardContent =
  | { kind: "view"; view: ConversationView }
  | { kind: "loading" }
  | { kind: "error"; message: string };

/** What a child conversation is opened for: a spin-off already noted, or a new problem. */
export type SpawnTarget = { spinoffId: string; text: string } | { text: string };

/** A file to send along with the new problem; the hover keeps the file itself under this id. */
export interface PendingFile {
  id: string;
  name: string;
  size: number;
  kind: AttachmentKind;
}

/** The card's part for opening child conversations. */
export interface ComposeState {
  /** The field for a new problem is open. */
  open: boolean;
  /** What has been typed in it. */
  text: string;
  /** Photos, videos and other files that go with the new problem. */
  files: PendingFile[];
  /** The button waiting for its confirming second click: "new", or a spin-off's id. */
  armed: string | null;
  /** A child conversation is being opened. */
  busy: boolean;
  /** While the files are sent: how far, in percent. */
  uploading?: number;
  /** Why files were left out (too large, too many). */
  notice?: string;
  /**
   * How the last try went; `pending`: codexhost has not answered yet, and the child may still open.
   * `hostId`: the child opened on another computer (its parent's), which opening it names.
   */
  result?: { ok: true; childThreadId: string; title: string; hostId?: string } | { ok: false; message: string; pending?: true };
}

export const COMPOSE_IDLE: ComposeState = { open: false, text: "", files: [], armed: null, busy: false };

export interface CardActions {
  /** Opens another conversation (a child, the parent, a linked one); `hostId` when it is known to be on another computer. */
  open(threadId: string, hostId?: string): void;
  /** Unfolds a folded list. */
  expand(what: Expandable): void;
  /** A PR or issue link was followed. */
  followed(): void;
  /** Opens or closes the field for a new problem. */
  compose(open: boolean): void;
  /** Keeps what is typed in that field. */
  type(text: string): void;
  /** Opens the file picker for photos, videos and other files to send along. */
  attach(): void;
  /** Takes a file off the list. */
  detach(fileId: string): void;
  /** The first click arms the button; a second one opens the child conversation. */
  spawn(target: SpawnTarget, key: string): void;
  /** The user has seen a PR or issue's GitHub news. */
  seen(refKey: string): void;
  /** Asks the model to summarize this conversation again. */
  summarize(): void;
}

export interface CardContext {
  h: Builder;
  t: HoverStrings;
  now: number;
  expanded: ReadonlySet<Expandable>;
  actions: CardActions;
  compose: ComposeState;
  /** A summary was asked for and has not arrived yet. */
  summarizing?: boolean;
  /** A summary asked for was refused: no model is set for this agent's conversations. */
  summaryRefused?: boolean;
  /** A summary asked for failed for another reason: why, in the card's language. */
  summaryFailed?: string;
  /** The conversation is on another computer: a child opens there, and no files can go along. */
  remote?: boolean;
}

const shortId = (threadId: string) => `#${threadId.slice(0, 8)}`;

export function cardNodes(content: CardContent, ctx: CardContext): Node[] {
  const { h, t } = ctx;
  if (content.kind === "loading") return [h("div", { class: "note", text: t.loading })];
  if (content.kind === "error") return [h("div", { class: "note error", attrs: { role: "alert" }, text: t.failed(content.message) })];
  const view = content.view;
  return [
    news(view, ctx),
    head(view, ctx),
    relations(view, ctx),
    prompts(view, ctx),
    timeline(view, ctx),
    spinoffs(view, ctx),
    children(view, ctx),
    refs(view, ctx),
    compose(view, ctx),
  ].filter((node): node is HTMLElement => node !== null);
}

/** GitHub news about PRs and issues this conversation started, first so a reply leads straight here. */
function news(view: ConversationView, ctx: CardContext): HTMLElement | null {
  const { h, t, now } = ctx;
  const fresh = view.refs.filter((ref) => ref.activity?.unseen);
  if (!fresh.length) return null;
  return section(
    ctx,
    "news",
    t.news,
    null,
    ...fresh.map((ref) =>
      h(
        "div",
        { class: "news-row", attrs: { "data-ref": ref.key } },
        refRow(ref, ctx, () => ctx.actions.seen(ref.key)),
        h(
          "div",
          { class: "news-meta" },
          h("span", { text: `${t.reason(ref.activity!.reason)} · ${t.time(ref.activity!.at, now)}` }),
          h("button", { class: "btn small", text: t.seen, attrs: { type: "button" }, on: { click: () => ctx.actions.seen(ref.key) } }),
        ),
      ),
    ),
  );
}

/** Problems noted while working that are not opened yet: each can become a child conversation. */
function spinoffs(view: ConversationView, ctx: CardContext): HTMLElement | null {
  const { h, t } = ctx;
  const open = view.spinoffs.filter((spinoff) => spinoff.state === "open");
  if (!open.length) return null;
  return section(
    ctx,
    "spinoffs",
    t.spinoffs,
    null,
    ...open.map((spinoff) =>
      h(
        "div",
        { class: "spinoff", attrs: { "data-spinoff": spinoff.id } },
        h("span", { class: "spinoff-text", text: spinoff.text }),
        spawnButton(ctx, spinoff.id, () => ({ spinoffId: spinoff.id, text: spinoff.text })),
      ),
    ),
  );
}

/** A button that asks for a second click before it opens a child conversation. */
function spawnButton(ctx: CardContext, key: string, target: () => SpawnTarget | null): HTMLElement {
  const { h, t } = ctx;
  const { armed, busy } = ctx.compose;
  const mine = armed === key;
  const uploading = ctx.compose.uploading;
  return h("button", {
    class: `btn spawn${mine ? " armed" : ""}`,
    text: mine && busy ? (uploading !== undefined ? t.uploading(uploading) : t.spawning) : mine ? t.confirm : t.spawnChild,
    attrs: { type: "button", "data-spawn": key, disabled: busy ? "" : undefined },
    on: {
      click: () => {
        const what = target();
        if (what) ctx.actions.spawn(what, key);
      },
    },
  });
}

/**
 * "+ Child conversation": a one-line field for a new problem, with photos, videos or other files
 * to send along, opened as a child after a confirming click. (Screen readers hear when a button
 * waits for that click, and that a child is still opening, from a status line outside the card,
 * which is rebuilt all the time.)
 */
function compose(view: ConversationView, ctx: CardContext): HTMLElement {
  const { h, t } = ctx;
  const state = ctx.compose;
  const result = state.result
    ? state.result.ok
      ? h(
          "div",
          { class: "compose-result", attrs: { "data-ok": "" } },
          h("span", { text: t.spawned(state.result.title) }),
          (({ childThreadId, hostId }) => h("button", { class: "btn small", text: t.openIt, attrs: { type: "button" }, on: { click: () => ctx.actions.open(childThreadId, hostId) } }))(
            state.result,
          ),
        )
      : state.result.pending
        ? h("div", { class: "compose-result", attrs: { "data-pending": "" }, text: state.result.message })
        : h("div", { class: "compose-result", attrs: { role: "alert" }, text: t.spawnFailed(state.result.message) })
    : null;
  if (!state.open)
    return h(
      "div",
      { class: "compose" },
      result,
      ctx.summaryRefused ? h("div", { class: "compose-result summary-refused", attrs: { role: "alert" }, text: t.noSummarizer }) : null,
      ctx.summaryFailed ? h("div", { class: "compose-result summary-refused", attrs: { role: "alert" }, text: ctx.summaryFailed }) : null,
      h(
        "div",
        { class: "compose-links" },
        h("button", { class: "more compose-open", text: t.newChild, attrs: { type: "button" }, on: { click: () => ctx.actions.compose(true) } }),
        h("button", {
          class: "more resummarize",
          text: ctx.summarizing ? t.summarizing : view.draft ? t.summarizeNow : t.resummarize,
          attrs: { type: "button", disabled: ctx.summarizing ? "" : undefined },
          on: { click: () => ctx.actions.summarize() },
        }),
      ),
    );
  const input = h("input", {
    class: "compose-input",
    attrs: { type: "text", placeholder: t.newChildHint, "aria-label": t.newChildHint, maxlength: "200", disabled: state.busy ? "" : undefined },
  });
  input.value = state.text;
  input.addEventListener("input", () => ctx.actions.type(input.value));
  input.addEventListener("keydown", (event) => {
    if (event.isComposing || event.key !== "Enter") return;
    event.preventDefault();
    const text = input.value.trim();
    if (text) ctx.actions.spawn({ text }, "new");
  });
  // A child of a conversation on another computer opens there, where files kept here cannot be read: none is offered.
  const attach = ctx.remote
    ? null
    : h("button", {
        class: "attach",
        text: "📎",
        title: t.attachTip,
        attrs: { type: "button", "aria-label": t.attach, disabled: state.busy ? "" : undefined },
        on: { click: () => ctx.actions.attach() },
      });
  const notice = state.notice ?? (ctx.remote ? t.remoteFiles : undefined);
  return h(
    "div",
    { class: "compose", attrs: { "data-open": "", "data-remote": ctx.remote ? "" : undefined } },
    result,
    h("div", { class: "compose-field" }, input, attach),
    state.files.length ? h("ul", { class: "attachments" }, ...state.files.map((file) => attachmentRow(file, ctx))) : null,
    notice ? h("div", { class: "compose-notice", attrs: { role: "status" }, text: notice }) : null,
    h(
      "div",
      { class: "compose-buttons" },
      spawnButton(ctx, "new", () => {
        const text = input.value.trim();
        return text ? { text } : null;
      }),
      h("button", { class: "btn", text: t.cancel, attrs: { type: "button", disabled: state.busy ? "" : undefined }, on: { click: () => ctx.actions.compose(false) } }),
    ),
  );
}

const KIND_ICON: Record<AttachmentKind, string> = { image: "🖼", video: "🎬", file: "📄" };

/** One file going with the new problem: what it is, its name and size, and a way to take it off. */
function attachmentRow(file: PendingFile, ctx: CardContext): HTMLElement {
  const { h, t } = ctx;
  return h(
    "li",
    { class: "attachment", title: file.name, attrs: { "data-kind": file.kind, "data-file": file.id } },
    h("span", { class: "attachment-icon", text: KIND_ICON[file.kind], attrs: { "aria-hidden": "true" } }),
    h("span", { class: "attachment-name", text: file.name }),
    h("span", { class: "attachment-size", text: formatSize(file.size) }),
    h("button", {
      class: "attachment-remove",
      text: "×",
      title: t.detach(file.name),
      attrs: { type: "button", "aria-label": t.detach(file.name), disabled: ctx.compose.busy ? "" : undefined },
      on: { click: () => ctx.actions.detach(file.id) },
    }),
  );
}

function head(view: ConversationView, ctx: CardContext): HTMLElement {
  const { h, t, now } = ctx;
  const status = view.threadStatus;
  return h(
    "div",
    { class: "head" },
    h(
      "div",
      { class: "title" },
      h("span", { class: "title-text", text: view.title }),
      view.draft ? h("span", { class: "chip draft", text: t.draft, title: t.draftTip }) : null,
    ),
    h(
      "div",
      { class: "meta" },
      view.draft ? null : h("span", { class: "state", text: t.status[view.status], attrs: { "data-state": view.status } }),
      status !== "unknown"
        ? h("span", { class: "live", attrs: { "data-status": status } }, h("span", { class: "dot", attrs: { "data-status": status } }), t.live[status])
        : null,
      view.updatedAt ? h("span", { class: "when", text: t.time(view.updatedAt, now), title: t.date(view.updatedAt) }) : null,
      view.summary ? h("span", { class: "when summarized", text: t.summarized(t.time(view.summary.at, now)), title: view.summary.model }) : null,
    ),
    view.host
      ? h(
          "div",
          { class: "host", attrs: { "data-state": view.host.state }, title: t.hostTip },
          h("span", { class: "dot", attrs: { "data-host": view.host.state, "aria-hidden": "true" } }),
          h("span", { class: "host-text", text: t.host(view.host.name, view.host.state) }),
        )
      : null,
    view.tags.length ? h("div", { class: "tags" }, ...view.tags.map((tag) => h("span", { class: "chip", text: tag, title: tag }))) : null,
  );
}

/** "From: parent" and "Linked to: …", each a way over to that conversation. */
function relations(view: ConversationView, ctx: CardContext): HTMLElement | null {
  const rows: Child[] = [];
  if (view.parent) rows.push(relationRow(ctx.t.from, view.parent, "parent", ctx));
  if (view.related) rows.push(relationRow(ctx.t.related, view.related, "related", ctx));
  return rows.length ? ctx.h("div", { class: "relations" }, ...rows) : null;
}

function relationRow(label: string, other: RelatedView, role: string, ctx: CardContext): HTMLElement {
  const { h, t } = ctx;
  return h(
    "button",
    {
      class: "rel",
      title: t.open(other.title),
      attrs: { type: "button", "data-role": role, "data-thread": other.threadId },
      on: { click: () => ctx.actions.open(other.threadId, other.hostId) },
    },
    h("span", { class: "rel-label", text: label }),
    h("span", { class: "dot", title: t.live[other.threadStatus], attrs: { "data-status": other.threadStatus } }),
    h("span", { class: "rel-title", text: other.title }),
  );
}

/** What started a draft, and the latest request when nothing is recorded as in progress. */
function prompts(view: ConversationView, ctx: CardContext): HTMLElement | null {
  const { h, t, now } = ctx;
  const lines: Child[] = [];
  const first = view.firstPrompt?.trim();
  if (first) lines.push(h("div", { class: "prompt", attrs: { "data-role": "origin" } }, h("span", { class: "label", text: t.origin }), first));
  const last = view.lastPrompt;
  if (!view.now && last && last.text.trim() && last.text.trim() !== first)
    lines.push(
      h(
        "div",
        { class: "prompt", attrs: { "data-role": "last" } },
        h("span", { class: "label", text: t.lastPrompt }),
        last.text.trim(),
        h("span", { class: "when", text: t.time(last.at, now) }),
      ),
    );
  return lines.length ? h("div", { class: "prompts" }, ...lines) : null;
}

function section(ctx: CardContext, role: string, title: string, count: string | null, ...children: Child[]): HTMLElement {
  const { h } = ctx;
  return h(
    "section",
    { class: "section", attrs: { "data-section": role } },
    h("div", { class: "section-title" }, h("span", { text: title }), count ? h("span", { class: "count", text: count }) : null),
    ...children,
  );
}

function moreButton(ctx: CardContext, text: string, what: Expandable): HTMLElement {
  return ctx.h("button", {
    class: "more",
    text,
    attrs: { type: "button", "data-expand": what },
    on: { click: () => ctx.actions.expand(what) },
  });
}

/** Milestones: ✓ reached (with the time), ● current with its tasks, ○ planned. */
function timeline(view: ConversationView, ctx: CardContext): HTMLElement | null {
  const { h, t } = ctx;
  const milestones = view.milestones;
  const count = view.progress.total > 0 ? `${view.progress.done}/${view.progress.total}` : null;
  if (!milestones.length) {
    // A draft has nothing recorded yet; its origin above says what it is about.
    if (view.draft) return null;
    if (view.now)
      return section(ctx, "milestones", t.milestones, count, h("ul", { class: "tasks" }, taskRow({ id: "now", text: view.now.text, done: false, at: view.now.at }, true, ctx)));
    return section(ctx, "milestones", t.milestones, count, h("div", { class: "note", text: t.noMilestones }));
  }
  // Fold the oldest of the reached milestones that lead the list, so the current one stays in sight.
  let leading = 0;
  while (leading < milestones.length && milestones[leading]?.state === "done") leading += 1;
  const folded = !ctx.expanded.has("milestones") && leading > DONE_MILESTONES_SHOWN + 1 ? leading - DONE_MILESTONES_SHOWN : 0;
  const items = milestones.slice(folded).map((milestone) => milestoneRow(milestone, view, ctx));
  return section(
    ctx,
    "milestones",
    t.milestones,
    count,
    folded ? moreButton(ctx, t.earlierMilestones(folded), "milestones") : null,
    h("ol", { class: "timeline" }, ...items),
  );
}

function milestoneRow(milestone: MilestoneView, view: ConversationView, ctx: CardContext): HTMLElement {
  const { h, t, now } = ctx;
  const mark = milestone.state === "done" ? "✓" : milestone.state === "current" ? "●" : "○";
  return h(
    "li",
    { class: "ms", attrs: { "data-state": milestone.state, "data-id": milestone.id } },
    h("span", { class: "mark", text: mark, attrs: { "aria-hidden": "true" } }),
    h(
      "div",
      { class: "ms-body" },
      h(
        "div",
        { class: "ms-head" },
        h("span", { class: "ms-title", text: milestone.title }),
        milestone.state === "done" && milestone.doneAt
          ? h("span", { class: "when", text: t.time(milestone.doneAt, now), title: t.date(milestone.doneAt) })
          : null,
      ),
      milestone.state === "current" ? tasksOf(milestone, view, ctx) : null,
    ),
  );
}

/** Tasks of the current milestone: ✓ done, ▸ the one in progress, ↳ carried by a child conversation. */
function tasksOf(milestone: MilestoneView, view: ConversationView, ctx: CardContext): HTMLElement | null {
  const tasks = Array.isArray(milestone.tasks) ? milestone.tasks : [];
  const nowText = view.now?.text.trim();
  const nowIndex = nowText ? tasks.findIndex((task) => !task.done && task.text.trim() === nowText) : -1;
  const doneCount = tasks.filter((task) => task.done).length;
  const folded = !ctx.expanded.has("tasks") && doneCount > DONE_TASKS_SHOWN + 1 ? doneCount - DONE_TASKS_SHOWN : 0;
  const rows: Child[] = [];
  let skipped = 0;
  tasks.forEach((task, index) => {
    if (task.done && skipped < folded) {
      skipped += 1;
      return;
    }
    rows.push(taskRow(task, index === nowIndex, ctx));
  });
  // "Doing" belongs to the current milestone even when no task has its words.
  if (view.now && nowIndex < 0) rows.push(taskRow({ id: "now", text: view.now.text, done: false, at: view.now.at }, true, ctx));
  if (!rows.length) return null;
  const list = ctx.h("ul", { class: "tasks" }, ...rows);
  return folded ? ctx.h("div", null, moreButton(ctx, ctx.t.earlierTasks(folded), "tasks"), list) : list;
}

function taskRow(task: TaskView, isNow: boolean, ctx: CardContext): HTMLElement {
  const { h, t } = ctx;
  const kind = task.done ? "done" : isNow ? "now" : task.threadId ? "child" : "open";
  const mark = { done: "✓", now: "▸", child: "↳", open: "◦" }[kind];
  const childId = task.threadId;
  const childTitle = childId ? (task.threadTitle ?? shortId(childId)) : undefined;
  return h(
    "li",
    { class: "task", attrs: { "data-kind": kind, "data-id": task.id } },
    h("span", { class: "mark", text: mark, attrs: { "aria-hidden": "true" } }),
    h(
      "div",
      { class: "task-body" },
      h("span", { class: "task-text", text: task.text }),
      isNow ? h("span", { class: "now-label", text: t.doing }) : null,
      childId && childTitle
        ? h("button", {
            class: "task-child",
            text: t.inChild(childTitle),
            title: t.open(childTitle),
            attrs: { type: "button", "data-thread": childId },
            on: { click: () => ctx.actions.open(childId) },
          })
        : null,
    ),
  );
}

/** Child conversations: title, live status and the milestone each is at. */
function children(view: ConversationView, ctx: CardContext): HTMLElement | null {
  const { h, t } = ctx;
  if (!view.children.length) return null;
  const shown = ctx.expanded.has("children") ? view.children : view.children.slice(0, CHILDREN_SHOWN);
  const rest = view.children.length - shown.length;
  return section(
    ctx,
    "children",
    t.children(view.children.length),
    null,
    ...shown.map((child) => {
      const meta = [child.current, child.progress?.total ? `${child.progress.done}/${child.progress.total}` : null, child.draft ? t.draft : null]
        .filter(Boolean)
        .join(" · ");
      return h(
        "button",
        {
          class: "child",
          title: t.open(child.title),
          attrs: { type: "button", "data-thread": child.threadId },
          on: { click: () => ctx.actions.open(child.threadId, child.hostId) },
        },
        h("span", { class: "dot", title: t.live[child.threadStatus], attrs: { "data-status": child.threadStatus } }),
        h("span", { class: "child-body" }, h("span", { class: "child-title", text: child.title }), meta ? h("span", { class: "child-meta", text: meta }) : null),
      );
    }),
    rest > 0 ? moreButton(ctx, t.moreChildren(rest), "children") : null,
  );
}

/** PRs and issues: number, title and state; three at first, the rest on request. */
function refs(view: ConversationView, ctx: CardContext): HTMLElement | null {
  const { t } = ctx;
  if (!view.refs.length) return null;
  const shown = ctx.expanded.has("refs") ? view.refs : view.refs.slice(0, REFS_SHOWN);
  const rest = view.refs.length - shown.length;
  return section(
    ctx,
    "refs",
    t.refs,
    null,
    ...shown.map((ref) => refRow(ref, ctx)),
    rest > 0 ? moreButton(ctx, t.moreRefs(rest), "refs") : null,
  );
}

function refRow(ref: RefView, ctx: CardContext, onFollow?: () => void): HTMLElement {
  const { h, t } = ctx;
  const state = ref.state ?? "unknown";
  // Only web links leave the card; anything else stays inert text.
  const href = /^https:\/\//iu.test(ref.url) ? ref.url : undefined;
  return h(
    "a",
    {
      class: "ref",
      title: ref.url,
      attrs: { href, target: href ? "_blank" : undefined, rel: "noopener noreferrer", "data-ref": ref.key },
      on: {
        click: () => {
          onFollow?.();
          ctx.actions.followed();
        },
      },
    },
    h("span", { class: "ref-number", text: `${t.kind[ref.kind] ?? ref.kind} #${ref.number}` }),
    h("span", { class: "ref-title", text: ref.title ?? ref.repo }),
    h("span", { class: "ref-state", text: t.refState[state] ?? state, attrs: { "data-state": state } }),
  );
}
