/**
 * Conversations on other computers: codexhost Web's `web-remote:` session ids, the backend's record
 * of which conversation runs on which remote host, and the rounds that list each host (made-up ids
 * and names only).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { isRemoteHostId, parseWebSessionId, shortHost, webSessionId } from "../src/core/hosts.js";
import type { ListedThread, RemoteHostInfo } from "../src/backend/external-api.js";
import { HttpError } from "../src/backend/external-api.js";
import { REMOTE_RETRY_CAP_MS, REMOTE_RETRY_FIRST_MS, RemoteHosts } from "../src/backend/remote-hosts.js";

const HOST = "remote-peer:0d1e2f3a-aaaa-4bbb-8ccc-000000000001";
const OTHER_HOST = "remote-peer:0d1e2f3a-aaaa-4bbb-8ccc-000000000002";
const REMOTE = "019b0001-aaaa-7bbb-8ccc-00000000000a";

/** codexhost Web's own encoding (its `thread://…?hostId=` link handler), written out again here. */
function codexhostSessionId(hostId: string, threadId: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify([hostId, threadId]));
  return `web-remote:${btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join("")).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")}`;
}
const encode = (value: unknown) => `web-remote:${Buffer.from(JSON.stringify(value)).toString("base64url")}`;

describe("codexhost Web's session ids", () => {
  it("name a local conversation by its Thread id and one on another computer as codexhost Web does", () => {
    expect(webSessionId(REMOTE)).toBe(REMOTE);
    expect(webSessionId(REMOTE, "local")).toBe(REMOTE);
    expect(webSessionId(REMOTE, HOST)).toBe(codexhostSessionId(HOST, REMOTE));
    expect(webSessionId(REMOTE, HOST)).not.toMatch(/[=+/]/u);
    expect(parseWebSessionId(webSessionId(REMOTE, HOST))).toEqual({ threadId: REMOTE, hostId: HOST });
    expect(parseWebSessionId(REMOTE)).toEqual({ threadId: REMOTE });
  });

  it("decode only what is well formed: a remote host id and a conversation id; anything else is no conversation", () => {
    for (const bad of [
      "web-remote:",
      "web-remote:@@@not-base64",
      "web-remote:a",
      `web-remote:${Buffer.from("not json").toString("base64url")}`,
      `${encode([HOST, REMOTE])}==`,
      encode({ hostId: HOST, threadId: REMOTE }),
      encode([HOST]),
      encode([HOST, REMOTE, "x"]),
      encode(["remote-peer:bad id", REMOTE]),
      encode(["remote-peer:", REMOTE]),
      encode([`remote-peer:${"a".repeat(65)}`, REMOTE]),
      encode(["local", REMOTE]),
      encode([HOST, "__proto__"]),
      encode([HOST, "x/y"]),
      encode([HOST, "draft-3"]),
      encode([HOST, 7]),
      "web-remote:draft-3",
      "draft-19",
      "x:y",
      "",
    ])
      expect(parseWebSessionId(bad), bad).toBeUndefined();
    expect(parseWebSessionId(undefined)).toBeUndefined();
    expect(parseWebSessionId(null)).toBeUndefined();
  });

  it("know a remote host's id by codexhost's own rule, and write it in the log by a short form only", () => {
    expect(isRemoteHostId(HOST)).toBe(true);
    for (const bad of ["local", "remote-peer:", "remote-peer:a b", "remote-peer:a/b", `remote-peer:${"x".repeat(65)}`, "peer:abc", 7, undefined]) expect(isRemoteHostId(bad), String(bad)).toBe(false);
    expect(shortHost(HOST)).toBe("0d1e2f3a");
  });
});

/** A stand-in for codexhost's local API: which hosts there are, and each host's list. */
function standIn(hosts: RemoteHostInfo[]) {
  const asked: string[] = [];
  const lists = new Map<string, ListedThread[] | Error | (() => Promise<never>)>();
  const api = {
    listHosts: vi.fn(async () => hosts),
    listThreads: vi.fn(async (options: { hostId?: string; limit?: number } = {}) => {
      asked.push(options.hostId ?? "local");
      const list = lists.get(options.hostId ?? "local");
      if (list instanceof Error) throw list;
      if (typeof list === "function") return list();
      return { threads: list ?? [], nextCursor: null };
    }),
  };
  return { api, asked, lists };
}
const listed = (threadId: string, updatedAt = "2026-11-26T08:00:00Z"): ListedThread => ({ threadId, updatedAt, status: "idle", harnessId: "codex" });

