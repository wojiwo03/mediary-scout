/**
 * Slot-based search-keyword recipe for rules mode (and Agent gap queries).
 *
 * Prior art (ideas only, not a source copy):
 *  - MoviePilot `SearchChain.__prepare_params`: ordered unique *name* slots
 *    `title / original_title / en_title / hk_title / tw_title / sg_title`,
 *    capped by `MAX_SEARCH_NAME_LIMIT`; `SEARCH_MULTIPLE_NAME` keeps going
 *    across names. Year/season are *filters* there; PanSou is AND-match so we
 *    also emit them as later modifier slots.
 *  - NAS-Tools `searcher.py`: cn_name → en_name → zh-TW → original_title.
 *  - PanSou / 115 / 夸克 share titles: `全集`, `第N季`, `第N集` / ranges,
 *    `国漫` (cn-anime only), late `美剧` for us-tv.
 *
 * Quality / subtitle tokens and raw custom-identifier blobs never enter `kw`.
 * Literal `from => to` identifier pairs become extra *name* slots when one
 * side is this title (Settings 识别词, no new UI).
 */
import { normalizeSearchKeyword } from "../planning-search-gate.js";
import { chineseSeasonToken } from "./cover-planner.js";
import { isAnimeSearchProfile, type SearchProfile } from "./search-profile.js";
import { literalSearchAliasesFromIdentifierWords } from "./words-matcher.js";
import { simplifiedToTraditional } from "./zh-s2t.js";

/** Includes the primed bare title. Extra provider hits after prime ≤ 7. */
export const MAX_RULES_FIRST_WAVE_QUERIES = 8;
/** MoviePilot-style multi-name cap (zh + latin + 繁体 + identifier/original). */
export const MAX_RULES_NAME_SLOTS = 4;

export interface RulesSearchRecipeInput {
  kind: "movie" | "tv";
  title: string;
  aliases?: readonly string[];
  year?: number;
  seasons?: readonly number[];
  missingEpisodes?: readonly string[];
  searchProfile?: SearchProfile;
  /** MoviePilot identifier lines — only literal `A => B` title aliases are used. */
  customIdentifierWords?: readonly string[];
}

export type SearchNameSource = "zh" | "latin" | "original" | "traditional" | "identifier";

export interface SearchNameSlot {
  value: string;
  source: SearchNameSource;
}

export type SearchModifier =
  | { kind: "year"; year: number }
  | { kind: "pack"; token: "全集" | "Complete" }
  | { kind: "region"; token: "国漫" | "美剧" }
  | { kind: "season"; token: string };

export interface RulesSearchRecipe {
  names: SearchNameSlot[];
  modifiers: SearchModifier[];
  queries: string[];
}

const LATIN_TOKEN = /[A-Za-z]{2,}/;
const QUALITY_OR_SUB_LEAK =
  /1080|2160|4k|hdr|中字|字幕|国语|双语|蓝光|remux|web-?dl|atmos|dovi/i;
const FORBIDDEN_SUBTYPE = /美剧|韩剧|日剧|国产剧|番剧|动画/;

export function collectSearchNames(input: RulesSearchRecipeInput): SearchNameSlot[] {
  const title = input.title.trim();
  if (!title) {
    return [];
  }
  const slots: SearchNameSlot[] = [];
  const seen = new Set<string>();
  const push = (value: string | undefined, source: SearchNameSource): void => {
    if (!value || slots.length >= MAX_RULES_NAME_SLOTS) {
      return;
    }
    const trimmed = value.trim().replace(/\s+/g, " ");
    if (!trimmed) {
      return;
    }
    const key = normalizeSearchKeyword(trimmed);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    slots.push({ value: trimmed, source });
  };

  push(title, "zh");

  const aliases = uniqueAliases(title, input.aliases ?? []);
  for (const alias of aliases.filter(isLatinLead)) {
    push(alias, "latin");
  }
  for (const extra of literalSearchAliasesFromIdentifierWords(input.customIdentifierWords, title)) {
    push(extra, "identifier");
  }
  // Traditional before extra CJK originals so the 繁体 PanSou pool is not
  // crowded out by JP/KR aliases (MoviePilot hk/tw sit with name slots).
  push(simplifiedToTraditional(title), "traditional");
  for (const alias of aliases.filter((item) => !isLatinLead(item))) {
    push(alias, "original");
  }
  return slots;
}

