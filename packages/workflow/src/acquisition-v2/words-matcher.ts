/**
 * Custom identifier preprocessor used before title/filename recognition.
 *
 * Formats and application order follow MoviePilot WordsMatcher
 * (https://github.com/jxxghp/MoviePilot, v3 `app/domain/meta/words.py`) as
 * prior art — not a source copy:
 *   1. block word (regex removed from the title)
 *   2. `from => to` replacement / name binding
 *   3. `front <> back >> EP±n` episode offset
 *   4. `from => to && front <> back >> EP±n` combined
 *
 * Built-in words only cover Chinese cloud-share / PT noise that otherwise
 * poisons season-episode and quality tokens. User words are applied after.
 */
import { parseChineseNumber } from "./chinese-number.js";

export interface PreparedTitle {
  title: string;
  appliedWords: string[];
}

export interface MediaBinding {
  source: "tmdb" | "douban" | "bangumi" | "anilist";
  id: string;
}

export interface ExplicitMediaTags {
  title: string;
  binding?: MediaBinding;
  beginSeason?: number;
  endSeason?: number;
  beginEpisode?: number;
  endEpisode?: number;
  mediaType?: "movie" | "tv";
}

const COMBINED_RE =
  /^\s*(.*?)\s*=>\s*(.*?)\s*&&\s*(.*?)\s*<>\s*(.*?)\s*>>\s*(.*?)\s*$/;

const OFFSET_SIMPLE_RE = /^EP\s*([+\-*/])\s*(\d+)$/i;

/**
 * Built-in identifiers. Regex on the left; `#` comments are skipped the same
 * way MoviePilot skips them.
 */
export const BUILTIN_IDENTIFIER_WORDS: readonly string[] = [
  String.raw`[0-9.]+\s*[MGT]i?B(?![A-Z]+)`,
  "招募翻译校对",
  String.raw`★?\d{0,2}月?新番`,
  String.raw`\d{2}年[日美韩中港台]剧`,
  "B-Blobal => B-Global",
];

type WordKind = "block" | "replace" | "offset" | "replace_and_offset";

interface ParsedWord {
  kind: WordKind;
  params: string[];
  raw: string;
}

function parseWord(word: string): ParsedWord | null {
  if (!word.trim() || /^\s*#/.test(word)) {
    return null;
  }
  // Do not trim the whole line: `from => ` (empty replacement) relies on the
  // trailing space after `=>`, matching MoviePilot's ` => ` splitter.
  if (word.includes(" => ") && word.includes(" && ") && word.includes(" >> ") && word.includes(" <> ")) {
    const match = COMBINED_RE.exec(word);
    if (!match) {
      return null;
    }
    return { kind: "replace_and_offset", params: match.slice(1).map((part) => part.trim()), raw: word };
  }
  if (word.includes(" => ")) {
    const [from, to = ""] = word.split(" => ");
    return { kind: "replace", params: [from!.trim(), to.trim()], raw: word };
  }
  if (word.includes(" >> ") && word.includes(" <> ")) {
    const [front, rest = ""] = word.split(" <> ");
    const [back = "", offset = ""] = rest.split(" >> ");
    return { kind: "offset", params: [front!.trim(), back.trim(), offset.trim()], raw: word };
  }
  return { kind: "block", params: [word.trim()], raw: word.trim() };
}

function compileSafe(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, "gi");
  } catch {
    return null;
  }
}

function regexHits(re: RegExp, title: string): boolean {
  re.lastIndex = 0;
  const hit = re.test(title);
  re.lastIndex = 0;
  return hit;
}

function replaceRegex(title: string, from: string, to: string): { title: string; hit: boolean } {
  const re = compileSafe(from);
  if (!re) {
    return { title, hit: false };
  }
  const next = title.replace(re, to);
  return { title: next, hit: next !== title };
}

const MAX_IDENTIFIER_WORD_CHARS = 8000;
const MAX_IDENTIFIER_WORD_LINES = 200;

