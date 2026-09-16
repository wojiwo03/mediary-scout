import { describe, expect, it } from "vitest";
import {
  candidateMatchesTitle,
  chineseSubtitleScore,
  describeTvSelection,
  formatEpisodeCodes,
  mapTvCoverage,
  mediaBindingDecision,
  parseEpisodeSpan,
  parseSeasonMarkers,
  selectResourceCandidates,
  assessRulesConfidence,
} from "../src/acquisition-v2/rules-selector.js";
import { joinReleaseTitleParts } from "../src/acquisition-v2/release-meta.js";
import { movieTargetToRules, tvTargetToRules } from "../src/acquisition-v2/rules-task.js";
import { qualityLadderPolicyFromFlags, BELOW_QUALITY_FLOOR_REASON } from "../src/acquisition-v2/quality-ladder.js";

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

describe("selectResourceCandidates — movie multi-disc", () => {
  const target = {
    kind: "movie" as const,
    title: "蝙蝠侠：黑暗骑士",
    aliases: ["The Dark Knight"],
    year: 2008,
  };

  it("prefers a CD1+CD2 pack over a lone CD1 of the same quality", () => {
    const selection = selectResourceCandidates({
      candidates: [
        cand("cd1", "蝙蝠侠：黑暗骑士 2008 1080p BluRay CD1 中字"),
        cand("pack", "蝙蝠侠：黑暗骑士 2008 1080p BluRay CD1+CD2 中字"),
      ],
      target,
      policy: high,
    });
    expect(selection.selected.map((c) => c.candidateId)).toEqual(["pack"]);
    expect(
      selection.rejected.some((r) => r.candidateId === "cd1" && r.reason === "incomplete-disc-set"),
    ).toBe(true);
  });

  it("prefers a title without PART/CD over a lone CD1 of equal quality", () => {
    const selection = selectResourceCandidates({
      candidates: [
        cand("cd1", "蝙蝠侠：黑暗骑士 2008 1080p WEB-DL CD1 中字"),
        cand("full", "蝙蝠侠：黑暗骑士 2008 1080p WEB-DL 中字"),
      ],
      target,
      policy: high,
    });
    expect(selection.selected.map((c) => c.candidateId)).toEqual(["full"]);
    expect(
      selection.rejected.some((r) => r.candidateId === "cd1" && r.reason === "incomplete-disc-set"),
    ).toBe(true);
  });

  it("prefers a complete 1080p pack over a 4K lone CD1", () => {
    const selection = selectResourceCandidates({
      candidates: [
        cand("cd1-4k", "蝙蝠侠：黑暗骑士 2008 2160p DV REMUX CD1 中字"),
        cand("full-1080", "蝙蝠侠：黑暗骑士 2008 1080p WEB-DL 中字"),
      ],
      target,
      policy: high,
    });
    expect(selection.selected.map((c) => c.candidateId)).toEqual(["full-1080"]);
  });

  it("still picks a lone CD1 when it is the only match", () => {
    const selection = selectResourceCandidates({
      candidates: [cand("cd1", "蝙蝠侠：黑暗骑士 2008 1080p BluRay CD1 中字")],
      target,
      policy: high,
    });
    expect(selection.selected.map((c) => c.candidateId)).toEqual(["cd1"]);
    expect(selection.rejected.some((r) => r.reason === "incomplete-disc-set")).toBe(false);
  });

  it("does not multi-pick separate CD1 and CD2 shares (movies transfer one)", () => {
    const selection = selectResourceCandidates({
      candidates: [
        cand("cd1", "蝙蝠侠：黑暗骑士 2008 1080p BluRay CD1 中字"),
        cand("cd2", "蝙蝠侠：黑暗骑士 2008 1080p BluRay CD2 中字"),
      ],
      target,
      policy: high,
    });
    expect(selection.selected).toHaveLength(1);
    expect(["cd1", "cd2"]).toContain(selection.selected[0]!.candidateId);
    expect(selection.rejected.some((r) => r.reason === "outranked")).toBe(true);
    expect(selection.rejected.some((r) => r.reason === "incomplete-disc-set")).toBe(false);
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

  it("covers a versioned anime episode as the same SxxEN", () => {
    const selection = selectResourceCandidates({
      candidates: [cand("v2", "[LoliHouse] 葬送的芙莉莲 - 28v2 [WebRip 1080p][简繁内封字幕]")],
      target: {
        kind: "tv",
        title: "葬送的芙莉莲",
        aliases: ["Sousou no Frieren"],
        seasons: [1],
        missingEpisodes: ["S01E28"],
        preferredLanguage: "中文",
      },
    });
    expect(selection.selected.map((c) => c.candidateId)).toEqual(["v2"]);
    expect(selection.selected[0]!.coveredEpisodes).toEqual(["S01E28"]);
  });
});

function ep(n: number): string {
  return `S01E${String(n).padStart(2, "0")}`;
}

function eps(from: number, to: number): string[] {
  return Array.from({ length: to - from + 1 }, (_, i) => ep(from + i));
}

describe("selectResourceCandidates — scattered TV multi-share fill", () => {
  const show = {
    kind: "tv" as const,
    title: "Show",
    aliases: [],
    seasons: [1] as const,
    preferredLanguage: "中文",
    originCountries: ["CN"],
  };

  it("composes E01-E02 + E03 + E04-E06 when no complete pack exists", () => {
    const selection = selectResourceCandidates({
      candidates: [
        cand("a", "Show 1-2集 1080p WEB-DL"),
        cand("b", "Show 第3集 1080p WEB-DL"),
        cand("c", "Show 4-6集 1080p WEB-DL"),
        cand("noise", "流浪地球 全集 1080p"),
      ],
      target: { ...show, missingEpisodes: eps(1, 6) },
      policy: high,
    });
    expect(selection.selected.map((c) => c.candidateId).sort()).toEqual(["a", "b", "c"]);
    expect([...new Set(selection.selected.flatMap((c) => c.coveredEpisodes))].sort()).toEqual(eps(1, 6));
    expect(selection.reason).toMatch(/用 3 个分享补齐/);
    expect(selection.reason).toContain("S01E01–E06");
    expect(selection.rejected.some((r) => r.candidateId === "noise")).toBe(true);
  });

  it("prefers one denser 1080p pack over ten 4K singles when the pack is not a complete season", () => {
    const singles = eps(1, 10).map((code, i) => cand(`e${i + 1}`, `Show 第${i + 1}集 2160p WEB-DL`));
    const selection = selectResourceCandidates({
      candidates: [cand("dense", "Show 1-9集 1080p WEB-DL"), ...singles],
      target: { ...show, missingEpisodes: eps(1, 10) },
      policy: high,
    });
    expect(selection.selected.map((c) => c.candidateId)).toEqual(["dense", "e10"]);
    expect(selection.selected).toHaveLength(2);
    expect(selection.rejected.filter((r) => r.reason === "redundant-coverage").length).toBeGreaterThanOrEqual(9);
  });

  it("does not report empty selection just because a 全集 pack is absent", () => {
    const selection = selectResourceCandidates({
      candidates: [cand("a", "Show 1-2集 1080p WEB-DL"), cand("b", "Show 第4集 1080p WEB-DL")],
      target: { ...show, missingEpisodes: eps(1, 6) },
    });
    expect(selection.selected.map((c) => c.candidateId).sort()).toEqual(["a", "b"]);
    expect(selection.reason).toMatch(/整季包不可用/);
    expect(selection.reason).toMatch(/仍缺/);
    expect(selection.selected.length).toBeGreaterThan(0);
  });

  it("skips redundant overlapping packs (no extra transfers of the same episodes)", () => {
    const selection = selectResourceCandidates({
      candidates: [
        cand("low", "Show 1-6集 1080p WEB-DL"),
        cand("dup", "Show 1-6集 1080p WEB-DL 中字"),
        cand("overlap", "Show 4-8集 1080p WEB-DL"),
        cand("tail", "Show 7-10集 1080p WEB-DL"),
        cand("hi", "Show 1-6集 2160p WEB-DL"),
      ],
      target: { ...show, missingEpisodes: eps(1, 10) },
      policy: high,
    });
    expect(selection.selected.map((c) => c.candidateId).sort()).toEqual(["hi", "tail"]);
    expect(selection.selected).toHaveLength(2);
    expect(
      selection.rejected.filter((r) =>
        ["low", "dup", "overlap"].includes(r.candidateId) && r.reason === "redundant-coverage",
      ),
    ).toHaveLength(3);
  });

  it("keeps explicit scattered spans at high confidence (auto must not bounce to agent)", () => {
    const selection = selectResourceCandidates({
      candidates: [
        cand("a", "Show 1-2集 1080p WEB-DL"),
        cand("b", "Show 第3集 1080p WEB-DL"),
      ],
      target: { ...show, missingEpisodes: eps(1, 3) },
    });
    expect(
      assessRulesConfidence({
        target: { ...show, missingEpisodes: eps(1, 3) },
        selection,
        candidateCount: 2,
      }).confidence,
    ).toBe("high");
  });
});

describe("formatEpisodeCodes / describeTvSelection", () => {
  it("compresses consecutive SxxExx into an en-dash range", () => {
    expect(formatEpisodeCodes(["S01E01", "S01E02", "S01E03", "S01E05"])).toBe("S01E01–E03、S01E05");
    expect(formatEpisodeCodes(["S02E01", "S01E12", "S01E11"])).toBe("S01E11–E12、S02E01");
  });

  it("names a multi-share fill in 用 N 个分享补齐 form", () => {
    const selected = [
      {
        snapshotId: "s",
        candidateId: "a",
        title: "t",
        coveredEpisodes: ["S01E01", "S01E02"],
        qualityScore: 1,
        chineseScore: 0,
        totalScore: 10,
      },
      {
        snapshotId: "s",
        candidateId: "b",
        title: "t",
        coveredEpisodes: ["S01E03"],
        qualityScore: 1,
        chineseScore: 0,
        totalScore: 10,
      },
    ];
    expect(describeTvSelection(selected, ["S01E01", "S01E02", "S01E03"])).toBe(
      "规则选片：用 2 个分享补齐 S01E01–E03",
    );
    expect(describeTvSelection(selected, ["S01E01", "S01E02", "S01E03", "S01E04"])).toMatch(
      /用 2 个分享补齐 S01E01–E03（整季包不可用，仍缺 S01E04）/,
    );
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

describe("selectResourceCandidates — custom identifier words", () => {
  const dune = {
    kind: "movie" as const,
    title: "沙丘2",
    aliases: [],
    year: 2024,
  };

  it("rejects a messy share title without user words", () => {
    const selection = selectResourceCandidates({
      candidates: [cand("alias", "网盘乱码分享 2024 2160p DV 中字")],
      target: dune,
      policy: high,
    });
    expect(selection.selected).toEqual([]);
    expect(selection.rejected.some((r) => r.reason === "title-mismatch")).toBe(true);
  });

  it("matches after a stored from => to replacement", () => {
    const selection = selectResourceCandidates({
      candidates: [cand("alias", "网盘乱码分享 2024 2160p DV 中字")],
      target: dune,
      policy: high,
      customIdentifierWords: ["网盘乱码分享 => 沙丘2"],
    });
    expect(selection.selected.map((c) => c.candidateId)).toEqual(["alias"]);
  });

  it("maps TV coverage after an episode-offset word", () => {
    expect(
      mapTvCoverage({
        title: "进击的巨人 第08集 1080p",
        seasons: [1],
        missingEpisodes: ["S01E10"],
        customWords: ["第 <> 集 >> EP+2"],
      }),
    ).toEqual(["S01E10"]);
    expect(
      mapTvCoverage({
        title: "进击的巨人 第08集 1080p",
        seasons: [1],
        missingEpisodes: ["S01E10"],
      }),
    ).toEqual([]);
  });
});

describe("selectResourceCandidates — folder + filename", () => {
  it("covers SxxExx when the share title is folder/file", () => {
    const selection = selectResourceCandidates({
      candidates: [cand("ep", joinReleaseTitleParts(["庆余年 第二季", "E01.mkv"]))],
      target: {
        kind: "tv",
        title: "庆余年",
        aliases: [],
        seasons: [2],
        missingEpisodes: ["S02E01", "S02E02"],
      },
    });
    expect(selection.selected.map((c) => c.candidateId)).toEqual(["ep"]);
    expect(selection.selected[0]!.coveredEpisodes).toEqual(["S02E01"]);
  });

  it("ranks by leaf quality, not a higher parent pix token", () => {
    const selection = selectResourceCandidates({
      candidates: [
        cand("parent4k", joinReleaseTitleParts(["庆余年 第二季 2160p 中字", "S02E01.1080p.mkv"])),
        cand("leaf4k", joinReleaseTitleParts(["庆余年 第二季 1080p 中字", "S02E01.2160p.mkv"])),
      ],
      target: {
        kind: "tv",
        title: "庆余年",
        aliases: [],
        seasons: [2],
        missingEpisodes: ["S02E01"],
        preferredLanguage: "中文",
        originCountries: ["CN"],
      },
      policy: high,
    });
    expect(selection.selected.map((c) => c.candidateId)).toEqual(["leaf4k"]);
  });
});

describe("chineseSubtitleScore — finer language tiers", () => {
  it("orders 简繁内封 > 简中 > 中字 > 繁中 > 国语 > CJK > 生肉 > English scene", () => {
    const score = (title: string) => chineseSubtitleScore(title, true, false);
    expect(score("Show 2024 1080p 简繁内封字幕")).toBe(160);
    expect(score("Show 2024 1080p 简中")).toBe(140);
    expect(score("Show 2024 1080p 中字")).toBe(120);
    expect(score("Show 2024 1080p 中英双语")).toBe(120);
    expect(score("Show 2024 1080p 中日双语")).toBe(120);
    expect(score("Show 2024 1080p 繁中内封")).toBe(115);
    expect(score("Show 2024 1080p 繁中")).toBe(100);
    expect(score("Show 2024 1080p 国语")).toBe(70);
    expect(score("Show 2024 1080p 粤语")).toBe(55);
    expect(score("沙丘2 2024 1080p")).toBe(40);
    expect(score("Show 2024 1080p 生肉")).toBe(-40);
    expect(score("Show.2024.1080p.WEB-DL.x264")).toBe(-80);
    expect(score("Show.2024.1080p.CHS-ENG.WEB-DL")).toBe(140);
  });

  it("short-circuits originCN and preferChinese false", () => {
    expect(chineseSubtitleScore("Show 2024 1080p 简繁内封", true, true)).toBe(0);
    expect(chineseSubtitleScore("Show.2024.1080p.WEB-DL.x264", true, true)).toBe(0);
    expect(chineseSubtitleScore("庆余年 2024 生肉", true, true)).toBe(0);
    expect(chineseSubtitleScore("Show 2024 1080p 中字", false, false)).toBe(0);
    expect(chineseSubtitleScore("Show.2024.1080p.WEB-DL.x264", false, false)).toBe(0);
  });

  it("picks 简繁内封 over plain 中字 at the same quality", () => {
    const selection = selectResourceCandidates({
      candidates: [
        cand("plain", "蝙蝠侠：黑暗骑士 2008 1080p WEB-DL 中字"),
        cand("chs", "蝙蝠侠：黑暗骑士 2008 1080p WEB-DL 简繁内封字幕"),
        cand("cht", "蝙蝠侠：黑暗骑士 2008 1080p WEB-DL 繁中"),
      ],
      target: {
        kind: "movie" as const,
        title: "蝙蝠侠：黑暗骑士",
        aliases: ["The Dark Knight"],
        year: 2008,
        preferredLanguage: "中文",
      },
      policy: high,
    });
    expect(selection.selected.map((c) => c.candidateId)).toEqual(["chs"]);
  });

  it("does not let subtitle tiers overrule originCN quality ranking", () => {
    const selection = selectResourceCandidates({
      candidates: [
        cand("sdr", "庆余年 2019 1080p WEB-DL 简繁内封"),
        cand("dv", "庆余年 2019 2160p DV REMUX"),
      ],
      target: {
        kind: "movie" as const,
        title: "庆余年",
        aliases: [],
        year: 2019,
        preferredLanguage: "中文",
        originCountries: ["CN"],
      },
      policy: high,
    });
    expect(selection.selected.map((c) => c.candidateId)).toEqual(["dv"]);
  });
});

describe("assessRulesConfidence", () => {
  it("is high for an explicit movie pick and a TV SxxExx / 全集 pack", () => {
    const movie = selectResourceCandidates({
      candidates: [cand("dv", "盗梦空间 2010 2160p DV REMUX 中字")],
      target: { kind: "movie", title: "盗梦空间", aliases: ["Inception"], year: 2010 },
      policy: high,
    });
    expect(
      assessRulesConfidence({ target: { kind: "movie", title: "盗梦空间", aliases: [], year: 2010 }, selection: movie, candidateCount: 1 })
        .confidence,
    ).toBe("high");

    const tv = selectResourceCandidates({
      candidates: [cand("ep", "庆余年 S01E01 1080p")],
      target: {
        kind: "tv",
        title: "庆余年",
        aliases: [],
        seasons: [1],
        missingEpisodes: ["S01E01"],
      },
    });
    expect(
      assessRulesConfidence({
        target: { kind: "tv", title: "庆余年", aliases: [], seasons: [1], missingEpisodes: ["S01E01"] },
        selection: tv,
        candidateCount: 1,
      }).confidence,
    ).toBe("high");
  });

  it("is low when TV titles match but have no episode coverage", () => {
    const selection = selectResourceCandidates({
      candidates: [cand("date", "快乐大本营 2024.03.15 1080p")],
      target: {
        kind: "tv",
        title: "快乐大本营",
        aliases: [],
        seasons: [1],
        missingEpisodes: ["S01E01"],
      },
    });
    expect(selection.selected).toEqual([]);
    const report = assessRulesConfidence({
      target: {
        kind: "tv",
        title: "快乐大本营",
        aliases: [],
        seasons: [1],
        missingEpisodes: ["S01E01"],
      },
      selection,
      candidateCount: 1,
    });
    expect(report.confidence).toBe("low");
    expect(report.reasons).toContain("no-episode-coverage");
  });

  it("is high when the empty set is only a hard quality-floor reject (do not escalate to agent)", () => {
    const movieSel = selectResourceCandidates({
      candidates: [cand("low", "盗梦空间 2010 720p WEB-DL 中字")],
      target: { kind: "movie", title: "盗梦空间", aliases: ["Inception"], year: 2010 },
      policy: qualityLadderPolicyFromFlags({ resolutionFloor: "1080p" }),
    });
    expect(movieSel.selected).toEqual([]);
    expect(movieSel.rejected.some((row) => row.reason === BELOW_QUALITY_FLOOR_REASON)).toBe(true);
    expect(
      assessRulesConfidence({
        target: { kind: "movie", title: "盗梦空间", aliases: ["Inception"], year: 2010 },
        selection: movieSel,
        candidateCount: 1,
      }),
    ).toEqual({ confidence: "high", reasons: [] });

    const tvSel = selectResourceCandidates({
      candidates: [cand("pack", "Show 全集 720p WEB-DL")],
      target: {
        kind: "tv",
        title: "Show",
        aliases: [],
        seasons: [1],
        missingEpisodes: ["S01E01"],
        originCountries: ["CN"],
      },
      policy: qualityLadderPolicyFromFlags({ resolutionFloor: "1080p" }),
    });
    expect(
      assessRulesConfidence({
        target: {
          kind: "tv",
          title: "Show",
          aliases: [],
          seasons: [1],
          missingEpisodes: ["S01E01"],
          originCountries: ["CN"],
        },
        selection: tvSel,
        candidateCount: 1,
      }).confidence,
    ).toBe("high");
  });

  it("is low for sequel-or-year-only leftovers and for an empty pool", () => {
    const sequels = selectResourceCandidates({
      candidates: [cand("rises", "蝙蝠侠：黑暗骑士崛起 2012 1080p")],
      target: { kind: "movie", title: "蝙蝠侠：黑暗骑士", aliases: [], year: 2008 },
    });
    expect(
      assessRulesConfidence({
        target: { kind: "movie", title: "蝙蝠侠：黑暗骑士", aliases: [], year: 2008 },
        selection: sequels,
        candidateCount: 1,
      }).reasons,
    ).toContain("sequel-or-year");

    expect(
      assessRulesConfidence({
        target: { kind: "movie", title: "盗梦空间", aliases: [], year: 2010 },
        selection: { selected: [], rejected: [], reason: "none" },
        candidateCount: 0,
      }).reasons,
    ).toContain("no-candidates");
  });

  it("is low for a season-named pack with no episode span", () => {
    const selection = selectResourceCandidates({
      candidates: [cand("s2", "Show 第二季 1080p")],
      target: {
        kind: "tv",
        title: "Show",
        aliases: [],
        seasons: [2],
        missingEpisodes: ["S02E01", "S02E10"],
      },
    });
    expect(selection.selected.length).toBeGreaterThan(0);
    const report = assessRulesConfidence({
      target: {
        kind: "tv",
        title: "Show",
        aliases: [],
        seasons: [2],
        missingEpisodes: ["S02E01", "S02E10"],
      },
      selection,
      candidateCount: 1,
    });
    expect(report.confidence).toBe("low");
    expect(report.reasons).toContain("season-pack-without-span");
  });
});

describe("selectResourceCandidates — quality floor hard reject", () => {
  const movie = {
    kind: "movie" as const,
    title: "蝙蝠侠：黑暗骑士",
    aliases: ["The Dark Knight"],
    year: 2008,
  };
  const tv = {
    kind: "tv" as const,
    title: "Show",
    aliases: [] as string[],
    seasons: [1],
    missingEpisodes: ["S01E01", "S01E02"],
    originCountries: ["CN"],
  };

  it("global 1080p floor rejects 720p/SD even when they are the only candidates", () => {
    const movieSel = selectResourceCandidates({
      candidates: [cand("low", "蝙蝠侠：黑暗骑士 2008 720p WEB-DL 中字")],
      target: movie,
      policy: qualityLadderPolicyFromFlags({ resolutionFloor: "1080p" }),
    });
    expect(movieSel.selected).toEqual([]);
    expect(movieSel.rejected.some((row) => row.reason === BELOW_QUALITY_FLOOR_REASON)).toBe(true);
    expect(movieSel.reason).toMatch(/画质下限/);

    const tvSel = selectResourceCandidates({
      candidates: [cand("pack", "Show 全集 720p WEB-DL")],
      target: tv,
      policy: qualityLadderPolicyFromFlags({ resolutionFloor: "1080p" }),
    });
    expect(tvSel.selected).toEqual([]);
    expect(tvSel.rejected.some((row) => row.reason === BELOW_QUALITY_FLOOR_REASON)).toBe(true);
    expect(tvSel.reason).toMatch(/画质下限/);
  });

  it("per-run override can raise or disable the global floor", () => {
    const raised = selectResourceCandidates({
      candidates: [cand("fhd", "蝙蝠侠：黑暗骑士 2008 1080p WEB-DL 中字")],
      target: movie,
      policy: qualityLadderPolicyFromFlags({ resolutionFloor: "4k" }),
    });
    expect(raised.selected).toEqual([]);
    expect(raised.rejected.some((row) => row.reason === BELOW_QUALITY_FLOOR_REASON)).toBe(true);

    const disabled = selectResourceCandidates({
      candidates: [cand("sd", "蝙蝠侠：黑暗骑士 2008 720p WEB-DL 中字")],
      target: movie,
      policy: qualityLadderPolicyFromFlags({}),
    });
    expect(disabled.selected.map((row) => row.candidateId)).toEqual(["sd"]);
  });

  it("below-floor packs never fill the multi-share cover as the only option", () => {
    const selection = selectResourceCandidates({
      candidates: [
        cand("hi", "Show S01E01 1080p WEB-DL"),
        cand("filler", "Show 全集 720p WEB-DL"),
      ],
      target: { ...tv, missingEpisodes: ["S01E01", "S01E02"] },
      policy: qualityLadderPolicyFromFlags({ resolutionPreference: "high", resolutionFloor: "1080p" }),
    });
    expect(selection.selected.map((row) => row.candidateId)).toEqual(["hi"]);
    expect(selection.rejected.some((row) => row.candidateId === "filler" && row.reason === BELOW_QUALITY_FLOOR_REASON)).toBe(
      true,
    );
  });
});
