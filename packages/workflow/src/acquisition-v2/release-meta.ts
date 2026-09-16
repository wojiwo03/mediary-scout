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
   * Named seasons. `-1` means “complete series” (intersect with tracked seasons).
   * Empty = unspecified (TV season-1 default at the coverage mapper).
   */
  seasons: number[];
  episode?: ReleaseEpisodeSpan;
  /** PART1 / CD1 / DISC1 when present. */
  part?: string;
  /** Raw pix token MoviePilot would put in resource_pix (e.g. 2160p, 4k). */
  resourcePix?: string;
  /** Raw source token (WEB-DL, BluRay, REMUX, …). */
  resourceType?: string;
  /** HDR / edition effects in appearance order (DoVi, HDR10, REPACK, IMAX, …). */
  resourceEffect: string[];
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
const ANIME_DASH_EP_RE = /\s+-\s+[\dv]{1,4}\s+/i;
const VIDEO_SEASON_EP_RE =
  /S\d{2}\s*-\s*S\d{2}|S\d{2}|\s+S\d{1,2}|EP?\d{2,4}\s*-\s*EP?\d{2,4}|EP?\d{2,4}|\s+EP?\d{1,4}/i;

const PIX_AS_EPISODE = new Set([480, 576, 720, 1080, 2160, 4320]);

/**
 * Common WEB/PT streaming tags. Subset of MoviePilot StreamingPlatforms —
 * codes that actually show up on Chinese cloud-share / PT titles.
 */
const WEB_PLATFORMS: Array<{ re: RegExp; name: string }> = [
  { re: /\bAMZN\b|Amazon/i, name: "Amazon" },
  { re: /\bNF\b|Netflix/i, name: "Netflix" },
  { re: /\bATVP\b|Apple\s*TV\+?/i, name: "Apple TV+" },
  { re: /\bDSNP\b|Disney\+/i, name: "Disney+" },
  { re: /\biT\b|\biTunes\b/i, name: "iTunes" },
  { re: /\bHMAX\b|\bHBO\s*Max\b/i, name: "Max" },
  { re: /\bHBO(?:GO)?\b/i, name: "HBO" },
  { re: /\bHULU\b/i, name: "Hulu" },
  { re: /\bPMTP\b|Paramount\+/i, name: "Paramount+" },
  { re: /\bPCOK\b|Peacock/i, name: "Peacock" },
  { re: /\bIQ\b|iQIYI|爱奇艺/i, name: "iQIYI" },
  { re: /\bWeTV\b|腾讯视频|腾讯/i, name: "WeTV" },
  { re: /优酷|\bYouku\b/i, name: "Youku" },
  { re: /芒果|\bMango\b/i, name: "Mango" },
  { re: /\bBaha\b/i, name: "Baha" },
  { re: /\bCR\b|Crunchyroll/i, name: "Crunchyroll" },
  { re: /\bBG\b|B-Global|Bilibili|哔哩哔哩/i, name: "Bilibili" },
  { re: /\bVIU\b/i, name: "Viu" },
  { re: /\bTVING\b/i, name: "TVING" },
  { re: /\bHami(?:Video)?\b/i, name: "Hami Video" },
  { re: /\bKKTV\b/i, name: "KKTV" },
  { re: /\bHIDI\b|HIDIVE/i, name: "HIDIVE" },
  { re: /\bFUNi\b|Funimation/i, name: "Funimation" },
  { re: /\bSTAN\b/i, name: "Stan" },
  { re: /\bDSCP\b|Discovery\+/i, name: "Discovery+" },
];

const WEB_NEAR_RE =
  /\bWEB[\s._-]?DL\b|\bWEB[\s._-]?RIP\b|\bWEBDL\b|\bWEBRIP\b|(?:^|[.\[_-])WEB(?:[.\]_-]|$)|官源/i;

