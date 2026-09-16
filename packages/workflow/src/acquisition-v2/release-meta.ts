/**
 * Structured release / filename parser used by the quality ladder and the
 * deterministic rules selector.
 *
 * Field set and matching behavior follow MoviePilot MetaInfo / MetaBase /
 * MetaVideo / MetaAnime (https://github.com/jxxghp/MoviePilot, v3
 * `app/domain/meta/*`) as prior art — especially resource_pix, resource_type,
 * resource_effect, web_source, video/audio encode, part, release group,
 * WordsMatcher preprocessing, explicit media-id tags, and Chinese 第N季/集/话
 * plus anime absolute-episode forms. This module reimplements those
 * recognizers in TypeScript; it is not a copy of MoviePilot source.
 */
import { parseChineseNumber } from "./chinese-number.js";
import {
  parseReleaseQuality,
  normalizeQualityText,
  type ParsedReleaseQuality,
  type ResolutionBand,
  type SourceClass,
} from "./quality-ladder.js";
import {
  compileReleaseGroupRegExp,
  compileStreamingPlatforms,
} from "./release-catalog.js";
import {
  extractExplicitMediaTags,
  prepareTitle,
  type MediaBinding,
} from "./words-matcher.js";

export { parseChineseNumber } from "./chinese-number.js";
export {
  prepareTitle,
  extractExplicitMediaTags,
  BUILTIN_IDENTIFIER_WORDS,
  applyEpisodeOffsetExpr,
  parseIdentifierWordLines,
  validateIdentifierWord,
  validateIdentifierWordText,
  customIdentifierWordsSpread,
} from "./words-matcher.js";

export type VideoCodec = "h264" | "h265" | "av1" | "avc" | "hevc" | "xvid" | "unknown";

export interface ReleaseEpisodeSpan {
  from: number;
  to: number;
  complete: boolean;
}

export interface ParseReleaseMetaOptions {
  /** MoviePilot-style identifier words (`from => to`, block, `front <> back >> EP±n`). */
  customWords?: readonly string[];
  /**
   * Extra listing segment (file name, share subtitle, …). With default `joinPath`,
   * it is merged Infopath-style as the leaf — episode tokens here win; parent
   * title fills season/year/quality gaps. Do not space-concatenate folder+file.
   */
  subtitle?: string;
  /** Skip built-in cloud-share noise words (tests / debugging). */
  includeBuiltinWords?: boolean;
  /**
   * Treat this string as a filename (bare `05.mkv` → episode 5). Set internally
   * for path leaves; callers rarely need it.
   */
  isFile?: boolean;
  /**
   * When false, do not split `/` `\\` path segments. Default true — Infopath-style
   * parent folders fill gaps, the leaf episode wins.
   */
  joinPath?: boolean;
}

export interface ReleaseMeta extends ParsedReleaseQuality {
  /** Calendar year when the title clearly names one. */
  year?: number;
  /**
   * Variety / news air-date token as `YYYY-MM-DD` (`2024.03.15`, `240315`,
   * `2024年3月15日`). Not episode identity — library codes stay SxxExx;
   * coverage mapping only hits a missing code that already embeds this date.
   */
  airDate?: string;
  /**
   * Named seasons. `-1` means “complete series” (intersect with tracked seasons).
   * Empty = unspecified (TV season-1 default at the coverage mapper).
   */
  seasons: number[];
  episode?: ReleaseEpisodeSpan;
  /** Fansub re-encode marker (`28v2` / `[08v3]`) — same episode, later version. */
  episodeVersion?: number;
  /** PART1 / CD1 / DISC1 when present (first token; see `discParts`). */
  part?: string;
  /**
   * Every disc/part token on the title (`CD1`, `PART2`, `上集`).
   * A range like `CD1-CD2` lists both. Empty = not a split disc listing.
   */
  discParts: string[];
  /** Raw pix token MoviePilot would put in resource_pix (e.g. 2160p, 4k). */
  resourcePix?: string;
  /** Raw source token (WEB-DL, BluRay, REMUX, …). */
  resourceType?: string;
  /** HDR / edition effects in appearance order (DoVi, HDR10, REPACK, IMAX, …). */
  resourceEffect: string[];
  /**
   * Pan/PT language tokens: `简中` `繁中` `简繁` `中字` `内封` `外挂`
   * `中英` `中日` `双语` `国语` `粤语` `生肉`. Empty = unmarked.
   */
  subtitleTags: string[];
  /** Streaming platform (Netflix, Amazon, Disney+, 爱奇艺, …). */
  webSource?: string;
  videoCodec: VideoCodec;
  /** Raw video-encode token (H265, HEVC, x264, …). */
  videoEncode?: string;
  /** Raw audio tag (Atmos, TrueHD 7.1, DDP 5.1, …). */
  audioCodec?: string;
  videoBit?: "8bit" | "10bit" | "12bit";
  releaseGroup?: string;
  fps?: number;
  /** CJK title leftover after stripping tags. */
  cnName?: string;
  /** Latin title leftover after stripping tags. */
  enName?: string;
  /** Title after identifier words + media-id tags are applied. */
  parsedTitle?: string;
  appliedWords: string[];
  mediaBinding?: MediaBinding;
  /** OVA / 特别篇 / SP — do not map onto regular SxxExx coverage. */
  special: boolean;
}

const MEDIA_EXT_RE = /\.(mkv|mp4|ts|m2ts|avi|mov|wmv|iso|rmvb|flv)$/i;

/** MoviePilot `is_anime` heuristics (bracket + dash-episode, unless Sxx/EPxx). */
const ANIME_BRACKET_RE = /【[+0-9XVPI-]+】\s*【/i;
const ANIME_SQUARE_RE = /\[[+0-9XVPI-]+]\s*\[/i;
const ANIME_DASH_EP_RE = /\s+-\s+\d{1,4}(?:v\d{1,2})?\s+/i;
const VIDEO_SEASON_EP_RE =
  /S\d{2}\s*-\s*S\d{2}|S\d{2}|\s+S\d{1,2}|EP?\d{2,4}\s*-\s*EP?\d{2,4}|EP?\d{2,4}|\s+EP?\d{1,4}/i;

const PIX_AS_EPISODE = new Set([480, 576, 720, 1080, 2160, 4320]);

/**
 * WEB/PT streaming tags. Codes/names from MoviePilot StreamingPlatforms
 * (see `release-catalog.ts`); CJK pan names are extra aliases.
 */
const WEB_PLATFORMS = compileStreamingPlatforms();

const WEB_NEAR_RE =
  /\bWEB[\s._-]?DL\b|\bWEB[\s._-]?RIP\b|\bWEBDL\b|\bWEBRIP\b|(?:^|[.\[_-])WEB(?:[.\]_-]|$)|官源/i;

/** Built-in groups MoviePilot matches around - @ [ 】 (Chinese fansubs + PT). */
const RELEASE_GROUP_RE = compileReleaseGroupRegExp();

const FANSUB_BRACKET_RE =
  /[【\[]([^\]】]{2,24}(?:字幕组|字幕社|字幕|Raws|House|Sub|手抄部|奶茶屋|发布组|压制组))[】\]]/;

