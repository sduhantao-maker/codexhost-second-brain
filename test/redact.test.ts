import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExternalApi } from "../src/backend/external-api.js";
import { activate } from "../src/backend/index.js";
import { Scanner } from "../src/backend/scanner.js";
import { recordPromptV2 } from "../src/core/conversation-ops.js";
import { emptyStateV2 } from "../src/core/conversation.js";
import { requestOf } from "../src/core/model.js";
import { MASK, maskSecrets } from "../src/core/redact.js";
import { addMention, extractLinks } from "../src/core/refs.js";
import { summaryPrompt } from "../src/core/summary-prompt.js";
import { readIndex, refsPaths, updateIndex } from "../src/node/refs-store.js";
import { fileSignature, readState, storePaths, updateState } from "../src/node/store.js";

// Made-up values in the shapes of real ones; none of them works anywhere. They are put together
// here, so that secret scanners do not take this file for a leak.
const KEYS = {
  anthropic: ["sk", "ant", "api03", "AbCdEf0123456789_ghIJklMNopQRstuVWxyz", "0123456789"].join("-"),
  openai: ["sk", "proj", "4f9KxQ2mN8vR1tY6uZ0aB3cD5eF7gH9j"].join("-"),
  github: ["ghp", "1A2b3C4d5E6f7G8h9I0jK1lM2nO3pQ4rS5tU"].join("_"),
  githubPat: ["github", "pat", "11ABCDEFG0123456789", "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ"].join("_"),
  aws: ["AKIA", "IOSFODNN7EXAMPLE"].join(""),
  slack: ["xoxb", "123456789012", "1234567890123", "AbCdEfGhIjKlMnOpQrStUvWx"].join("-"),
  jwt: ["eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ", "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"].join("."),
};