/** Non-comment, non-blank lines from a Settings textarea (preserves `from => `). */
export function parseIdentifierWordLines(raw: string | null | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith("#");
  });
}

/** `null` = ok (blank and `#` comments included). Otherwise a short Chinese error. */
export function validateIdentifierWord(word: string): string | null {
  const trimmed = word.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }
  const parsed = parseWord(word);
  if (!parsed) {
    return "无法解析。格式：屏蔽词、A => B、前 <> 后 >> EP±n";
  }
  if (parsed.kind === "block" || parsed.kind === "replace" || parsed.kind === "replace_and_offset") {
    if (!compileSafe(parsed.params[0]!)) {
      return `正则无效：${parsed.params[0]}`;
    }
  }
  if (parsed.kind === "offset" || parsed.kind === "replace_and_offset") {
    const front = parsed.kind === "offset" ? parsed.params[0]! : parsed.params[2]!;
    const back = parsed.kind === "offset" ? parsed.params[1]! : parsed.params[3]!;
    const offset = parsed.kind === "offset" ? parsed.params[2]! : parsed.params[4]!;
    if (front && !compileSafe(front)) {
      return `前定位词正则无效：${front}`;
    }
    if (back && !compileSafe(back)) {
      return `后定位词正则无效：${back}`;
    }
    try {
      applyEpisodeOffsetExpr(offset, 1);
    } catch {
      return "集数偏移仅支持 EP±n / EP*n / EP/n";
    }
  }
  return null;
}

/** Validate a full textarea. First error wins. */
export function validateIdentifierWordText(raw: string): string | null {
  if (raw.length > MAX_IDENTIFIER_WORD_CHARS) {
    return `识别词过长（最多 ${MAX_IDENTIFIER_WORD_CHARS} 字）`;
  }
  const lines = raw.split(/\r?\n/);
  if (lines.length > MAX_IDENTIFIER_WORD_LINES) {
    return `识别词过多（最多 ${MAX_IDENTIFIER_WORD_LINES} 行）`;
  }
  for (let index = 0; index < lines.length; index += 1) {
    const message = validateIdentifierWord(lines[index]!);
    if (message) {
      return `第 ${index + 1} 行：${message}`;
    }
  }
  return null;
}

/** exactOptionalPropertyTypes-safe spread for workflow / worker request bags. */
export function customIdentifierWordsSpread(
  words: readonly string[] | undefined,
): { customIdentifierWords?: string[] } {
  if (!words || words.length === 0) {
    return {};
  }
  return { customIdentifierWords: [...words] };
}

/**
 * Literal title aliases implied by MoviePilot `from => to` identifier rules.
 * Used as extra *search name slots* when one side is this title. Regex / block /
 * offset rules and quality tokens are skipped — those stay parse-only.
 */
export function literalSearchAliasesFromIdentifierWords(
  words: readonly string[] | undefined,
  targetTitle: string,
): string[] {
  const target = targetTitle.trim();
  if (!words || words.length === 0 || !target) {
    return [];
  }
  const targetKey = target.toLowerCase();
  const out: string[] = [];
  const seen = new Set([targetKey]);
  for (const raw of words) {
    if (!raw.includes(" => ") || raw.includes(" && ")) {
      continue;
    }
    const [fromRaw, toRaw = ""] = raw.split(" => ");
    const from = (fromRaw ?? "").trim();
    const to = extractExplicitMediaTags(toRaw).title.trim();
    if (!from || !to || REGEXISH.test(from) || REGEXISH.test(to)) {
      continue;
    }
    if (QUALITYISH.test(from) || QUALITYISH.test(to)) {
      continue;
    }
    const fromKey = from.toLowerCase();
    const toKey = to.toLowerCase();
    let extra: string | undefined;
    if (fromKey === targetKey && toKey !== targetKey) {
      extra = to;
    } else if (toKey === targetKey && fromKey !== targetKey) {
      extra = from;
    }
    if (!extra) {
      continue;
    }
    const extraKey = extra.toLowerCase();
    if (seen.has(extraKey)) {
      continue;
    }
    seen.add(extraKey);
    out.push(extra);
  }
  return out;
}

