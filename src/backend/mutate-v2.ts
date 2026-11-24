/** Edits requested by the cards and the overview page (mainline v2). */
import type { StateV2 } from "../core/conversation.js";
import {
  addMilestone,
  addSpinoff,
  addTask,
  completeTask,
  createConversation,
  deleteConversation,
  dismissSpinoff,
  focusMilestone,
  keepSpinoff,
  pin,
  pinMilestone,
  reachMilestone,
  rememberRemoved,
  relate,
  removeMilestone,
  removeTask,
  renameMilestone,
  setDoing,
  setStatus,
  setTags,
  setTitle,
  unpin,
  type V2Context,
} from "../core/conversation-ops.js";
import { isThreadId, MainlineError } from "../core/model.js";
import type { MutateV2Params } from "../core/rpc.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function text(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== "string") throw new MainlineError("INVALID_ARGUMENT", `${key} is required`);
  return value;
}

function thread(raw: Record<string, unknown>, key = "threadId"): string {
  const value = raw[key];
  if (!isThreadId(value)) throw new MainlineError("INVALID_ARGUMENT", `${key} is required`);
  return value;
}

function strings(raw: Record<string, unknown>, key: string): string[] {
  const value = raw[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new MainlineError("INVALID_ARGUMENT", `${key} must be a list of text`);
  return value as string[];
}

/** Checks the shape of a request from the browser. */
export function parseMutationV2(raw: unknown): MutateV2Params {
  if (!isRecord(raw) || typeof raw.op !== "string") throw new MainlineError("INVALID_ARGUMENT", "op is required");
  const threadId = thread(raw);
  switch (raw.op) {
    case "create":
      return {
        op: "create",
        threadId,
        title: text(raw, "title"),
        ...(raw.tags !== undefined ? { tags: strings(raw, "tags") } : {}),
        ...(raw.milestones !== undefined ? { milestones: strings(raw, "milestones") } : {}),
      };
    case "title":
      return { op: "title", threadId, title: text(raw, "title") };
    case "tags":
      return { op: "tags", threadId, tags: strings(raw, "tags") };
    case "status":
      if (raw.status !== "active" && raw.status !== "paused" && raw.status !== "done")
        throw new MainlineError("INVALID_ARGUMENT", "status must be active, paused or done");
      return { op: "status", threadId, status: raw.status };
    case "milestoneAdd":
      return {
        op: "milestoneAdd",
        threadId,
        title: text(raw, "title"),
        ...(typeof raw.index === "number" && Number.isInteger(raw.index) ? { index: raw.index } : {}),
      };
    case "milestoneRename":
      return { op: "milestoneRename", threadId, milestoneId: text(raw, "milestoneId"), title: text(raw, "title") };
    case "milestoneRemove":
    case "milestoneFocus":
      return { op: raw.op, threadId, milestoneId: text(raw, "milestoneId") };
    case "milestoneReach":
      return { op: "milestoneReach", threadId, ...(typeof raw.milestoneId === "string" ? { milestoneId: raw.milestoneId } : {}) };
    case "taskAdd":
      return { op: "taskAdd", threadId, text: text(raw, "text"), ...(typeof raw.milestoneId === "string" ? { milestoneId: raw.milestoneId } : {}) };
    case "taskDone":
    case "taskRemove":
      return { op: raw.op, threadId, taskId: text(raw, "taskId") };
    case "doing":
      return { op: "doing", threadId, text: raw.text === null ? null : text(raw, "text") };
    case "spinoffAdd":
      return { op: "spinoffAdd", threadId, text: text(raw, "text") };
    case "spinoffDismiss":
    case "spinoffKeep":
      return { op: raw.op, threadId, spinoffId: text(raw, "spinoffId") };
    case "relate":
      return { op: "relate", threadId, toThreadId: raw.toThreadId === null ? null : thread(raw, "toThreadId") };
    case "delete":
      return { op: "delete", threadId };
    case "unpin":
      return { op: "unpin", threadId };
    default:
      throw new MainlineError("INVALID_ARGUMENT", `Unknown op: ${raw.op}`);
  }
}

/**
 * Applies an edit made by the user in the interface. What the user changes by hand is pinned: the
 * title, the tags, a milestone they add or rename, a milestone they remove. Model summaries leave
 * these alone. (Edits by agents through the command line are not pinned.)
 */
export function applyMutationV2(draft: StateV2, params: MutateV2Params, ctx: V2Context): unknown {
  const result = applyEdit(draft, params, ctx);
  const { threadId } = params;
  switch (params.op) {
    case "title":
      pin(draft, threadId, ["title"]);
      break;
    case "tags":
      pin(draft, threadId, ["tags"]);
      break;
    case "status":
      pin(draft, threadId, ["status"]);
      break;
    case "milestoneAdd":
      if (typeof result === "string") pinMilestone(draft, threadId, result);
      break;
    case "milestoneRename":
      pinMilestone(draft, threadId, params.milestoneId);
      break;
    default:
      break;
  }
  return result;
}

function applyEdit(draft: StateV2, params: MutateV2Params, ctx: V2Context): unknown {
  const { threadId } = params;
  switch (params.op) {
    case "create":
      return createConversation(
        draft,
        threadId,
        { title: params.title, ...(params.tags ? { tags: params.tags } : {}), ...(params.milestones ? { milestones: params.milestones } : {}) },
        ctx,
      ).threadId;
    case "title":
      return setTitle(draft, threadId, params.title, ctx);
    case "tags":
      return setTags(draft, threadId, params.tags, ctx);
    case "status":
      return setStatus(draft, threadId, params.status, ctx);
    case "milestoneAdd":
      return addMilestone(draft, threadId, params.title, ctx, params.index).id;
    case "milestoneRename":
      return renameMilestone(draft, threadId, params.milestoneId, params.title, ctx);
    case "milestoneRemove": {
      const title = draft.conversations[threadId]?.milestones.find(({ id }) => id === params.milestoneId)?.title;
      removeMilestone(draft, threadId, params.milestoneId, ctx);
      if (title) rememberRemoved(draft, threadId, title);
      return undefined;
    }
    case "milestoneReach":
      return reachMilestone(draft, threadId, ctx, params.milestoneId).reached.id;
    case "milestoneFocus":
      return focusMilestone(draft, threadId, params.milestoneId, ctx);
    case "taskAdd":
      return addTask(draft, threadId, params.text, ctx, params.milestoneId).id;
    case "taskDone":
      return completeTask(draft, threadId, ctx, { taskId: params.taskId }).id;
    case "taskRemove":
      return removeTask(draft, threadId, params.taskId, ctx);
    case "doing":
      return setDoing(draft, threadId, params.text, ctx);
    case "spinoffAdd":
      return addSpinoff(draft, threadId, params.text, ctx).id;
    case "spinoffDismiss":
      return dismissSpinoff(draft, threadId, params.spinoffId, ctx);
    case "spinoffKeep":
      return keepSpinoff(draft, threadId, params.spinoffId, ctx).id;
    case "relate":
      return relate(draft, threadId, params.toThreadId, ctx);
    case "delete":
      // It stays deleted: automatic summaries and the backfill leave the conversation alone.
      return deleteConversation(draft, threadId, ctx);
    case "unpin":
      return unpin(draft, threadId);
  }
}
