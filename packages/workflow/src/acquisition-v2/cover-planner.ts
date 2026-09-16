/**
 * Shared complementary-cover planner for TV/anime.
 *
 * Rules ranking already used `greedyCover`; the Agent path previously only
 * described the same idea in prose. Both now call this module so a planned set
 * is a real artifact (rules transfers it; Agent gets it as a tool result /
 * hard constraint against redundant overlaps).
 *
 * Also owns bounded gap re-search query shaping and per-run transfer caps so a
 * 50-ep single-file season cannot melt the drive — leftovers stay for patrol.
 */
import { QUALITY_RESOLUTION_BAND } from "./quality-ladder.js";

export const MAX_GAP_RESEARCH_ROUNDS = 2;
export const MAX_GAP_QUERIES_PER_ROUND = 2;
/** Hard ceiling on TV/anime share transfers per run (attempts, including failures). */
export const MAX_TV_TRANSFERS_PER_RUN = 12;

export interface CoverCandidate {
  snapshotId: string;
  candidateId: string;
  title: string;
  coveredEpisodes: string[];
  qualityScore: number;
  chineseScore: number;
  totalScore: number;
}

export interface CoverPlanExtras {
  gapResearch?: boolean;
  refill?: boolean;
  transferCap?: boolean;
}

export interface EpisodeRange {
  season: number;
  from: number;
  to: number;
}

const SXE_CODE = /^S(\d+)E(\d+)$/i;
const CN_SEASON = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

export function remainingGain(candidate: CoverCandidate, remaining: ReadonlySet<string>): number {
  return candidate.coveredEpisodes.reduce((count, code) => count + (remaining.has(code) ? 1 : 0), 0);
}

export function uncoveredEpisodes(selected: readonly CoverCandidate[], missing: readonly string[]): string[] {
  const covered = new Set(selected.flatMap((candidate) => candidate.coveredEpisodes));
  return missing.filter((code) => !covered.has(code));
}

function isQualityAcceptable(candidate: CoverCandidate, bestQuality: number): boolean {
  return candidate.qualityScore + QUALITY_RESOLUTION_BAND >= bestQuality;
}

function compareCoverPicks(a: CoverCandidate, b: CoverCandidate, remaining: ReadonlySet<string>): number {
  const aGain = remainingGain(a, remaining);
  const bGain = remainingGain(b, remaining);
  if (aGain !== bGain) {
    return bGain - aGain;
  }
  const aOverlap = a.coveredEpisodes.length - aGain;
  const bOverlap = b.coveredEpisodes.length - bGain;
  if (aOverlap !== bOverlap) {
    return aOverlap - bOverlap;
  }
  if (a.totalScore !== b.totalScore) {
    return b.totalScore - a.totalScore;
  }
  return a.candidateId.localeCompare(b.candidateId);
}

function bestOf(pool: CoverCandidate[], remaining: ReadonlySet<string>): CoverCandidate {
  return [...pool].sort((a, b) => compareCoverPicks(a, b, remaining))[0]!;
}

/**
 * Minimal covering set for TV/anime: prefer a single pack that covers all
 * remaining missing episodes; otherwise greedily compose complementary packs
 * by remaining gain (denser first), then less overlap waste, then quality.
 *
 * Quality floor: when composing partials, prefer candidates within one
 * resolution band of the best eligible score so a 1080p 9-ep pack beats ten
 * 4K singles. A below-floor pack is still used when it is the only way to
 * cover leftover episodes. Complete coverage of the current remainder always
 * wins (整季包不可用 must not block acquisition).
 */
export function greedyCover(ranked: CoverCandidate[], missing: readonly string[]): CoverCandidate[] {
  const remaining = new Set(missing);
  const picked: CoverCandidate[] = [];
  const unused = [...ranked];
  const bestQuality = ranked.reduce((max, candidate) => Math.max(max, candidate.qualityScore), 0);

  while (remaining.size > 0 && unused.length > 0) {
    const withGain = unused.filter((candidate) => remainingGain(candidate, remaining) > 0);
    if (withGain.length === 0) {
      break;
    }

    const complete = withGain.filter((candidate) => remainingGain(candidate, remaining) === remaining.size);
    const acceptable = withGain.filter((candidate) => isQualityAcceptable(candidate, bestQuality));
    let winner: CoverCandidate;
    if (complete.length > 0) {
      const acceptableComplete = complete.filter((candidate) => isQualityAcceptable(candidate, bestQuality));
      winner = bestOf(acceptableComplete.length > 0 ? acceptableComplete : complete, remaining);
      picked.push(winner);
      break;
    }

    const pool = acceptable.length > 0 ? acceptable : withGain;
    winner = bestOf(pool, remaining);
    picked.push(winner);
    unused.splice(unused.indexOf(winner), 1);
    for (const code of winner.coveredEpisodes) {
      remaining.delete(code);
    }
  }
  return picked;
}

