/**
 * Bounded black-box / opaque TV share probing.
 *
 * Chinese cloud-drive share titles are often just `剧名 第一季` or `剧名 全集`
 * (or a bare show name). Episode numbers live in *file names inside the share*.
 * `mapTvCoverage` therefore returns [] — and the old rule was "do not transfer
 * to see what is inside". That left high-confidence title matches unused.
 *
 * This module opens a NARROW probe path. It is NOT unrestricted "transfer to look".
 *
 * Gate conditions (all must hold) — do not widen without revisiting these:
 * 1. TV/anime only.
 * 2. Title match OR tmdb `mediaBinding` match (`isHighConfidenceTvTitleMatch`).
 * 3. NOT media-id mismatch, sequel/year reject, extras/trailers.
 * 4. Specials stay special: SP/OVA/特别篇 titles are never probed onto regular SxxExx.
 * 5. Date-token shares that already failed to match missing codes are not probed
 *    into a SxxExx library (综艺/新闻 stay date-identity).
 * 6. `mapTvCoverage` is empty, OR the title is a season-folder guess
 *    (named season, no episode/air-date span, no 全集) — refine lucky-dip coverage.
 * 7. A transparent title-mapped set that already covers every missing episode
 *    blocks probing entirely (no lucky-dip when a real span already covers).
 * 8. At most `MAX_BLACKBOX_PROBES` candidates per run, highest quality first.
 *    Never probe the whole low-score tail.
 *
 * Listing vs transfer (verified 2026-09 against sandbox / executor surfaces):
 * - `StorageV2` / `TaskSandbox` have NO list-share tool. The documented read of
 *   share contents is `inspectStaging` AFTER transfer (`listTree`).
 * - Brand clients list internally DURING transfer (Quark `listShareDetail`,
 *   Tianyi/123 `listShareDir`) but that is not on StorageExecutor.
 * - 115 executor has no share-list; 光鸭 is magnet-only.
 * Prefer `StorageV2.listCandidateListing` when the backend implements it
 * (simulator: pack paths, no materialize). Else: capped staging transfer +
 * `inferEpisodeCodeFromListingPath`, keep only files covering still-missing
 * eps, discard junk.
 */
import { episodeCode } from "../domain.js";
import { episodeCodeFromFileName } from "../episode-code.js";
import { MAX_BLACKBOX_PROBES, uncoveredEpisodes, type CoverCandidate } from "./cover-planner.js";
import { isBelowQualityFloor, scoreReleaseQuality, type QualityLadderPolicy } from "./quality-ladder.js";
import {
  parseReleaseMeta,
  splitReleaseTitleParts,
  type ParseReleaseMetaOptions,
} from "./release-meta.js";
import {
  chineseSubtitleScore,
  isHighConfidenceTvTitleMatch,
  mapTvCoverage,
  type RulesSelectorCandidate,
  type RulesSelectorTarget,
} from "./rules-selector.js";

const VIDEO_LISTING_RE = /\.(mkv|mp4|avi|ts|m2ts|mov|flv|wmv)$/i;
const EXTRA_RE = /花絮|预告|trailer|sample|extras?|花絮篇|\bNCOP\b|\bNCED\b/i;
const PACK_RE = /全集|\bcomplete\b|季完整/i;
const SXE_IN_TITLE = /[Ss]\d{1,2}[Ee]\d/;

function parseOptions(customWords: readonly string[] | undefined): ParseReleaseMetaOptions {
  return !customWords || customWords.length === 0 ? {} : { customWords };
}

/**
 * Map a sandbox listing path (`SimTreeFile.path`) onto SxxExx.
 * Parent folders may supply the season when the leaf is only `05.mkv` / `E01`.
 */
export function inferEpisodeCodeFromListingPath(
  path: string,
  fallbackSeason: number | undefined,
  allowedSeasons: readonly number[],
  customWords?: readonly string[],
): string | null {
  const meta = parseReleaseMeta(path, { ...parseOptions(customWords), isFile: true });
  const span = meta.episode;
  const named = meta.seasons.filter((season) => season > 0);
  let episode: number | undefined =
    span && span.from === span.to && span.to < 9999 ? span.from : undefined;

  const leaf = splitReleaseTitleParts(path).at(-1) ?? path;
  if (episode === undefined) {
    const parsed = episodeCodeFromFileName(leaf);
    if (parsed) {
      const season = Number(/^S(\d+)/.exec(parsed)?.[1] ?? 0);
      if (allowedSeasons.length === 0 || allowedSeasons.includes(season)) {
        return parsed;
      }
      return null;
    }
    // Date-named leaves (`2024.03.15.mkv`) must not become E15 via the trailing
    // `\d{2,3}.ext` heuristic. Library identity stays SxxExx; we do not invent it.
    if (!meta.airDate) {
      const bare = /(?:^|[^\d])(\d{2,3})(?:v\d+)?\.(mkv|mp4|ts|m2ts|avi)$/i.exec(leaf);
      if (bare) {
        const n = Number(bare[1]);
        if (n >= 1 && n <= 2000) {
          episode = n;
        }
      }
    }
  }
  if (episode === undefined) {
    return null;
  }

  let season: number | undefined;
  if (named.length === 1) {
    season = named[0];
  } else if (named.length > 1) {
    season = named.find((value) => allowedSeasons.includes(value)) ?? named[named.length - 1];
  } else {
    season = fallbackSeason;
  }
  if (season === undefined) {
    return null;
  }
  if (allowedSeasons.length > 0 && !allowedSeasons.includes(season)) {
    return null;
  }
  return episodeCode(season, episode);
}

