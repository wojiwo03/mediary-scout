/**
 * Deterministic post-recall candidate matching / ranking / episode coverage.
 *
 * Search still goes through the sandbox (prime + optional alias upgrades). This
 * module never transfers: it produces a scored decision the worker already
 * validates (snapshot-bound candidate ids). Quality ranking reuses the same
 * ladder as the agent prompt — never a parallel scoring system.
 */
import { episodeCode } from "../domain.js";
import { normalizeForTitleMatch } from "../planning-search-gate.js";
import type { SearchProfile } from "./search-profile.js";
import {
  greedyCover,
  describeTvSelection,
  gapSearchQueries,
  uncoveredEpisodes,
  type CoverCandidate,
} from "./cover-planner.js";
import { rulesSearchNameValues } from "./rules-search-recipe.js";
import {
  BELOW_QUALITY_FLOOR_REASON,
  formatQualityFloorLabel,
  isBelowQualityFloor,
  scoreReleaseQuality,
  type QualityLadderPolicy,
} from "./quality-ladder.js";
import {
  airDateCodeForms,
  isIncompleteMovieDisc,
  parseEpisodeSpanFromTitle,
  parseNamedSeasons,
  parseReleaseMeta,
  parseSubtitleTags,
  prepareTitle,
  releaseMetaNoisePattern,
  type ParseReleaseMetaOptions,
  type ReleaseEpisodeSpan,
} from "./release-meta.js";

export interface RulesSelectorCandidate {
  snapshotId: string;
  candidateId: string;
  title: string;
}

export interface RulesSelectorTarget {
  kind: "movie" | "tv";
  title: string;
  aliases: readonly string[];
  year?: number;
  seasons?: readonly number[];
  missingEpisodes?: readonly string[];
  originCountries?: readonly string[];
  preferredLanguage?: string;
  /**
   * Library TMDB id. The only media identity MediaTitle currently stores —
   * douban/bangumi/anilist bindings on a candidate therefore cannot hard-match
   * or hard-reject against the target.
   */
  tmdbId?: number;
  /** Fine-grained PanSou profile (anime vs live-action). Year is skipped on anime. */
  searchProfile?: SearchProfile;
}

export type RankedRulesCandidate = CoverCandidate;

export { greedyCover, describeTvSelection, formatEpisodeCodes } from "./cover-planner.js";

export interface RulesSelection {
  selected: RankedRulesCandidate[];
  /** Title-matched covering candidates (TV) / playable ranked pool (movie). */
  eligible?: RankedRulesCandidate[];
  rejected: Array<{ snapshotId: string; candidateId: string; title: string; reason: string }>;
  reason: string;
}

const SEQUEL_WORD =
  /崛起|归来|起源|前传|续集|重生|第二部|第三部|第四部/;
const SEQUEL_TOKEN = /^(?:[2-9]|ii|iii|iv)$/i;

const CODEC_NOISE =
  /x\d{3}|h\.?\d{3}|hevc|avc|\baac\b|ac3|eac3|flac|lpcm|ma10/gi;

const MOVIE_PACK_RE =
  /第\s*[一二三四五六七八九十两\d]+\s*季|\bseason\s*\d|\bs0?\d{1,2}e\d|\bcomplete\s*series|全[集季]|1\s*[-~～]\s*\d{1,3}\s*集/i;

const ENGLISH_SCENE_RE =
  /^[\x20-\x7e]+$/; // no CJK — typical scene / English-only rip

const QUALITY_NOISE_RE = releaseMetaNoisePattern();

function parseOptions(customWords: readonly string[] | undefined): ParseReleaseMetaOptions {
  return !customWords || customWords.length === 0 ? {} : { customWords };
}

function titledWithWords(title: string, customWords: readonly string[] | undefined): string {
  if (!customWords || customWords.length === 0) {
    return title;
  }
  return prepareTitle(title, customWords).title;
}

export function titleTermsFor(target: Pick<RulesSelectorTarget, "title" | "aliases">): string[] {
  return [target.title, ...target.aliases].map((term) => term.trim()).filter((term) => term.length > 0);
}