const DISC_KIND_RE = "part|cd|dvd|disk|disc";
const DISC_RANGE_RE = new RegExp(
  `\\b(${DISC_KIND_RE})\\s*([0-9abi]{1,2})\\s*[-+~_/到至]\\s*(?:(?:${DISC_KIND_RE})\\s*)?([0-9abi]{1,2})\\b`,
  "gi",
);
const DISC_SINGLE_RE = new RegExp(`\\b(${DISC_KIND_RE})\\s*([0-9abi]{1,2})\\b`, "gi");
const CJK_BOTH_DISC_RE = /上下[集部碟篇]/;
const CJK_UPPER_DISC_RE = /上[集部碟篇]/;
const CJK_LOWER_DISC_RE = /下[集部碟篇]/;

const VIDEO_BIT_RE = /(?<![A-Za-z0-9])(8|10|12)[\s._-]*bits?\b/i;

const AUDIO_TOKEN_RE =
  /\b(?:atmos|true[\s._-]*hd|dts[\s._-]*hd(?:[\s._-]*ma)?|dts[\s._:]*x|eac3|ddp?[\s._+-]?\d?(?:\.\d)?|dd\+|aac|flac|lpcm|ac3|opus|e-?ac-?3)(?:[\s._-]*\d(?:\.\d)?)?\b|杜比全景声|全景声|\b[257]\.1\b|\b2\.0\b/gi;

const EFFECT_TOKEN_RE =
  /\b(?:sdr|hdr10(?:\+|p(?:lus)?)?|hdrvivid|hdr[\s._-]*vivid|hdr|dovi|dv|dolby[\s._-]*vision|hlg|edr|repack|proper|rerip|hq|3d|imax|extended|uncut|unrated|unrate)\b|杜比视界|未删减|导演剪辑|加长版/gi;

const FPS_RE = /(?<![A-Za-z0-9])(\d{2,3})\s*fps\b/i;

const VIDEO_ENCODE_RE = /\b(?:h[\s._-]*26[45]|x26[45]|hevc|avc|av1|xvid|divx|mpeg-?4)\b/i;

const SPECIAL_RE = /特别篇|番外(?:篇)?|\bOVA\b|\bOAD\b|\bONA\b|(?<![A-Za-z])SP\d*(?![A-Za-z])/i;

const NAME_NOISE_RE =
  /合集|连载|日剧|美剧|韩剧|电视剧|动画片|动漫|欧美|超高清|全高清|超清|高清|无水印|下载|蓝光|最终季|版本|出品|台版|港版|未删减版|简繁内封|简中内封|简中内嵌|中日双语|国语中字|中字|国语|双语|[多中国英葡法俄日韩德意西印泰台港粤双文语简繁体特效内封官译外挂]+字幕|类型[:：]?\s*动画|TV Series|Animation|Movie|Documentar|Anime/gi;

export function isAnimeTitle(name: string): boolean {
  if (!name) {
    return false;
  }
  if (ANIME_BRACKET_RE.test(name) || ANIME_DASH_EP_RE.test(name)) {
    return true;
  }
  if (VIDEO_SEASON_EP_RE.test(name)) {
    return false;
  }
  return ANIME_SQUARE_RE.test(name);
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function isPlausibleEpisode(n: number): boolean {
  return n >= 1 && n < 4000 && !PIX_AS_EPISODE.has(n) && !(n >= 1900 && n <= 2155);
}

export function parseNamedSeasons(title: string): number[] {
  const seasons: number[] = [];
  const seasonRe = /第\s*([一二三四五六七八九十两\dIVXⅠ-Ⅻ]{1,4})\s*季/g;
  let match: RegExpExecArray | null;
  while ((match = seasonRe.exec(title)) !== null) {
    const n = parseChineseNumber(match[1]!);
    if (n !== null && n >= 1) {
      seasons.push(n);
    }
  }
  const sxe = /[Ss](\d{1,2})[Ee]\d/g;
  while ((match = sxe.exec(title)) !== null) {
    const n = Number(match[1]);
    if (n >= 1) {
      seasons.push(n);
    }
  }
  const latin = /(?:\bseason\s*)(\d{1,2})\b|(?:^|[.\s_\[(])s(\d{1,2})(?:[.\s_\])e]|$)/gi;
  while ((match = latin.exec(title)) !== null) {
    const n = Number(match[1] ?? match[2]);
    if (n >= 1) {
      seasons.push(n);
    }
  }
  const span = /S(\d{1,2})\s*[-~～到至]\s*S?(\d{1,2})/i.exec(title);
  if (span) {
    const from = Number(span[1]);
    const to = Number(span[2]);
    if (from >= 1 && to >= from && to <= 20) {
      for (let season = from; season <= to; season += 1) {
        seasons.push(season);
      }
    }
  }
  const allSeasons = /[全共]\s*([一二三四五六七八九十两\d]{1,3})\s*季|complete\s*series/i.exec(title);
  if (allSeasons) {
    if (allSeasons[1]) {
      const n = parseChineseNumber(allSeasons[1]);
      if (n !== null && n >= 1 && n <= 20) {
        for (let season = 1; season <= n; season += 1) {
          seasons.push(season);
        }
      }
    } else {
      seasons.push(-1);
    }
  }
  return uniqueSorted(seasons.filter((season) => season !== 0));
}

interface ParsedEpisodeToken {
  span: ReleaseEpisodeSpan;
  version?: number;
}

function parseEpisodeVersion(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }
  const n = Number(raw);
  return n >= 1 && n <= 99 ? n : undefined;
}

function singleEpisode(n: number, versionRaw?: string): ParsedEpisodeToken | null {
  if (!isPlausibleEpisode(n)) {
    return null;
  }
  const version = parseEpisodeVersion(versionRaw);
  return {
    span: { from: n, to: n, complete: false },
    ...(version === undefined ? {} : { version }),
  };
}

