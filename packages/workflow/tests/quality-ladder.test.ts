import { describe, expect, it } from "vitest";
import {
  compareReleaseQuality,
  composeAcquisitionQualityGuidance,
  describeQualityLadder,
  formatHdrLadderGuidance,
  formatQualityLadderSummary,
  formatReleaseQualityLabel,
  formatTargetQualityLabel,
  describeUpgradeOpportunity,
  hasQualityEvidence,
  HDR_LADDER_LINES,
  landedQualityTitlesFromAcquisition,
  parseAudioClass,
  parseHdrFormat,
  parseReleaseQuality,
  parseResolutionBand,
  parseSourceClass,
  PATROL_GAP_ONLY_LINE,
  QUALITY_SEARCH_TOKEN_LAW,
  QUALITY_UPGRADE_LINES,
  shouldReplaceCoverage,
  shouldScheduleQualityUpgrade,
  SOURCE_LADDER_LINES,
  summarizeLandedQuality,
} from "../src/acquisition-v2/quality-ladder.js";

describe("parseHdrFormat", () => {
  it("ranks Dolby Vision tokens first (DV / DoVi / 杜比视界)", () => {
    expect(parseHdrFormat("Movie.2024.2160p.BluRay.DV.HDR10.mkv")).toBe("dv");
    expect(parseHdrFormat("沙丘2 杜比视界 REMUX")).toBe("dv");
    expect(parseHdrFormat("Dune.DoVi.2160p")).toBe("dv");
    expect(parseHdrFormat("Title Dolby Vision")).toBe("dv");
  });

  it("detects HDR10+ before plain HDR", () => {
    expect(parseHdrFormat("Show.1080p.HDR10+.WEB-DL")).toBe("hdr10plus");
    expect(parseHdrFormat("Show HDR10 Plus")).toBe("hdr10plus");
    expect(parseHdrFormat("Show.hdr10plus.mkv")).toBe("hdr10plus");
  });

  it("detects HDR10 / HDR, else SDR", () => {
    expect(parseHdrFormat("Film.2160p.HDR10.mkv")).toBe("hdr10");
    expect(parseHdrFormat("Film 4K HDR WEB-DL")).toBe("hdr10");
    expect(parseHdrFormat("庆余年 1080P 全集")).toBe("sdr");
  });
});

describe("parseResolutionBand", () => {
  it("reads 4K / 1080p / 720p / sd / unknown", () => {
    expect(parseResolutionBand("Movie.2160p.REMUX")).toBe("4k");
    expect(parseResolutionBand("Movie 4K UHD")).toBe("4k");
    expect(parseResolutionBand("Show.1080p.BluRay")).toBe("1080p");
    expect(parseResolutionBand("Show.720p.WEB-DL")).toBe("720p");
    expect(parseResolutionBand("Preview.480p")).toBe("sd");
    expect(parseResolutionBand("名称: 奥本海默")).toBe("unknown");
  });
});

describe("parseReleaseQuality disc images", () => {
  it("flags ISO / BDMV / 原盘", () => {
    expect(parseReleaseQuality("Movie.4K.BDMV.ISO").discImage).toBe(true);
    expect(parseReleaseQuality("沙丘 4K 蓝光原盘").discImage).toBe(true);
    expect(parseReleaseQuality("Movie.2160p.REMUX.mkv").discImage).toBe(false);
  });
});

describe("parseSourceClass", () => {
  it("reads Remux / BluRay / WEB-DL / WEBRip / HDTV / CAM", () => {
    expect(parseSourceClass("Movie.2160p.REMUX.mkv")).toBe("remux");
    expect(parseSourceClass("Show.1080p.BluRay.mkv")).toBe("bluray");
    expect(parseSourceClass("沙丘 4K 蓝光")).toBe("bluray");
    expect(parseSourceClass("Show.1080p.WEB-DL.mkv")).toBe("webdl");
    expect(parseSourceClass("Show.1080p.WEBRip.mkv")).toBe("webrip");
    expect(parseSourceClass("Show.720p.HDTV.mkv")).toBe("hdtv");
    expect(parseSourceClass("Movie.CAM.mkv")).toBe("cam");
    expect(parseSourceClass("电影 枪版")).toBe("cam");
    expect(parseSourceClass("名称: 奥本海默")).toBe("unknown");
  });

  it("prefers Remux over a co-occurring BluRay token", () => {
    expect(parseSourceClass("Movie.2160p.BluRay.REMUX.mkv")).toBe("remux");
  });
});