/**
 * Compare a candidate title's MoviePilot-style `mediaBinding` with the target.
 * `match` / `mismatch` only fire when both sides have an id for the same source.
 */
export function mediaBindingDecision(
  candidateTitle: string,
  target: Pick<RulesSelectorTarget, "tmdbId">,
  customWords?: readonly string[],
): "match" | "mismatch" | "absent" {
  const binding = parseReleaseMeta(candidateTitle, parseOptions(customWords)).mediaBinding;
  if (!binding) {
    return "absent";
  }
  const targetId =
    binding.source === "tmdb" && target.tmdbId !== undefined && target.tmdbId > 0
      ? String(target.tmdbId)
      : undefined;
  if (targetId === undefined) {
    return "absent";
  }
  return targetId === binding.id ? "match" : "mismatch";
}

export function candidateMatchesTitle(candidateTitle: string, terms: readonly string[]): boolean {
  const hay = normalizeForTitleMatch(candidateTitle);
  if (hay.length === 0) {
    return false;
  }
  return terms.some((term) => {
    const needle = normalizeForTitleMatch(term);
    return needle.length > 0 && hay.includes(needle);
  });
}

/**
 * High-confidence "this share IS the target show" — required before any
 * black-box directory probe. tmdb mediaBinding match is enough; otherwise the
 * title must match AND the leftover after stripping the matched term / year /
 * quality / season-episode noise must be empty (sequel/year leftover rejects).
 */
export function isHighConfidenceTvTitleMatch(
  candidateTitle: string,
  target: Pick<RulesSelectorTarget, "title" | "aliases" | "year" | "tmdbId">,
  customWords?: readonly string[],
): boolean {
  const binding = mediaBindingDecision(candidateTitle, target, customWords);
  if (binding === "mismatch") {
    return false;
  }
  if (binding === "match") {
    return true;
  }
  const titled = titledWithWords(candidateTitle, customWords);
  const terms = titleTermsFor(target);
  if (!candidateMatchesTitle(titled, terms)) {
    return false;
  }
  if (looksLikeSequelOrRemake(candidateTitle, terms, target.year, customWords)) {
    return false;
  }
  const matched = [...terms]
    .sort((a, b) => b.length - a.length)
    .find((term) => candidateMatchesTitle(titled, [term]));
  if (!matched) {
    return false;
  }
  return leftoverAfterTitle(candidateTitle, matched, target.year, customWords).length === 0;
}

/** Seasons the title explicitly names. Empty = unspecified (season-1 default). */
export function parseSeasonMarkers(title: string): number[] {
  return parseNamedSeasons(title);
}

export type EpisodeSpan = ReleaseEpisodeSpan;

export function parseEpisodeSpan(title: string): EpisodeSpan | null {
  return parseEpisodeSpanFromTitle(title);
}

function codesForSeasons(seasons: number[], span: EpisodeSpan, missing: readonly string[]): string[] {
  const missingSet = new Set(missing);
  const out: string[] = [];
  for (const season of seasons) {
    if (span.complete && span.to >= 9999) {
      for (const code of missing) {
        if (code.startsWith(`S${String(season).padStart(2, "0")}E`)) {
          out.push(code);
        }
      }
      continue;
    }
    for (let episode = span.from; episode <= span.to; episode += 1) {
      const code = episodeCode(season, episode);
      if (missingSet.has(code)) {
        out.push(code);
      }
    }
  }
  return [...new Set(out)];
}

/**
 * Match a parsed air date onto missing codes that already use that date
 * (`2024-03-15`, `20240315`, `240315`) or SxxE + those digits (`S01E20240315`).
 * Never invent SxxExx from the calendar day (2024.03.15 ≠ S01E15).
 */