/**
 * Re-cover leftover missing episodes from unused eligible candidates
 * (drop failed/used ids first). Same greedyCover, so rules refill and Agent
 * re-plan stay aligned.
 */
export function refillCover(input: {
  eligible: readonly CoverCandidate[];
  missing: readonly string[];
  excludeIds?: ReadonlySet<string>;
}): CoverCandidate[] {
  const excluded = input.excludeIds ?? new Set<string>();
  const pool = input.eligible.filter((candidate) => !excluded.has(candidate.candidateId));
  return greedyCover(pool, input.missing);
}

/** Compress SxxExx lists for activity/reason text: S01E01,E02,E03 → S01E01–E03. */
export function formatEpisodeCodes(codes: readonly string[]): string {
  const unique = [...new Set(codes)];
  if (unique.length === 0) {
    return "";
  }
  const sxe: Array<{ season: number; episode: number }> = [];
  const other: string[] = [];
  for (const code of unique) {
    const match = SXE_CODE.exec(code);
    if (!match) {
      other.push(code);
      continue;
    }
    sxe.push({ season: Number(match[1]), episode: Number(match[2]) });
  }
  sxe.sort((a, b) => a.season - b.season || a.episode - b.episode);
  const ranges: string[] = [];
  let index = 0;
  while (index < sxe.length) {
    const start = sxe[index]!;
    let endEpisode = start.episode;
    while (
      index + 1 < sxe.length &&
      sxe[index + 1]!.season === start.season &&
      sxe[index + 1]!.episode === endEpisode + 1
    ) {
      index += 1;
      endEpisode = sxe[index]!.episode;
    }
    const season = `S${String(start.season).padStart(2, "0")}`;
    const from = `E${String(start.episode).padStart(2, "0")}`;
    ranges.push(
      start.episode === endEpisode
        ? `${season}${from}`
        : `${season}${from}–E${String(endEpisode).padStart(2, "0")}`,
    );
    index += 1;
  }
  return [...ranges, ...other].join("、");
}

export function describeTvSelection(
  selected: readonly CoverCandidate[],
  missing: readonly string[],
  extras: CoverPlanExtras = {},
): string {
  const covered = [...new Set(selected.flatMap((candidate) => candidate.coveredEpisodes))];
  const uncovered = uncoveredEpisodes(selected, missing);
  const n = selected.length;
  const coverText = formatEpisodeCodes(covered);
  const lead = extras.gapResearch ? "规则选片：补搜后用" : "规则选片：用";
  let body = `${lead} ${n} 个分享补齐${coverText ? ` ${coverText}` : ""}`;
  const notes: string[] = [];
  if (extras.refill) {
    notes.push("转失败换备选");
  }
  if (uncovered.length > 0) {
    const leftover = formatEpisodeCodes(uncovered);
    notes.push(
      extras.transferCap
        ? `本轮转存达上限，仍缺 ${leftover}，留给巡检`
        : `整季包不可用，仍缺 ${leftover}`,
    );
  } else if (extras.transferCap) {
    notes.push("本轮转存达上限，其余留给巡检");
  }
  if (notes.length > 0) {
    body += `（${notes.join("；")}）`;
  }
  return body;
}

export function groupEpisodeRanges(codes: readonly string[]): EpisodeRange[] {
  const sxe: Array<{ season: number; episode: number }> = [];
  for (const code of codes) {
    const match = SXE_CODE.exec(code);
    if (!match) {
      continue;
    }
    sxe.push({ season: Number(match[1]), episode: Number(match[2]) });
  }
  sxe.sort((a, b) => a.season - b.season || a.episode - b.episode);
  const ranges: EpisodeRange[] = [];
  let index = 0;
  while (index < sxe.length) {
    const start = sxe[index]!;
    let endEpisode = start.episode;
    while (
      index + 1 < sxe.length &&
      sxe[index + 1]!.season === start.season &&
      sxe[index + 1]!.episode === endEpisode + 1
    ) {
      index += 1;
      endEpisode = sxe[index]!.episode;
    }
    ranges.push({ season: start.season, from: start.episode, to: endEpisode });
    index += 1;
  }
  return ranges;
}

