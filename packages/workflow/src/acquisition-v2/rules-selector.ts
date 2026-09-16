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
import {
  parseReleaseQuality,
  scoreReleaseTitle,
  type QualityLadderPolicy,
} from "./quality-ladder.js";
import {
  parseEpisodeSpanFromTitle,
  parseNamedSeasons,
  parseReleaseMeta,
  releaseMetaNoisePattern,
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
}

export interface RankedRulesCandidate {
  snapshotId: string;
  candidateId: string;
  title: string;
  coveredEpisodes: string[];
  qualityScore: number;
  chineseScore: number;
  totalScore: number;
}

export interface RulesSelection {
  selected: RankedRulesCandidate[];
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

const CHINESE_SUB_MARKER =
  /中字|国语|中英|简繁|双语|chs[\s._-]*eng|\bchs\b|中英双字|国粤|内封/i;

const ENGLISH_SCENE_RE =
  /^[\x20-\x7e]+$/; // no CJK — typical scene / English-only rip

const QUALITY_NOISE_RE = releaseMetaNoisePattern();

export function titleTermsFor(target: Pick<RulesSelectorTarget, "title" | "aliases">): string[] {
  return [target.title, ...target.aliases].map((term) => term.trim()).filter((term) => term.length > 0);
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
 * Map a TV/anime share title onto missing episode codes. Returns [] when the
 * title does not clearly cover anything we still need (do not transfer to look).
 */
export function mapTvCoverage(input: {
  title: string;
  seasons: readonly number[];
  missingEpisodes: readonly string[];
}): string[] {
  const tracked = input.seasons.filter((season) => season >= 1);
  if (tracked.length === 0 || input.missingEpisodes.length === 0) {
    return [];
  }
  const markers = parseSeasonMarkers(input.title);
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

  const meta = parseReleaseMeta(input.title);
  if (meta.special && !/[Ss]\d{1,2}[Ee]\d/.test(input.title)) {
    return [];
  }
  const span = parseEpisodeSpan(input.title);
  if (!span) {
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
  /第\s*[一二三四五六七八九十两\d]+\s*[季集话話期幕]|s\d{1,2}(?:[-~～]s?\d{1,2})?(?:e\d{1,4}(?:[-~～]e?\d{1,4})?)?|season\s*\d+|(?:e|ep)\d{1,4}|\d{1,4}\s*[-~～至到]\s*\d{1,4}\s*[集话話]|\d{1,4}[集话話]/gi;

function leftoverAfterTitle(candidateTitle: string, matchedTerm: string, year: number | undefined): string {
  const hay = normalizeForTitleMatch(candidateTitle);
  const needle = normalizeForTitleMatch(matchedTerm);
  let rest = needle.length > 0 ? hay.replace(needle, "") : hay;
  if (year && year > 0) {
    rest = rest.replace(String(year), "");
  }
  const meta = parseReleaseMeta(candidateTitle);
  for (const extra of [
    meta.webSource,
    meta.releaseGroup,
    meta.part,
    meta.audioCodec,
    meta.resourceType,
    meta.resourcePix,
    meta.videoEncode,
    meta.fps !== undefined ? `${meta.fps}fps` : undefined,
    ...meta.resourceEffect,
  ]) {
    if (!extra) {
      continue;
    }
    const token = normalizeForTitleMatch(extra);
    if (token.length > 0) {
      rest = rest.replace(token, "");
    }
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
): boolean {
  const years = [...candidateTitle.matchAll(/\b((?:19|20)\d{2})\b/g)].map((match) => Number(match[1]));
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
    .find((term) => candidateMatchesTitle(candidateTitle, [term]));
  if (!matched) {
    return true;
  }
  const leftover = leftoverAfterTitle(candidateTitle, matched, year);
  return leftover.length > 0 && (SEQUEL_WORD.test(leftover) || SEQUEL_TOKEN.test(leftover));
}

function looksLikeEnglishScene(title: string): boolean {
  const text = title.normalize("NFKC");
  return ENGLISH_SCENE_RE.test(text) && /\d{3,4}p|\bweb|\bblu/i.test(text) && !CHINESE_SUB_MARKER.test(text);
}

export function chineseSubtitleScore(
  title: string,
  preferChinese: boolean,
  originCN: boolean,
): number {
  if (!preferChinese || originCN) {
    return 0;
  }
  if (CHINESE_SUB_MARKER.test(title)) {
    return 120;
  }
  if (/[\u4e00-\u9fff]/.test(title) && !looksLikeEnglishScene(title)) {
    return 40;
  }
  if (looksLikeEnglishScene(title)) {
    return -80;
  }
  return 0;
}

function preferChineseSubs(target: RulesSelectorTarget): boolean {
  return (target.preferredLanguage ?? "中文").includes("中");
}

function originIsCN(target: RulesSelectorTarget): boolean {
  return (target.originCountries ?? []).includes("CN");
}

function rejectMovieNoise(title: string): string | null {
  const quality = parseReleaseQuality(title);
  if (quality.discImage) {
    return "disc-image";
  }
  if (MOVIE_PACK_RE.test(title)) {
    return "tv-pack";
  }
  if (/花絮|预告|trailer|sample|extras?|花絮篇/i.test(title)) {
    return "extra";
  }
  return null;
}

function rankOne(
  candidate: RulesSelectorCandidate,
  target: RulesSelectorTarget,
  policy: QualityLadderPolicy,
  coveredEpisodes: string[],
): RankedRulesCandidate {
  const qualityScore = scoreReleaseTitle(candidate.title, policy);
  const chineseScore = chineseSubtitleScore(candidate.title, preferChineseSubs(target), originIsCN(target));
  return {
    snapshotId: candidate.snapshotId,
    candidateId: candidate.candidateId,
    title: candidate.title,
    coveredEpisodes,
    qualityScore,
    chineseScore,
    totalScore: qualityScore * 10 + chineseScore,
  };
}

function greedyCover(ranked: RankedRulesCandidate[], missing: readonly string[]): RankedRulesCandidate[] {
  const remaining = new Set(missing);
  const picked: RankedRulesCandidate[] = [];
  const pool = [...ranked].sort((a, b) => {
    const aAll = a.coveredEpisodes.length >= remaining.size && a.coveredEpisodes.every((code) => remaining.has(code) || !missing.includes(code));
    const bAll = b.coveredEpisodes.length >= remaining.size;
    if (aAll !== bAll) {
      return aAll ? -1 : 1;
    }
    const aCover = a.coveredEpisodes.filter((code) => remaining.has(code)).length;
    const bCover = b.coveredEpisodes.filter((code) => remaining.has(code)).length;
    if (aCover !== bCover) {
      return bCover - aCover;
    }
    return b.totalScore - a.totalScore;
  });

  const complete = pool.find((candidate) => candidate.coveredEpisodes.filter((code) => remaining.has(code)).length === remaining.size);
  if (complete) {
    return [complete];
  }

  for (const candidate of [...pool].sort((a, b) => b.totalScore - a.totalScore)) {
    if (remaining.size === 0) {
      break;
    }
    const gain = candidate.coveredEpisodes.filter((code) => remaining.has(code));
    if (gain.length === 0) {
      continue;
    }
    picked.push(candidate);
    for (const code of gain) {
      remaining.delete(code);
    }
  }
  return picked;
}

export function selectResourceCandidates(input: {
  candidates: readonly RulesSelectorCandidate[];
  target: RulesSelectorTarget;
  policy?: QualityLadderPolicy;
}): RulesSelection {
  const policy = input.policy ?? {};
  const terms = titleTermsFor(input.target);
  const rejected: RulesSelection["rejected"] = [];
  const eligible: RankedRulesCandidate[] = [];
  const preferZh = preferChineseSubs(input.target);
  const originCN = originIsCN(input.target);
  const missing = input.target.missingEpisodes ?? (input.target.kind === "movie" ? ["MOVIE"] : []);
  const seasons = input.target.seasons ?? [1];

  for (const candidate of input.candidates) {
    if (!candidateMatchesTitle(candidate.title, terms)) {
      rejected.push({ ...candidate, reason: "title-mismatch" });
      continue;
    }
    if (looksLikeSequelOrRemake(candidate.title, terms, input.target.year)) {
      rejected.push({ ...candidate, reason: "sequel-or-year" });
      continue;
    }
    if (input.target.kind === "movie") {
      const noise = rejectMovieNoise(candidate.title);
      if (noise) {
        rejected.push({ ...candidate, reason: noise });
        continue;
      }
      if (preferZh && !originCN && looksLikeEnglishScene(candidate.title) && chineseSubtitleScore(candidate.title, true, false) < 0) {
        // Keep as last-resort raw: don't reject yet, just low-score.
      }
      eligible.push(rankOne(candidate, input.target, policy, ["MOVIE"]));
      continue;
    }

    const covered = mapTvCoverage({
      title: candidate.title,
      seasons,
      missingEpisodes: missing,
    });
    if (covered.length === 0) {
      rejected.push({ ...candidate, reason: "no-episode-coverage" });
      continue;
    }
    if (preferZh && !originCN && looksLikeEnglishScene(candidate.title)) {
      rejected.push({ ...candidate, reason: "raw-foreign" });
      continue;
    }
    eligible.push(rankOne(candidate, input.target, policy, covered));
  }

  if (input.target.kind === "movie") {
    const playable = eligible.filter((candidate) => parseReleaseQuality(candidate.title).discImage === false);
    const pool = playable.length > 0 ? playable : eligible;
    const withChinese = preferZh && !originCN ? pool.filter((candidate) => candidate.chineseScore >= 0) : pool;
    const ranked = (withChinese.length > 0 ? withChinese : pool).sort((a, b) => b.totalScore - a.totalScore);
    const best = ranked[0];
    if (!best) {
      return {
        selected: [],
        rejected,
        reason: "规则选片：没有标题匹配且可播放的目标影片候选",
      };
    }
    return {
      selected: [best],
      rejected: [
        ...rejected,
        ...ranked.slice(1).map((candidate) => ({
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
      rejected,
      reason: "规则选片：没有能覆盖缺集的标题匹配候选",
    };
  }
  const selectedIds = new Set(selected.map((candidate) => candidate.candidateId));
  return {
    selected,
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
    reason: `规则选片：${selected.length} 个候选覆盖 ${[...new Set(selected.flatMap((c) => c.coveredEpisodes))].join(",")}`,
  };
}
