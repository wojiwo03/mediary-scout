import { describe, expect, it } from "vitest";
import {
  MAX_GAP_QUERIES_PER_ROUND,
  MAX_RULES_FIRST_WAVE_QUERIES,
  MAX_RULES_NAME_SLOTS,
  buildRulesSearchRecipe,
  gapSearchQueries,
  literalSearchAliasesFromIdentifierWords,
  rulesFirstWaveQueries,
  simplifiedToTraditional,
} from "../src/index.js";

describe("simplifiedToTraditional — PanSou 繁体 name slot", () => {
  it("converts common drama/movie titles", () => {
    expect(simplifiedToTraditional("庆余年")).toBe("慶餘年");
    expect(simplifiedToTraditional("权力的游戏")).toBe("權力的遊戲");
    expect(simplifiedToTraditional("盗梦空间")).toBe("盜夢空間");
    expect(simplifiedToTraditional("匹兹堡医护前线")).toBe("匹茲堡醫護前線");
    expect(simplifiedToTraditional("静雪")).toBe("靜雪");
    expect(simplifiedToTraditional("葬送的芙莉莲")).toBe("葬送的芙莉蓮");
  });

  it("leaves already-traditional / latin / 皇后-style ambiguous 后 unchanged as a whole when nothing else converts", () => {
    expect(simplifiedToTraditional("Game of Thrones")).toBeUndefined();
    expect(simplifiedToTraditional("皇后")).toBeUndefined();
  });
});

describe("literalSearchAliasesFromIdentifierWords", () => {
  it("takes the other side of a literal A => B when one side is the title", () => {
    expect(literalSearchAliasesFromIdentifierWords(["Joy of Life => 庆余年"], "庆余年")).toEqual(["Joy of Life"]);
    expect(literalSearchAliasesFromIdentifierWords(["网盘乱码分享 => 盗梦空间"], "盗梦空间")).toEqual(["网盘乱码分享"]);
  });

  it("strips {[tmdbid]} bindings and skips regex / quality / block words", () => {
    expect(
      literalSearchAliasesFromIdentifierWords(["Silent => 静雪{[tmdbid=123;type=tv]}"], "静雪"),
    ).toEqual(["Silent"]);
    expect(literalSearchAliasesFromIdentifierWords(["庆.* => 庆余年", "1080p => 庆余年", "垃圾"], "庆余年")).toEqual([]);
  });
});