function codesMatchingAirDate(
  airDate: string,
  missing: readonly string[],
  applicableSeasons: readonly number[],
): string[] {
  const forms = new Set(airDateCodeForms(airDate));
  const compact8 = airDate.replace(/-/g, "");
  const compact6 = compact8.slice(2);
  return missing.filter((code) => {
    if (forms.has(code)) {
      return true;
    }
    const sxe = /^S(\d+)E(\d+)$/i.exec(code);
    if (!sxe) {
      return false;
    }
    const season = Number(sxe[1]);
    if (!applicableSeasons.includes(season)) {
      return false;
    }
    const episodeDigits = sxe[2]!;
    return episodeDigits === compact8 || episodeDigits === compact6;
  });
}

/**
 * Map a TV/anime share title onto missing episode codes. Returns [] when the
 * title does not clearly cover anything we still need (do not transfer to look).
 */
export function mapTvCoverage(input: {
  title: string;
  seasons: readonly number[];
  missingEpisodes: readonly string[];
  customWords?: readonly string[];
}): string[] {
  const tracked = input.seasons.filter((season) => season >= 1);
  if (tracked.length === 0 || input.missingEpisodes.length === 0) {
    return [];
  }
  const meta = parseReleaseMeta(input.title, parseOptions(input.customWords));
  const markers = meta.seasons;
  const completeSeries = markers.includes(-1);
  const named = markers.filter((season) => season > 0);
  const needsNonFirst = tracked.some((season) => season >= 2);

  let applicable: number[];
  if (completeSeries) {
    applicable = [...tracked];
  } else if (named.length > 0) {
    applicable = named.filter((season) => tracked.includes(season));
  } else if (needsNonFirst) {
    // Season 2+ must be named on the resource; a bare "完结/更新至N集" is S1.
    return [];
  } else {
    applicable = tracked.filter((season) => season === 1);
  }
  if (applicable.length === 0) {
    return [];
  }

  if (meta.special && !/[Ss]\d{1,2}[Ee]\d/.test(input.title)) {
    return [];
  }
  const span = meta.episode ?? null;
  if (!span) {
    // Date-token titles (综艺/新闻) never become a season pack, and never
    // invent SxxExx from the calendar day. Coverage only when missing already
    // stores the same date form.
    if (meta.airDate) {
      return codesMatchingAirDate(meta.airDate, input.missingEpisodes, applicable);
    }
    // Season-named pack with no episode span (e.g. "第二季 1080p") — treat as
    // that season's full missing set only when the title also looks like a pack.
    if (named.length > 0 || /全集|\bcomplete\b|季完整/i.test(input.title)) {
      return input.missingEpisodes.filter((code) =>
        applicable.some((season) => code.startsWith(`S${String(season).padStart(2, "0")}E`)),
      );
    }
    return [];
  }
  return codesForSeasons(applicable, span, input.missingEpisodes);
}

const SEASON_EPISODE_NOISE =
  /第\s*[一二三四五六七八九十两\d]+\s*[季集话話期幕]|s\d{1,2}(?:[-~～]s?\d{1,2})?(?:e\d{1,4}(?:v\d{1,2})?(?:[-~～]e?\d{1,4})?)?|season\s*\d+|(?:e|ep)\d{1,4}(?:v\d{1,2})?|\d{1,4}v\d{1,2}|\d{1,4}\s*[-~～至到]\s*\d{1,4}\s*[集话話]|\d{1,4}[集话話]/gi;

