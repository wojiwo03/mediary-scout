import { describe, expect, it } from "vitest";
import { MAX_BLACKBOX_PROBES } from "../src/acquisition-v2/cover-planner.js";
import {
  inferEpisodeCodeFromListingPath,
  isOpaqueTvProbeEligible,
  isSeasonFolderGuess,
  mapTvCoverageFromListing,
  pickOpaqueProbeCandidates,
} from "../src/acquisition-v2/listing-coverage.js";
import {
  isHighConfidenceTvTitleMatch,
  mapTvCoverage,
  planTvCover,
  selectResourceCandidates,
} from "../src/acquisition-v2/rules-selector.js";

const showTarget = {
  kind: "tv" as const,
  title: "庆余年",
  aliases: [] as string[],
  seasons: [1],
  missingEpisodes: ["S01E01", "S01E02", "S01E03"],
  originCountries: ["CN"],
};

function cand(id: string, title: string) {
  return { snapshotId: "snap", candidateId: id, title };
}

describe("mapTvCoverageFromListing — season-folder title + inner E01/E02", () => {
  it("maps parent 第一季 folder + inner E01/E02 files onto missing codes", () => {
    expect(
      mapTvCoverageFromListing({
        paths: ["庆余年 第一季/E01.mkv", "庆余年 第一季/E02.mkv", "庆余年 第一季/readme.txt"],
        seasons: [1],
        missingEpisodes: ["S01E01", "S01E02", "S01E03"],
      }),
    ).toEqual(["S01E01", "S01E02"]);
  });

  it("keeps specials as specials (SP files never become S01E01)", () => {
    expect(
      mapTvCoverageFromListing({
        paths: ["庆余年 特别篇/SP01.mkv", "庆余年 第一季/E01.mkv"],
        seasons: [1],
        missingEpisodes: ["S01E01", "S01E02"],
      }),
    ).toEqual(["S01E01"]);
  });

  it("joint path+filename parse still works via inferEpisodeCodeFromListingPath", () => {
    expect(inferEpisodeCodeFromListingPath("庆余年 第一季/E01.mkv", 1, [1])).toBe("S01E01");
    expect(inferEpisodeCodeFromListingPath("Show S02/05.mkv", undefined, [1, 2])).toBe("S02E05");
  });
});

describe("opaque probe gates — not unrestricted transfer-to-look", () => {
  it("allows a high-confidence title with no episode span (mapTvCoverage [])", () => {
    expect(mapTvCoverage({ title: "庆余年 1080p", seasons: [1], missingEpisodes: showTarget.missingEpisodes })).toEqual(
      [],
    );
    expect(isHighConfidenceTvTitleMatch("庆余年 1080p", showTarget)).toBe(true);
    expect(isOpaqueTvProbeEligible({ title: "庆余年 1080p", target: showTarget })).toBe(true);
  });

  it("allows a season-folder guess (第一季, no per-episode token) so listing can refine it", () => {
    expect(isSeasonFolderGuess("庆余年 第一季")).toBe(true);
    expect(isOpaqueTvProbeEligible({ title: "庆余年 第一季", target: showTarget })).toBe(true);
  });

  it("never probes a wrong-show title", () => {
    expect(isHighConfidenceTvTitleMatch("琅琊榜 1080p", showTarget)).toBe(false);
    expect(isOpaqueTvProbeEligible({ title: "琅琊榜 1080p", target: showTarget })).toBe(false);
    expect(pickOpaqueProbeCandidates({ candidates: [cand("wrong", "琅琊榜 1080p")], target: showTarget })).toEqual([]);
  });

  it("never probes sequels, specials, extras, or date-token 综艺 that missed the library codes", () => {
    expect(isOpaqueTvProbeEligible({ title: "庆余年2 1080p", target: showTarget })).toBe(false);
    expect(isOpaqueTvProbeEligible({ title: "庆余年 特别篇", target: showTarget })).toBe(false);
    expect(isOpaqueTvProbeEligible({ title: "庆余年 花絮", target: showTarget })).toBe(false);
    expect(isOpaqueTvProbeEligible({ title: "庆余年 2024.03.15 1080p", target: showTarget })).toBe(false);
  });

  it("skips probing when a transparent title-mapped pack already covers the need", () => {
    const titleMapped = selectResourceCandidates({
      candidates: [cand("full", "庆余年 全集 1080p WEB-DL")],
      target: showTarget,
    }).selected;
    expect(titleMapped.length).toBe(1);
    expect(
      pickOpaqueProbeCandidates({
        candidates: [cand("full", "庆余年 全集 1080p WEB-DL"), cand("box", "庆余年 1080p")],
        target: showTarget,
        titleMapped,
      }),
    ).toEqual([]);
  });

  it("caps probes at MAX_BLACKBOX_PROBES, highest quality first — never the whole low-score tail", () => {
    const candidates = [
      cand("cam", "庆余年 CAM"),
      cand("sd", "庆余年 480p"),
      cand("hd", "庆余年 720p"),
      cand("fhd", "庆余年 1080p"),
      cand("uhd", "庆余年 2160p DV"),
    ];
    const picked = pickOpaqueProbeCandidates({ candidates, target: showTarget });
    expect(picked).toHaveLength(MAX_BLACKBOX_PROBES);
    expect(picked.map((row) => row.candidateId)).toEqual(["uhd", "fhd", "hd"]);
  });

  it("never probes a below-floor candidate (even if it is the only opaque pack)", () => {
    const picked = pickOpaqueProbeCandidates({
      candidates: [cand("sd", "庆余年 720p"), cand("uhd", "庆余年 2160p")],
      target: showTarget,
      policy: { resolutionFloor: "1080p" },
    });
    expect(picked.map((row) => row.candidateId)).toEqual(["uhd"]);
    expect(
      pickOpaqueProbeCandidates({
        candidates: [cand("only", "庆余年 720p")],
        target: showTarget,
        policy: { resolutionFloor: "1080p" },
      }),
    ).toEqual([]);
  });
});

describe("cover planner integration — probed coverage participates like titled spans", () => {
  it("greedy-composes two opaque packs from listing overrides", () => {
    const overrides = new Map<string, string[]>([
      ["a", ["S01E01", "S01E02"]],
      ["b", ["S01E03"]],
      ["dup", ["S01E01"]],
    ]);
    const plan = planTvCover({
      candidates: [
        cand("a", "庆余年 1080p"),
        cand("b", "庆余年 第一季"),
        cand("dup", "庆余年 720p"),
        cand("wrong", "琅琊榜 1080p"),
      ],
      target: showTarget,
      coverageOverrides: overrides,
    });
    expect(plan.selection.selected.map((row) => row.candidateId).sort()).toEqual(["a", "b"]);
    expect(plan.selection.selected.every((row) => row.coverageSource === "probe")).toBe(true);
    expect(plan.uncovered).toEqual([]);
    expect(plan.redundantCandidateIds).toContain("dup");
    expect(plan.selection.rejected.some((row) => row.candidateId === "wrong" && row.reason === "title-mismatch")).toBe(
      true,
    );
  });
});
