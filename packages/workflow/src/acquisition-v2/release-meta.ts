/**
 * Structured release / filename parser used by the quality ladder and the
 * deterministic rules selector.
 *
 * Field set and matching behavior follow MoviePilot MetaInfo / MetaBase /
 * MetaVideo / MetaAnime (https://github.com/jxxghp/MoviePilot, v3
 * `app/domain/meta/*`) as prior art — especially resource_pix, resource_type,
 * resource_effect, web_source, video/audio encode, part, release group, and
 * Chinese 第N季/集/话 plus anime absolute-episode forms. This module reimplements
 * those recognizers in TypeScript; it is not a copy of MoviePilot source.
 */
import {
  parseAudioClass,
  parseHdrFormat,
  parseReleaseQuality,
  parseResolutionBand,
  parseSourceClass,
  normalizeQualityText,
  type AudioClass,
  type HdrFormat,
  type ParsedReleaseQuality,
  type ResolutionBand,
  type SourceClass,
} from "./quality-ladder.js";

export type VideoCodec = "h264" | "h265" | "av1" | "avc" | "hevc" | "xvid" | "unknown";

export interface ReleaseEpisodeSpan {
  from: number;
  to: number;
  complete: boolean;
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
  /** HDR / edition effects in appearance order (DoVi, HDR10, REPACK, …). */
  resourceEffect: string[];
  /** Streaming platform (Netflix, Amazon, Disney+, 爱奇艺, …). */
  webSource?: string;
  videoCodec: VideoCodec;
  /** Raw audio tag (Atmos, TrueHD, DDP 5.1, …). */
  audioCodec?: string;
  videoBit?: "8bit" | "10bit" | "12bit";
  releaseGroup?: string;
}

const CN_DIGIT: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

/** MoviePilot `is_anime` heuristics (bracket + dash-episode, unless Sxx/EPxx). */
const ANIME_BRACKET_RE = /【[+0-9XVPI-]+】\s*【/i;
const ANIME_SQUARE_RE = /\[[+0-9XVPI-]+]\s*\[/i;
const ANIME_DASH_EP_RE = /\s+-\s+[\dv]{1,4}\s+/i;
const VIDEO_SEASON_EP_RE =
  /S\d{2}\s*-\s*S\d{2}|S\d{2}|\s+S\d{1,2}|EP?\d{2,4}\s*-\s*EP?\d{2,4}|EP?\d{2,4}|\s+EP?\d{1,4}/i;

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
  { re: /\bIQ\b|iQIYI|爱奇艺/i, name: "iQIYI" },
  { re: /\bWeTV\b|腾讯视频|腾讯/i, name: "WeTV" },
  { re: /优酷|\bYouku\b/i, name: "Youku" },
  { re: /芒果|\bMango\b/i, name: "Mango" },
  { re: /\bBaha\b/i, name: "Baha" },
  { re: /\bCR\b|Crunchyroll/i, name: "Crunchyroll" },
  { re: /\bBG\b|B-Global|Bilibili|哔哩哔哩/i, name: "Bilibili" },
];

const WEB_NEAR_RE =
  /\bWEB[\s._-]?DL\b|\bWEB[\s._-]?RIP\b|\bWEBDL\b|\bWEBRIP\b|(?:^|[.\[_-])WEB(?:[.\]_-]|$)|官源/i;

/** Built-in groups MoviePilot matches around - @ [ 】 (Chinese fansubs + PT). */
const RELEASE_GROUP_RE =
  /(?<=[-@\[￡【&])(?:ANi|HYSUB|KTXP|LoliHouse|MCE|SweetSub|MingY|(?:Lilith|NC)-Raws|FRDS|TTG|WiKi|NGB|CMCTV?|Our(?:Bits|TV)|HHWEB|HDH(?:ome|WEB)|PTHWEB|HDSWEB|MWeb|PTerWEB|Audies|beAst|FLTTH|Yumi|cXcY)(?=$|[@.\s\]\[】&])/i;

const FANSUB_BRACKET_RE =
  /[【\[]([^\]】]{2,20}(?:字幕组|字幕社|字幕|Raws|House|Sub|手抄部|奶茶屋))[】\]]/;

const PART_RE = /\b(?:part|cd|dvd|disk|disc)\s*([0-9abi]{1,2})\b/i;

const VIDEO_BIT_RE = /(?<![A-Za-z0-9])(8|10|12)[\s._-]*bits?\b/i;

const AUDIO_RAW_RE =
  /\b(?:atmos|true[\s._-]*hd|dts[\s._-]*hd(?:[\s._-]*ma)?|dts[\s._:]*x|eac3|ddp?[\s._+-]?\d?(?:\.\d)?|dd\+|aac|flac|lpcm|ac3|opus)\b|杜比全景声|全景声/i;

const EFFECT_TOKEN_RE =
  /\b(?:sdr|hdr10(?:\+|p(?:lus)?)?|hdrvivid|hdr[\s._-]*vivid|hdr|dovi|dv|dolby[\s._-]*vision|hlg|edr|repack|hq|3d)\b|杜比视界/gi;

export function parseChineseNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  if (trimmed === "十") {
    return 10;
  }
  if (trimmed.length === 2 && trimmed.startsWith("十")) {
    const ones = CN_DIGIT[trimmed[1]!];
    return ones === undefined ? null : 10 + ones;
  }
  if (trimmed.length === 2 && trimmed.endsWith("十")) {
    const tens = CN_DIGIT[trimmed[0]!];
    return tens === undefined ? null : tens * 10;
  }
  if (trimmed.length === 3 && trimmed[1] === "十") {
    const tens = CN_DIGIT[trimmed[0]!];
    const ones = CN_DIGIT[trimmed[2]!];
    if (tens === undefined || ones === undefined) {
      return null;
    }
    return tens * 10 + ones;
  }
  return CN_DIGIT[trimmed] ?? null;
}

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

