/**
 * Conversations on other computers. codexhost Web shows the conversations of the computers paired
 * with it ("remote hosts", ids `remote-peer:…`), and codexhost's local API reads and lists them when
 * asked with the host's id. Everywhere in the extension a conversation is still known by its Thread
 * id; where it is remote, its host's id goes beside it. This machine is `local`, which is no remote
 * host: a conversation without a host id is a local one.
 */
import { isThreadId } from "./model.js";

/** codexhost's id of a paired computer (its host runtime's `remotePeerHostIdSchema`). */
const REMOTE_HOST_ID = /^remote-peer:[a-zA-Z0-9_-]{1,64}$/u;
const PREFIX = "remote-peer:";

export function isRemoteHostId(value: unknown): value is string {
  return typeof value === "string" && REMOTE_HOST_ID.test(value);
}

/** A remote host as the log names it: the first 8 characters of its id after `remote-peer:`, never its name. */
export function shortHost(hostId: string): string {
  return hostId.startsWith(PREFIX) ? hostId.slice(PREFIX.length, PREFIX.length + 8) : "?";
}

/** How codexhost says a paired computer is doing; `unknown` when it does not list the computer at all. */
export type HostState = "connected" | "connecting" | "auth-error" | "offline" | "disabled" | "unknown";
const HOST_STATES = new Set<string>(["connected", "connecting", "auth-error", "offline", "disabled"]);

export function hostState(value: unknown): HostState {
  return typeof value === "string" && HOST_STATES.has(value) ? (value as HostState) : "unknown";
}

/** A remote host as a card shows it: its name (as its owner set it in codexhost) and how it is doing. */
export interface HostView {
  id: string;
  name?: string;
  state: HostState;
}

/** A conversation as codexhost Web names it: its Thread id, and the host it is on when that is another computer. */
export interface WebSession {
  threadId: string;
  hostId?: string;
}

/** codexhost Web's session ids of conversations on another computer start with this. */
const WEB_REMOTE = "web-remote:";
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

/**
 * codexhost Web's session id of a conversation, as its sidebar keys rows and its `?session=` link
 * names it: the Thread id of a local one; for one on another computer, `web-remote:` and the
 * base64url (no padding) of the JSON `[hostId, threadId]`.
 */
export function webSessionId(threadId: string, hostId?: string): string {
  if (!isRemoteHostId(hostId)) return threadId;
  const bytes = new TextEncoder().encode(JSON.stringify([hostId, threadId]));
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return `${WEB_REMOTE}${btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "")}`;
}

/**
 * The conversation a codexhost Web session id names. Undefined for anything that is not one: a
 * draft (`draft-<n>`, `web-remote:draft-<n>`), and a remote id that does not decode to a valid
 * host id and conversation id; such a row is ignored, never trusted.
 */
export function parseWebSessionId(id: unknown): WebSession | undefined {
  if (typeof id !== "string") return undefined;
  if (!id.startsWith(WEB_REMOTE)) return isThreadId(id) ? { threadId: id } : undefined;
  const encoded = id.slice(WEB_REMOTE.length);
  if (!BASE64URL.test(encoded) || encoded.length % 4 === 1 || encoded.startsWith("draft-")) return undefined;
  try {
    const binary = atob(encoded.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(Math.ceil(encoded.length / 4) * 4, "="));
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
    const pair = JSON.parse(text) as unknown;
    if (!Array.isArray(pair) || pair.length !== 2) return undefined;
    const [hostId, threadId] = pair as unknown[];
    return isRemoteHostId(hostId) && isThreadId(threadId) ? { threadId, hostId } : undefined;
  } catch {
    return undefined;
  }
}
