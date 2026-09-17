/**
 * Deterministic rules-mode keyword recipe — a capped subset of the Agent
 * `getSearchRecipe()` upgrade ladder. Prime still searches the bare zh title;
 * these extras run only when that snapshot cannot cover the need.
 *
 * Ordered first-wave list (unique, ≤ `MAX_RULES_FIRST_WAVE_QUERIES`, including
 * the primed title as [0]):
 *  1. Bare zh title (`target.title`) — system prime; extras skip it via
 *     sandbox `normalizeSearchKeyword` dedup.
 *  2. Original / English / romaji aliases ≠ title (Latin-script first, then
 *     other CJK originals; max 2).
 *  3. `{title} {year}` for movie AND live-action TV (skipped on anime
 *     profiles — Agent 忌年份).
 *  4. `{latin-alias} {year}` when year is attached (one alias).
 *  5. `{title} 全集` for TV/anime (115/Quark 整季包 high-recall).
 *  6. `{title} 国漫` for `cn-anime` only (the one subtype-tag exception).
 *  7. `{title} 第N季` including S01 as a *later* slot (S01-without-season
 *     stays the prime / first gap query).
 *
 * Never emitted: quality / subtitle tokens, custom identifier words, 美剧/
 * 韩剧/日剧/国产剧/番剧/动画. Traditional-Chinese conversion is not in-repo
 * (no OpenCC); skip rather than ship a partial map.
 *
 * Gap wave stays in `gapSearchQueries`: `{title|alias} {range}` first (S01
 * omits 季), then S01 `第一季` as a second query; cap +1 vs the old 2.
 */
import { normalizeSearchKeyword } from "../planning-search-gate.js";
import { chineseSeasonToken } from "./cover-planner.js";
import { isAnimeSearchProfile, type SearchProfile } from "./search-profile.js";

/** Includes the primed bare title. Extra provider hits after prime ≤ 5. */
export const MAX_RULES_FIRST_WAVE_QUERIES = 6;
const MAX_FIRST_WAVE_ALIASES = 2;

export interface RulesSearchRecipeInput {
  kind: "movie" | "tv";
  title: string;
  aliases?: readonly string[];
  year?: number;
  seasons?: readonly number[];
  missingEpisodes?: readonly string[];
  searchProfile?: SearchProfile;
}

const LATIN_TOKEN = /[A-Za-z]{2,}/;
const QUALITY_OR_SUB_LEAK =
  /1080|2160|4k|hdr|中字|字幕|国语|双语|蓝光|remux|web-?dl|atmos|dovi/i;
const FORBIDDEN_SUBTYPE =
  /美剧|韩剧|日剧|国产剧|番剧|动画/;

export function rulesFirstWaveQueries(input: RulesSearchRecipeInput): string[] {
  const title = input.title.trim();
  if (!title) {
    return [];
  }
  const seen = new Set<string>();
  const queries: string[] = [];
  const push = (keyword: string | undefined, built: boolean): void => {
    if (!keyword) {
      return;
    }
    const trimmed = keyword.trim().replace(/\s+/g, " ");
    if (trimmed.length === 0) {
      return;
    }
    const key = normalizeSearchKeyword(trimmed);
    if (seen.has(key) || queries.length >= MAX_RULES_FIRST_WAVE_QUERIES) {
      return;
    }
    // Constructed extras must never leak quality/subtitle/subtype tokens
    // (custom identifier words are not an input to this builder). Catalog
    // title/aliases pass through even if they happen to contain those chars.
    if (built && (QUALITY_OR_SUB_LEAK.test(trimmed) || (FORBIDDEN_SUBTYPE.test(trimmed) && !trimmed.endsWith("国漫")))) {
      return;
    }
    seen.add(key);
    queries.push(trimmed);
  };

  push(title, false);

  const aliases = uniqueAliases(title, input.aliases ?? []);
  const latinAliases = aliases.filter(isLatinLead);
  const otherAliases = aliases.filter((alias) => !isLatinLead(alias));
  const rankedAliases = [...latinAliases, ...otherAliases].slice(0, MAX_FIRST_WAVE_ALIASES);
  for (const alias of rankedAliases) {
    push(alias, false);
  }

  const yearKw = yearKeyword(title, input.year, input.searchProfile);
  push(yearKw, true);
  const yearAlias = latinAliases[0];
  if (yearKw && yearAlias) {
    push(yearKeyword(yearAlias, input.year, input.searchProfile), true);
  }

  if (input.kind === "tv") {
    push(`${title} 全集`, true);
  }
  if (input.searchProfile === "cn-anime") {
    push(`${title} 国漫`, true);
  }
  if (input.kind === "tv") {
    const season = firstSeason(input);
    if (season !== undefined && season > 0) {
      push(`${title} ${chineseSeasonToken(season)}`, true);
    }
  }

  return queries;
}

function uniqueAliases(title: string, aliases: readonly string[]): string[] {
  const seen = new Set([normalizeSearchKeyword(title)]);
  const out: string[] = [];
  for (const alias of aliases) {
    const trimmed = alias.trim();
    if (!trimmed) {
      continue;
    }
    const key = normalizeSearchKeyword(trimmed);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function isLatinLead(value: string): boolean {
  return LATIN_TOKEN.test(value);
}

function yearKeyword(
  lead: string,
  year: number | undefined,
  profile: SearchProfile | undefined,
): string | undefined {
  if (year === undefined || year < 1900 || year > 2100) {
    return undefined;
  }
  if (isAnimeSearchProfile(profile)) {
    return undefined;
  }
  if (lead.includes(String(year))) {
    return undefined;
  }
  return `${lead} ${year}`;
}

function firstSeason(input: RulesSearchRecipeInput): number | undefined {
  for (const code of input.missingEpisodes ?? []) {
    const match = /^S(\d+)E/i.exec(code);
    if (match) {
      return Number(match[1]);
    }
  }
  const seasons = input.seasons ?? [];
  return seasons[0];
}