const REGEXISH = /[.*+?^${}()|[\]\\]/;
const QUALITYISH = /1080|2160|4k|hdr|中字|字幕|国语|双语|蓝光|remux|web-?dl|atmos|dovi/i;

export function applyEpisodeOffsetExpr(offset: string, episode: number): number {
  const match = OFFSET_SIMPLE_RE.exec(offset.trim());
  if (!match) {
    throw new Error("集数偏移仅支持 EP±n / EP*n / EP/n");
  }
  const op = match[1]!;
  const n = Number(match[2]);
  if (op === "+") {
    return episode + n;
  }
  if (op === "-") {
    return episode - n;
  }
  if (op === "*") {
    return episode * n;
  }
  return Math.trunc(episode / n);
}

function formatOffsetEpisode(original: string, next: number): string {
  if (!/^\d+$/.test(original)) {
    return String(next);
  }
  return original.startsWith("0") ? String(Math.max(0, next)).padStart(original.length, "0") : String(next);
}

function applyEpisodeOffset(title: string, front: string, back: string, offset: string): { title: string; hit: boolean } {
  const frontRe = compileSafe(front);
  const backRe = compileSafe(back);
  if ((front && !frontRe) || (back && !backRe)) {
    return { title, hit: false };
  }
  if (front && frontRe && !regexHits(frontRe, title)) {
    return { title, hit: false };
  }
  if (back && backRe && !regexHits(backRe, title)) {
    return { title, hit: false };
  }
  const between = compileSafe(`(${front}.*?)([0-9一二三四五六七八九十百零]+)(.*?${back})`);
  if (!between) {
    return { title, hit: false };
  }
  let hit = false;
  const next = title.replace(between, (_whole, lead: string, num: string, trail: string) => {
    const parsed = parseChineseNumber(num);
    if (parsed === null) {
      return `${lead}${num}${trail}`;
    }
    try {
      const shifted = applyEpisodeOffsetExpr(offset, parsed);
      hit = true;
      return `${lead}${formatOffsetEpisode(num, shifted)}${trail}`;
    } catch {
      return `${lead}${num}${trail}`;
    }
  });
  return { title: next, hit };
}

function applyOne(title: string, word: ParsedWord): { title: string; hit: boolean } {
  if (word.kind === "block") {
    return replaceRegex(title, word.params[0]!, "");
  }
  if (word.kind === "replace") {
    return replaceRegex(title, word.params[0]!, word.params[1] ?? "");
  }
  if (word.kind === "offset") {
    return applyEpisodeOffset(title, word.params[0]!, word.params[1]!, word.params[2]!);
  }
  const replaced = replaceRegex(title, word.params[0]!, word.params[1] ?? "");
  if (!replaced.hit) {
    return replaced;
  }
  return applyEpisodeOffset(replaced.title, word.params[2]!, word.params[3]!, word.params[4]!);
}

/** Apply built-in then user identifier words. `#` lines are ignored. */
export function prepareTitle(
  title: string,
  customWords: readonly string[] = [],
  options: { includeBuiltin?: boolean } = {},
): PreparedTitle {
  let working = title;
  const applied: string[] = [];
  const includeBuiltin = options.includeBuiltin !== false;
  const words = includeBuiltin ? [...BUILTIN_IDENTIFIER_WORDS, ...customWords] : [...customWords];
  for (const raw of words) {
    const parsed = parseWord(raw);
    if (!parsed) {
      continue;
    }
    const result = applyOne(working, parsed);
    if (result.hit) {
      working = result.title;
      applied.push(parsed.raw);
    }
  }
  return { title: working, appliedWords: applied };
}

const TMDB_RE_LIST = [
  /\[tmdbid[=\-](\d+)\]/i,
  /\[tmdb[=\-](\d+)\]/i,
  /\{tmdbid[=\-](\d+)\}/i,
  /\{tmdb[=\-](\d+)\}/i,
  /\(tmdbid[=\-]\s*(\d+)\s*\)/i,
  /\(tmdb[=\-]\s*(\d+)\s*\)/i,
];

