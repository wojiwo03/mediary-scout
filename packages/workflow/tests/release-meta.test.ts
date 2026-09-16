import { describe, expect, it } from "vitest";
import { parseReleaseQuality, shouldReplaceCoverage } from "../src/acquisition-v2/quality-ladder.js";
import { mapTvCoverage } from "../src/acquisition-v2/rules-selector.js";
import {
  isAnimeTitle,
  joinReleaseTitleParts,
  parseReleaseMeta,
  parseReleaseMetaParts,
  splitReleaseTitleParts,
  parseIdentifierWordLines,
  validateIdentifierWord,
  validateIdentifierWordText,
} from "../src/acquisition-v2/release-meta.js";
import { inferEpisodeCodeFromListingPath } from "../src/acquisition-v2/rules-task.js";
import { RELEASE_GROUP_PATTERNS, STREAMING_PLATFORMS } from "../src/acquisition-v2/release-catalog.js";

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
    expect(meta.resourceType).toMatch(/REMUX/i);
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
    expect(meta.releaseGroup).toMatch(/FLUX/i);
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

  it("MoviePilot meta_cases: WEB-DL + fps + S01 without episode", () => {
    const long = parseReleaseMeta("The Long Season 2017 2160p WEB-DL H265 120FPS AAC-XXX");
    expect(long.resolution).toBe("4k");
    expect(long.source).toBe("webdl");
    expect(long.resourceType).toBe("WEB-DL");
    expect(long.videoCodec).toBe("h265");
    expect(long.fps).toBe(120);
    expect(long.year).toBe(2017);

    const cherry = parseReleaseMeta("Cherry Season S01 2014 2160p 60fps WEB-DL H265 AAC-XXX");
    expect(cherry.seasons).toEqual([1]);
    expect(cherry.episode).toBeUndefined();
    expect(cherry.fps).toBe(60);
    expect(cherry.year).toBe(2014);
  });

  it("MoviePilot meta_cases: Chinese fansub 第二季 + [11] + HEVC", () => {
    const title =
      "【爪爪字幕组】★7月新番[欢迎来到实力至上主义的教室 第二季/Youkoso Jitsuryoku Shijou Shugi no Kyoushitsu e S2][11][1080p][HEVC][GB][MP4][招募翻译校对]";
    const meta = parseReleaseMeta(title);
    expect(meta.releaseGroup).toMatch(/爪爪字幕组/);
    expect(meta.seasons).toEqual([2]);
    expect(meta.episode).toEqual({ from: 11, to: 11, complete: false });
    expect(meta.resolution).toBe("1080p");
    expect(meta.videoCodec).toBe("h265");
    expect(meta.appliedWords.some((word) => word.includes("新番") || word.includes("招募"))).toBe(true);
  });

  it("MoviePilot meta_cases: 【04】日剧、#13 AI-Raws、[TV 08]", () => {
    expect(parseReleaseMeta("【幻月字幕组】【22年日剧】【据幸存的六人所说】【04】【1080P】【中日双语】").episode).toEqual({
      from: 4,
      to: 4,
      complete: false,
    });
    expect(
      parseReleaseMeta("[AI-Raws] 逆境無頼カイジ #13 (BD HEVC 1920x1080 yuv444p10le FLAC)[7CFEE642].mkv").episode,
    ).toEqual({ from: 13, to: 13, complete: false });
    expect(
      parseReleaseMeta("[秋叶原冥途战争][Akiba Maid Sensou][2022][WEB-DL][1080][TV Series][第01话][LeagueWEB]").episode
        ?.from,
    ).toBe(1);
    expect(
      parseReleaseMeta("[诛仙][Jade Dynasty][2022][WEB-DL][2160][TV Series][TV 08][LeagueWEB]").episode?.from,
    ).toBe(8);
  });

  it("MoviePilot meta_cases: WEBDL-1080p, UHD BluRay, Blu-ray Remux, 3D, parenthesized year", () => {
    const nine = parseReleaseMeta("9-1-1 - S04E03 - Future Tense WEBDL-1080p.mp4");
    expect(nine.source).toBe("webdl");
    expect(nine.seasons).toEqual([4]);
    expect(nine.episode?.from).toBe(3);

    const rock = parseReleaseMeta("30.Rock.S02E01.1080p.UHD.BluRay.X264-BORDURE.mkv");
    expect(rock.resourceType).toMatch(/UHD/i);
    expect(rock.resourceType).toMatch(/BluRay/i);
    expect(rock.seasons).toEqual([2]);

    const remux = parseReleaseMeta("Nande Koko ni Sensei ga!? 2019 Blu-ray Remux 1080p AVC LPCM");
    expect(remux.resourceType).toMatch(/BluRay/i);
    expect(remux.resourceType).toMatch(/REMUX/i);
    expect(remux.source).toBe("remux");

    const threeD = parseReleaseMeta(
      "National.Parks.Adventure.AKA.America.Wild:.National.Parks.Adventure.3D.2016.1080p.Blu-ray.AVC.TrueHD.7.1",
    );
    expect(threeD.resourceEffect).toEqual(expect.arrayContaining(["3D"]));
    expect(threeD.year).toBe(2016);

    expect(parseReleaseMeta("哆啦A梦：大雄的宇宙小战争 2021 (2022) - 1080p.mp4").year).toBe(2022);
    expect(parseReleaseMeta("Wonder Woman 1984 2020 BluRay 1080p Atmos TrueHD 7.1 X264-EPiC").year).toBe(2020);
  });

  it("IMAX / UNCUT / REPACK edition effects and SDTV", () => {
    expect(parseReleaseMeta("Dune.2021.IMAX.2160p.WEB-DL").resourceEffect).toEqual(expect.arrayContaining(["IMAX"]));
    expect(parseReleaseMeta("Movie.2020.1080p.BluRay.UNCUT.REPACK").resourceEffect).toEqual(
      expect.arrayContaining(["UNCUT", "REPACK"]),
    );
    expect(parseReleaseQuality("Mr. Robot - S02E06 SDTV.mp4").source).toBe("hdtv");
  });

  it("bracketed 2160 without p, roman 第四季, and 第十三话", () => {
    expect(parseReleaseQuality("[猎户不鸽发布组] 诛仙 [2160] [TV 08]").resolution).toBe("4k");
    expect(parseReleaseMeta("[猎户不鸽发布组] 不死者之王 第四季 OVERLORD Ⅳ [02] [1080p]").seasons).toEqual([4]);
    expect(parseReleaseMeta("进击的巨人 第二十一集").episode?.from).toBe(21);
  });

  it("WordsMatcher replacement / block / episode offset / media binding", () => {
    const replaced = parseReleaseMeta("电影测试替换名称 (2024) 1080p", {
      customWords: ["测试替换 => "],
    });
    expect(replaced.appliedWords).toEqual(expect.arrayContaining(["测试替换 => "]));
    expect(replaced.cnName ?? replaced.parsedTitle ?? "").not.toMatch(/测试替换/);

    const offset = parseReleaseMeta("进击的巨人 第08集 1080p", {
      customWords: ["第 <> 集 >> EP+2"],
    });
    expect(offset.episode).toEqual({ from: 10, to: 10, complete: false });

    const bound = parseReleaseMeta("狩猎 (2022) (tmdb-727340)/狩猎.mkv");
    expect(bound.mediaBinding).toEqual({ source: "tmdb", id: "727340" });
    expect(bound.year).toBe(2022);

    const emby = parseReleaseMeta("Inception (2010) [tmdbid=27205] Inception.2010.1080p.mkv");
    expect(emby.mediaBinding).toEqual({ source: "tmdb", id: "27205" });
  });

  it("specials are not regular episode coverage", () => {
    const ova = parseReleaseMeta("[字幕组] 某科学的超电磁炮 OVA [01] [1080p]");
    expect(ova.special).toBe(true);
    expect(
      mapTvCoverage({
        title: "[字幕组] 某科学的超电磁炮 OVA [01] [1080p]",
        seasons: [1],
        missingEpisodes: ["S01E01"],
      }),
    ).toEqual([]);
  });
});