function seasonQueryToken(season: number): string {
  // S1: never add 第一季 — PanSou AND-match collapses recall (庆余年 第二季 实测).
  if (season <= 1) {
    return "";
  }
  if (season <= 10) {
    return `第${CN_SEASON[season]}季`;
  }
  return `第${season}季`;
}

function rangeQueryToken(range: EpisodeRange): string {
  return range.from === range.to ? `第${range.from}集` : `${range.from}-${range.to}集`;
}

function collapseSeasonRanges(ranges: readonly EpisodeRange[]): EpisodeRange[] {
  const bySeason = new Map<number, EpisodeRange[]>();
  for (const range of ranges) {
    const list = bySeason.get(range.season) ?? [];
    list.push(range);
    bySeason.set(range.season, list);
  }
  return [...bySeason.entries()].map(([season, list]) => ({
    season,
    from: Math.min(...list.map((item) => item.from)),
    to: Math.max(...list.map((item) => item.to)),
  }));
}

/**
 * Targeted follow-up search keywords for leftover holes. First recall is always
 * the bare title (prime); these queries are the exception — they name the
 * remaining range so E04–E10 can enter the pool when round-1 only had E01–E03.
 *
 * Bounded: at most `MAX_GAP_QUERIES_PER_ROUND` queries, never quality/subtitle
 * tokens, never one query per episode of a 50-ep season.
 */
export function gapSearchQueries(input: {
  title: string;
  aliases?: readonly string[];
  missing: readonly string[];
  /** 0 = first re-search round (title); 1 = alias fallback. */
  round?: number;
}): string[] {
  const title = input.title.trim();
  if (!title || input.missing.length === 0) {
    return [];
  }
  const ranges = collapseSeasonRanges(groupEpisodeRanges(input.missing));
  if (ranges.length === 0) {
    return [];
  }
  const round = input.round ?? 0;
  const extras = (input.aliases ?? []).map((alias) => alias.trim()).filter((alias) => alias.length > 0 && alias !== title);
  if (round >= 1 && extras.length === 0) {
    return [];
  }
  const lead = round >= 1 ? extras[0]! : title;
  const queries: string[] = [];
  const seen = new Set<string>();
  const push = (parts: string[]) => {
    const keyword = parts.filter((part) => part.length > 0).join(" ").trim();
    if (keyword.length === 0 || keyword === title || seen.has(keyword)) {
      return;
    }
    seen.add(keyword);
    queries.push(keyword);
  };
  for (const range of ranges) {
    if (queries.length >= MAX_GAP_QUERIES_PER_ROUND) {
      break;
    }
    push([lead, seasonQueryToken(range.season), rangeQueryToken(range)]);
  }
  return queries.slice(0, MAX_GAP_QUERIES_PER_ROUND);
}

export function candidatesFromSnapshots(
  snapshots: readonly { id: string; candidates: readonly { id: string; title: string }[] }[],
): Array<{ snapshotId: string; candidateId: string; title: string }> {
  const out: Array<{ snapshotId: string; candidateId: string; title: string }> = [];
  const seen = new Set<string>();
  for (const snapshot of snapshots) {
    for (const candidate of snapshot.candidates) {
      if (seen.has(candidate.id)) {
        continue;
      }
      seen.add(candidate.id);
      out.push({ snapshotId: snapshot.id, candidateId: candidate.id, title: candidate.title });
    }
  }
  return out;
}

export function transferAttemptSucceeded(result: unknown): boolean {
  if (!result || typeof result !== "object" || "error" in result) {
    return false;
  }
  if ("attempt" in result) {
    const attempt = (result as { attempt?: { status?: string } }).attempt;
    if (attempt?.status === "succeeded") {
      return true;
    }
    if (attempt?.status === "failed") {
      return false;
    }
  }
  if ("staging" in result) {
    const staging = (result as { staging?: Array<{ isVideo?: boolean }> }).staging;
    return Array.isArray(staging) && staging.some((file) => file.isVideo);
  }
  return false;
}

export function isTransferCapError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("SANDBOX_TRANSFER_CAP");
}

export function transferCapMessage(limit: number = MAX_TV_TRANSFERS_PER_RUN): string {
  return `SANDBOX_TRANSFER_CAP: 本轮已转存 ${limit} 个分享，其余缺集留给巡检，避免单集连转过多。`;
}