describe("rulesFirstWaveQueries — golden keyword lists", () => {
  it("CJK drama: MoviePilot name slots then PanSou modifiers (year/全集/季), 繁体 included", () => {
    const built = buildRulesSearchRecipe({
      kind: "tv",
      title: "庆余年",
      aliases: ["Joy of Life"],
      year: 2019,
      seasons: [1],
      missingEpisodes: ["S01E01", "S01E02"],
      searchProfile: "cn-tv",
    });
    expect(built.names.map((slot) => slot.source)).toEqual(["zh", "latin", "traditional"]);
    expect(built.queries[0]).toBe("庆余年");
    expect(built.queries).toEqual([
      "庆余年",
      "Joy of Life",
      "慶餘年",
      "庆余年 2019",
      "Joy of Life 2019",
      "庆余年 全集",
      "庆余年 第一季",
    ]);
    expect(built.queries.length).toBeLessThanOrEqual(MAX_RULES_FIRST_WAVE_QUERIES);
    expect(built.queries.join(" ")).not.toMatch(/1080|4K|中字|美剧|国产剧/);
  });

  it("US show: English + 繁体 names, year, 全集, 第N季; Complete/美剧 only if cap remains", () => {
    const built = buildRulesSearchRecipe({
      kind: "tv",
      title: "权力的游戏",
      aliases: ["Game of Thrones"],
      year: 2011,
      seasons: [1],
      missingEpisodes: ["S01E01"],
      searchProfile: "us-tv",
    });
    expect(built.modifiers.some((row) => row.kind === "region" && row.token === "美剧")).toBe(true);
    expect(built.queries[0]).toBe("权力的游戏");
    expect(built.queries).toContain("Game of Thrones");
    expect(built.queries).toContain("權力的遊戲");
    expect(built.queries).toContain("权力的游戏 2011");
    expect(built.queries).toContain("权力的游戏 全集");
    expect(built.queries).toContain("权力的游戏 第一季");
    expect(built.queries.length).toBeLessThanOrEqual(MAX_RULES_FIRST_WAVE_QUERIES);
    expect(built.names.length).toBeLessThanOrEqual(MAX_RULES_NAME_SLOTS);
    if (built.queries.length < MAX_RULES_FIRST_WAVE_QUERIES) {
      expect(built.queries).toContain("权力的游戏 美剧");
    }
    expect(built.queries.join(" ")).not.toMatch(/韩剧|国产剧|1080|4K|中字/);
  });

  it("JP anime: original/romaji + 繁体, 全集, 第N季; year is skipped", () => {
    const queries = rulesFirstWaveQueries({
      kind: "tv",
      title: "葬送的芙莉莲",
      aliases: ["Frieren", "Sousou no Frieren"],
      year: 2023,
      seasons: [1],
      missingEpisodes: ["S01E01"],
      searchProfile: "jp-anime",
    });
    expect(queries[0]).toBe("葬送的芙莉莲");
    expect(queries).toContain("Frieren");
    expect(queries).toContain("Sousou no Frieren");
    expect(queries).toContain("葬送的芙莉蓮");
    expect(queries).toContain("葬送的芙莉莲 全集");
    expect(queries).toContain("葬送的芙莉莲 第一季");
    expect(queries.join(" ")).not.toMatch(/2023/);
    expect(queries.join(" ")).not.toMatch(/番剧|动画/);
    expect(queries.length).toBeLessThanOrEqual(MAX_RULES_FIRST_WAVE_QUERIES);
  });

  it("CN anime: +国漫 disambiguator, no year", () => {
    const queries = rulesFirstWaveQueries({
      kind: "tv",
      title: "一人之下",
      aliases: ["Hitori no Shita"],
      year: 2016,
      seasons: [1],
      missingEpisodes: ["S01E01"],
      searchProfile: "cn-anime",
    });
    expect(queries).toEqual(["一人之下", "Hitori no Shita", "一人之下 全集", "一人之下 国漫", "一人之下 第一季"]);
    expect(queries.join(" ")).not.toMatch(/2016/);
  });

  it("movie + year: names (zh/en/繁体) then year on zh and latin; no 全集 / 季", () => {
    const queries = rulesFirstWaveQueries({
      kind: "movie",
      title: "盗梦空间",
      aliases: ["Inception"],
      year: 2010,
      searchProfile: "movie",
    });
    expect(queries).toEqual(["盗梦空间", "Inception", "盜夢空間", "盗梦空间 2010", "Inception 2010"]);
    expect(queries.join(" ")).not.toMatch(/全集|第.+季/);
  });

  it("latin aliases rank ahead of CJK originals; extras are capped", () => {
    const queries = rulesFirstWaveQueries({
      kind: "tv",
      title: "静雪",
      aliases: ["サイレント", "Silent", "サイレント・サイレンス"],
      year: 2022,
      seasons: [1],
      missingEpisodes: ["S01E01"],
      searchProfile: "jp-tv",
    });
    expect(queries[0]).toBe("静雪");
    expect(queries[1]).toBe("Silent");
    expect(queries).toContain("サイレント");
    expect(queries).toContain("靜雪");
    expect(queries.filter((keyword) => keyword === "サイレント・サイレンス")).toEqual([]);
    expect(queries.length).toBeLessThanOrEqual(MAX_RULES_FIRST_WAVE_QUERIES);
  });

  it("identifier A => B becomes a name slot; quality/regex identifier lines do not enter kw", () => {
    const withAlias = rulesFirstWaveQueries({
      kind: "tv",
      title: "庆余年",
      aliases: [],
      seasons: [1],
      missingEpisodes: ["S01E01"],
      searchProfile: "cn-tv",
      customIdentifierWords: ["Joy of Life => 庆余年"],
    });
    expect(withAlias).toContain("Joy of Life");
    const dirty = rulesFirstWaveQueries({
      kind: "movie",
      title: "奥本海默",
      aliases: ["Oppenheimer"],
      year: 2023,
      searchProfile: "movie",
      customIdentifierWords: ["1080p => 奥本海默", "奥.* => 奥本海默"],
    });
    expect(dirty.join(" ")).not.toMatch(/1080|4K|中字|字幕|蓝光/i);
    expect(dirty).toContain("奧本海默");
  });

  it("S02 uses 第二季 (not 第一季) when that is the missing season", () => {
    const queries = rulesFirstWaveQueries({
      kind: "tv",
      title: "庆余年",
      aliases: [],
      seasons: [2],
      missingEpisodes: ["S02E01"],
      searchProfile: "cn-tv",
    });
    expect(queries).toContain("庆余年 第二季");
    expect(queries).not.toContain("庆余年 第一季");
  });
});

describe("gapSearchQueries — S01 第一季 as second query", () => {
  it("keeps the no-季 first query and adds 第一季 second", () => {
    const queries = gapSearchQueries({
      title: "庆余年",
      aliases: ["Joy of Life", "慶餘年"],
      missing: ["S01E04", "S01E05", "S01E06", "S01E07", "S01E08", "S01E09", "S01E10"],
    });
    expect(queries[0]).toBe("庆余年 4-10集");
    expect(queries).toContain("庆余年 第一季 4-10集");
    expect(queries.length).toBeLessThanOrEqual(MAX_GAP_QUERIES_PER_ROUND);
    expect(queries.join(" ")).not.toMatch(/1080|4K|中字/);
  });
});