export function parseNamedSeasons(title: string): number[] {
  const seasons: number[] = [];
  const seasonRe = /第\s*([一二三四五六七八九十两\d]{1,3})\s*季/g;
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
    /(?:E|EP|第)?\s*(\d{1,4})\s*[-~～至到]\s*(?:E|EP|第)?\s*(\d{1,4})\s*[集话話期幕]?/i.exec(title) ??
    /(\d{1,4})\s*[-~～]\s*(\d{1,4})\s*[集话話期幕]/.exec(title);
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
    /\bE(?:P)?(\d{1,4})\b/i.exec(title) ??
    /\bEpisode\s+(\d{1,4})\b/i.exec(title);
  if (single) {
    const raw = single[1]!.replace(/[EP]/gi, "");
    const n = parseChineseNumber(raw) ?? Number(raw);
    if (n >= 1 && n < 10000) {
      return { from: n, to: n, complete: false };
    }
  }

  if (isAnimeTitle(title)) {
    const dash = /\s+-\s+(\d{1,4})(?:v\d+)?(?:\s+|$)/i.exec(title);
    if (dash) {
      const n = Number(dash[1]);
      if (n >= 1 && n < 10000) {
        return { from: n, to: n, complete: false };
      }
    }
    const bracket = /\[(\d{1,4})(?:v\d+)?\]/.exec(title);
    if (bracket) {
      const n = Number(bracket[1]);
      if (n >= 1 && n < 4000) {
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
  const pix = /(\d{3,4})[pi]|([248])k|\buhd\b/i.exec(text);
  if (pix) {
    if (pix[2]) {
      return `${pix[2]}k`;
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
  if (/\bremux\b|无压/i.test(text)) {
    return "REMUX";
  }
  if (/\bblu[\s._-]*ray\b|\bbluray\b/i.test(text)) {
    return "BluRay";
  }
  if (/\bbd[\s._-]*rip\b|\bbdrip\b/i.test(text)) {
    return "BDRip";
  }
  if (/\bweb[\s._-]*dl\b|\bwebdl\b|官源/i.test(text)) {
    return "WEB-DL";
  }
  if (/\bweb[\s._-]*rip\b|\bwebrip\b/i.test(text)) {
    return "WEBRip";
  }
  if (/\bhdtv\b|\buhdtv\b/i.test(text)) {
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
    }
    if (!seen.has(label)) {
      seen.add(label);
      out.push(label);
    }
  }
  return out;
}

function detectYear(title: string): number | undefined {
  const years = [...title.matchAll(/\b((?:19|20)\d{2})\b/g)].map((match) => Number(match[1]));
  const plausible = years.filter((year) => year > 1900 && year < 2050);
  return plausible[0];
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

/**
 * Recognize a Chinese cloud-share title, PT torrent name, or on-disk filename
 * into MoviePilot-comparable structured meta + the local quality-ladder enums.
 */
export function parseReleaseMeta(title: string): ReleaseMeta {
  const quality = parseReleaseQuality(title);
  const episode = parseEpisodeSpanFromTitle(title);
  const videoBit = mapVideoBit(title);
  const audioRaw = AUDIO_RAW_RE.exec(normalizeQualityText(title))?.[0];
  const year = detectYear(title);
  const part = detectPart(title);
  const webSource = detectWebSource(title);
  const releaseGroup = detectReleaseGroup(title);
  const resourcePix = detectResourcePix(title, quality.resolution);
  const resourceType = detectResourceType(title, quality.source);
  return omitUndefined({
    ...quality,
    seasons: parseNamedSeasons(title),
    resourceEffect: detectEffects(title),
    videoCodec: mapVideoCodec(title),
    ...(episode ? { episode } : {}),
    ...(year === undefined ? {} : { year }),
    ...(part === undefined ? {} : { part }),
    ...(webSource === undefined ? {} : { webSource }),
    ...(releaseGroup === undefined ? {} : { releaseGroup }),
    ...(resourcePix === undefined ? {} : { resourcePix }),
    ...(resourceType === undefined ? {} : { resourceType }),
    ...(audioRaw === undefined ? {} : { audioCodec: audioRaw }),
    ...(videoBit === undefined ? {} : { videoBit }),
  });
}

/** Tokens the leftover/sequel heuristic should ignore (quality + meta tags). */
export function releaseMetaNoisePattern(): RegExp {
  return /hdr\s*10\s*\+|1080\s*[pi]|2160p|720\s*[pi]|4k|uhd|hdr10plus|hdr10p?|\bhdr\b|\bdv\b|dovi|dolby|remux|web-?dl|webrip|bluray|bdrip|hdtv|uhdtv|hddvd|hdrip|dvdrip|atmos|truehd|dts|eac3|ddp?|aac|flac|lpcm|h\.?26[45]|x26[45]|hevc|avc|av1|10bit|8bit|中字|国语|双语|字幕|超高清|全高清|超清|无压|官源|蓝光|杜比视界|mkv|mp4|ts|complete|全集|完结|更新至|分享|磁力|\biso\b|bdmv|原盘|amzn|netflix|\bnf\b|atvp|dsnp|hmax|hulu|pmtp|iqiyi|wetv|webdl|repack|\bpart\d|\bcd\d|\bdisc\d/gi;
}
