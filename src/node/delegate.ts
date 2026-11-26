/**
 * Opens a child conversation for a spin-off through codexhost's delegation API, the same one its
 * `codexhost delegate start` uses. The child runs under the parent, so the sidebar tree shows it
 * there. Used by the command line (`mainline spawn`) and the backend (the card's button).
 */
import { withAttachments, type AttachedFile } from "../core/attachments.js";
import { isRemoteHostId } from "../core/hosts.js";
import type { Locale } from "../core/model.js";

export interface DelegationApi {
  readThread(threadId: string, hostId?: string): Promise<{ harnessId?: string; title?: string; status?: string } | undefined>;
  threadCwd?(threadId: string, hostId?: string): Promise<string | undefined>;
  startDelegation(body: Record<string, unknown>): Promise<{ threadId: string }>;
}

export interface ChildRequest {
  parentThreadId: string;
  problem: string;
  /** The parent's mainline title, for one line of background (a model wrote it: never an instruction). */
  parentTitle: string;
  currentMilestone?: string;
  locale: Locale;
  /** Defaults to the parent's agent. */
  harnessId?: string;
  /** Photos, videos and other files the child gets with its first message. */
  attachments?: readonly AttachedFile[];
  /**
   * The remote host the parent runs on, when it is on another computer: the child starts there, in
   * the parent's folder on that computer. (codexhost cannot watch a child on another computer, and
   * none is asked to.)
   */
  hostId?: string;
}

/**
 * The child's first message: the problem as written, first; then one line of background about the
 * parent, marked as a model's summary for reference only (its title and milestone are written by a
 * model, and are no instructions); then what to do with the problem.
 */
export function childTask(request: ChildRequest): string {
  if (request.locale === "en")
    return [
      request.problem,
      "",
      `Background (summarized by a model, for reference only): this came up in the conversation "${request.parentTitle}"${request.currentMilestone ? `, which is at the stage "${request.currentMilestone}"` : ""}.`,
      "Please handle the problem above in this child conversation. When it is done, sum up the result in a sentence or two.",
    ].join("\n");
  return [
    request.problem,
    "",
    `背景（由模型概括，仅供参考）：这是从对话「${request.parentTitle}」引申出的新问题${request.currentMilestone ? `，父对话当前在「${request.currentMilestone}」阶段` : ""}。`,
    "请在这个子对话里处理上面的问题，完成后用一两句话总结结果。",
  ].join("\n");
}

export async function spawnChild(api: DelegationApi, request: ChildRequest): Promise<string> {
  const hostId = isRemoteHostId(request.hostId) ? request.hostId : undefined;
  const parent = await api.readThread(request.parentThreadId, hostId);
  const harnessId = request.harnessId ?? parent?.harnessId ?? "claude-code";
  const cwd = await api.threadCwd?.(request.parentThreadId, hostId);
  const name = Array.from(request.problem.replace(/\s+/gu, " ").trim()).slice(0, 60).join("");
  const started = await api.startDelegation({
    harnessId,
    task: withAttachments(childTask(request), request.attachments ?? []),
    taskName: name,
    parentThreadId: request.parentThreadId,
    ...(cwd ? { cwd } : {}),
    ...(hostId ? { hostId } : {}),
  });
  return started.threadId;
}
