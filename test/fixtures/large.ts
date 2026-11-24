/**
 * Synthetic data at the sizes the release audit measured: thousands of conversations with long
 * Chinese titles, milestones and tasks, as a heavy user's state can hold.
 */
import type { Conversation, ConversationStatus, StateV2 } from "../../src/core/conversation.js";

/** Chinese text of exactly `n` characters (three bytes each in UTF-8). */
export const filler = (n: number): string => "里程碑任务说明文字".repeat(Math.ceil(n / 9)).slice(0, n);

export const threadIdOf = (i: number): string => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

export interface LargeOptions {
  count: number;
  now: number;
  /** The status of the i-th conversation (the newest is 0). */
  status?: (i: number) => ConversationStatus;
  titleChars?: number;
  milestoneChars?: number;
  taskChars?: number;
  milestones?: number;
  tasks?: number;
  /** Last requests kept, for the newest conversations, and how long each is. */
  prompts?: number;
  promptChars?: number;
}

/** A state like the release audit's synthetic one (about 4 KB per conversation by default). */
export function largeState(options: LargeOptions): StateV2 {
  const { count, now } = options;
  const status = options.status ?? ((i: number) => (i % 10 < 7 ? "done" : i % 10 < 8 ? "paused" : "active"));
  const conversations: Record<string, Conversation> = {};
  for (let i = 0; i < count; i++) {
    const threadId = threadIdOf(i);
    const milestones = Array.from({ length: options.milestones ?? 4 }, (_, m) => ({
      id: `m${m}x`,
      title: `${m} ${filler((options.milestoneChars ?? 40) - String(m).length - 1)}`,
      state: (m < 2 ? "done" : m === 2 ? "current" : "planned") as "done" | "current" | "planned",
      ...(m < 2 ? { doneAt: now - 1000 } : {}),
      tasks: Array.from({ length: options.tasks ?? 3 }, (_, t) => ({
        id: `t${m}${t}x`,
        text: filler(options.taskChars ?? 60),
        done: m < 2,
        at: now - 5000,
        ...(m < 2 ? { doneAt: now - 2000 } : {}),
      })),
    }));
    conversations[threadId] = {
      threadId,
      title: filler(options.titleChars ?? 30),
      tags: ["tag-a", "tag-b", "tag-c"],
      status: status(i),
      milestones,
      spinoffs: [],
      createdAt: now - 9_000_000,
      updatedAt: now - i * 60_000,
    };
  }
  const prompts: StateV2["prompts"] = {};
  for (let i = 0; i < (options.prompts ?? 0); i++) prompts[threadIdOf(i)] = { text: filler(options.promptChars ?? 300), at: now - i * 60_000 };
  return { version: 2, rev: 1, locale: "zh-CN", conversations, prompts };
}