function parseEpisodeToken(title: string): ParsedEpisodeToken | null {
  const fin =
    /(?<!\d)\[?\s*(\d{1,4})\s*[-~～]\s*(\d{1,4})\s*(?:(?:Fin|End)(?![a-z0-9])|完结)(?:\s*\]|(?!\d))/i.exec(
      title,
    );
  if (fin) {
    const from = Number(fin[1]);
    const to = Number(fin[2]);
    if (from >= 1 && to >= from && to < 10000 && !(from >= 1900 && to <= 2155)) {
      return { span: { from, to, complete: true } };
    }
  }

  const range =
    /(?:E|EP|第)\s*(\d{1,4})\s*[-~～至到]\s*(?:E|EP|第)?\s*(\d{1,4})\s*[集话話期幕]?/i.exec(title) ??
    /(\d{1,4})\s*[-~～至到]\s*(\d{1,4})\s*[集话話期幕]/.exec(title);
  if (range) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    if (from >= 1 && to >= from && !(from >= 1900 && to <= 2155)) {
      return { span: { from, to, complete: false } };
    }
  }

  const until = /更新至\s*(?:第)?\s*(\d{1,4})\s*[集话話]/.exec(title);
  if (until) {
    return { span: { from: 1, to: Number(until[1]), complete: false } };
  }

  const between =
    /第\s*([0-9一二三四五六七八九十百零]+)\s*[集话話期幕]?\s*[-~～至到]\s*第?\s*([0-9一二三四五六七八九十百零]+)\s*[集话話期幕]/.exec(
      title,
    );
  if (between) {
    const from = parseChineseNumber(between[1]!);
    const to = parseChineseNumber(between[2]!);
    if (from !== null && to !== null && from >= 1 && to >= from) {
      return { span: { from, to, complete: false } };
    }
  }

  const sxe = /[Ss]\d{1,2}[Ee](\d{1,4})(?:v(\d{1,2}))?/i.exec(title);
  if (sxe) {
    const hit = singleEpisode(Number(sxe[1]), sxe[2]);
    if (hit) {
      return hit;
    }
  }

  const chinese = /第\s*([0-9一二三四五六七八九十百零EP]+)\s*[集话話期幕]/.exec(title);
  if (chinese) {
    const raw = chinese[1]!.replace(/[EP]/gi, "");
    const hit = singleEpisode(parseChineseNumber(raw) ?? Number(raw));
    if (hit) {
      return hit;
    }
  }

  const tv = /\[TV\s+(\d{1,4})(?:v(\d{1,2}))?\]/i.exec(title);
  if (tv) {
    const hit = singleEpisode(Number(tv[1]), tv[2]);
    if (hit) {
      return hit;
    }
  }

  const latinEp = /\bE(?:P)?(\d{1,4})(?:v(\d{1,2}))?(?![A-Za-z0-9])/i.exec(title);
  if (latinEp) {
    const hit = singleEpisode(Number(latinEp[1]), latinEp[2]);
    if (hit) {
      return hit;
    }
  }

  const episodeWord = /\bEpisode\s+(\d{1,4})(?:v(\d{1,2}))?\b/i.exec(title);
  if (episodeWord) {
    const hit = singleEpisode(Number(episodeWord[1]), episodeWord[2]);
    if (hit) {
      return hit;
    }
  }

  const hash = /#(\d{1,4})(?:v(\d{1,2}))?\b/i.exec(title);
  if (hash) {
    const hit = singleEpisode(Number(hash[1]), hash[2]);
    if (hit) {
      return hit;
    }
  }

  const dash = /\s+-\s+(\d{1,4})(?:v(\d{1,2}))?(?=$|[\s.\[\]【】])/i.exec(title);
  if (dash && (isAnimeTitle(title) || dash[2] || /[【\[]\d{1,4}(?:v\d+)?[】\]]/.test(title))) {
    const hit = singleEpisode(Number(dash[1]), dash[2]);
    if (hit) {
      return hit;
    }
  }

  if (isAnimeTitle(title) || /[【\[]\d{1,4}(?:v\d+)?[】\]]/.test(title)) {
    for (const bracket of title.matchAll(/[【\[](\d{1,4})(?:v(\d{1,2}))?[】\]]/g)) {
      const hit = singleEpisode(Number(bracket[1]), bracket[2]);
      if (hit) {
        return hit;
      }
    }
  }

  const versioned = /(?<![A-Za-z0-9])(\d{1,4})v(\d{1,2})(?![A-Za-z0-9])/i.exec(title);
  if (versioned) {
    const hit = singleEpisode(Number(versioned[1]), versioned[2]);
    if (hit) {
      return hit;
    }
  }

  if (/全集|\bcomplete\b/i.test(title) && !/complete\s*series/i.test(title)) {
    const count = /[全共]\s*(\d{1,4})\s*[集话話]/.exec(title);
    if (count) {
      return { span: { from: 1, to: Number(count[1]), complete: true } };
    }
    return { span: { from: 1, to: 9999, complete: true } };
  }
  return null;
}

export function parseEpisodeSpanFromTitle(title: string): ReleaseEpisodeSpan | null {
  return parseEpisodeToken(title)?.span ?? null;
}

const AIR_DATE_YEAR_MIN = 1970;
const AIR_DATE_YEAR_MAX = 2049;