describe("remote hosts", () => {
  afterEach(() => vi.useRealTimers());

  it("are listed each round with their host id; the entries name it, and every conversation on the list is known to run there", async () => {
    const { api, asked, lists } = standIn([
      { hostId: HOST, name: "测试主机", online: true, state: "connected" },
      { hostId: OTHER_HOST, online: false, state: "offline" },
    ]);
    lists.set(HOST, [listed(REMOTE)]);
    const onListed = vi.fn();
    const remote = new RemoteHosts(api, { info: () => undefined, error: () => undefined }, { everyMs: () => 60_000, onListed });
    await remote.tick();
    // The host that is not connected is not asked at all.
    expect(asked).toEqual([HOST]);
    expect(api.listThreads).toHaveBeenCalledWith({ hostId: HOST, limit: 50 });
    expect(remote.hostOf(REMOTE)).toBe(HOST);
    expect(remote.listed()).toEqual([{ ...listed(REMOTE), hostId: HOST }]);
    expect(onListed).toHaveBeenCalledWith(HOST, [{ ...listed(REMOTE), hostId: HOST }]);
    expect(remote.view(HOST)).toEqual({ id: HOST, name: "测试主机", state: "connected" });
    expect(remote.view(OTHER_HOST)).toEqual({ id: OTHER_HOST, state: "offline" });
    expect([remote.down(HOST), remote.down(OTHER_HOST)]).toEqual([false, true]);
    // A host codexhost does not list (no longer paired, or codexhost Web not running) is not asked either.
    remote.note("019b0001-aaaa-7bbb-8ccc-00000000000b", "remote-peer:not-paired");
    expect(remote.down("remote-peer:not-paired")).toBe(true);
    // What a surface names that is no remote host or no conversation is not trusted.
    expect(remote.note("019b0001-aaaa-7bbb-8ccc-00000000000c", "local")).toBe(false);
    expect(remote.note("draft-3", HOST)).toBe(false);
    expect(remote.hostOf("019b0001-aaaa-7bbb-8ccc-00000000000c")).toBeUndefined();
  });

  it("start on their own timer: every minute while the extension is in use, every 10 minutes otherwise", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-26T08:00:00Z") });
    const { api, asked, lists } = standIn([{ hostId: HOST, online: true, state: "connected" }]);
    lists.set(HOST, []);
    let inUse = true;
    const remote = new RemoteHosts(api, { info: () => undefined, error: () => undefined }, { everyMs: () => (inUse ? 60_000 : 10 * 60_000) });
    remote.start(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(asked).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(asked).toHaveLength(2);
    inUse = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(asked).toHaveLength(3);
    // Idle now: the next round comes 10 minutes after the last one.
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(asked).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(asked).toHaveLength(4);
    await remote.stop();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(asked).toHaveLength(4);
  });

  it("back off when a host's list fails: a minute, then twice as long each time up to half an hour, logged once per step; it is not asked meanwhile", async () => {
    let now = Date.parse("2026-11-26T08:00:00Z");
    const { api, asked, lists } = standIn([{ hostId: HOST, online: true, state: "connected" }]);
    lists.set(HOST, new HttpError(400, "/v1/thread/list answered HTTP 400 (RUNTIME_UNREACHABLE)", "RUNTIME_UNREACHABLE"));
    const lines: string[] = [];
    const remote = new RemoteHosts(api, { info: (line) => lines.push(line), error: (line) => lines.push(line) }, { everyMs: () => 60_000, now: () => now });
    const waits: number[] = [];
    for (let round = 0; round < 8; round += 1) {
      const before = asked.length;
      await remote.tick();
      if (asked.length > before) waits.push(now);
      expect(remote.down(HOST)).toBe(true);
      // The next round is a minute later, or when the host's next try is due, whichever comes later.
      now += 60_000;
      while (remote.down(HOST)) now += 60_000;
    }
    const gaps = waits.slice(1).map((at, index) => (at - waits[index]!) / 60_000);
    expect(gaps).toEqual([1, 2, 4, 8, 16, 30, 30]);
    expect(REMOTE_RETRY_FIRST_MS).toBe(60_000);
    expect(REMOTE_RETRY_CAP_MS).toBe(30 * 60_000);
    // Once per step until the cap; the log names the host by the short form of its id, never by a name.
    expect(lines.filter((line) => line.startsWith("list remote host 0d1e2f3a failed"))).toHaveLength(6);
    expect(lines.every((line) => !line.includes(HOST))).toBe(true);
    // It works again: said once, and listed as usual.
    lists.set(HOST, [listed(REMOTE)]);
    await remote.tick();
    expect(remote.down(HOST)).toBe(false);
    expect(lines.at(-1)).toBe("listing remote host 0d1e2f3a works again");
    expect(remote.listed()).toHaveLength(1);
  });

  it("never make a round wait for a host that does not answer: the others are listed meanwhile", async () => {
    const { api, lists } = standIn([
      { hostId: HOST, online: true, state: "connected" },
      { hostId: OTHER_HOST, online: true, state: "connected" },
    ]);
    let release!: () => void;
    lists.set(OTHER_HOST, () => new Promise<never>((_resolve, reject) => (release = () => reject(new Error("timeout")))));
    lists.set(HOST, [listed(REMOTE)]);
    const remote = new RemoteHosts(api, { info: () => undefined, error: () => undefined }, { everyMs: () => 60_000 });
    const round = remote.tick();
    await vi.waitFor(() => expect(remote.listed()).toHaveLength(1));
    release();
    await round;
    expect(remote.down(OTHER_HOST)).toBe(true);
    expect(remote.down(HOST)).toBe(false);
  });
});