function leftoverAfterTitle(
  candidateTitle: string,
  matchedTerm: string,
  year: number | undefined,
  customWords?: readonly string[],
): string {
  const titled = titledWithWords(candidateTitle, customWords);
  const hay = normalizeForTitleMatch(titled);
  const needle = normalizeForTitleMatch(matchedTerm);
  let rest = needle.length > 0 ? hay.replace(needle, "") : hay;
  const meta = parseReleaseMeta(candidateTitle, parseOptions(customWords));
  for (const extra of [
    meta.webSource,
    meta.releaseGroup,
    meta.part,
    ...meta.discParts,
    meta.audioCodec,
    meta.resourceType,
    meta.resourcePix,
    meta.videoEncode,
    meta.fps !== undefined ? `${meta.fps}fps` : undefined,
    meta.airDate,
    ...(meta.airDate ? airDateCodeForms(meta.airDate) : []),
    ...meta.resourceEffect,
    ...meta.subtitleTags,
  ]) {
    if (!extra) {
      continue;
    }
    const token = normalizeForTitleMatch(extra);
    if (token.length > 0) {
      rest = rest.replace(token, "");
    }
  }
  if (year && year > 0) {
    rest = rest.replace(String(year), "");
  }
  QUALITY_NOISE_RE.lastIndex = 0;
  rest = rest.replace(QUALITY_NOISE_RE, "");
  QUALITY_NOISE_RE.lastIndex = 0;
  CODEC_NOISE.lastIndex = 0;
  rest = rest.replace(CODEC_NOISE, "");
  CODEC_NOISE.lastIndex = 0;
  // Strip season/episode spans so "Show S02 全集" is not a sequel of "Show".
  // Keep 第N部 / a bare 2–9 (庆余年2) for the sequel heuristic.
  SEASON_EPISODE_NOISE.lastIndex = 0;
  rest = rest.replace(SEASON_EPISODE_NOISE, "");
  SEASON_EPISODE_NOISE.lastIndex = 0;
  return rest.replace(/[\s._-]+/g, "");
}

function looksLikeSequelOrRemake(
  candidateTitle: string,
  terms: readonly string[],
  year: number | undefined,
  customWords?: readonly string[],
): boolean {
  const titled = titledWithWords(candidateTitle, customWords);
  const years = [...titled.matchAll(/\b((?:19|20)\d{2})\b/g)].map((match) => Number(match[1]));
  if (
    year &&
    year > 0 &&
    years.length > 0 &&
    !years.includes(year) &&
    !terms.some((term) => term.includes(String(year)))
  ) {
    return true;
  }
  const matched = [...terms]
    .sort((a, b) => b.length - a.length)
    .find((term) => candidateMatchesTitle(titled, [term]));
  if (!matched) {
    return true;
  }
  const leftover = leftoverAfterTitle(candidateTitle, matched, year, customWords);
  return leftover.length > 0 && (SEQUEL_WORD.test(leftover) || SEQUEL_TOKEN.test(leftover));
}

function looksLikeEnglishScene(title: string): boolean {
  const text = title.normalize("NFKC");
  if (!ENGLISH_SCENE_RE.test(text) || !/\d{3,4}p|\bweb|\bblu/i.test(text)) {
    return false;
  }
  return !hasChineseLanguageSignal(parseSubtitleTags(text));
}

function hasChineseLanguageSignal(tags: readonly string[]): boolean {
  return tags.some((tag) => tag !== "生肉");
}

/**
 * Chinese-subtitle preference when `preferredLanguage` wants 中文 and origin
 * is not CN. Tiebreaker only (`totalScore = quality*10 + this`); one
 * resolution/HDR step dwarfs these values.
 *
 * Tier (high → low):
 *   1. 简中/简繁 + 内封          160
 *   2. 简中/简繁                 140
 *   3. 中字/中英/中日/双语 + 内封 125
 *   4. 中字/中英/中日/双语       120
 *   5. 繁中 + 内封               115
 *   6. 繁中                      100
 *   7. 国语 (audio, no sub tag)   70
 *   8. 粤语 (audio, no sub tag)   55
 *   9. CJK title, no markers      40
 *  10. unmarked                    0
 *  11. 生肉/无字幕               -40
 *  12. English-only scene rip    -80
 *
 * originCN or !preferChinese → 0 (do not over-penalize 国产 / skip when
 * the user did not ask for 中文).
 */
export function chineseSubtitleScore(
  title: string,
  preferChinese: boolean,
  originCN: boolean,
  tags: readonly string[] = parseSubtitleTags(title),
): number {
  if (!preferChinese || originCN) {
    return 0;
  }
  return scoreChineseLanguage(tags, title);
}