describe("Chinese / cloud-share title and filename patterns", () => {
  it("reads 网盘 bracket / fullwidth / dotted scene names", () => {
    expect(parseResolutionBand("【４Ｋ】沙丘2 2024")).toBe("4k");
    expect(parseHdrFormat("【杜比视界】沙丘：第二部")).toBe("dv");
    expect(parseHdrFormat("Show.HDR10＋.WEB.DL")).toBe("hdr10plus");
    expect(parseSourceClass("狂飙.2023.WEB.DL.1080p")).toBe("webdl");
    expect(parseSourceClass("权力的游戏 S01 蓝光1080P")).toBe("bluray");
    expect(parseAudioClass("Movie.True.HD.7.1.mkv")).toBe("truehd");
    expect(parseAudioClass("Movie.DTS.HD.MA.mkv")).toBe("dtshd");
  });

  it("reads common Chinese aliases (超高清 / 全高清 / 超清 / 无压 / 官源 / 尝鲜版)", () => {
    expect(parseResolutionBand("三体 4K超高清 全集")).toBe("4k");
    expect(parseResolutionBand("庆余年 超高清")).toBe("4k");
    expect(parseResolutionBand("庆余年 第一季 全高清完整版")).toBe("1080p");
    expect(parseResolutionBand("狂飙 超清 全集")).toBe("1080p");
    expect(parseResolutionBand("最后生还者 2K")).toBe("1080p");
    expect(parseSourceClass("沙丘2 4K无压")).toBe("remux");
    expect(parseSourceClass("热辣滚烫 官源 1080P")).toBe("webdl");
    expect(parseSourceClass("电影 尝鲜版")).toBe("cam");
    expect(parseSourceClass("预告 抢先版")).toBe("cam");
    expect(parseAudioClass("沙丘 全景声")).toBe("atmos");
  });

  it("does not treat 超高清 as 1080p 超清", () => {
    expect(parseResolutionBand("电影 超高清")).toBe("4k");
  });
});

describe("parseAudioClass", () => {
  it("reads Atmos before TrueHD, then DTS-HD", () => {
    expect(parseAudioClass("Movie.TrueHD.Atmos.mkv")).toBe("atmos");
    expect(parseAudioClass("沙丘 杜比全景声")).toBe("atmos");
    expect(parseAudioClass("Movie.TrueHD.7.1.mkv")).toBe("truehd");
    expect(parseAudioClass("Movie.DTS-HD.MA.mkv")).toBe("dtshd");
    expect(parseAudioClass("Show.1080p.AAC.mkv")).toBe("unknown");
  });
});

describe("compareReleaseQuality — resolution-first (default)", () => {
  const high = { resolutionPreference: "high" as const };

  it("prefers 4K DV over 4K SDR", () => {
    expect(
      compareReleaseQuality("Dune.2160p.DV.mkv", "Dune.2160p.SDR.mkv", high),
    ).toBeGreaterThan(0);
  });

  it("does NOT prefer 1080p DV over 4K SDR", () => {
    expect(
      compareReleaseQuality(
        "Dune.1080p.DoVi.mkv",
        "Dune.2160p.WEB-DL.mkv",
        high,
      ),
    ).toBeLessThan(0);
  });

  it("HDR10+ beats HDR10 at the same resolution", () => {
    expect(
      compareReleaseQuality("Show.1080p.HDR10+.mkv", "Show.1080p.HDR10.mkv", high),
    ).toBeGreaterThan(0);
  });

  it("medium ceiling: 1080p beats 4K", () => {
    const medium = { resolutionPreference: "medium" as const };
    expect(
      compareReleaseQuality("Show.1080p.mkv", "Show.2160p.REMUX.mkv", medium),
    ).toBeGreaterThan(0);
  });

  it("playable video beats a disc image even if the disc claims 4K", () => {
    expect(
      compareReleaseQuality("Movie.1080p.mkv", "Movie.4K.BDMV.ISO", high),
    ).toBeGreaterThan(0);
  });
});

describe("preferHdrOverResolution", () => {
  it("lets 1080p DV beat 4K SDR when configured", () => {
    const policy = { resolutionPreference: "high" as const, preferHdrOverResolution: true };
    expect(
      compareReleaseQuality("Dune.1080p.DV.mkv", "Dune.2160p.WEB-DL.mkv", policy),
    ).toBeGreaterThan(0);
  });
});

