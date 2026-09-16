import { describe, expect, it } from "vitest";
import { parseReleaseQuality, shouldReplaceCoverage } from "../src/acquisition-v2/quality-ladder.js";
import { mapTvCoverage } from "../src/acquisition-v2/rules-selector.js";
import { isAnimeTitle, parseReleaseMeta } from "../src/acquisition-v2/release-meta.js";

/**
 * Golden titles shaped like MoviePilot MetaInfo inputs (PT / WEB / 网盘分享 /
 * anime fansub). Behavior is aligned with MoviePilot v3 MetaVideo/MetaAnime
 * fields — not a live MoviePilot call.
 */
describe("parseReleaseMeta — MoviePilot-style golden titles", () => {
  it("PT UHD BluRay REMUX + DoVi + Atmos + group", () => {
    const meta = parseReleaseMeta(
      "The.Mandalorian.S03E01.2160p.UHD.BluRay.REMUX.HDR10.DoVi.TrueHD.Atmos-FRDS",
    );
    expect(meta.resolution).toBe("4k");
    expect(meta.hdr).toBe("dv");
    expect(meta.source).toBe("remux");
    expect(meta.audio).toBe("atmos");
    expect(meta.resourceType).toBe("REMUX");
    expect(meta.resourcePix).toMatch(/2160p|4k|uhd/i);
    expect(meta.resourceEffect).toEqual(expect.arrayContaining(["DoVi", "HDR10"]));
    expect(meta.releaseGroup).toMatch(/FRDS/i);
    expect(meta.seasons).toEqual([3]);
    expect(meta.episode).toEqual({ from: 1, to: 1, complete: false });
  });

  it("streaming WEB-DL with platform code, H.265, DDP, DV", () => {
    const meta = parseReleaseMeta(
      "The.Last.of.Us.S01E03.2160p.DSNP.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX",
    );
    expect(meta.resolution).toBe("4k");
    expect(meta.hdr).toBe("dv");
    expect(meta.source).toBe("webdl");
    expect(meta.webSource).toBe("Disney+");
    expect(meta.videoCodec).toBe("h265");
    expect(meta.audio).toBe("atmos");
    expect(meta.audioCodec).toMatch(/ddp|atmos/i);
    expect(meta.seasons).toEqual([1]);
    expect(meta.episode?.from).toBe(3);
  });

  it("Chinese cloud-share: 杜比视界 / 无压 / 超高清 / 中字", () => {
    const meta = parseReleaseMeta("沙丘2 2024 超高清 杜比视界 无压 中字");
    expect(meta.resolution).toBe("4k");
    expect(meta.hdr).toBe("dv");
    expect(meta.source).toBe("remux");
    expect(meta.year).toBe(2024);
    expect(meta.discImage).toBe(false);
  });

  it("官源 WEB.DL + 爱奇艺 platform name", () => {
    const meta = parseReleaseMeta("狂飙.2023.爱奇艺.WEB.DL.1080p.H264.AAC");
    expect(meta.source).toBe("webdl");
    expect(meta.webSource).toBe("iQIYI");
    expect(meta.videoCodec).toBe("h264");
    expect(meta.year).toBe(2023);
  });

  it("Netflix / AMZN codes only count next to WEB", () => {
    expect(parseReleaseMeta("Oppenheimer.2023.2160p.NF.WEB-DL.DDP5.1.Atmos.H265-HHWEB").webSource).toBe(
      "Netflix",
    );
    expect(parseReleaseMeta("Oppenheimer.2023.2160p.AMZN.WEB-DL.DDP.Atmos").webSource).toBe("Amazon");
    expect(parseReleaseMeta("A Random Title Without Web Tags NF")).not.toHaveProperty("webSource");
  });

  it("HDR10P / HLG / HDRip / DVDRip aliases MoviePilot also recognizes", () => {
    expect(parseReleaseQuality("Show.1080p.HDR10P.WEB-DL").hdr).toBe("hdr10plus");
    expect(parseReleaseQuality("Show.1080p.HLG.WEB-DL").hdr).toBe("hdr10");
    expect(parseReleaseQuality("Show.1080p.HDRip").source).toBe("bluray");
    expect(parseReleaseQuality("Show.576p.DVDRip").source).toBe("hdtv");
  });

  it("anime fansub: dash-episode + LoliHouse + 10bit HEVC", () => {
    const title =
      "[LoliHouse] 葬送的芙莉莲 / Sousou no Frieren - 28 [WebRip 1080p HEVC-10bit AAC][简繁内封字幕]";
    expect(isAnimeTitle(title)).toBe(true);
    const meta = parseReleaseMeta(title);
    expect(meta.resolution).toBe("1080p");
    expect(meta.source).toBe("webrip");
    expect(meta.videoCodec).toBe("h265");
    expect(meta.videoBit).toBe("10bit");
    expect(meta.releaseGroup).toMatch(/LoliHouse/i);
    expect(meta.episode).toEqual({ from: 28, to: 28, complete: false });
  });

  it("anime bracket episode + 喵萌奶茶屋 + 第N话", () => {
    const bracket = parseReleaseMeta("【喵萌奶茶屋】[鬼灭之刃 柱训练篇][08][1080p][简日双语]");
    expect(bracket.releaseGroup).toMatch(/喵萌奶茶屋/);
    expect(bracket.episode?.from).toBe(8);
    expect(parseReleaseMeta("进击的巨人 第十三话 1080p").episode).toEqual({
      from: 13,
      to: 13,
      complete: false,
    });
  });

  it("01-26Fin complete range (not a year span)", () => {
    expect(parseReleaseMeta("某科学的超电磁炮 01-26Fin 1080p").episode).toEqual({
      from: 1,
      to: 26,
      complete: true,
    });
    expect(parseReleaseMeta("Show 2019-2020完结").episode).toBeUndefined();
  });

  it("PART/CD and 10bit are extracted without changing the quality ladder score", () => {
    const meta = parseReleaseMeta("Movie.2010.1080p.BluRay.DTS-HD.MA.5.1.x264.10bit.CD1");
    expect(meta.part).toMatch(/CD1/i);
    expect(meta.videoBit).toBe("10bit");
    expect(meta.videoCodec).toBe("h264");
    expect(meta.audio).toBe("dtshd");
  });
});

describe("rules coverage uses the same meta parser", () => {
  it("maps 第N话 and anime dash episodes onto missing codes", () => {
    expect(
      mapTvCoverage({
        title: "葬送的芙莉莲 - 28 [WebRip 1080p]",
        seasons: [1],
        missingEpisodes: ["S01E28", "S01E29"],
      }),
    ).toEqual(["S01E28"]);
    expect(
      mapTvCoverage({
        title: "进击的巨人 第13话 1080p",
        seasons: [1],
        missingEpisodes: ["S01E13"],
      }),
    ).toEqual(["S01E13"]);
  });
});

describe("quality upgrade still reads the upgraded parser", () => {
  it("NF WEB-DL DV is a strict upgrade over 1080p SDR WEB-DL", () => {
    expect(
      shouldReplaceCoverage(
        "Show.S01E01.1080p.WEB-DL.H264.mkv",
        "Show.S01E01.2160p.NF.WEB-DL.DDP.Atmos.DV.H265.mkv",
        { resolutionPreference: "high" },
      ),
    ).toBe(true);
  });
});