function scoreChineseLanguage(tags: readonly string[], title: string): number {
  const raw = tags.includes("生肉");
  const simplified = tags.includes("简中") || tags.includes("简繁");
  const traditional = tags.includes("繁中");
  const embedded = tags.includes("内封");
  const genericSub =
    tags.includes("中字") ||
    tags.includes("中英") ||
    tags.includes("中日") ||
    tags.includes("双语") ||
    (embedded && !simplified && !traditional);
  const hasSub = simplified || traditional || genericSub;
  if (simplified && embedded) {
    return 160;
  }
  if (simplified) {
    return 140;
  }
  if (genericSub && embedded) {
    return 125;
  }
  if (genericSub) {
    return 120;
  }
  if (traditional && embedded) {
    return 115;
  }
  if (traditional) {
    return 100;
  }
  if (tags.includes("国语")) {
    return 70;
  }
  if (tags.includes("粤语")) {
    return 55;
  }
  if (looksLikeEnglishScene(title)) {
    return -80;
  }
  if (raw && !hasSub) {
    return -40;
  }
  if (/[\u4e00-\u9fff]/.test(title)) {
    return 40;
  }
  return 0;
}

function preferChineseSubs(target: RulesSelectorTarget): boolean {
  return (target.preferredLanguage ?? "中文").includes("中");
}

function originIsCN(target: RulesSelectorTarget): boolean {
  return (target.originCountries ?? []).includes("CN");
}

function emptySelectionReason(
  rejected: RulesSelection["rejected"],
  kind: "movie" | "tv",
  floor: QualityLadderPolicy["resolutionFloor"],
): string {
  const floorHits = rejected.some((row) => row.reason === BELOW_QUALITY_FLOOR_REASON);
  if (floorHits && floor !== undefined) {
    const label = formatQualityFloorLabel(floor);
    return kind === "movie"
      ? `规则选片：没有达到画质下限（${label}）的可播放候选，低于此档不下载，留给巡检`
      : `规则选片：没有达到画质下限（${label}）且能覆盖缺集的候选，低于此档不下载，留给巡检`;
  }
  return kind === "movie"
    ? "规则选片：没有标题匹配且可播放的目标影片候选"
    : "规则选片：没有能覆盖缺集的标题匹配候选";
}

/** Machine code for an empty pick — activity UI maps this to 中文, not a raw enum. */
export type EmptyPickReasonCode =
  | "no-candidates"
  | "below-quality-floor"
  | "no-episode-coverage"
  | "media-id-mismatch"
  | "redundant-coverage"
  | "empty-selection";

export function classifyEmptyPickReason(
  rejected: ReadonlyArray<{ reason: string }>,
  candidateCount: number,
): EmptyPickReasonCode {
  if (candidateCount <= 0) {
    return "no-candidates";
  }
  const reasons = rejected.map((row) => row.reason);
  const count = (reason: string) => reasons.filter((value) => value === reason).length;
  const floor = count(BELOW_QUALITY_FLOOR_REASON);
  const noEpisode = count("no-episode-coverage");
  const media = count("media-id-mismatch");
  const redundant = count("redundant-coverage");
  if (floor > 0 && floor >= noEpisode && floor >= media) {
    return "below-quality-floor";
  }
  if (noEpisode > 0 && noEpisode >= media) {
    return "no-episode-coverage";
  }
  if (media > 0 && media >= redundant) {
    return "media-id-mismatch";
  }
  if (redundant > 0) {
    return "redundant-coverage";
  }
  return "empty-selection";
}

function rejectMovieNoise(title: string, customWords?: readonly string[]): string | null {
  const titled = titledWithWords(title, customWords);
  const quality = parseReleaseMeta(title, parseOptions(customWords));
  if (quality.discImage) {
    return "disc-image";
  }
  if (MOVIE_PACK_RE.test(titled)) {
    return "tv-pack";
  }
  if (/花絮|预告|trailer|sample|extras?|花絮篇/i.test(titled)) {
    return "extra";
  }
  return null;
}