/** Built-in groups MoviePilot matches around - @ [ 】 (Chinese fansubs + PT). */
const RELEASE_GROUP_RE =
  /(?<=[-@\[￡【&])(?:ANi|HYSUB|KTXP|LoliHouse|MCE|SweetSub|MingY|(?:Lilith|NC|AI)-Raws|FRDS|TTG|WiKi|NGB|CMCTV?|Our(?:Bits|TV)|HHWEB|HDH(?:ome|WEB)|PTHWEB|HDSWEB|MWeb|PTerWEB|Audies|beAst|FLTTH|Yumi|cXcY|ADWeb|LeagueWEB|EPiC|GM-Team|AnimeS)(?=$|[@.\s\]\[】&])/i;

const FANSUB_BRACKET_RE =
  /[【\[]([^\]】]{2,24}(?:字幕组|字幕社|字幕|Raws|House|Sub|手抄部|奶茶屋|发布组|压制组))[】\]]/;

const PART_RE = /\b(?:part|cd|dvd|disk|disc)\s*([0-9abi]{1,2})\b/i;

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

export function parseEpisodeSpanFromTitle(title: string): ReleaseEpisodeSpan | null {
  const fin =
    /(?<!\d)\[?\s*(\d{1,4})\s*[-~～]\s*(\d{1,4})\s*(?:(?:Fin|End)(?![a-z0-9])|完结)(?:\s*\]|(?!\d))/i.exec(
      title,
    );
  if (fin) {
    const from = Number(fin[1]);
    const to = Number(fin[2]);
    if (from >= 1 && to >= from && to < 10000 && !(from >= 1900 && to <= 2155)) {
      return { from, to, complete: true };
    }
  }

  const range =
    /(?:E|EP|第)\s*(\d{1,4})\s*[-~～至到]\s*(?:E|EP|第)?\s*(\d{1,4})\s*[集话話期幕]?/i.exec(title) ??
    /(\d{1,4})\s*[-~～至到]\s*(\d{1,4})\s*[集话話期幕]/.exec(title);
  if (range) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    if (from >= 1 && to >= from && !(from >= 1900 && to <= 2155)) {
      return { from, to, complete: false };
    }
  }

  const until = /更新至\s*(?:第)?\s*(\d{1,4})\s*[集话話]/.exec(title);
  if (until) {
    return { from: 1, to: Number(until[1]), complete: false };
  }

  const between =
    /第\s*([0-9一二三四五六七八九十百零]+)\s*[集话話期幕]?\s*[-~～至到]\s*第?\s*([0-9一二三四五六七八九十百零]+)\s*[集话話期幕]/.exec(
      title,
    );
  if (between) {
    const from = parseChineseNumber(between[1]!);
    const to = parseChineseNumber(between[2]!);
    if (from !== null && to !== null && from >= 1 && to >= from) {
      return { from, to, complete: false };
    }
  }

  const single =
    /[Ss]\d{1,2}[Ee](\d{1,4})/.exec(title) ??
    /第\s*([0-9一二三四五六七八九十百零EP]+)\s*[集话話期幕]/.exec(title) ??
    /\[TV\s+(\d{1,4})\]/i.exec(title) ??
    /\bE(?:P)?(\d{1,4})\b/i.exec(title) ??
    /\bEpisode\s+(\d{1,4})\b/i.exec(title);
  if (single) {
    const raw = single[1]!.replace(/[EP]/gi, "");
    const n = parseChineseNumber(raw) ?? Number(raw);
    if (isPlausibleEpisode(n)) {
      return { from: n, to: n, complete: false };
    }
  }

  const hash = /#(\d{1,4})\b/.exec(title);
  if (hash) {
    const n = Number(hash[1]);
    if (isPlausibleEpisode(n)) {
      return { from: n, to: n, complete: false };
    }
  }

  if (isAnimeTitle(title) || /[【\[]\d{1,4}(?:v\d+)?[】\]]/.test(title)) {
    const dash = /\s+-\s+(\d{1,4})(?:v\d+)?(?:\s+|$)/i.exec(title);
    if (dash) {
      const n = Number(dash[1]);
      if (isPlausibleEpisode(n)) {
        return { from: n, to: n, complete: false };
      }
    }
    for (const bracket of title.matchAll(/[【\[](\d{1,4})(?:v\d+)?[】\]]/g)) {
      const n = Number(bracket[1]);
      if (isPlausibleEpisode(n)) {
        return { from: n, to: n, complete: false };
      }
    }
  }

  if (/全集|\bcomplete\b/i.test(title) && !/complete\s*series/i.test(title)) {
    const count = /[全共]\s*(\d{1,4})\s*[集话話]/.exec(title);
    if (count) {
      return { from: 1, to: Number(count[1]), complete: true };
    }
    return { from: 1, to: 9999, complete: true };
  }
  return null;
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
    platform.re.lastIndex = 0;
    const hit = platform.re.exec(text);
    if (!hit) {
      continue;
    }
    const matched = hit[0];
    const cjk = /[\u4e00-\u9fff]/.test(matched);
    if (cjk || nearWeb) {
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

function detectPart(title: string): string | undefined {
  const match = PART_RE.exec(normalizeQualityText(title));
  if (!match) {
    return undefined;
  }
  return `${match[0].replace(/\s+/g, "")}`.toUpperCase();
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
  rest = rest.replace(/\(\s*(?:19|20)\d{2}\s*\)/g, " ");
  rest = rest.replace(/\b(?:19|20)\d{2}\b/g, " ");
  rest = rest.replace(/第\s*[一二三四五六七八九十两\dIVXⅠ-Ⅻ]{1,4}\s*[季集话話期幕]/g, " ");
  rest = rest.replace(/\bS\d{1,2}(?:E\d{1,4})?\b/gi, " ");
  rest = rest.replace(/[【\[]\d{1,4}(?:v\d+)?[】\]]/g, " ");
  rest = rest.replace(/\[TV\s+\d{1,4}\]/gi, " ");
  rest = rest.replace(/#\d{1,4}\b/g, " ");
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
    videoCodec: pick(leaf.videoCodec, parent.videoCodec, "unknown"),
    appliedWords: applied,
    special: leaf.special || (!leaf.episode && parent.special),
    ...(parsedTitle ? { parsedTitle } : {}),
    ...(leaf.episode ? { episode: leaf.episode } : parent.episode ? { episode: parent.episode } : {}),
    ...(leaf.year !== undefined ? { year: leaf.year } : parent.year !== undefined ? { year: parent.year } : {}),
    ...(leaf.part ? { part: leaf.part } : parent.part ? { part: parent.part } : {}),
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
  let parsedEpisode = parseEpisodeSpanFromTitle(stem);
  if (!parsedEpisode && options.isFile) {
    const trimmedStem = stem.trim();
    const bare = /^(\d{1,4})(?:v\d+)?$/i.exec(trimmedStem);
    const dash = /\s+-\s+(\d{1,4})(?:v\d+)?$/i.exec(trimmedStem);
    const token = bare?.[1] ?? dash?.[1];
    if (token) {
      const n = Number(token);
      if (isPlausibleEpisode(n)) {
        parsedEpisode = { from: n, to: n, complete: false };
      }
    }
  }
  const episode =
    tagged.beginEpisode !== undefined
      ? {
          from: tagged.beginEpisode,
          to: tagged.endEpisode ?? tagged.beginEpisode,
          complete: false,
        }
      : parsedEpisode;
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
  const year = detectYear(stem);
  const part = detectPart(stem);
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
    videoCodec: mapVideoCodec(stem),
    appliedWords: prepared.appliedWords,
    special: SPECIAL_RE.test(stem),
    parsedTitle: stem,
    ...(episode ? { episode } : {}),
    ...(year === undefined ? {} : { year }),
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
