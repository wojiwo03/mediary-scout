import { describe, expect, it } from "vitest";
import {
  advanceTrickle,
  findActiveRun,
  initialTrickleState,
  inlineProgressView,
  trickleDisplayPercent,
} from "./inline-progress";
import type { ActivityActiveRun } from "./activity-view";

function run(over: Partial<ActivityActiveRun>): ActivityActiveRun {
  return {
    runId: "r",
    tmdbId: 1,
    title: "T",
    year: 2026,
    type: "movie",
    posterPath: null,
    seasonNumber: null,
    seasonNumbers: [],
    status: "running",
    queuePosition: null,
    missingCount: 0,
    progress: null,
    qualityUpgrade: false,
    selectionPath: null,
    ...over,
  };
}

function progress(
  percent: number,
  activity: string,
  phase: NonNullable<ActivityActiveRun["progress"]>["phase"] = "transfer",
): ActivityActiveRun["progress"] {
  return { percent, activity, phase, updatedAt: "2026-06-23T00:00:00.000Z" };
}

describe("findActiveRun", () => {
  it("matches a movie by tmdbId (seasonNumber null = any)", () => {
    const a = [run({ runId: "x", tmdbId: 5 }), run({ runId: "y", tmdbId: 9 })];
    expect(findActiveRun(a, 9, null)?.runId).toBe("y");
  });
  it("matches a series by tmdbId + seasonNumber", () => {
    const a = [
      run({ runId: "s2", tmdbId: 5, seasonNumber: 2 }),
      run({ runId: "s3", tmdbId: 5, seasonNumber: 3 }),
    ];
    expect(findActiveRun(a, 5, 3)?.runId).toBe("s3");
  });
  it("seasonNumber null prefers a running run over a queued one (same tmdbId)", () => {
    const a = [
      run({ runId: "q", tmdbId: 5, seasonNumber: 2, status: "queued" }),
      run({ runId: "run", tmdbId: 5, seasonNumber: 3, status: "running" }),
    ];
    expect(findActiveRun(a, 5, null)?.runId).toBe("run");
  });
  it("returns null when no run matches", () => {
    expect(findActiveRun([run({ tmdbId: 1 })], 999, null)).toBeNull();
  });
});

describe("inlineProgressView", () => {
  it("running run → running:true, percent clamped, step from the 5-step list", () => {
    const v = inlineProgressView(run({ status: "running", progress: progress(42, "正在转存到网盘…") }));
    expect(v.running).toBe(true);
    expect(v.percent).toBe(42);
    expect(v.step).toMatch(/^转存/);
    expect(v.steps).toHaveLength(5);
    expect(v.steps.map((s) => s.id)).toEqual(["search", "pick", "transfer", "organize", "finalize"]);
  });
  it("clamps percent to [3,100] and falls back step", () => {
    expect(inlineProgressView(run({ status: "running", progress: progress(0, "") })).percent).toBe(3);
    expect(inlineProgressView(run({ status: "running", progress: progress(250, "x") })).percent).toBe(100);
    expect(inlineProgressView(run({ status: "running", progress: null })).step).toBe("搜索 · 开始搜片和匹配候选");
  });
  it("treats empty/whitespace activity as missing → fallback step", () => {
    expect(inlineProgressView(run({ status: "running", progress: progress(50, "", "search") })).step).toBe(
      "搜索 · 开始搜片和匹配候选",
    );
    expect(inlineProgressView(run({ status: "running", progress: progress(50, "   ", "search") })).step).toBe(
      "搜索 · 开始搜片和匹配候选",
    );
  });
  it("queued or null → running:false", () => {
    expect(inlineProgressView(run({ status: "queued" })).running).toBe(false);
    expect(inlineProgressView(null).running).toBe(false);
  });
  it("正在收尾 is the last step (核对), not a hung percent", () => {
    const v = inlineProgressView(run({ status: "running", progress: progress(96, "正在收尾…", "finalize") }));
    expect(v.step).toBe("收尾 · 核对结果，清理暂存");
    expect(v.steps.find((s) => s.id === "finalize")?.state).toBe("current");
  });
  it("no_coverage wrap-up surfaces 未找到资源 on 选片, not frozen 97%", () => {
    const v = inlineProgressView(
      run({
        status: "running",
        progress: {
          percent: 97,
          activity: "正在收尾…",
          phase: "finalize",
          updatedAt: "2026-06-23T00:00:00.000Z",
          noCoverage: true,
          searchCount: 4,
          needed: 12,
          obtained: 0,
        },
      }),
    );
    expect(v.step).toBe("选片 · 未找到资源");
    expect(v.hint).toBe("核对结果，清理暂存");
    expect(v.steps.find((s) => s.id === "pick")?.state).toBe("failed");
    expect(v.steps.find((s) => s.id === "transfer")?.state).toBe("skipped");
  });
  it("floor-empty wrap-up uses the pick reason, not generic 未找到资源", () => {
    const v = inlineProgressView(
      run({
        status: "running",
        progress: {
          percent: 97,
          activity: "正在收尾…",
          phase: "finalize",
          updatedAt: "2026-06-23T00:00:00.000Z",
          noCoverage: true,
          skippedTransfer: true,
          pickReason: "below-quality-floor",
          candidateCount: 8,
          searchCount: 3,
          currentKeyword: "兰香如敌",
        },
      }),
    );
    expect(v.step).toBe("选片 · 候选 8 个，均低于画质下限");
    expect(v.steps.find((s) => s.id === "search")?.detail).toContain("兰香如敌");
  });
});