function rankOne(
  candidate: RulesSelectorCandidate,
  target: RulesSelectorTarget,
  policy: QualityLadderPolicy,
  coveredEpisodes: string[],
  customWords?: readonly string[],
  coverageSource?: "title" | "probe",
): RankedRulesCandidate {
  const titled = titledWithWords(candidate.title, customWords);
  const meta = parseReleaseMeta(candidate.title, parseOptions(customWords));
  const qualityScore = scoreReleaseQuality(meta, policy);
  const chineseScore = chineseSubtitleScore(
    titled,
    preferChineseSubs(target),
    originIsCN(target),
    meta.subtitleTags,
  );
  return {
    snapshotId: candidate.snapshotId,
    candidateId: candidate.candidateId,
    title: candidate.title,
    coveredEpisodes,
    qualityScore,
    chineseScore,
    totalScore: qualityScore * 10 + chineseScore,
    ...(coverageSource ? { coverageSource } : {}),
  };
}


export interface RulesConfidenceReport {
  confidence: "high" | "low";
  reasons: string[];
}

/**
 * Whether the deterministic selector's pick (or empty result) is safe to
 * transfer without an LLM. Used by `auto` mode; forced `rules` ignores this.
 *
 * Low-confidence signals:
 * - empty eligible set (no candidates, or every title filtered)
 * - TV title matched but no episode/air-date coverage (`no-episode-coverage`)
 * - sequel/year rejects (wrong-film risk)
 * - season-named pack with no episode span / 全集 (guessing a whole season)
 * - named seasons that do not intersect the tracked seasons
 *
 * High (stay on rules): explicit SxxExx / 第N集 / 全集, movie with a clear
 * title or tmdbid hit — including a lone CD1 when it is the only disc.
 */
export function assessRulesConfidence(input: {
  target: RulesSelectorTarget;
  selection: RulesSelection;
  candidateCount: number;
  customWords?: readonly string[];
}): RulesConfidenceReport {
  const reasons: string[] = [];
  const rejected = input.selection.rejected.map((row) => row.reason);
  const count = (reason: string) => rejected.filter((value) => value === reason).length;

  if (input.selection.selected.length === 0) {
    if (count("no-episode-coverage") > 0) {
      reasons.push("no-episode-coverage");
    }
    if (count("sequel-or-year") > 0) {
      reasons.push("sequel-or-year");
    }
    if (input.candidateCount === 0) {
      reasons.push("no-candidates");
    } else if (reasons.length === 0) {
      // Hard quality floor is a confident "do not download" — not parser
      // uncertainty. Escalating to the agent would show 「正在收尾」 after an
      // unmet-coverage finish and then keep the loop alive (coverageMet:false
      // used to not stop). Leave the gap for patrol instead.
      if (count(BELOW_QUALITY_FLOOR_REASON) > 0) {
        return { confidence: "high", reasons: [] };
      }
      reasons.push("empty-selection");
    }
    return { confidence: "low", reasons };
  }

  const words = input.customWords;
  const parseOpts = !words || words.length === 0 ? {} : { customWords: words };
  for (const picked of input.selection.selected) {
    if (input.target.kind !== "tv") {
      continue;
    }
    const meta = parseReleaseMeta(picked.title, parseOpts);
    const tracked = (input.target.seasons ?? [1]).filter((season) => season >= 1);
    const named = meta.seasons.filter((season) => season > 0);
    if (named.length > 0 && tracked.length > 0 && named.every((season) => !tracked.includes(season))) {
      reasons.push("season-conflict");
    }
    const pack = /全集|\bcomplete\b|季完整/i.test(picked.title) || meta.episode?.complete === true;
    if (picked.coverageSource !== "probe" && named.length > 0 && !meta.episode && !meta.airDate && !pack) {
      reasons.push("season-pack-without-span");
    }
    const missing = input.target.missingEpisodes ?? [];
    if (missing.length > 0 && picked.coverageSource === "probe") {
      continue;
    }
    if (missing.length > 0 && !meta.episode && !meta.airDate && !pack && named.length === 0) {
      reasons.push("weak-episode-parse");
    }
  }

  const unique = [...new Set(reasons)];
  return unique.length > 0 ? { confidence: "low", reasons: unique } : { confidence: "high", reasons: [] };
}