/**
 * Season-named pack with no episode span / 全集 — `mapTvCoverage` guesses the
 * whole remaining season. Probe to replace that lucky-dip with file tokens.
 */
export function isSeasonFolderGuess(title: string, customWords?: readonly string[]): boolean {
  const meta = parseReleaseMeta(title, parseOptions(customWords));
  if (meta.special && !SXE_IN_TITLE.test(title)) {
    return false;
  }
  const named = meta.seasons.filter((season) => season > 0);
  const pack = PACK_RE.test(title) || meta.episode?.complete === true;
  return named.length > 0 && !meta.episode && !meta.airDate && !pack;
}

export function mapTvCoverageFromListing(input: {
  paths: readonly string[];
  seasons: readonly number[];
  missingEpisodes: readonly string[];
  fallbackSeason?: number;
  customWords?: readonly string[];
}): string[] {
  const allowed = input.seasons.filter((season) => season >= 1);
  if (allowed.length === 0 || input.missingEpisodes.length === 0) {
    return [];
  }
  const fallback =
    input.fallbackSeason ?? (allowed.length === 1 ? allowed[0] : undefined);
  const missing = new Set(input.missingEpisodes);
  const out = new Set<string>();
  for (const path of input.paths) {
    if (!VIDEO_LISTING_RE.test(path)) {
      continue;
    }
    const meta = parseReleaseMeta(path, { ...parseOptions(input.customWords), isFile: true });
    if (meta.special && !SXE_IN_TITLE.test(path)) {
      continue;
    }
    const code = inferEpisodeCodeFromListingPath(path, fallback, allowed, input.customWords);
    if (code && missing.has(code)) {
      out.add(code);
    }
  }
  return [...out];
}

function isSpecialTitle(title: string, customWords?: readonly string[]): boolean {
  const meta = parseReleaseMeta(title, parseOptions(customWords));
  return meta.special && !SXE_IN_TITLE.test(title);
}

/**
 * Whether this title-matched candidate may be directory-probed.
 * Returns false for every "do not transfer to look" case we are NOT opening.
 */
export function isOpaqueTvProbeEligible(input: {
  title: string;
  target: RulesSelectorTarget;
  customWords?: readonly string[];
}): boolean {
  if (input.target.kind !== "tv") {
    return false;
  }
  if (!isHighConfidenceTvTitleMatch(input.title, input.target, input.customWords)) {
    return false;
  }
  if (EXTRA_RE.test(input.title) || isSpecialTitle(input.title, input.customWords)) {
    return false;
  }
  const preferZh = (input.target.preferredLanguage ?? "中文").includes("中");
  const originCN = (input.target.originCountries ?? []).includes("CN");
  if (preferZh && !originCN && chineseSubtitleScore(input.title, true, false) < 0) {
    return false;
  }
  const seasons = input.target.seasons ?? [1];
  const missing = input.target.missingEpisodes ?? [];
  const covered = mapTvCoverage({
    title: input.title,
    seasons,
    missingEpisodes: missing,
    ...(input.customWords && input.customWords.length > 0 ? { customWords: input.customWords } : {}),
  });
  const meta = parseReleaseMeta(input.title, parseOptions(input.customWords));
  if (meta.airDate && covered.length === 0) {
    return false;
  }
  if (covered.length === 0) {
    return true;
  }
  return isSeasonFolderGuess(input.title, input.customWords);
}

export function transparentCoverComplete(
  titleMapped: readonly CoverCandidate[],
  missing: readonly string[],
  customWords?: readonly string[],
): boolean {
  const solid = titleMapped.filter(
    (candidate) => candidate.coverageSource !== "probe" && !isSeasonFolderGuess(candidate.title, customWords),
  );
  return solid.length > 0 && uncoveredEpisodes(solid, missing).length === 0;
}

/**
 * Highest-quality opaque candidates, capped. Empty when a transparent span
 * already covers the need or no candidate passes the gates.
 */
export function pickOpaqueProbeCandidates(input: {
  candidates: readonly RulesSelectorCandidate[];
  target: RulesSelectorTarget;
  policy?: QualityLadderPolicy;
  customWords?: readonly string[];
  titleMapped?: readonly CoverCandidate[];
  limit?: number;
}): RulesSelectorCandidate[] {
  const missing = input.target.missingEpisodes ?? [];
  if (input.target.kind !== "tv" || missing.length === 0) {
    return [];
  }
  if (transparentCoverComplete(input.titleMapped ?? [], missing, input.customWords)) {
    return [];
  }
  const policy = input.policy ?? {};
  const scored = input.candidates
    .filter((candidate) =>
      isOpaqueTvProbeEligible({
        title: candidate.title,
        target: input.target,
        ...(input.customWords && input.customWords.length > 0 ? { customWords: input.customWords } : {}),
      }),
    )
    .filter((candidate) => !isBelowQualityFloor(candidate.title, policy.resolutionFloor))
    .map((candidate) => {
      const meta = parseReleaseMeta(candidate.title, parseOptions(input.customWords));
      const qualityScore = scoreReleaseQuality(meta, policy);
      const chineseScore = chineseSubtitleScore(
        candidate.title,
        (input.target.preferredLanguage ?? "中文").includes("中"),
        (input.target.originCountries ?? []).includes("CN"),
        meta.subtitleTags,
      );
      return { candidate, totalScore: qualityScore * 10 + chineseScore };
    });
  scored.sort((a, b) => b.totalScore - a.totalScore || a.candidate.candidateId.localeCompare(b.candidate.candidateId));
  const limit = input.limit ?? MAX_BLACKBOX_PROBES;
  return scored.slice(0, Math.max(0, limit)).map((row) => row.candidate);
}
