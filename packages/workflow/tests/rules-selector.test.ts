import { describe, expect, it } from "vitest";
import {
  candidateMatchesTitle,
  mapTvCoverage,
  mediaBindingDecision,
  parseEpisodeSpan,
  parseSeasonMarkers,
  selectResourceCandidates,
} from "../src/acquisition-v2/rules-selector.js";
import { movieTargetToRules, tvTargetToRules } from "../src/acquisition-v2/rules-task.js";
import { qualityLadderPolicyFromFlags } from "../src/acquisition-v2/quality-ladder.js";

const high = qualityLadderPolicyFromFlags({ resolutionPreference: "high" });

function cand(id: string, title: string, snapshotId = "snap") {
  return { snapshotId, candidateId: id, title };
}

describe("candidateMatchesTitle", () => {
  it("matches Chinese title and English alias after normalization", () => {
    expect(candidateMatchesTitle("盗梦空间 2010 1080p 中字", ["盗梦空间", "Inception"])).toBe(true);
    expect(candidateMatchesTitle("Inception.2010.1080p.BluRay", ["盗梦空间", "Inception"])).toBe(true);
  });

  it("rejects unrelated noise", () => {
    expect(candidateMatchesTitle("流浪地球 4K", ["盗梦空间"])).toBe(false);
  });
});

describe("parseSeasonMarkers / parseEpisodeSpan / mapTvCoverage", () => {
  it("reads 第N季 and 全集 coverage", () => {
    expect(parseSeasonMarkers("庆余年 第二季 1080p")).toEqual([2]);
    expect(parseEpisodeSpan("庆余年 全集 1080p")?.complete).toBe(true);
    expect(
      mapTvCoverage({
        title: "庆余年 全集 1080p",
        seasons: [1],
        missingEpisodes: ["S01E01", "S01E13"],
      }),
    ).toEqual(["S01E01", "S01E13"]);
  });

  it("maps a ranged pack (1-6集合集) without treating 全集 as the whole season", () => {
    expect(
      mapTvCoverage({
        title: "匹兹堡医护前线 第二季 1-6集合集",
        seasons: [2],
        missingEpisodes: ["S02E04", "S02E07"],
      }),
    ).toEqual(["S02E04"]);
  });

  it("rejects season-2 need when the title has no season marker", () => {
    expect(
      mapTvCoverage({
        title: "匹兹堡医护前线 完结 更新至13集",
        seasons: [2],
        missingEpisodes: ["S02E04"],
      }),
    ).toEqual([]);
  });

  it("maps a named season-2 pack", () => {
    expect(
      mapTvCoverage({
        title: "Show S02 1080p 全集",
        seasons: [2],
        missingEpisodes: ["S02E01", "S02E10"],
      }),
    ).toEqual(["S02E01", "S02E10"]);
  });
});

describe("selectResourceCandidates — movie", () => {
  const target = {
    kind: "movie" as const,
    title: "蝙蝠侠：黑暗骑士",
    aliases: ["The Dark Knight"],
    year: 2008,
  };

  it("ranks by quality ladder and skips disc images", () => {
    const selection = selectResourceCandidates({
      candidates: [
        cand("iso", "蝙蝠侠：黑暗骑士 2008 4K 蓝光原盘 ISO"),
        cand("sdr", "蝙蝠侠：黑暗骑士 2008 2160p WEB-DL"),
        cand("dv", "蝙蝠侠：黑暗骑士 2008 2160p DV REMUX 中字"),
        cand("noise", "流浪地球 4K"),
      ],
      target,
      policy: high,
    });
    expect(selection.selected.map((c) => c.candidateId)).toEqual(["dv"]);
    expect(selection.rejected.some((r) => r.reason === "title-mismatch")).toBe(true);
    expect(selection.rejected.some((r) => r.reason === "disc-image")).toBe(true);
  });

  it("rejects a sequel / remake when heuristics allow", () => {
    const selection = selectResourceCandidates({
      candidates: [
        cand("rises", "蝙蝠侠：黑暗骑士崛起 2012 1080p"),
        cand("ok", "蝙蝠侠：黑暗骑士 2008 1080p 中字"),
      ],
      target,
      policy: high,
    });
    expect(selection.selected.map((c) => c.candidateId)).toEqual(["ok"]);
    expect(selection.rejected.some((r) => r.candidateId === "rises" && r.reason === "sequel-or-year")).toBe(true);
  });
});