export function selectResourceCandidates(input: {
  candidates: readonly RulesSelectorCandidate[];
  target: RulesSelectorTarget;
  policy?: QualityLadderPolicy;
  customIdentifierWords?: readonly string[];
  /**
   * Per-candidate episode codes from a bounded black-box probe (share listing
   * or staging path parse). When present, replaces `mapTvCoverage` — including
   * an empty list (probed, nothing usable: do not fall back to a season guess).
   */
  coverageOverrides?: ReadonlyMap<string, readonly string[]>;
}): RulesSelection {
  const policy = input.policy ?? {};
  const terms = titleTermsFor(input.target);
  const rejected: RulesSelection["rejected"] = [];
  const eligible: RankedRulesCandidate[] = [];
  const preferZh = preferChineseSubs(input.target);
  const originCN = originIsCN(input.target);
  const missing = input.target.missingEpisodes ?? (input.target.kind === "movie" ? ["MOVIE"] : []);
  const seasons = input.target.seasons ?? [1];
  const words = input.customIdentifierWords;

  for (const candidate of input.candidates) {
    const titled = titledWithWords(candidate.title, words);
    const binding = mediaBindingDecision(candidate.title, input.target, words);
    if (binding === "mismatch") {
      rejected.push({ ...candidate, reason: "media-id-mismatch" });
      continue;
    }
    const boundMatch = binding === "match";
    if (!boundMatch && !candidateMatchesTitle(titled, terms)) {
      rejected.push({ ...candidate, reason: "title-mismatch" });
      continue;
    }
    if (!boundMatch && looksLikeSequelOrRemake(candidate.title, terms, input.target.year, words)) {
      rejected.push({ ...candidate, reason: "sequel-or-year" });
      continue;
    }
    if (input.target.kind === "movie") {
      const noise = rejectMovieNoise(candidate.title, words);
      if (noise) {
        rejected.push({ ...candidate, reason: noise });
        continue;
      }
      if (isBelowQualityFloor(candidate.title, policy.resolutionFloor)) {
        rejected.push({ ...candidate, reason: BELOW_QUALITY_FLOOR_REASON });
        continue;
      }
      if (preferZh && !originCN && looksLikeEnglishScene(titled) && chineseSubtitleScore(titled, true, false) < 0) {
        // Keep as last-resort raw: don't reject yet, just low-score.
      }
      eligible.push(rankOne(candidate, input.target, policy, ["MOVIE"], words));
      continue;
    }

    const override = input.coverageOverrides?.get(candidate.candidateId);
    if (isBelowQualityFloor(candidate.title, policy.resolutionFloor)) {
      rejected.push({ ...candidate, reason: BELOW_QUALITY_FLOOR_REASON });
      continue;
    }
    const covered = override
      ? [...override].filter((code) => missing.includes(code))
      : mapTvCoverage({
          title: candidate.title,
          seasons,
          missingEpisodes: missing,
          ...(words && words.length > 0 ? { customWords: words } : {}),
        });
    if (covered.length === 0) {
      rejected.push({ ...candidate, reason: "no-episode-coverage" });
      continue;
    }
    if (preferZh && !originCN && looksLikeEnglishScene(titled)) {
      rejected.push({ ...candidate, reason: "raw-foreign" });
      continue;
    }
    eligible.push(
      override
        ? rankOne(candidate, input.target, policy, covered, words, "probe")
        : rankOne(candidate, input.target, policy, covered, words),
    );
  }

  if (input.target.kind === "movie") {
    const playable = eligible.filter(
      (candidate) => parseReleaseMeta(candidate.title, parseOptions(words)).discImage === false,
    );
    const pool = playable.length > 0 ? playable : eligible;
    const withChinese = preferZh && !originCN ? pool.filter((candidate) => candidate.chineseScore >= 0) : pool;
    const rankedBase = withChinese.length > 0 ? withChinese : pool;
    // Movies transfer exactly one share. A lone CD1/PART1 is incomplete when a
    // complete pack (no disc split, or CD1+CD2 in the same title) exists.
    const complete = rankedBase.filter(
      (candidate) => !isIncompleteMovieDisc(parseReleaseMeta(candidate.title, parseOptions(words))),
    );
    const incomplete = rankedBase.filter((candidate) => !complete.includes(candidate));
    const moviePool = complete.length > 0 ? complete : rankedBase;
    const ranked = [...moviePool].sort((a, b) => b.totalScore - a.totalScore);
    const best = ranked[0];
    if (!best) {
      return {
        selected: [],
        eligible: [],
        rejected,
        reason: emptySelectionReason(rejected, "movie", policy.resolutionFloor),
      };
    }
    const skippedIncomplete =
      complete.length > 0
        ? incomplete.map((candidate) => ({
            snapshotId: candidate.snapshotId,
            candidateId: candidate.candidateId,
            title: candidate.title,
            reason: "incomplete-disc-set",
          }))
        : [];
    const skippedIds = new Set(skippedIncomplete.map((candidate) => candidate.candidateId));
    return {
      selected: [best],
      eligible: ranked,
      rejected: [
        ...rejected,
        ...skippedIncomplete,
        ...ranked
          .slice(1)
          .filter((candidate) => !skippedIds.has(candidate.candidateId))
          .map((candidate) => ({
            snapshotId: candidate.snapshotId,
            candidateId: candidate.candidateId,
            title: candidate.title,
            reason: "outranked",
          })),
      ],
      reason: `规则选片：按画质阶梯选择「${best.title}」`,
    };
  }

  const selected = greedyCover(eligible, missing);
  if (selected.length === 0) {
    return {
      selected: [],
      eligible,
      rejected,
      reason: emptySelectionReason(rejected, "tv", policy.resolutionFloor),
    };
  }
  const selectedIds = new Set(selected.map((candidate) => candidate.candidateId));
  return {
    selected,
    eligible,
    rejected: [
      ...rejected,
      ...eligible
        .filter((candidate) => !selectedIds.has(candidate.candidateId))
        .map((candidate) => ({
          snapshotId: candidate.snapshotId,
          candidateId: candidate.candidateId,
          title: candidate.title,
          reason: "redundant-coverage",
        })),
    ],
    reason: describeTvSelection(selected, missing),
  };
}