describe("masking secrets", () => {
  it("masks keys and tokens of common services, keeping what kind they were", () => {
    expect(maskSecrets(`ANTHROPIC_AUTH_TOKEN=${KEYS.anthropic}`)).toBe(`ANTHROPIC_AUTH_TOKEN=sk-${MASK}`);
    expect(maskSecrets(`用这个 key：${KEYS.openai} 试试`)).toBe(`用这个 key：sk-${MASK} 试试`);
    expect(maskSecrets(`git clone https://${KEYS.github}@github.com/o/r`)).toBe(`git clone https://ghp_${MASK}@github.com/o/r`);
    expect(maskSecrets(KEYS.githubPat)).toBe(`github_pat_${MASK}`);
    expect(maskSecrets(`aws_access_key_id = ${KEYS.aws}`)).toBe(`aws_access_key_id = AKIA${MASK}`);
    expect(maskSecrets(`slack: ${KEYS.slack}.`)).toBe(`slack: xoxb-${MASK}.`);
    expect(maskSecrets(`cookie ${KEYS.jwt} expired`)).toBe(`cookie eyJ${MASK} expired`);
    expect(maskSecrets("Authorization: Bearer abc123def456ghi789")).toBe(`Authorization: Bearer ${MASK}`);
    expect(maskSecrets("DATABASE_URL=postgres://admin:hunter2pass@db.local:5432/app")).toBe(`DATABASE_URL=postgres://admin:${MASK}@db.local:5432/app`);
  });

  it("masks private key blocks, also when they are cut off", () => {
    const block = ["-----BEGIN OPENSSH PRIVATE KEY-----", "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ", "-----END OPENSSH PRIVATE KEY-----"].join("\n");
    expect(maskSecrets(`key:\n${block}\ndone`)).toBe("key:\n[private key]\ndone");
    expect(maskSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA")).toBe("[private key]");
    // A public key or a certificate is no secret.
    expect(maskSecrets("-----BEGIN PUBLIC KEY-----\nMIIBIjAN")).toBe("-----BEGIN PUBLIC KEY-----\nMIIBIjAN");
  });

  it("masks password= and token: style assignments, quoted or not", () => {
    expect(maskSecrets("PASSWORD=hunter2")).toBe(`PASSWORD=${MASK}`);
    expect(maskSecrets("mysql -u root --password=s3cr3t!")).toBe(`mysql -u root --password=${MASK}`);
    expect(maskSecrets('{"api_key": "abc123xyz", "name": "x"}')).toBe(`{"api_key": "${MASK}", "name": "x"}`);
    expect(maskSecrets("client_secret: 'two words here'")).toBe(`client_secret: '${MASK}'`);
    expect(maskSecrets("SECRET_KEY = django-insecure-abc")).toBe(`SECRET_KEY = ${MASK}`);
    expect(maskSecrets("accessToken: tok_9f8e7d6c")).toBe(`accessToken: ${MASK}`);
    expect(maskSecrets("数据库密码：Abc12345，记得改")).toBe(`数据库密码：${MASK}，记得改`);
  });

  it("leaves alone what only looks like one: types, counts, references and prose", () => {
    for (const text of [
      "token: string",
      "max_tokens=4096",
      "password=$DB_PASSWORD",
      "token=${GITHUB_TOKEN}",
      "api_key = os.environ",
      "const token = process.env.TOKEN",
      "sk-learn-tutorial is a package",
      "use Bearer authentication for this API",
      "the secretary said password is required",
      "PR #42 修复结算页",
    ])
      expect(maskSecrets(text)).toBe(text);
  });

  it("changes nothing more when run again", () => {
    const text = `token=${KEYS.github} and password: "a b c" and Bearer ${KEYS.jwt} and ${KEYS.anthropic}`;
    const once = maskSecrets(text);
    expect(once).not.toContain("1A2b3C4d");
    expect(maskSecrets(once)).toBe(once);
  });
});

describe("where masking applies", () => {
  it("keeps the request without its attachment list or secrets", () => {
    const text = ["# Files mentioned by the user:", "", "## .env: /Users/someone/project/.env", "", "## My request:", `用 ${KEYS.openai} 调一下接口`].join("\n");
    expect(requestOf(text)).toBe(`用 sk-${MASK} 调一下接口`);
    const state = emptyStateV2();
    expect(recordPromptV2(state, "t1", `登录密码=Pa55word 帮我登录 ${KEYS.github}`, { now: 1 })).toBe(true);
    expect(state.prompts.t1?.text).toBe(`登录密码=${MASK} 帮我登录 ghp_${MASK}`);
  });

  it("masks every text in the summary prompt, before it is cut to length", () => {
    // The key straddles the 600-character cut: no part of it may be left.
    const long = `${"背景".repeat(290)} ${KEYS.anthropic} 后面还有很多`;
    const prompt = summaryPrompt({
      threadTitle: `部署 token=${KEYS.github}`,
      current: { title: "接入网关", tags: [], milestones: [], now: { text: `换掉 ${KEYS.openai}`, at: 1 } },
      firstPrompt: `password: hunter2hunter2`,
      totalTurns: 3,
      turns: [
        { turn: 2, user: long, agent: `已配置 Authorization: Bearer ${KEYS.jwt}` },
        { turn: 3, user: "继续", agent: `-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----` },
      ],
    });
    for (const secret of [...Object.values(KEYS), "hunter2hunter2", "sk-ant-api03-AbCd", "MIIEvQIB"]) expect(prompt).not.toContain(secret);
    expect(prompt).toContain(`token=ghp_${MASK}`);
    expect(prompt).toContain("[private key]");
  });

  it("keeps the requests the scanner indexes, and first requests, without secrets", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mainline-redact-"));
    try {
      const said = `部署用 ${KEYS.github}，看看 https://github.com/o/r/pull/7 为什么挂了`;
      const api = {
        listThreads: async () => ({ threads: [{ threadId: "t1", updatedAt: "u1", title: "部署" }], nextCursor: null }),
        readTurns: async () => ({ totalTurns: 1, turns: [{ turnNumber: 1, status: "completed", messages: [{ role: "user" as const, text: said }] }] }),
      } as unknown as ExternalApi;
      const paths = refsPaths(dir);
      const scanner = new Scanner(api, paths, { info: () => undefined, error: () => undefined }, { recentEveryMs: () => 60_000, pauseMs: 0, now: () => 1 });
      for (let i = 0; i < 3; i += 1) await scanner.tick();
      scanner.stop();
      const index = await readIndex(paths);
      expect(index.threads.t1?.firstPrompt).toBe(`部署用 ghp_${MASK}，看看 https://github.com/o/r/pull/7 为什么挂了`);
      expect(index.refs["o/r#7"]?.mentions[0]?.prompt).toBe(index.threads.t1?.firstPrompt);
      expect(await readFile(paths.file, "utf8")).not.toContain("1A2b3C4d");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("text stored before masking", () => {
  it("is masked once when the backend starts, and written only when something changed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mainline-redact-old-"));
    try {
      const dataDir = path.join(root, "host-extension-data", "second-brain");
      const extensionDir = path.join(root, "extension");
      await mkdir(path.join(extensionDir, "bin"), { recursive: true });
      await writeFile(path.join(extensionDir, "bin", "mainline.mjs"), "// cli\n");
      // What 0.7 kept: the last request, and the index's request and first request, as said.
      const said = `部署用 ${KEYS.github}，看看 https://github.com/o/r/pull/7 为什么挂了`;
      const paths = storePaths(dataDir);
      await updateState(paths, (draft) => {
        draft.prompts.t1 = { text: said, at: Date.now() };
        draft.prompts.t2 = { text: "没有密钥的请求", at: Date.now() };
      });
      const refs = refsPaths(dataDir);
      await updateIndex(refs, (index) => {
        const [link] = extractLinks("https://github.com/o/r/pull/7");
        addMention(index, link!, { threadId: "t1", turn: 1, at: 1, role: "user", prompt: said });
        index.threads.t1 = { turns: 1, updatedAt: "u1", scannedAt: 1, firstPrompt: said };
      });
      const start = () =>
        activate(
          { extensionId: "second-brain", extensionDir, dataDir, readSettings: async () => ({}), writeSettings: async (values) => values, handle: () => undefined },
          { runGh: async () => Promise.reject(new Error("no gh in tests")), runModel: async () => Promise.reject(new Error("no model in tests")) },
        );
      await (await start())();
      const state = await readState(paths);
      expect(state.prompts.t1?.text).toBe(`部署用 ghp_${MASK}，看看 https://github.com/o/r/pull/7 为什么挂了`);
      expect(state.prompts.t2?.text).toBe("没有密钥的请求");
      const index = await readIndex(refs);
      expect(index.threads.t1?.firstPrompt).toBe(state.prompts.t1?.text);
      expect(index.refs["o/r#7"]?.mentions[0]?.prompt).toBe(state.prompts.t1?.text);
      for (const file of [paths.state, refs.file]) expect(await readFile(file, "utf8")).not.toContain("1A2b3C4d");
      const log = await readFile(path.join(dataDir, "backend.log"), "utf8");
      expect(log).toContain("masked secrets in stored text: 1 last requests, 1 requests and 1 first requests in the link index");
      expect(log).not.toContain("部署");

      // Nothing left to mask: the next start writes neither file.
      const [stateBefore, indexBefore] = [await fileSignature(paths.state), await fileSignature(refs.file)];
      await (await start())();
      expect([await fileSignature(paths.state), await fileSignature(refs.file)]).toEqual([stateBefore, indexBefore]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