describe("selectResourceCandidates — TV", () => {
  it("prefers one complete pack over overlapping ranges", () => {
    const selection = selectResourceCandidates({
      candidates: [
        cand("part", "庆余年 1-10集 4K"),
        cand("full", "庆余年 全集 1080p WEB-DL"),
        cand("wrong", "庆余年2 全集"),
      ],
      target: {
        kind: "tv",
        title: "庆余年",
        aliases: [],
        seasons: [1],
        missingEpisodes: ["S01E01", "S01E10", "S01E13"],
      },
      policy: high,
    });
    expect(selection.selected.map((c) => c.candidateId)).toEqual(["full"]);
    expect(selection.selected[0]!.coveredEpisodes).toEqual(["S01E01", "S01E10", "S01E13"]);
  });

  it("composes non-overlapping ranges when no complete pack exists", () => {
    const selection = selectResourceCandidates({
      candidates: [
        cand("a", "Show 1-8集 1080p"),
        cand("b", "Show 9-13集 1080p"),
      ],
      target: {
        kind: "tv",
        title: "Show",
        aliases: [],
        seasons: [1],
        missingEpisodes: ["S01E01", "S01E08", "S01E13"],
      },
    });
    expect(selection.selected.map((c) => c.candidateId).sort()).toEqual(["a", "b"]);
  });

  it("does not treat a season-2 pack as a sequel of the same title", () => {
    const selection = selectResourceCandidates({
      candidates: [cand("s2", "Show S02 1080p 全集")],
      target: {
        kind: "tv",
        title: "Show",
        aliases: [],
        seasons: [2],
        missingEpisodes: ["S02E01"],
      },
    });
    expect(selection.selected.map((c) => c.candidateId)).toEqual(["s2"]);
  });

  it("rejects English-scene noise when Chinese subs are preferred", () => {
    const selection = selectResourceCandidates({
      candidates: [cand("raw", "Show.S01E01.1080p.WEB-DL.x264")],
      target: {
        kind: "tv",
        title: "Show",
        aliases: [],
        seasons: [1],
        missingEpisodes: ["S01E01"],
        preferredLanguage: "中文",
      },
    });
    expect(selection.selected).toEqual([]);
    expect(selection.rejected.some((r) => r.reason === "raw-foreign")).toBe(true);
  });
});

describe("selectResourceCandidates — mediaBinding", () => {
  const batman = {
    kind: "movie" as const,
    title: "蝙蝠侠：黑暗骑士",
    aliases: ["The Dark Knight"],
    year: 2008,
    tmdbId: 155,
  };

  it("matches by tmdbid even when the share title is messy", () => {
    expect(mediaBindingDecision("随机网盘名 2160p WEB-DL [tmdbid=155]", batman)).toBe("match");
    const selection = selectResourceCandidates({
      candidates: [
        cand("messy", "随机网盘名 无中文片名 2010 2160p DV REMUX [tmdbid=155]"),
        cand("named", "蝙蝠侠：黑暗骑士 2008 1080p WEB-DL 中字"),
      ],
      target: batman,
      policy: high,
    });
    expect(selection.selected.map((c) => c.candidateId)).toEqual(["messy"]);
  });

  it("rejects a different tmdbid even if the fuzzy title matches", () => {
    expect(mediaBindingDecision("蝙蝠侠：黑暗骑士 2008 2160p [tmdbid=27205]", batman)).toBe("mismatch");
    const selection = selectResourceCandidates({
      candidates: [
        cand("wrong", "蝙蝠侠：黑暗骑士 2008 2160p DV REMUX 中字 [tmdbid=27205]"),
        cand("ok", "蝙蝠侠：黑暗骑士 2008 1080p WEB-DL 中字"),
      ],
      target: batman,
      policy: high,
    });
    expect(selection.selected.map((c) => c.candidateId)).toEqual(["ok"]);
    expect(selection.rejected.some((r) => r.candidateId === "wrong" && r.reason === "media-id-mismatch")).toBe(
      true,
    );
  });

  it("falls back to title match when the candidate has no binding", () => {
    expect(mediaBindingDecision("蝙蝠侠：黑暗骑士 2008 1080p 中字", batman)).toBe("absent");
    const selection = selectResourceCandidates({
      candidates: [
        cand("named", "蝙蝠侠：黑暗骑士 2008 1080p WEB-DL 中字"),
        cand("unrelated", "随机网盘名 2160p WEB-DL"),
      ],
      target: batman,
      policy: high,
    });
    expect(selection.selected.map((c) => c.candidateId)).toEqual(["named"]);
    expect(selection.rejected.some((r) => r.candidateId === "unrelated" && r.reason === "title-mismatch")).toBe(
      true,
    );
  });

  it("does not invent a lookup when the candidate binds a source the target lacks", () => {
    expect(mediaBindingDecision("蝙蝠侠：黑暗骑士 2008 [doubanid=1851857] 1080p", batman)).toBe("absent");
    const selection = selectResourceCandidates({
      candidates: [cand("douban", "蝙蝠侠：黑暗骑士 2008 1080p 中字 [doubanid=1851857]")],
      target: batman,
      policy: high,
    });
    expect(selection.selected.map((c) => c.candidateId)).toEqual(["douban"]);
  });

  it("threads tmdbId from MovieTarget / TvAnimeTarget into the rules target", () => {
    expect(
      movieTargetToRules({
        title: "盗梦空间",
        aliases: ["Inception"],
        year: 2010,
        qualityPreference: "4K",
        tmdbId: 27205,
      }).tmdbId,
    ).toBe(27205);
    expect(
      tvTargetToRules({
        title: "庆余年",
        aliases: [],
        seasons: [1],
        missingEpisodes: ["S01E01"],
        qualityPreference: "1080p",
        tmdbId: 90000,
      }).tmdbId,
    ).toBe(90000);
  });
});