const OTHER_ID_RE: Array<{ source: MediaBinding["source"]; re: RegExp }> = [
  { source: "douban", re: /\[(?:doubanid|douban)[=\-](\d+)\]/i },
  { source: "bangumi", re: /\[(?:bangumiid|bangumi)[=\-](\d+)\]/i },
  { source: "anilist", re: /\[(?:anilistid|anilist)[=\-](\d+)\]/i },
];

const BRACED_BLOCK_RE = /\{\[([\s\S]+?)\]\}/;

/**
 * Strip MoviePilot/Emby-style `{[tmdbid=…]}` / `[tmdbid=…]` tags and return
 * the bound identity. Explicit season/episode in the brace override parsers.
 */
export function extractExplicitMediaTags(title: string): ExplicitMediaTags {
  let working = title;
  let binding: MediaBinding | undefined;
  let beginSeason: number | undefined;
  let endSeason: number | undefined;
  let beginEpisode: number | undefined;
  let endEpisode: number | undefined;
  let mediaType: "movie" | "tv" | undefined;

  const braced = BRACED_BLOCK_RE.exec(working);
  if (braced) {
    const inner = braced[1]!;
    const tmdb = /(?:tmdbid|tmdb)=(\d+)/i.exec(inner);
    const douban = /doubanid=(\d+)/i.exec(inner);
    const bangumi = /bangumiid=(\d+)/i.exec(inner);
    const anilist = /anilistid=(\d+)/i.exec(inner);
    if (tmdb && tmdb[1] !== "0") {
      binding = { source: "tmdb", id: tmdb[1]! };
    } else if (douban && douban[1] !== "0") {
      binding = { source: "douban", id: douban[1]! };
    } else if (bangumi && bangumi[1] !== "0") {
      binding = { source: "bangumi", id: bangumi[1]! };
    } else if (anilist && anilist[1] !== "0") {
      binding = { source: "anilist", id: anilist[1]! };
    }
    const type = /(?:^|[;])type=(\w+)/i.exec(inner);
    if (type) {
      const value = type[1]!.toLowerCase();
      if (value === "movie" || value === "movies") {
        mediaType = "movie";
      } else if (value === "tv") {
        mediaType = "tv";
      }
    }
    const season = /(?:^|[;])s=(\d+)(?:-(\d+))?/i.exec(inner);
    if (season) {
      beginSeason = Number(season[1]);
      if (season[2]) {
        endSeason = Number(season[2]);
      }
    }
    const episode = /(?:^|[;])e=(\d+)(?:-(\d+))?/i.exec(inner);
    if (episode) {
      beginEpisode = Number(episode[1]);
      if (episode[2]) {
        endEpisode = Number(episode[2]);
      }
    }
    working = working.replace(braced[0], " ").trim();
  }

  if (!binding) {
    for (const re of TMDB_RE_LIST) {
      const match = re.exec(working);
      if (match && match[1] !== "0") {
        binding = { source: "tmdb", id: match[1]! };
        working = working.replace(re, " ").trim();
        break;
      }
    }
  }
  if (!binding) {
    for (const item of OTHER_ID_RE) {
      const match = item.re.exec(working);
      if (match && match[1] !== "0") {
        binding = { source: item.source, id: match[1]! };
        working = working.replace(item.re, " ").trim();
        break;
      }
    }
  }

  return {
    title: working.replace(/\s{2,}/g, " ").trim(),
    ...(binding ? { binding } : {}),
    ...(beginSeason === undefined ? {} : { beginSeason }),
    ...(endSeason === undefined ? {} : { endSeason }),
    ...(beginEpisode === undefined ? {} : { beginEpisode }),
    ...(endEpisode === undefined ? {} : { endEpisode }),
    ...(mediaType === undefined ? {} : { mediaType }),
  };
}