// 2026-06-24 bug: a single `searchResources` tool call ran 94s (half the run); the
// bar is event-driven (only writes on a tool call) so it sat FROZEN at 11% the whole
// time → looked empty / "no progress". Fix: client trickles the bar forward between
// server updates. trickleDisplayPercent eases from the last server % toward a soft
// ceiling just above it (decelerating, never reaching), so a long opaque step shows
// continuous life without claiming completion.
describe("trickleDisplayPercent — keep the bar alive during a long opaque step", () => {
  it("no creep at t=0 (shows exactly the server value)", () => {
    expect(trickleDisplayPercent(11, 0)).toBe(11);
  });
  it("creeps forward over time, strictly increasing (the frozen-94s symptom)", () => {
    const early = trickleDisplayPercent(11, 5_000);
    const mid = trickleDisplayPercent(11, 30_000);
    const late = trickleDisplayPercent(11, 90_000);
    expect(early).toBeGreaterThan(11);
    expect(mid).toBeGreaterThan(early);
    expect(late).toBeGreaterThan(mid);
  });
  it("never crosses the next real milestone (search 11% must not creep toward transfer 37%)", () => {
    // Even after an absurdly long wait, the soft ceiling stays well below the next jump.
    expect(trickleDisplayPercent(11, 10_000_000)).toBeLessThan(30);
  });
  it("never claims completion (capped below 100 even from a high base)", () => {
    expect(trickleDisplayPercent(96, 10_000_000)).toBeLessThanOrEqual(99);
  });
  it("never trickles BACKWARD for a base at/above the cap (Copilot: base 100 → stays 100)", () => {
    expect(trickleDisplayPercent(100, 0)).toBe(100);
    expect(trickleDisplayPercent(100, 60_000)).toBe(100); // not 99 — no negative slope
    expect(trickleDisplayPercent(100, 600_000)).toBeGreaterThanOrEqual(100);
  });
  it("monotonic non-decreasing in elapsed (never rewinds)", () => {
    let prev = -1;
    for (const ms of [0, 1_000, 10_000, 60_000, 300_000]) {
      const v = trickleDisplayPercent(20, ms);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe("advanceTrickle — display stays monotonic across polls/ticks", () => {
  it("Copilot: a small server increment must NOT rewind the displayed bar", () => {
    // base 10, crept to ~13 after 10s; next poll reports server=11 → must stay ≥13.
    let s = initialTrickleState(10, 0, "run1");
    s = advanceTrickle(s, { serverPercent: 10, nowMs: 10_000, key: "run1" });
    const crept = s.displayed;
    expect(crept).toBeGreaterThan(11);
    s = advanceTrickle(s, { serverPercent: 11, nowMs: 10_400, key: "run1" });
    expect(s.displayed).toBeGreaterThanOrEqual(crept); // no drop to 11
  });
  it("eases from a real jump (search 11% → transfer 37%) and keeps climbing", () => {
    let s = initialTrickleState(11, 0, "r");
    s = advanceTrickle(s, { serverPercent: 11, nowMs: 90_000, key: "r" }); // long search creep
    expect(s.displayed).toBeGreaterThan(11);
    expect(s.displayed).toBeLessThan(30); // never crossed toward 37
    s = advanceTrickle(s, { serverPercent: 37, nowMs: 92_000, key: "r" }); // transfer jump
    expect(s.displayed).toBeGreaterThanOrEqual(37);
  });
  it("a new run (key change) resets the bar to that run's value", () => {
    let s = initialTrickleState(80, 0, "old");
    s = advanceTrickle(s, { serverPercent: 80, nowMs: 30_000, key: "old" });
    expect(s.displayed).toBeGreaterThan(80);
    s = advanceTrickle(s, { serverPercent: 8, nowMs: 30_100, key: "new" });
    expect(s.displayed).toBe(8); // fresh, not carrying old run's 80+
  });
  it("monotonic across a full real sequence (never rewinds at any tick)", () => {
    const ticks: Array<{ serverPercent: number; nowMs: number }> = [
      { serverPercent: 8, nowMs: 0 },
      { serverPercent: 10, nowMs: 3_000 },
      { serverPercent: 11, nowMs: 7_000 }, // then frozen 94s of trickle:
      { serverPercent: 11, nowMs: 30_000 },
      { serverPercent: 11, nowMs: 101_000 },
      { serverPercent: 37, nowMs: 121_000 },
      { serverPercent: 64, nowMs: 135_000 },
      { serverPercent: 96, nowMs: 170_000 },
    ];
    let s = initialTrickleState(8, 0, "r");
    let prev = -1;
    for (const t of ticks) {
      s = advanceTrickle(s, { ...t, key: "r" });
      expect(s.displayed).toBeGreaterThanOrEqual(prev);
      prev = s.displayed;
    }
    expect(prev).toBeGreaterThanOrEqual(96);
  });
});