export interface TvCoverPlan {
  selection: RulesSelection;
  uncovered: string[];
  gapQueries: string[];
  redundantCandidateIds: string[];
}

/**
 * Snapshot → complementary cover, leftover holes, and bounded gap-search
 * queries. Shared by the rules worker and the Agent `planEpisodeCover` tool.
 */
export function planTvCover(input: {
  candidates: readonly RulesSelectorCandidate[];
  target: RulesSelectorTarget;
  policy?: QualityLadderPolicy;
  customIdentifierWords?: readonly string[];
  excludeIds?: ReadonlySet<string>;
  remainingMissing?: readonly string[];
  gapRound?: number;
  coverageOverrides?: ReadonlyMap<string, readonly string[]>;
}): TvCoverPlan {
  const missing = input.remainingMissing ?? input.target.missingEpisodes ?? [];
  const excluded = input.excludeIds ?? new Set<string>();
  const candidates = input.candidates.filter((candidate) => !excluded.has(candidate.candidateId));
  const selection = selectResourceCandidates({
    candidates,
    target: { ...input.target, missingEpisodes: missing },
    ...(input.policy ? { policy: input.policy } : {}),
    ...(input.customIdentifierWords && input.customIdentifierWords.length > 0
      ? { customIdentifierWords: input.customIdentifierWords }
      : {}),
    ...(input.coverageOverrides ? { coverageOverrides: input.coverageOverrides } : {}),
  });
  const uncovered = uncoveredEpisodes(selection.selected, missing);
  return {
    selection,
    uncovered,
    gapQueries:
      uncovered.length === 0
        ? []
        : gapSearchQueries({
            title: input.target.title,
            aliases: rulesSearchNameValues({
              ...input.target,
              ...(input.customIdentifierWords && input.customIdentifierWords.length > 0
                ? { customIdentifierWords: input.customIdentifierWords }
                : {}),
            }).slice(1),
            missing: uncovered,
            round: input.gapRound ?? 0,
          }),
    redundantCandidateIds: selection.rejected
      .filter((row) => row.reason === "redundant-coverage")
      .map((row) => row.candidateId),
  };
}