describe("source class and audio — richer post-recall ranking", () => {
  const high = { resolutionPreference: "high" as const };

  it("Remux beats WEB-DL at the same resolution and HDR", () => {
    expect(
      compareReleaseQuality("Dune.2160p.DV.REMUX.mkv", "Dune.2160p.DV.WEB-DL.mkv", high),
    ).toBeGreaterThan(0);
  });

  it("BluRay beats WEBRip at the same resolution", () => {
    expect(
      compareReleaseQuality("Show.1080p.BluRay.mkv", "Show.1080p.WEBRip.mkv", high),
    ).toBeGreaterThan(0);
  });

  it("does NOT treat unlabeled as worse than WEB-DL (missing labels are not punished)", () => {
    expect(
      shouldReplaceCoverage("Show.1080p.mkv", "Show.1080p.WEB-DL.mkv", high),
    ).toBe(false);
    expect(
      compareReleaseQuality("Show.1080p.mkv", "Show.1080p.WEB-DL.mkv", high),
    ).toBe(0);
  });

  it("BluRay may replace an unlabeled file at the same resolution", () => {
    expect(
      shouldReplaceCoverage("Show.1080p.mkv", "Show.1080p.BluRay.mkv", high),
    ).toBe(true);
  });

  it("CAM loses to an unlabeled 1080p file", () => {
    expect(
      compareReleaseQuality("Show.1080p.mkv", "Show.1080p.CAM.mkv", high),
    ).toBeGreaterThan(0);
  });

  it("does not let source class beat a higher resolution (resolution-first)", () => {
    expect(
      compareReleaseQuality("Dune.1080p.BluRay.REMUX.mkv", "Dune.2160p.WEB-DL.mkv", high),
    ).toBeLessThan(0);
  });

  it("Atmos is only a tiebreaker at otherwise equal rungs", () => {
    expect(
      shouldReplaceCoverage("Show.1080p.WEB-DL.mkv", "Show.1080p.WEB-DL.Atmos.mkv", high),
    ).toBe(true);
    expect(
      compareReleaseQuality("Show.1080p.WEB-DL.Atmos.mkv", "Show.2160p.WEB-DL.mkv", high),
    ).toBeLessThan(0);
  });

  it("does not replace when the only difference is a missing audio tag vs DTS-HD? Atmos still wins; unlabeled vs DTS-HD is a soft upgrade", () => {
    expect(
      shouldReplaceCoverage("Show.1080p.WEB-DL.mkv", "Show.1080p.WEB-DL.DTS-HD.mkv", high),
    ).toBe(true);
    expect(
      shouldReplaceCoverage("Show.1080p.WEB-DL.DTS-HD.mkv", "Show.1080p.WEB-DL.mkv", high),
    ).toBe(false);
  });

  it("considerSourceClass false ignores encode class", () => {
    const off = { resolutionPreference: "high" as const, considerSourceClass: false };
    expect(
      shouldReplaceCoverage("Show.1080p.mkv", "Show.1080p.BluRay.mkv", off),
    ).toBe(false);
    expect(
      compareReleaseQuality("Show.1080p.BluRay.mkv", "Show.1080p.WEBRip.mkv", off),
    ).toBe(0);
  });
});

describe("shouldReplaceCoverage — upgrade decision", () => {
  const high = { resolutionPreference: "high" as const };

  it("replaces only when the candidate is strictly better", () => {
    expect(
      shouldReplaceCoverage("Show.1080p.mkv", "Show.2160p.DV.mkv", high),
    ).toBe(true);
    expect(
      shouldReplaceCoverage("Show.2160p.DV.mkv", "Show.2160p.DoVi.mkv", high),
    ).toBe(false);
    expect(
      shouldReplaceCoverage("Show.2160p.DV.mkv", "Show.1080p.DV.mkv", high),
    ).toBe(false);
  });

  it("never upgrades a playable file to a disc image", () => {
    expect(
      shouldReplaceCoverage("Show.1080p.mkv", "Show.4K.原盘.ISO", high),
    ).toBe(false);
  });

  it("does not replace Remux with a lower encode even when HDR matches", () => {
    expect(
      shouldReplaceCoverage("Show.2160p.DV.REMUX.mkv", "Show.2160p.DV.WEB-DL.mkv", high),
    ).toBe(false);
  });

  it("does not rewrite when quality is equal (conservative)", () => {
    expect(
      shouldReplaceCoverage("A.1080p.HDR.mkv", "B.1080p.HDR10.mkv", high),
    ).toBe(false);
  });

  it("medium: does not replace 1080p with 4K", () => {
    expect(
      shouldReplaceCoverage("Show.1080p.mkv", "Show.2160p.mkv", {
        resolutionPreference: "medium",
      }),
    ).toBe(false);
  });
});