describe("parseReleaseMeta — folder + filename Infopath merge", () => {
  it("joins parts without ad-hoc concat and does not split URLs", () => {
    expect(joinReleaseTitleParts([" 庆余年 第二季 ", "", "E01.mkv"])).toBe("庆余年 第二季/E01.mkv");
    expect(splitReleaseTitleParts("https://115.com/s/abc/def")).toEqual(["https://115.com/s/abc/def"]);
    expect(splitReleaseTitleParts("Show S02／05.mkv")).toEqual(["Show S02", "05.mkv"]);
    expect(
      splitReleaseTitleParts("[LoliHouse] 葬送的芙莉莲 / Sousou no Frieren - 28 [WebRip 1080p]"),
    ).toHaveLength(1);
  });

  it("folder has show+season, file has episode only → SxxExx", () => {
    const joined = joinReleaseTitleParts(["庆余年 第二季", "E01.mkv"]);
    const meta = parseReleaseMeta(joined);
    expect(meta.seasons).toEqual([2]);
    expect(meta.episode).toEqual({ from: 1, to: 1, complete: false });
    expect(
      mapTvCoverage({
        title: joined,
        seasons: [2],
        missingEpisodes: ["S02E01", "S02E02"],
      }),
    ).toEqual(["S02E01"]);
    expect(inferEpisodeCodeFromListingPath("Show S02/05.mkv", undefined, [1, 2])).toBe("S02E05");
    expect(
      inferEpisodeCodeFromListingPath("[NC-Raws] Show S01/Show - 01.mkv", undefined, [1, 2]),
    ).toBe("S01E01");
  });

  it("folder has quality/HDR, file has S01E02 → quality comes through", () => {
    const meta = parseReleaseMetaParts(["Show S01 2160p 杜比视界 WEB-DL", "S01E02.mkv"]);
    expect(meta.seasons).toEqual([1]);
    expect(meta.episode).toEqual({ from: 2, to: 2, complete: false });
    expect(meta.resolution).toBe("4k");
    expect(meta.hdr).toBe("dv");
    expect(meta.source).toBe("webdl");
    expect(
      parseReleaseMeta("Show S01 2160p 杜比视界", { subtitle: "S01E02.mkv" }).resolution,
    ).toBe("4k");
  });

  it("conflicting episodes prefer the leaf/file token", () => {
    const conflict = parseReleaseMeta("Show S01E01/E02.mkv");
    expect(conflict.seasons).toEqual([1]);
    expect(conflict.episode).toEqual({ from: 2, to: 2, complete: false });
    expect(
      mapTvCoverage({
        title: "Show S01E01/E02.mkv",
        seasons: [1],
        missingEpisodes: ["S01E01", "S01E02"],
      }),
    ).toEqual(["S01E02"]);
    const pack = parseReleaseMetaParts(["庆余年 第二季 全集", "05.mkv"]);
    expect(pack.episode).toEqual({ from: 5, to: 5, complete: false });
    expect(
      mapTvCoverage({
        title: joinReleaseTitleParts(["庆余年 第二季 全集", "05.mkv"]),
        seasons: [2],
        missingEpisodes: ["S02E01", "S02E05"],
      }),
    ).toEqual(["S02E05"]);
  });

  it("leaf quality wins over a higher parent pix token", () => {
    const meta = parseReleaseMeta("Show S02 2160p/E01.1080p.mkv");
    expect(meta.resolution).toBe("1080p");
    expect(parseReleaseQuality("Show S02 2160p/E01.1080p.mkv").resolution).toBe("4k");
  });

  it("flat single-string titles still behave as before", () => {
    const dune = parseReleaseMeta("沙丘2 2024 超高清 杜比视界 无压 中字");
    expect(dune.year).toBe(2024);
    expect(dune.resolution).toBe("4k");
    expect(dune.hdr).toBe("dv");
    expect(parseReleaseMeta("庆余年.S01E01.1080p.WEB-DL.mkv").episode).toEqual({
      from: 1,
      to: 1,
      complete: false,
    });
    expect(parseReleaseMeta("狩猎 (2022) (tmdb-727340)/狩猎.mkv").year).toBe(2022);
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

describe("identifier word parse / validate", () => {
  it("parseIdentifierWordLines keeps replacement lines and drops comments", () => {
    expect(
      parseIdentifierWordLines("# note\n\n网盘乱码 => 沙丘2\n  \n招募翻译校对\n测试替换 => \n"),
    ).toEqual(["网盘乱码 => 沙丘2", "招募翻译校对", "测试替换 => "]);
  });

  it("validateIdentifierWord accepts the three MoviePilot formats", () => {
    expect(validateIdentifierWord("招募翻译校对")).toBeNull();
    expect(validateIdentifierWord("B-Blobal => B-Global")).toBeNull();
    expect(validateIdentifierWord("测试替换 => ")).toBeNull();
    expect(validateIdentifierWord("第 <> 集 >> EP+1")).toBeNull();
    expect(validateIdentifierWord("旧名 => 新名 && 第 <> 集 >> EP-1")).toBeNull();
    expect(validateIdentifierWord("# comment")).toBeNull();
    expect(validateIdentifierWord("   ")).toBeNull();
  });

  it("validateIdentifierWord reports invalid regex and offset", () => {
    expect(validateIdentifierWord("(unclosed")).toContain("正则无效");
    expect(validateIdentifierWord("第 <> 集 >> EP+x")).toContain("集数偏移");
  });

  it("validateIdentifierWordText points at the first bad line", () => {
    expect(validateIdentifierWordText("ok\n(unclosed")).toMatch(/^第 2 行：/);
    expect(validateIdentifierWordText("ok")).toBeNull();
  });
});

describe("parseReleaseMeta — expanded groups and platforms", () => {
  it("catalog is a full table, not the old short regex subset", () => {
    expect(RELEASE_GROUP_PATTERNS.length).toBeGreaterThan(90);
    expect(STREAMING_PLATFORMS.length).toBeGreaterThan(200);
    expect(STREAMING_PLATFORMS.some((p) => p.cjk && p.cjk.length > 0)).toBe(true);
  });

  it("hits groups the old regex missed: FLUX / HaresWEB / PTer / 氢气烤肉架 / Nekomoe", () => {
    expect(parseReleaseMeta("Movie.2024.1080p.WEB-DL-HaresWEB").releaseGroup).toMatch(/HaresWEB/i);
    expect(parseReleaseMeta("Show.S01E01.1080p.WEB-DL-PTer").releaseGroup).toMatch(/PTer/i);
    expect(parseReleaseMeta("Show.S01E01.2160p.UHD.BluRay.REMUX-Ctrlhd").releaseGroup).toMatch(/Ctrlhd/i);
    expect(parseReleaseMeta("【氢气烤肉架】葬送的芙莉莲 - 12 [1080p]").releaseGroup).toMatch(/氢气烤肉架/);
    expect(parseReleaseMeta("[Nekomoe kissaten] Show - 08 [WebRip 1080p]").releaseGroup).toMatch(
      /Nekomoe kissaten/i,
    );
    expect(parseReleaseMeta("【喵萌奶茶屋】[鬼灭之刃][08][1080p]").releaseGroup).toMatch(/喵萌奶茶屋/);
  });

  it("hits platforms the old table missed; Latin still needs WEB, CJK does not", () => {
    expect(parseReleaseMeta("Show.S01E01.2160p.HS.WEB-DL.DDP.H265-FLUX").webSource).toBe("Hotstar");
    expect(parseReleaseMeta("Show.S01E01.WAVVE.WEB-DL.1080p").webSource).toBe("Wavve");
    expect(parseReleaseMeta("Show.S01E01.AT-X.WEB-DL.1080p").webSource).toBe("AT-X");
    expect(parseReleaseMeta("Show.S01E01.PCOK.WEB-DL.1080p").webSource).toBe("Peacock");
    expect(parseReleaseMeta("沙丘2 2024 奈飞 中字").webSource).toBe("Netflix");
    expect(parseReleaseMeta("狂飙 优酷 1080p 中字").webSource).toBe("Youku");
    expect(parseReleaseMeta("A Random Title Without Web Tags HS")).not.toHaveProperty("webSource");
    expect(parseReleaseMeta("A Random Title Without Web Tags NF")).not.toHaveProperty("webSource");
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
