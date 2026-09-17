import { describe, expect, it } from "vitest";
import {
  MAX_GAP_QUERIES_PER_ROUND,
  MAX_RULES_FIRST_WAVE_QUERIES,
  gapSearchQueries,
  rulesFirstWaveQueries,
} from "../src/index.js";

describe("rulesFirstWaveQueries — golden keyword lists", () => {
  it("CJK drama: zh title, latin alias, year, 全集, 第N季 (S01 included as a later slot)", () => {
    const queries = rulesFirstWaveQueries({
      kind: "tv",
      title: "庆余年",
      aliases: ["Joy of Life"],
      year: 2019,
      seasons: [1],
      missingEpisodes: ["S01E01", "S01E02"],
      searchProfile: "cn-tv",
    });
    expect(queries[0]).toBe("庆余年");
    expect(queries).toEqual([
      "庆余年",
      "Joy of Life",
      "庆余年 2019",
      "Joy of Life 2019",
      "庆余年 全集",
      "庆余年 第一季",
    ]);
    expect(queries).toHaveLength(MAX_RULES_FIRST_WAVE_QUERIES);
    expect(queries.join(" ")).not.toMatch(/1080|4K|中字|美剧|国产剧/);
  });

  it("US show: English original is first-class; year on both names; 全集 before 第一季", () => {
    const queries = rulesFirstWaveQueries({
      kind: "tv",
      title: "权力的游戏",
      aliases: ["Game of Thrones"],
      year: 2011,
      seasons: [1],
      missingEpisodes: ["S01E01"],
      searchProfile: "us-tv",
    });
    expect(queries).toEqual([
      "权力的游戏",
      "Game of Thrones",
      "权力的游戏 2011",
      "Game of Thrones 2011",
      "权力的游戏 全集",
      "权力的游戏 第一季",
    ]);
    expect(queries).not.toContain("权力的游戏 美剧");
  });

  it("JP anime: original/romaji aliases, 全集, 第N季; year is skipped", () => {
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
    expect(queries).toEqual([
      "一人之下",
      "Hitori no Shita",
      "一人之下 全集",
      "一人之下 国漫",
      "一人之下 第一季",
    ]);
    expect(queries.join(" ")).not.toMatch(/2016/);
  });

  it("movie + year: original English and year on both; no 全集 / 季", () => {
    const queries = rulesFirstWaveQueries({
      kind: "movie",
      title: "盗梦空间",
      aliases: ["Inception"],
      year: 2010,
      searchProfile: "movie",
    });
    expect(queries).toEqual(["盗梦空间", "Inception", "盗梦空间 2010", "Inception 2010"]);
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
    expect(queries[2]).toBe("サイレント");
    expect(queries.filter((keyword) => keyword === "サイレント・サイレンス")).toEqual([]);
    expect(queries.length).toBeLessThanOrEqual(MAX_RULES_FIRST_WAVE_QUERIES);
  });

  it("does not take quality, subtitle, or custom-identifier words as inputs", () => {
    const queries = rulesFirstWaveQueries({
      kind: "movie",
      title: "奥本海默",
      aliases: ["Oppenheimer"],
      year: 2023,
      searchProfile: "movie",
    });
    expect(queries.join(" ")).not.toMatch(/1080|4K|中字|字幕|蓝光|custom/i);
    expect(queries).toEqual(["奥本海默", "Oppenheimer", "奥本海默 2023", "Oppenheimer 2023"]);
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
      aliases: ["Joy of Life"],
      missing: ["S01E04", "S01E05", "S01E06", "S01E07", "S01E08", "S01E09", "S01E10"],
    });
    expect(queries[0]).toBe("庆余年 4-10集");
    expect(queries).toContain("庆余年 第一季 4-10集");
    expect(queries.length).toBeLessThanOrEqual(MAX_GAP_QUERIES_PER_ROUND);
    expect(queries.join(" ")).not.toMatch(/1080|4K|中字/);
  });
});
