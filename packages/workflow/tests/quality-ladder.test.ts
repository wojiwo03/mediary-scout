import { describe, expect, it } from "vitest";
import {
  compareReleaseQuality,
  composeAcquisitionQualityGuidance,
  formatHdrLadderGuidance,
  HDR_LADDER_LINES,
  parseHdrFormat,
  parseReleaseQuality,
  parseResolutionBand,
  PATROL_GAP_ONLY_LINE,
  QUALITY_SEARCH_TOKEN_LAW,
  QUALITY_UPGRADE_LINES,
  shouldReplaceCoverage,
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