export function collectSearchModifiers(input: RulesSearchRecipeInput): SearchModifier[] {
  const modifiers: SearchModifier[] = [];
  const year = usableYear(input.year, input.searchProfile);
  if (year !== undefined) {
    modifiers.push({ kind: "year", year });
  }
  if (input.kind === "tv") {
    modifiers.push({ kind: "pack", token: "全集" });
  }
  if (input.searchProfile === "cn-anime") {
    modifiers.push({ kind: "region", token: "国漫" });
  }
  if (input.kind === "tv") {
    const season = firstSeason(input);
    if (season !== undefined && season > 0) {
      modifiers.push({ kind: "season", token: chineseSeasonToken(season) });
    }
  }
  if (input.searchProfile === "us-tv" || input.searchProfile === "us-anime") {
    modifiers.push({ kind: "pack", token: "Complete" });
  }
  if (input.searchProfile === "us-tv") {
    modifiers.push({ kind: "region", token: "美剧" });
  }
  return modifiers;
}

export function buildRulesSearchRecipe(input: RulesSearchRecipeInput): RulesSearchRecipe {
  const names = collectSearchNames(input);
  const modifiers = collectSearchModifiers(input);
  return { names, modifiers, queries: compileFirstWave(names, modifiers) };
}

export function rulesFirstWaveQueries(input: RulesSearchRecipeInput): string[] {
  return buildRulesSearchRecipe(input).queries;
}

/** Ordered name-slot values (zh first). Gap rounds use `.slice(1)` as aliases. */
export function rulesSearchNameValues(input: RulesSearchRecipeInput): string[] {
  return collectSearchNames(input).map((slot) => slot.value);
}

function compileFirstWave(names: readonly SearchNameSlot[], modifiers: readonly SearchModifier[]): string[] {
  const queries: string[] = [];
  const seen = new Set<string>();
  const push = (keyword: string | undefined, built: boolean): void => {
    if (!keyword || queries.length >= MAX_RULES_FIRST_WAVE_QUERIES) {
      return;
    }
    const trimmed = keyword.trim().replace(/\s+/g, " ");
    if (!trimmed) {
      return;
    }
    const key = normalizeSearchKeyword(trimmed);
    if (seen.has(key)) {
      return;
    }
    if (built && leaksForbidden(trimmed)) {
      return;
    }
    seen.add(key);
    queries.push(trimmed);
  };

  const zh = names.find((slot) => slot.source === "zh")?.value;
  const latin = names.find((slot) => slot.source === "latin")?.value;
  for (const slot of names) {
    push(slot.value, false);
  }
  if (!zh) {
    return queries;
  }
  for (const modifier of modifiers) {
    if (modifier.kind === "year") {
      if (!zh.includes(String(modifier.year))) {
        push(`${zh} ${modifier.year}`, true);
      }
      if (latin && !latin.includes(String(modifier.year))) {
        push(`${latin} ${modifier.year}`, true);
      }
      continue;
    }
    if (modifier.kind === "pack" && modifier.token === "Complete") {
      if (latin) {
        push(`${latin} Complete`, true);
      }
      continue;
    }
    if (modifier.kind === "pack") {
      push(`${zh} ${modifier.token}`, true);
      continue;
    }
    if (modifier.kind === "region") {
      push(`${zh} ${modifier.token}`, true);
      continue;
    }
    push(`${zh} ${modifier.token}`, true);
  }
  return queries;
}

function leaksForbidden(keyword: string): boolean {
  if (QUALITY_OR_SUB_LEAK.test(keyword)) {
    return true;
  }
  if (FORBIDDEN_SUBTYPE.test(keyword) && !keyword.endsWith("国漫") && !keyword.endsWith("美剧")) {
    return true;
  }
  return false;
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

function usableYear(year: number | undefined, profile: SearchProfile | undefined): number | undefined {
  if (year === undefined || year < 1900 || year > 2100) {
    return undefined;
  }
  if (isAnimeSearchProfile(profile)) {
    return undefined;
  }
  return year;
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