describe("guidance copy (prompt/skill shared strings)", () => {
  it("HDR guidance names the four rungs and the resolution-first rule", () => {
    const g = formatHdrLadderGuidance();
    expect(g).toContain("Dolby Vision");
    expect(g).toContain("HDR10+");
    expect(g).toContain("SDR");
    expect(g).toContain("4K DV");
    expect(g).toContain("1080p DV");
    expect(g).toContain(QUALITY_SEARCH_TOKEN_LAW);
    expect(g).toContain(HDR_LADDER_LINES[0]);
    expect(g).toContain(SOURCE_LADDER_LINES[0]);
    expect(g).toMatch(/Atmos/);
  });

  it("describeQualityLadder puts HDR first when preferHdrOverResolution is on", () => {
    const axes = describeQualityLadder({ preferHdrOverResolution: true });
    expect(axes[0]?.id).toBe("hdr");
    expect(axes.find((axis) => axis.id === "source")?.enabled).toBe(true);
    expect(formatQualityLadderSummary({ resolutionPreference: "high" })).toMatch(/比较顺序/);
    expect(formatTargetQualityLabel({ resolutionPreference: "high" })).toMatch(/4K/);
    expect(formatReleaseQualityLabel(parseReleaseQuality("Dune.2160p.DV.REMUX.Atmos.mkv"))).toMatch(
      /4K.*杜比视界.*Remux.*Atmos/,
    );
  });

  it("source-off guidance is explicit", () => {
    const g = formatHdrLadderGuidance({ considerSourceClass: false });
    expect(g).toMatch(/片源\/压制阶梯已关闭/);
  });

  it("HDR-over-resolution variant is explicit", () => {
    const g = formatHdrLadderGuidance({ preferHdrOverResolution: true });
    expect(g).toMatch(/HDR 优先于分辨率/);
    expect(g).toMatch(/1080p DV/);
  });

  it("compose includes upgrade lines only when requested", () => {
    const off = composeAcquisitionQualityGuidance({ resolutionGuidance: "画质偏好:高。" });
    expect(off).toContain("画质偏好:高");
    expect(off).toContain("Dolby Vision");
    expect(off).not.toContain(QUALITY_UPGRADE_LINES[0]);
    expect(off).toContain(PATROL_GAP_ONLY_LINE);

    const on = composeAcquisitionQualityGuidance({
      resolutionGuidance: "画质偏好:高。",
      qualityUpgrade: true,
    });
    expect(on).toContain(QUALITY_UPGRADE_LINES[0]);
    expect(on).toContain("严格更高");
    expect(on).not.toContain(PATROL_GAP_ONLY_LINE);
  });
});

describe("true upgrade detection — current vs preference target", () => {
  const high = { resolutionPreference: "high" as const };

  it("summarizes mixed files by the lowest parseable quality", () => {
    const summary = summarizeLandedQuality(
      [
        "Show.S01E01.2160p.DV.mkv",
        "Show.S01E02.720p.WEBRip.mkv",
        "readme.txt",
      ],
      high,
    );
    expect(summary.mixed).toBe(true);
    expect(summary.current?.resolution).toBe("720p");
    expect(hasQualityEvidence(summary.current!)).toBe(true);
  });

  it("treats generic episode names as unknown evidence", () => {
    const summary = summarizeLandedQuality(["Show - 01.mkv", "Show - 02.mkv"], high);
    expect(summary.current).toBeNull();
    const view = describeUpgradeOpportunity(null, high);
    expect(view.evidence).toBe("unknown");
    expect(view.headline).toMatch(/未能从已入库文件名判断画质/);
    expect(shouldScheduleQualityUpgrade(null, high)).toBe(true);
  });

  it("writes 现在 → 可升 from parsed 1080p WEB-DL toward 4K DV", () => {
    const current = parseReleaseQuality("庆余年.S01E01.1080p.WEB-DL.mkv");
    const view = describeUpgradeOpportunity(current, high);
    expect(view.evidence).toBe("parsed");
    expect(view.belowPreference).toBe(true);
    expect(view.headline).toBe("现在 1080p WEB-DL → 可升 4K 杜比视界");
    expect(shouldScheduleQualityUpgrade(current, high)).toBe(true);
  });

  it("does not schedule an upgrade when already at the ladder top", () => {
    const current = parseReleaseQuality("Dune.2160p.DV.REMUX.mkv");
    const view = describeUpgradeOpportunity(current, high);
    expect(view.atLadderTop).toBe(true);
    expect(view.headline).toMatch(/已达偏好阶梯顶部/);
    expect(shouldScheduleQualityUpgrade(current, high)).toBe(false);
  });

  it("does not fake a specific better target when current already matches 4K DV Remux", () => {
    const current = parseReleaseQuality("Movie.2160p.DoVi.REMUX.mkv");
    expect(describeUpgradeOpportunity(current, high).belowPreference).toBe(false);
  });

  it("reads transferred share titles when filenames themselves are generic", () => {
    const titles = landedQualityTitlesFromAcquisition({
      snapshots: [
        {
          candidates: [
            { id: "c1", title: "沙丘2 2024 1080P WEB-DL 中字" },
            { id: "c2", title: "无关" },
          ],
        },
      ],
      transferAttempts: [{ candidateId: "c1", status: "succeeded" }],
    });
    expect(titles).toEqual(["沙丘2 2024 1080P WEB-DL 中字"]);
    expect(summarizeLandedQuality(titles, high).current?.resolution).toBe("1080p");
  });
});