function isValidAirDateParts(year: number, month: number, day: number): boolean {
  if (year < AIR_DATE_YEAR_MIN || year > AIR_DATE_YEAR_MAX) {
    return false;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}

function formatAirDate(year: number, month: number, day: number): string | undefined {
  if (!isValidAirDateParts(year, month, day)) {
    return undefined;
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function expandAirDateYear(yy: number): number {
  return yy <= 69 ? 2000 + yy : 1900 + yy;
}

interface ParsedAirDate {
  iso: string;
  raw: string;
  index: number;
  rank: number;
}

function pushAirDate(
  out: ParsedAirDate[],
  raw: string,
  index: number,
  rank: number,
  year: number,
  month: number,
  day: number,
): void {
  const iso = formatAirDate(year, month, day);
  if (!iso) {
    return;
  }
  out.push({ iso, raw, index, rank });
}

function matchAirDate(title: string): ParsedAirDate | undefined {
  const hits: ParsedAirDate[] = [];

  const cjkRe = /((?:19|20)\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/g;
  let match: RegExpExecArray | null;
  while ((match = cjkRe.exec(title)) !== null) {
    pushAirDate(hits, match[0], match.index, 0, Number(match[1]), Number(match[2]), Number(match[3]));
  }

  const sepRe = /(?<![A-Za-z0-9])((?:19|20)\d{2})[\s._-](\d{1,2})[\s._-](\d{1,2})(?![A-Za-z0-9])/g;
  while ((match = sepRe.exec(title)) !== null) {
    pushAirDate(hits, match[0], match.index, 1, Number(match[1]), Number(match[2]), Number(match[3]));
  }

  const ymd8Re = /(?<![A-Za-z0-9])((?:19|20)\d{2})(\d{2})(\d{2})(?![A-Za-z0-9])/g;
  while ((match = ymd8Re.exec(title)) !== null) {
    pushAirDate(hits, match[0], match.index, 2, Number(match[1]), Number(match[2]), Number(match[3]));
  }

  const ymd6Re = /(?<![A-Za-z0-9])(\d{2})(\d{2})(\d{2})(?![A-Za-z0-9])/g;
  while ((match = ymd6Re.exec(title)) !== null) {
    pushAirDate(
      hits,
      match[0],
      match.index,
      3,
      expandAirDateYear(Number(match[1])),
      Number(match[2]),
      Number(match[3]),
    );
  }

  if (hits.length === 0) {
    return undefined;
  }
  hits.sort((a, b) => a.index - b.index || a.rank - b.rank);
  return hits[0];
}

/**
 * Calendar date used as a variety/news episode token. Rejects year-only,
 * year-span (`2019-2020`), and resolution (`2160` / `1080p`) tokens.
 */
export function parseAirDateFromTitle(title: string): string | undefined {
  return matchAirDate(title)?.iso;
}

/** Identity strings a missing-episode code may equal when it embeds this air date. */
export function airDateCodeForms(iso: string): string[] {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!parts) {
    return [];
  }
  const year = parts[1]!;
  const month = parts[2]!;
  const day = parts[3]!;
  const monthNum = String(Number(month));
  const dayNum = String(Number(day));
  return [
    iso,
    `${year}${month}${day}`,
    `${year.slice(2)}${month}${day}`,
    `${year}.${month}.${day}`,
    `${year}.${monthNum}.${dayNum}`,
    `${year}-${month}-${day}`,
    `${year}-${monthNum}-${dayNum}`,
    `${year}年${monthNum}月${dayNum}日`,
    `${year}年${month}月${day}日`,
  ];
}

function mapVideoCodec(title: string): VideoCodec {
  const text = normalizeQualityText(title);
  if (/\b(?:h[\s._-]*265|x265|hevc)\b/i.test(text)) {
    return "h265";
  }
  if (/\b(?:h[\s._-]*264|x264|avc)\b/i.test(text)) {
    return "h264";
  }
  if (/\bav1\b/i.test(text)) {
    return "av1";
  }
  if (/\bxvid\b|\bdivx\b/i.test(text)) {
    return "xvid";
  }
  return "unknown";
}

function detectVideoEncode(title: string): string | undefined {
  const match = VIDEO_ENCODE_RE.exec(normalizeQualityText(title));
  if (!match) {
    return undefined;
  }
  return match[0].replace(/[\s._-]+/g, "").replace(/^h/i, "H").replace(/^x/i, "x");
}

function mapVideoBit(title: string): ReleaseMeta["videoBit"] {
  const match = VIDEO_BIT_RE.exec(normalizeQualityText(title));
  if (!match) {
    return undefined;
  }
  if (match[1] === "10") {
    return "10bit";
  }
  if (match[1] === "12") {
    return "12bit";
  }
  return "8bit";
}

function detectWebSource(title: string): string | undefined {
  const text = normalizeQualityText(title);
  const nearWeb = WEB_NEAR_RE.test(text);
  for (const platform of WEB_PLATFORMS) {
    if (!platform.cjkRe) {
      continue;
    }
    platform.cjkRe.lastIndex = 0;
    if (platform.cjkRe.test(text)) {
      return platform.name;
    }
  }
  if (!nearWeb) {
    return undefined;
  }
  for (const platform of WEB_PLATFORMS) {
    if (!platform.latinRe) {
      continue;
    }
    platform.latinRe.lastIndex = 0;
    if (platform.latinRe.test(text)) {
      return platform.name;
    }
  }
  return undefined;
}

function detectReleaseGroup(title: string): string | undefined {
  const fansub = FANSUB_BRACKET_RE.exec(title);
  if (fansub?.[1]) {
    return fansub[1].trim();
  }
  const group = RELEASE_GROUP_RE.exec(`${title} `);
  return group?.[0];
}

function discIndexFromRaw(raw: string): number | undefined {
  const token = raw.toLowerCase();
  if (token === "a" || token === "i") {
    return 1;
  }
  if (token === "b") {
    return 2;
  }
  const n = Number(token);
  return Number.isInteger(n) && n >= 1 && n <= 20 ? n : undefined;
}

function canonicalDiscToken(kind: string, rawIndex: string): string | undefined {
  const index = discIndexFromRaw(rawIndex);
  if (index === undefined) {
    return undefined;
  }
  const label = kind.toUpperCase() === "DISK" ? "DISC" : kind.toUpperCase();
  // DVD5 / DVD9 are dual-layer capacity tags, not disc indices.
  if (label === "DVD" && (index === 5 || index === 9)) {
    return undefined;
  }
  return `${label}${index}`;
}

function pushUniqueToken(tokens: string[], token: string | undefined): void {
  if (!token || tokens.includes(token)) {
    return;
  }
  tokens.push(token);
}

/** Collect CD/PART/DISC tokens, including `CD1-CD2` / `CD1-2` ranges and 上/下集. */
export function parseDiscPartTokens(title: string): string[] {
  const text = normalizeQualityText(title);
  const tokens: string[] = [];
  DISC_RANGE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DISC_RANGE_RE.exec(text)) !== null) {
    pushUniqueToken(tokens, canonicalDiscToken(match[1]!, match[2]!));
    pushUniqueToken(tokens, canonicalDiscToken(match[1]!, match[3]!));
  }
  DISC_SINGLE_RE.lastIndex = 0;
  while ((match = DISC_SINGLE_RE.exec(text)) !== null) {
    pushUniqueToken(tokens, canonicalDiscToken(match[1]!, match[2]!));
  }
  if (CJK_BOTH_DISC_RE.test(text)) {
    pushUniqueToken(tokens, "上集");
    pushUniqueToken(tokens, "下集");
  } else {
    if (CJK_UPPER_DISC_RE.test(text)) {
      pushUniqueToken(tokens, "上集");
    }
    if (CJK_LOWER_DISC_RE.test(text)) {
      pushUniqueToken(tokens, "下集");
    }
  }
  return tokens;
}

function uniqueDiscKeys(tokens: readonly string[]): string[] {
  const keys: string[] = [];
  for (const token of tokens) {
    if (token === "上集") {
      pushUniqueToken(keys, "1");
      continue;
    }
    if (token === "下集") {
      pushUniqueToken(keys, "2");
      continue;
    }
    const numbered = /(\d{1,2})$/.exec(token);
    if (numbered) {
      pushUniqueToken(keys, String(Number(numbered[1])));
    }
  }
  return keys;
}

/**
 * True when the title names exactly one disc of a multi-disc split
 * (`CD1`, `PART2`, `上集`). A same-title set (`CD1+CD2`, `CD1-2`, `上下集`)
 * or a title with no disc token is complete for movie selection.
 */
export function isIncompleteMovieDisc(input: string | Pick<ReleaseMeta, "discParts">): boolean {
  const tokens = typeof input === "string" ? parseDiscPartTokens(input) : input.discParts;
  return uniqueDiscKeys(tokens).length === 1;
}

function pushSubtitleTag(tags: string[], tag: string): void {
  if (!tags.includes(tag)) {
    tags.push(tag);
  }
}

/**
 * Chinese pan/PT subtitle and audio-language tokens. Canonical tags:
 * `简中` `繁中` `简繁` `中字` `内封` `外挂` `中英` `中日` `双语` `国语` `粤语` `生肉`.
 */
export function parseSubtitleTags(title: string): string[] {
  const text = normalizeQualityText(title);
  const tags: string[] = [];
  if (/简繁|简体\s*繁体|CHS[\s._+-]*CHT|GB[\s._+-]*BIG5/i.test(text)) {
    pushSubtitleTag(tags, "简繁");
  }
  if (/简中|简体|简日|简英|\bCHS\b|\bGB\b/i.test(text)) {
    pushSubtitleTag(tags, "简中");
  }
  if (/繁中|繁体|繁體|繁日|繁英|\bCHT\b|\bBIG5\b/i.test(text)) {
    pushSubtitleTag(tags, "繁中");
  }
  if (/中英|英中|CHS[\s._+-]*ENG|ENG[\s._+-]*CHS|中英双字/i.test(text)) {
    pushSubtitleTag(tags, "中英");
  }
  if (/中日|日中|简日|繁日/i.test(text)) {
    pushSubtitleTag(tags, "中日");
  }
  if (/双语|双字/i.test(text)) {
    pushSubtitleTag(tags, "双语");
  }
  if (/内封|内嵌|硬字幕/i.test(text)) {
    pushSubtitleTag(tags, "内封");
  }
  if (/外挂|软字幕/i.test(text)) {
    pushSubtitleTag(tags, "外挂");
  }
  if (/国粤/i.test(text)) {
    pushSubtitleTag(tags, "国语");
    pushSubtitleTag(tags, "粤语");
    pushSubtitleTag(tags, "双语");
  }
  if (/国语|普通话|国配|\bmandarin\b/i.test(text)) {
    pushSubtitleTag(tags, "国语");
  }
  if (/粤语|粤配|\bcantonese\b/i.test(text)) {
    pushSubtitleTag(tags, "粤语");
  }
  if (/(?<!无)中字|中文字幕|官中/i.test(text)) {
    pushSubtitleTag(tags, "中字");
  }
  if (/无字幕|生肉|无中字|(?<![A-Za-z])RAW(?![A-Za-z])/i.test(text)) {
    pushSubtitleTag(tags, "生肉");
  }
  return tags;
}

function detectResourcePix(title: string, resolution: ResolutionBand): string | undefined {
  const text = normalizeQualityText(title);
  const pix = /(\d{3,4})[pi]|([248])k|\buhd\b|(\d{3,4})\s*[x×]\s*(\d{3,4})|[\[(](2160|1080|720|480|576|4k|uhd)[\])]/i.exec(
    text,
  );
  if (pix) {
    if (pix[2]) {
      return `${pix[2]}k`;
    }
    if (pix[5]) {
      const token = pix[5].toLowerCase();
      if (token === "4k" || token === "uhd" || token === "2160") {
        return token === "2160" ? "2160p" : token;
      }
      return `${token}p`;
    }
    if (pix[3] && pix[4]) {
      return `${pix[4]}p`.toLowerCase();
    }
    if (pix[1]) {
      return `${pix[1]}p`;
    }
    return "uhd";
  }
  if (resolution === "4k") {
    return "4k";
  }
  if (resolution === "1080p" || resolution === "720p" || resolution === "sd") {
    return resolution;
  }
  return undefined;
}

function detectResourceType(title: string, source: SourceClass): string | undefined {
  const text = normalizeQualityText(title);
  const parts: string[] = [];
  if (/\buhd\b/i.test(text) && /\bblu/i.test(text)) {
    parts.push("UHD");
  }
  if (/\bblu[\s._-]*ray\b|\bbluray\b/i.test(text)) {
    parts.push("BluRay");
  } else if (/\bbd[\s._-]*rip\b|\bbdrip\b/i.test(text)) {
    parts.push("BDRip");
  } else if (/\bbd\b/i.test(text) && !/\bbluray\b|\bblu[\s._-]*ray\b/i.test(text)) {
    parts.push("BD");
  }
  if (/\bremux\b|无压/i.test(text)) {
    parts.push("REMUX");
  }
  if (parts.length > 0) {
    return parts.join(" ");
  }
  if (/\bweb[\s._-]*dl\b|\bwebdl\b|官源/i.test(text)) {
    return "WEB-DL";
  }
  if (/\bweb[\s._-]*rip\b|\bwebrip\b/i.test(text)) {
    return "WEBRip";
  }
  if (/\bhdtv\b|\buhdtv\b|\bsdtv\b/i.test(text)) {
    return "HDTV";
  }
  if (/\bhd[\s._-]*rip\b/i.test(text)) {
    return "HDRip";
  }
  if (/\bdvd[\s._-]*rip\b/i.test(text)) {
    return "DVDRip";
  }
  if (source === "cam") {
    return "CAM";
  }
  if (source !== "unknown") {
    return source;
  }
  return undefined;
}

function detectEffects(title: string): string[] {
  const text = normalizeQualityText(title);
  const seen = new Set<string>();
  const out: string[] = [];
  EFFECT_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = EFFECT_TOKEN_RE.exec(text)) !== null) {
    const raw = match[0].replace(/[\s._-]+/g, "").toUpperCase();
    let label = raw;
    if (/DOLBYVISION|DOVI|^DV$|杜比视界/.test(raw) || raw === "DOLBYVISION") {
      label = "DoVi";
    } else if (/HDR10(\+|P|PLUS)/.test(raw)) {
      label = "HDR10+";
    } else if (raw === "HDR10" || raw === "HDR") {
      label = raw === "HDR10" ? "HDR10" : "HDR";
    } else if (raw === "IMAX") {
      label = "IMAX";
    } else if (raw === "3D") {
      label = "3D";
    } else if (/未删减|UNCUT|UNRATE/.test(raw)) {
      label = "UNCUT";
    } else if (/导演剪辑|加长版|EXTENDED/.test(raw)) {
      label = "Extended";
    }
    if (!seen.has(label)) {
      seen.add(label);
      out.push(label);
    }
  }
  return out;
}

