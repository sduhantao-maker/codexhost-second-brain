import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  autoCalls,
  COUNTED_DAYS,
  countSummaryCall,
  dayKey,
  dayOf,
  emptyCounts,
  normalizeCounts,
  pruneCounts,
  readSummaryCounts,
  summaryCountsPaths,
  uncountSummaryCall,
} from "../src/node/summary-counts.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 10, 24, 15, 0).getTime();

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "mainline-counts-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("summary counts", () => {
  it("reads what is well formed, by local day, and keeps the last 14 days", () => {
    expect(dayKey(NOW)).toBe("2026-11-24");
    const counts = normalizeCounts({
      version: 1,
      days: {
        "2026-11-24": { claude: { auto: 3, manual: 1, backfill: "x" }, codex: { auto: -2, backfill: 4 }, other: { auto: 9 } },
        "2026-11-01": { claude: { auto: 1 } },
        yesterday: { claude: { auto: 7 } },
      },
    });
    expect(Object.keys(counts.days).sort()).toEqual(["2026-11-01", "2026-11-24"]);
    const today = dayOf(counts, NOW);
    expect(today).toEqual({ claude: { auto: 3, manual: 1, backfill: 0 }, codex: { auto: 0, manual: 0, backfill: 4 } });
    expect(autoCalls(today)).toBe(3);
    expect(dayOf(counts, NOW + DAY)).toEqual(dayOf(emptyCounts(), NOW));
    pruneCounts(counts, NOW);
    expect(Object.keys(counts.days)).toEqual(["2026-11-24"]);
    const edge = normalizeCounts({ days: { [dayKey(NOW - (COUNTED_DAYS - 1) * DAY)]: {}, [dayKey(NOW - COUNTED_DAYS * DAY)]: {} } });
    pruneCounts(edge, NOW);
    expect(Object.keys(edge.days)).toEqual([dayKey(NOW - (COUNTED_DAYS - 1) * DAY)]);
    expect(normalizeCounts("nonsense")).toEqual(emptyCounts());
  });

  it("counts calls on disk; two at once cannot both take the last automatic one of the day", async () => {
    const paths = summaryCountsPaths(dir);
    expect(await readSummaryCounts(paths)).toEqual(emptyCounts());
    const results = await Promise.all(Array.from({ length: 5 }, () => countSummaryCall(paths, { engine: "claude", reason: "auto", at: NOW, limit: 3 })));
    expect(results.filter(({ counted }) => counted)).toHaveLength(3);
    // Asked-for calls and the backfill are counted with no limit.
    await countSummaryCall(paths, { engine: "codex", reason: "manual", at: NOW });
    await countSummaryCall(paths, { engine: "codex", reason: "backfill", at: NOW });
    const counts = await readSummaryCounts(paths);
    expect(dayOf(counts, NOW)).toEqual({ claude: { auto: 3, manual: 0, backfill: 0 }, codex: { auto: 0, manual: 1, backfill: 1 } });
    // A call that sent nothing after all is taken back, never below zero.
    expect(dayOf(await uncountSummaryCall(paths, { engine: "codex", reason: "manual", at: NOW }), NOW).codex.manual).toBe(0);
    expect(dayOf(await uncountSummaryCall(paths, { engine: "codex", reason: "manual", at: NOW }), NOW).codex.manual).toBe(0);
    // A new day starts from nothing, and the file drops days past the last 14.
    await countSummaryCall(paths, { engine: "claude", reason: "auto", at: NOW + 20 * DAY, limit: 3 });
    expect(Object.keys((await readSummaryCounts(paths)).days)).toEqual([dayKey(NOW + 20 * DAY)]);
    // A damaged file counts as nothing and is replaced on the next call.
    await writeFile(paths.file, "{ broken");
    expect(await readSummaryCounts(paths)).toEqual(emptyCounts());
    await countSummaryCall(paths, { engine: "codex", reason: "auto", at: NOW });
    expect(JSON.parse(await readFile(paths.file, "utf8"))).toMatchObject({ version: 1, days: { [dayKey(NOW)]: { codex: { auto: 1 } } } });
  });
});
