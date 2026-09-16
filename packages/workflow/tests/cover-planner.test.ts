import { describe, expect, it } from "vitest";
import {
  describeTvSelection,
  formatEpisodeCodes,
  gapSearchQueries,
  greedyCover,
  groupEpisodeRanges,
  MAX_GAP_QUERIES_PER_ROUND,
  MAX_TV_TRANSFERS_PER_RUN,
  refillCover,
  remainingGain,
  uncoveredEpisodes,
  type CoverCandidate,
} from "../src/acquisition-v2/cover-planner.js";

function cand(
  id: string,
  covered: string[],
  extras: Partial<CoverCandidate> = {},
): CoverCandidate {
  return {
    snapshotId: "snap",
    candidateId: id,
    title: id,
    coveredEpisodes: covered,
    qualityScore: 4000,
    chineseScore: 0,
    totalScore: 40000,
    ...extras,
  };
}

function ep(n: number): string {
  return `S01E${String(n).padStart(2, "0")}`;
}

function eps(from: number, to: number): string[] {
  return Array.from({ length: to - from + 1 }, (_, i) => ep(from + i));
}

describe("greedyCover / refillCover", () => {
  it("composes complementary packs and skips zero-gain leftovers", () => {
    const picked = greedyCover(
      [
        cand("a", eps(1, 2)),
        cand("b", [ep(3)]),
        cand("c", eps(4, 6)),
        cand("dup", eps(1, 2), { qualityScore: 2000, totalScore: 20000 }),
      ],
      eps(1, 6),
    );
    expect(picked.map((row) => row.candidateId).sort()).toEqual(["a", "b", "c"]);
  });

  it("refillCover drops a failed id and picks the unused alternate", () => {
    const eligible = [
      cand("dead", eps(1, 3), { qualityScore: 5000, totalScore: 50000 }),
      cand("alt", eps(1, 3), { qualityScore: 3000, totalScore: 30000 }),
      cand("tail", eps(4, 6)),
    ];
    const first = greedyCover(eligible, eps(1, 6));
    expect(first[0]?.candidateId).toBe("dead");
    const refilled = refillCover({
      eligible,
      missing: eps(1, 6),
      excludeIds: new Set(["dead"]),
    });
    expect(refilled.map((row) => row.candidateId).sort()).toEqual(["alt", "tail"]);
  });

  it("remainingGain is zero for a fully overlapped pack", () => {
    const remaining = new Set(eps(4, 6));
    expect(remainingGain(cand("early", eps(1, 3)), remaining)).toBe(0);
    expect(remainingGain(cand("tail", eps(4, 6)), remaining)).toBe(3);
  });
});

describe("gapSearchQueries", () => {
  it("shapes a leftover range query without quality tokens or per-ep spam", () => {
    const queries = gapSearchQueries({
      title: "庆余年",
      aliases: ["Joy of Life"],
      missing: eps(4, 10),
    });
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.length).toBeLessThanOrEqual(MAX_GAP_QUERIES_PER_ROUND);
    expect(queries[0]).toBe("庆余年 4-10集");
    expect(queries.join(" ")).not.toMatch(/1080|4K|中字/);
  });

  it("adds a season marker for S2+ and does not emit 50 per-episode queries", () => {
    const missing = Array.from({ length: 50 }, (_, i) => `S02E${String(i + 1).padStart(2, "0")}`);
    const queries = gapSearchQueries({ title: "Show", missing });
    expect(queries).toEqual(["Show 第二季 1-50集"]);
    expect(queries).toHaveLength(1);
  });

  it("round 1 uses an alias; without aliases it stops", () => {
    expect(
      gapSearchQueries({ title: "庆余年", aliases: ["Joy of Life"], missing: [ep(4)], round: 1 }),
    ).toEqual(["Joy of Life 第4集"]);
    expect(gapSearchQueries({ title: "庆余年", missing: [ep(4)], round: 1 })).toEqual([]);
  });

  it("groups contiguous holes into ranges", () => {
    expect(groupEpisodeRanges(["S01E01", "S01E02", "S01E05", "S02E01"])).toEqual([
      { season: 1, from: 1, to: 2 },
      { season: 1, from: 5, to: 5 },
      { season: 2, from: 1, to: 1 },
    ]);
  });
});

describe("describeTvSelection extras", () => {
  it("keeps the 用 N 个分享补齐 core and names 补搜 / 换备选 / 巡检", () => {
    const selected = [cand("a", eps(1, 3)), cand("b", eps(4, 6))];
    expect(describeTvSelection(selected, eps(1, 6))).toBe("规则选片：用 2 个分享补齐 S01E01–E06");
    expect(describeTvSelection(selected, eps(1, 8), { gapResearch: true })).toMatch(/补搜后用 2 个分享补齐/);
    expect(describeTvSelection(selected, eps(1, 8), { refill: true })).toMatch(/转失败换备选/);
    expect(describeTvSelection(selected, eps(1, 8), { transferCap: true })).toMatch(/留给巡检/);
    expect(formatEpisodeCodes(uncoveredEpisodes(selected, eps(1, 8)))).toBe("S01E07–E08");
  });

  it("caps transfers well below a 50-ep single-file season", () => {
    expect(MAX_TV_TRANSFERS_PER_RUN).toBeLessThan(50);
    expect(MAX_TV_TRANSFERS_PER_RUN).toBeGreaterThanOrEqual(8);
  });
});