function detectYear(title: string): number | undefined {
  const paren = /\(\s*((?:19|20)\d{2})\s*\)/.exec(title);
  if (paren) {
    return Number(paren[1]);
  }
  const years = [...title.matchAll(/\b((?:19|20)\d{2})\b/g)].map((match) => Number(match[1]));
  const plausible = years.filter((year) => year > 1900 && year < 2050);
  return plausible.length > 0 ? plausible[plausible.length - 1] : undefined;
}

function detectFps(title: string): number | undefined {
  const match = FPS_RE.exec(normalizeQualityText(title));
  if (!match) {
    return undefined;
  }
  const fps = Number(match[1]);
  return fps >= 23 && fps <= 240 ? fps : undefined;
}

function detectAudioCodec(title: string): string | undefined {
  const text = normalizeQualityText(title);
  AUDIO_TOKEN_RE.lastIndex = 0;
  const tokens: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = AUDIO_TOKEN_RE.exec(text)) !== null) {
    const token = match[0].replace(/[\s._-]+/g, " ").trim();
    if (!tokens.some((existing) => existing.toLowerCase() === token.toLowerCase())) {
      tokens.push(token);
    }
  }
  return tokens.length > 0 ? tokens.join(" ") : undefined;
}

function stripForNames(title: string): string {
  let rest = title;
  rest = rest.replace(FANSUB_BRACKET_RE, " ");
  rest = rest.replace(RELEASE_GROUP_RE, " ");
  rest = rest.replace(MEDIA_EXT_RE, " ");
  const dated = matchAirDate(rest);
  if (dated) {
    rest = rest.replace(dated.raw, " ");
  }
  rest = rest.replace(/\(\s*(?:19|20)\d{2}\s*\)/g, " ");
  rest = rest.replace(/\b(?:19|20)\d{2}\b/g, " ");
  rest = rest.replace(/第\s*[一二三四五六七八九十两\dIVXⅠ-Ⅻ]{1,4}\s*[季集话話期幕]/g, " ");
  rest = rest.replace(/\bS\d{1,2}(?:E\d{1,4}(?:v\d{1,2})?)?\b/gi, " ");
  rest = rest.replace(/[【\[]\d{1,4}(?:v\d{1,2})?[】\]]/g, " ");
  rest = rest.replace(/\[TV\s+\d{1,4}(?:v\d{1,2})?\]/gi, " ");
  rest = rest.replace(/#\d{1,4}(?:v\d{1,2})?\b/gi, " ");
  rest = rest.replace(/(?<![A-Za-z0-9])\d{1,4}v\d{1,2}(?![A-Za-z0-9])/gi, " ");
  rest = rest.replace(NAME_NOISE_RE, " ");
  rest = rest.replace(releaseMetaNoisePattern(), " ");
  rest = rest.replace(/[-@][A-Za-z0-9]+$/g, " ");
  rest = rest.replace(/[【\[\(].{0,40}[】\]\)]/g, " ");
  return rest.replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
}

function extractNames(title: string): { cnName?: string; enName?: string } {
  const cleaned = stripForNames(title);
  if (!cleaned) {
    return {};
  }
  const slash = cleaned.split(/\s*\/\s*/).map((part) => part.trim()).filter(Boolean);
  if (slash.length >= 2) {
    const left = slash[0]!;
    const right = slash[slash.length - 1]!;
    const leftCjk = /[\u4e00-\u9fff]/.test(left);
    const rightCjk = /[\u4e00-\u9fff]/.test(right);
    if (leftCjk && !rightCjk) {
      return omitEmptyNames({ cnName: left, enName: titleCaseName(right) });
    }
    if (rightCjk && !leftCjk) {
      return omitEmptyNames({ cnName: right, enName: titleCaseName(left) });
    }
  }
  const cjk = cleaned.match(/[\u4e00-\u9fff0-9：:·\-—]{2,}/g)?.join(" ").trim();
  const latin = cleaned
    .replace(/[\u4e00-\u9fff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return omitEmptyNames({
    ...(cjk ? { cnName: cjk } : {}),
    ...(latin && /[A-Za-z]{2,}/.test(latin) ? { enName: titleCaseName(latin) } : {}),
  });
}

function titleCaseName(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (word === word.toUpperCase() && word.length <= 3 ? word : word[0]!.toUpperCase() + word.slice(1).toLowerCase()))
    .join(" ");
}

function omitEmptyNames(value: { cnName?: string; enName?: string }): { cnName?: string; enName?: string } {
  const out: { cnName?: string; enName?: string } = {};
  if (value.cnName && value.cnName.length >= 1) {
    out.cnName = value.cnName;
  }
  if (value.enName && value.enName.length >= 2) {
    out.enName = value.enName;
  }
  return out;
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  const out = { ...value };
  for (const key of Object.keys(out)) {
    if (out[key] === undefined) {
      delete out[key];
    }
  }
  return out;
}

const PATH_SPLIT_RE = /[/\\／]+/;
const LISTING_EXT_RE =
  /\.(mkv|mp4|ts|m2ts|avi|mov|wmv|iso|rmvb|flv|srt|ass|ssa|sub|idx|vtt|sup|smi)$/i;
/** `中文 / English` PT bilingual titles — not a folder/file path. */
const UNSPACED_SLASH_RE = /[^/\s][/\\／][^/\s]/;

/** Split a share title or listing path into folder + file segments. */
export function splitReleaseTitleParts(title: string): string[] {
  const trimmed = title.trim();
  if (!trimmed) {
    return [];
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return [trimmed];
  }
  const rawParts = trimmed
    .split(PATH_SPLIT_RE)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part !== "." && part !== "..");
  if (rawParts.length <= 1) {
    return rawParts;
  }
  const leaf = rawParts[rawParts.length - 1]!;
  const looksLikeListing =
    LISTING_EXT_RE.test(leaf) || UNSPACED_SLASH_RE.test(trimmed) || rawParts.length >= 3;
  return looksLikeListing ? rawParts : [trimmed];
}

/**
 * Join folder/file names so `parseReleaseMeta` can apply Infopath merge.
 * Callers with separate parent + leaf should use this instead of ad-hoc concat.
 *
 * Real shapes in this codebase:
 * - search candidates (`ResourceCandidate.title`): share / PT listing name;
 *   sometimes already path-like (`狩猎 (2022)/狩猎.mkv`)
 * - sandbox interrogation (`SimTreeFile.path`): relative listing, e.g.
 *   `[Group] Show S01/Show - 01.mkv`
 * - verified library files (`VerifiedFile.name`): filename only
 */
export function joinReleaseTitleParts(parts: readonly string[]): string {
  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("/");
}

/** Parse already-split folder + file segments with Infopath merge. */
export function parseReleaseMetaParts(
  parts: readonly string[],
  options: ParseReleaseMetaOptions = {},
): ReleaseMeta {
  const { subtitle: _subtitle, ...rest } = options;
  return parseReleaseMeta(joinReleaseTitleParts(parts), rest);
}

function isTvLike(meta: ReleaseMeta): boolean {
  return meta.seasons.length > 0 || meta.episode !== undefined || meta.special;
}

/**
 * MoviePilot MetaInfoPath merge: leaf wins; parent fills empty fields.
 * A TV parent is not merged onto a non-TV leaf (folder pack vs a movie file).
 */
function shouldMergeParent(leaf: ReleaseMeta, parent: ReleaseMeta): boolean {
  return isTvLike(leaf) || !isTvLike(parent);
}

function mergeReleaseMeta(leaf: ReleaseMeta, parent: ReleaseMeta): ReleaseMeta {
  const pick = <T>(leafVal: T, parentVal: T, empty: T): T =>
    leafVal !== empty ? leafVal : parentVal;
  let seasons = leaf.seasons.length > 0 ? leaf.seasons : parent.seasons;
  if (leaf.episode && leaf.seasons.length === 0) {
    // Keep named parent seasons; drop a generic 全集 / complete-series (-1)
    // so a specific leaf episode is not treated as the whole pack.
    seasons = parent.seasons.filter((season) => season > 0);
  }
  const effects = [...leaf.resourceEffect];
  for (const effect of parent.resourceEffect) {
    if (!effects.includes(effect)) {
      effects.push(effect);
    }
  }
  const discParts = [...leaf.discParts];
  for (const token of parent.discParts) {
    if (!discParts.includes(token)) {
      discParts.push(token);
    }
  }
  const subtitleTags = [...leaf.subtitleTags];
  for (const tag of parent.subtitleTags) {
    if (!subtitleTags.includes(tag)) {
      subtitleTags.push(tag);
    }
  }
  const applied = [...leaf.appliedWords];
  for (const word of parent.appliedWords) {
    if (!applied.includes(word)) {
      applied.push(word);
    }
  }
  const parsedTitle = leaf.parsedTitle || parent.parsedTitle;
  return omitUndefined({
    resolution: pick(leaf.resolution, parent.resolution, "unknown"),
    hdr: pick(leaf.hdr, parent.hdr, "sdr"),
    source: pick(leaf.source, parent.source, "unknown"),
    audio: pick(leaf.audio, parent.audio, "unknown"),
    discImage: leaf.discImage,
    seasons,
    resourceEffect: effects,
    discParts,
    subtitleTags,
    videoCodec: pick(leaf.videoCodec, parent.videoCodec, "unknown"),
    appliedWords: applied,
    special: leaf.special || (!leaf.episode && parent.special),
    ...(parsedTitle ? { parsedTitle } : {}),
    ...(leaf.episode
      ? {
          episode: leaf.episode,
          ...(leaf.episodeVersion !== undefined ? { episodeVersion: leaf.episodeVersion } : {}),
        }
      : parent.episode
        ? {
            episode: parent.episode,
            ...(parent.episodeVersion !== undefined ? { episodeVersion: parent.episodeVersion } : {}),
          }
        : {}),
    ...(leaf.year !== undefined ? { year: leaf.year } : parent.year !== undefined ? { year: parent.year } : {}),
    ...(leaf.airDate
      ? { airDate: leaf.airDate }
      : parent.airDate
        ? { airDate: parent.airDate }
        : {}),
    ...(discParts[0] ? { part: leaf.part ?? parent.part ?? discParts[0] } : {}),
    ...(leaf.webSource ? { webSource: leaf.webSource } : parent.webSource ? { webSource: parent.webSource } : {}),
    ...(leaf.releaseGroup ? { releaseGroup: leaf.releaseGroup } : parent.releaseGroup ? { releaseGroup: parent.releaseGroup } : {}),
    ...(leaf.resourcePix ? { resourcePix: leaf.resourcePix } : parent.resourcePix ? { resourcePix: parent.resourcePix } : {}),
    ...(leaf.resourceType ? { resourceType: leaf.resourceType } : parent.resourceType ? { resourceType: parent.resourceType } : {}),
    ...(leaf.audioCodec ? { audioCodec: leaf.audioCodec } : parent.audioCodec ? { audioCodec: parent.audioCodec } : {}),
    ...(leaf.videoBit ? { videoBit: leaf.videoBit } : parent.videoBit ? { videoBit: parent.videoBit } : {}),
    ...(leaf.fps !== undefined ? { fps: leaf.fps } : parent.fps !== undefined ? { fps: parent.fps } : {}),
    ...(leaf.videoEncode ? { videoEncode: leaf.videoEncode } : parent.videoEncode ? { videoEncode: parent.videoEncode } : {}),
    ...(leaf.mediaBinding ? { mediaBinding: leaf.mediaBinding } : parent.mediaBinding ? { mediaBinding: parent.mediaBinding } : {}),
    ...(leaf.cnName ? { cnName: leaf.cnName } : parent.cnName ? { cnName: parent.cnName } : {}),
    ...(leaf.enName ? { enName: leaf.enName } : parent.enName ? { enName: parent.enName } : {}),
  });
}

function parseReleaseMetaFlat(title: string, options: ParseReleaseMetaOptions = {}): ReleaseMeta {
  const prepared = prepareTitle(
    title,
    options.customWords ?? [],
    options.includeBuiltinWords === undefined ? {} : { includeBuiltin: options.includeBuiltinWords },
  );
  const tagged = extractExplicitMediaTags(prepared.title);
  const working = [tagged.title, options.subtitle].filter((part) => part && part.trim().length > 0).join(" ");
  const stem = working.replace(MEDIA_EXT_RE, "");
  const quality = parseReleaseQuality(stem);
  const namedSeasons = parseNamedSeasons(stem);
  let parsed = parseEpisodeToken(stem);
  if (!parsed && options.isFile) {
    const trimmedStem = stem.trim();
    const bare = /^(\d{1,4})(?:v(\d{1,2}))?$/i.exec(trimmedStem);
    const fileDash = /\s+-\s+(\d{1,4})(?:v(\d{1,2}))?$/i.exec(trimmedStem);
    const token = bare ?? fileDash;
    if (token) {
      parsed = singleEpisode(Number(token[1]), token[2]);
    }
  }
  const episode =
    tagged.beginEpisode !== undefined
      ? {
          from: tagged.beginEpisode,
          to: tagged.endEpisode ?? tagged.beginEpisode,
          complete: false,
        }
      : parsed?.span;
  const episodeVersion = tagged.beginEpisode !== undefined ? undefined : parsed?.version;
  const seasons =
    tagged.beginSeason !== undefined
      ? uniqueSorted(
          tagged.endSeason !== undefined && tagged.endSeason >= tagged.beginSeason
            ? Array.from({ length: tagged.endSeason - tagged.beginSeason + 1 }, (_, i) => tagged.beginSeason! + i)
            : [tagged.beginSeason],
        )
      : namedSeasons;
  const videoBit = mapVideoBit(stem);
  const audioCodec = detectAudioCodec(stem);
  const airDate = parseAirDateFromTitle(stem);
  const year = detectYear(stem) ?? (airDate ? Number(airDate.slice(0, 4)) : undefined);
  const discParts = parseDiscPartTokens(stem);
  const part = discParts[0];
  const webSource = detectWebSource(stem);
  const releaseGroup = detectReleaseGroup(title) ?? detectReleaseGroup(stem);
  const resourcePix = detectResourcePix(stem, quality.resolution);
  const resourceType = detectResourceType(stem, quality.source);
  const names = extractNames(stem);
  const fps = detectFps(stem);
  const videoEncode = detectVideoEncode(stem);
  return omitUndefined({
    ...quality,
    seasons,
    resourceEffect: detectEffects(stem),
    discParts,
    subtitleTags: parseSubtitleTags(stem),
    videoCodec: mapVideoCodec(stem),
    appliedWords: prepared.appliedWords,
    special: SPECIAL_RE.test(stem),
    parsedTitle: stem,
    ...(episode ? { episode } : {}),
    ...(episodeVersion === undefined ? {} : { episodeVersion }),
    ...(year === undefined ? {} : { year }),
    ...(airDate === undefined ? {} : { airDate }),
    ...(part === undefined ? {} : { part }),
    ...(webSource === undefined ? {} : { webSource }),
    ...(releaseGroup === undefined ? {} : { releaseGroup }),
    ...(resourcePix === undefined ? {} : { resourcePix }),
    ...(resourceType === undefined ? {} : { resourceType }),
    ...(audioCodec === undefined ? {} : { audioCodec }),
    ...(videoBit === undefined ? {} : { videoBit }),
    ...(fps === undefined ? {} : { fps }),
    ...(videoEncode === undefined ? {} : { videoEncode }),
    ...(tagged.binding ? { mediaBinding: tagged.binding } : {}),
    ...names,
  });
}

function withoutSubtitle(options: ParseReleaseMetaOptions): ParseReleaseMetaOptions {
  const { subtitle: _subtitle, ...rest } = options;
  return rest;
}

/**
 * Recognize a Chinese cloud-share title, PT torrent name, or on-disk filename
 * into MoviePilot-comparable structured meta + the local quality-ladder enums.
 *
 * Path-like titles (`folder/file.mkv`) follow MoviePilot MetaInfoPath
 * (`app/domain/meta/infopath.py` + `MetaInfoPath`): parse the leaf, then merge
 * up to two parent folders so season/year/quality fill gaps while a leaf
 * episode token always wins.
 */
export function parseReleaseMeta(title: string, options: ParseReleaseMetaOptions = {}): ReleaseMeta {
  const joinPath = options.joinPath !== false;
  const combined = joinPath ? joinReleaseTitleParts([title, options.subtitle ?? ""]) : title;
  const parts = joinPath
    ? splitReleaseTitleParts(combined)
    : [title.trim()].filter((part) => part.length > 0);
  const consumed = joinPath ? withoutSubtitle(options) : options;
  if (parts.length <= 1) {
    const only = parts[0] ?? title;
    return parseReleaseMetaFlat(only, {
      ...consumed,
      ...(options.isFile || MEDIA_EXT_RE.test(only) ? { isFile: true } : {}),
    });
  }
  const window = parts.slice(-3);
  const leafName = window[window.length - 1]!;
  let merged = parseReleaseMetaFlat(leafName, {
    ...consumed,
    isFile: true,
  });
  for (let index = window.length - 2; index >= 0; index -= 1) {
    const parent = parseReleaseMetaFlat(window[index]!, {
      ...consumed,
      isFile: false,
    });
    if (shouldMergeParent(merged, parent)) {
      merged = mergeReleaseMeta(merged, parent);
    }
  }
  return merged;
}

/** Tokens the leftover/sequel heuristic should ignore (quality + meta tags). */
export function releaseMetaNoisePattern(): RegExp {
  return /hdr\s*10\s*\+|1080\s*[pi]|2160p|720\s*[pi]|4k|uhd|hdr10plus|hdr10p?|\bhdr\b|\bdv\b|dovi|dolby|remux|web-?dl|webrip|bluray|bdrip|hdtv|uhdtv|sdtv|hddvd|hdrip|dvdrip|atmos|truehd|dts|eac3|ddp?|aac|flac|lpcm|h\.?26[45]|x26[45]|hevc|avc|av1|10bit|8bit|中字|国语|双语|字幕|超高清|全高清|超清|无压|官源|蓝光|杜比视界|mkv|mp4|ts|complete|全集|完结|更新至|分享|磁力|\biso\b|bdmv|原盘|amzn|netflix|\bnf\b|atvp|dsnp|hmax|hulu|pmtp|iqiyi|wetv|webdl|repack|proper|imax|\bpart\d|\bcd\d|\bdisc\d|\bfps\b|tmdbid|doubanid/gi;
}
