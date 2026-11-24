import { describe, expect, it } from "vitest";
import { recordPromptV2 } from "../src/core/conversation-ops.js";
import { emptyStateV2 } from "../src/core/conversation.js";
import { REQUEST_SCAN, requestOf } from "../src/core/model.js";
import { MASK, maskSecrets } from "../src/core/redact.js";

// Made-up values in the shapes of real ones; put together here so secret scanners leave this file alone.
const GITHUB = ["ghp", "1A2b3C4d5E6f7G8h9I0jK1lM2nO3pQ4rS5tU"].join("_");
const OPENAI = ["sk", "proj", "4f9KxQ2mN8vR1tY6uZ0aB3cD5eF7gH9j"].join("-");

/**
 * Milliseconds of processor time the work takes: unlike the time on the clock it hardly changes
 * when the machine is busy with other work. Measured up to three times, the least counts.
 */
function fastest(work: () => void, enough = 300): number {
  let best = Infinity;
  for (let i = 0; i < 3 && best >= enough; i += 1) {
    const before = process.cpuUsage();
    work();
    const used = process.cpuUsage(before);
    best = Math.min(best, (used.user + used.system) / 1000);
  }
  return best;
}

const SIZE = 200_000;
const repeat = (unit: string) => unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);

describe("masking time", () => {
  // Long runs of letters, digits, dots and hyphens: each rule could start at almost every
  // character and scan to the end of the run, so the time grew with the square of the length.
  it.each([
    ["a-b.", repeat("a-b.")],
    ["a-", repeat("a-")],
    ["a.", repeat("a.")],
    ["Ab1.", repeat("Ab1.")],
    ["build-cache-key.", `see ${repeat("build-cache-key.")}`],
    ["sk-", repeat("sk-")],
    ["eyJ-", repeat("eyJ-")],
    ["xoxb-", repeat("xoxb-")],
    ["token-", repeat("token-")],
  ])("stays linear on 200 KB of %s", (_label, text) => {
    expect(fastest(() => maskSecrets(text))).toBeLessThan(300);
  }, 60_000);

  it("keeps a long request from holding the hook's lock: only its start is masked, far more than is kept", () => {
    const pasted = `fix this: ${"build-cache-key.".repeat(64 * 1024)}`;
    expect(fastest(() => requestOf(pasted))).toBeLessThan(300);
    expect(requestOf(pasted).length).toBeLessThanOrEqual(REQUEST_SCAN + 1_000);
    const state = emptyStateV2();
    expect(fastest(() => recordPromptV2(state, "t1", pasted, { now: 1 }))).toBeLessThan(300);
    expect(Array.from(state.prompts.t1!.text)).toHaveLength(300);
  }, 60_000);
});

describe("masking after the bounds", () => {
  it("still masks names of up to 64 characters before the word, in JSON and in assignments", () => {
    expect(maskSecrets('{"spring.datasource.hikari.data-source-properties.password": "hunter22"}')).toBe(
      `{"spring.datasource.hikari.data-source-properties.password": "${MASK}"}`,
    );
    expect(maskSecrets("MY_COMPANY_PRODUCTION_ANALYTICS_DATABASE_READONLY_USER_PASSWORD=hunter22")).toBe(
      `MY_COMPANY_PRODUCTION_ANALYTICS_DATABASE_READONLY_USER_PASSWORD=${MASK}`,
    );
    // Longer names are still masked from a later part of the name.
    const long = `${"segment.".repeat(12)}api_key=abc123xyz`;
    expect(maskSecrets(long)).toBe(`${"segment.".repeat(12)}api_key=${MASK}`);
  });

  it("still masks passwords in URLs after a long dotted word, keys and long JSON Web Tokens", () => {
    expect(maskSecrets("see.the.notes.from.the.last.release.https://admin:hunter2pass@db.local/app")).toBe(
      `see.the.notes.from.the.last.release.https://admin:${MASK}@db.local/app`,
    );
    expect(maskSecrets(`key ${OPENAI} here`)).toBe(`key sk-${MASK} here`);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "k".repeat(150), jku: `https://example.invalid/${"keys/".repeat(20)}` })).toString("base64url");
    expect(header.length).toBeGreaterThan(256);
    expect(maskSecrets(`cookie ${header}.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c end`)).toBe(`cookie eyJ${MASK} end`);
  });

  it("masks a secret that straddles the cut whole, and finds the request after a long list of attachments", () => {
    const before = "word ".repeat(Math.floor((REQUEST_SCAN - 10) / 5));
    const masked = requestOf(`${before}${GITHUB} and more after it`);
    expect(masked).toContain(`ghp_${MASK}`);
    expect(masked).not.toContain("1A2b3C4d");
    const files = Array.from({ length: 4000 }, (_, i) => `## file-${i}.png: /tmp/shots/file-${i}.png`).join("\n");
    expect(requestOf(`# Files mentioned by the user:\n\n${files}\n\n## My request:\nuse ${OPENAI} please`)).toBe(`use sk-${MASK} please`);
  });
});
