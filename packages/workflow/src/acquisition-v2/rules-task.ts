import { episodeCode } from "../domain.js";
import { episodeCodeFromFileName } from "../episode-code.js";
import type { AcquisitionAgentResult } from "./agent-loop.js";
import { interpretTool, type AgentToolEvent } from "./activity.js";
import { scoreReleaseQuality, type QualityLadderPolicy } from "./quality-ladder.js";
import {
  customIdentifierWordsSpread,
  parseReleaseMeta,
  splitReleaseTitleParts,
  type ParseReleaseMetaOptions,
} from "./release-meta.js";
import {
  candidatesFromSnapshots,
  describeTvSelection,
  gapSearchQueries,
  greedyCover,
  isTransferCapError,
  MAX_GAP_RESEARCH_ROUNDS,
  transferAttemptSucceeded,
} from "./cover-planner.js";
import type { TaskSandbox } from "./sandbox.js";
import {
  selectResourceCandidates,
  assessRulesConfidence,
  planTvCover,
  type RankedRulesCandidate,
  type RulesSelectorCandidate,
  type RulesSelectorTarget,
} from "./rules-selector.js";
import type { MovieTarget, TvAnimeTarget } from "./task-agents.js";

/**
 * Drive the existing sandbox tools with a deterministic selector: search
 * (prime already ran) → rank → transfer by candidate id → verify → mark.
 * Same permission cage as the LLM agent; never transfers by raw provider order.
 */

export interface RunRulesAcquisitionRequest {
  sandbox: TaskSandbox;
  target: RulesSelectorTarget;
  policy?: QualityLadderPolicy;
  qualityUpgrade?: boolean;
  /** MoviePilot-style identifier words from Settings; applied after built-ins. */
  customIdentifierWords?: readonly string[];
  onProgress?: (event: AgentToolEvent) => void;
  /**
   * `auto` mode: after ranking, if parse/coverage confidence is low, return
   * without transferring or reporting no-coverage so the orchestrator can run
   * the sandbox agent on the same primed snapshots. Forced `rules` omits this.
   */
  escalateOnLowConfidence?: boolean;
}

function parseOptions(words: readonly string[] | undefined): ParseReleaseMetaOptions {
  return !words || words.length === 0 ? {} : { customWords: words };
}

function shouldReplaceTitled(
  existingTitle: string,
  candidateTitle: string,
  policy: QualityLadderPolicy,
  words: readonly string[] | undefined,
): boolean {
  const existing = parseReleaseMeta(existingTitle, parseOptions(words));
  const candidate = parseReleaseMeta(candidateTitle, parseOptions(words));
  if (candidate.discImage && !existing.discImage) {
    return false;
  }
  return scoreReleaseQuality(candidate, policy) > scoreReleaseQuality(existing, policy);
}

function selectWithWords(
  candidates: readonly RulesSelectorCandidate[],
  target: RulesSelectorTarget,
  policy: QualityLadderPolicy,
  words: readonly string[] | undefined,
) {
  return selectResourceCandidates({
    candidates,
    target,
    policy,
    ...customIdentifierWordsSpread(words ? [...words] : undefined),
  });
}

function emit(onProgress: ((event: AgentToolEvent) => void) | undefined, toolName: string, args: Record<string, unknown>): void {
  if (!onProgress) {
    return;
  }
  try {
    onProgress({ toolName, args, ...interpretTool(toolName, args) });
  } catch {
    // progress is a display nicety
  }
}

function asEvidence<T>(run: () => Promise<T>): Promise<T | { error: string }> {
  return run().catch((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
  }));
}

function snapshotsToCandidates(sandbox: TaskSandbox): RulesSelectorCandidate[] {
  return candidatesFromSnapshots(sandbox.listObservedSnapshots());
}

async function searchAliases(sandbox: TaskSandbox, target: RulesSelectorTarget, onProgress?: (event: AgentToolEvent) => void): Promise<void> {
  const extras = target.aliases.filter((alias) => alias.trim() && alias.trim() !== target.title).slice(0, 3);
  if (target.kind === "movie" && target.year && target.year > 0) {
    extras.push(`${target.title} ${target.year}`);
  }
  for (const keyword of extras) {
    emit(onProgress, "searchResources", { keyword });
    const result = await asEvidence(() => sandbox.searchResources(keyword));
    if (result && typeof result === "object" && "error" in result) {
      continue;
    }
    const snapshot = result && typeof result === "object" && "snapshot" in result ? result.snapshot : undefined;
    if (snapshot && snapshot.candidates.length > 0) {
      // One successful upgrade search is enough — don't burn the budget.
      if (snapshotsToCandidates(sandbox).length > 0) {
        return;
      }
    }
  }
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

function transferSucceeded(result: unknown): boolean {
  return transferAttemptSucceeded(result);
}

async function runGapResearch(
  sandbox: TaskSandbox,
  target: RulesSelectorTarget,
  policy: QualityLadderPolicy,
  words: readonly string[] | undefined,
  onProgress?: (event: AgentToolEvent) => void,
): Promise<boolean> {
  const missing = target.missingEpisodes ?? [];
  if (target.kind !== "tv" || missing.length === 0) {
    return false;
  }
  let didSearch = false;
  for (let round = 0; round < MAX_GAP_RESEARCH_ROUNDS; round += 1) {
    const plan = planTvCover({
      candidates: snapshotsToCandidates(sandbox),
      target,
      policy,
      ...(words && words.length > 0 ? { customIdentifierWords: words } : {}),
      remainingMissing: missing,
      gapRound: round,
    });
    if (plan.uncovered.length === 0 || plan.gapQueries.length === 0) {
      break;
    }
    let searchedThisRound = false;
    for (const keyword of plan.gapQueries) {
      emit(onProgress, "searchResources", { keyword, gapResearch: true });
      const result = await asEvidence(() => sandbox.searchResources(keyword));
      if (result && typeof result === "object" && "refused" in result && result.refused) {
        return didSearch;
      }
      searchedThisRound = true;
      didSearch = true;
    }
    if (!searchedThisRound) {
      break;
    }
  }
  return didSearch;
}

async function lightGapSearch(
  sandbox: TaskSandbox,
  target: RulesSelectorTarget,
  remaining: readonly string[],
  onProgress?: (event: AgentToolEvent) => void,
): Promise<boolean> {
  const queries = gapSearchQueries({
    title: target.title,
    aliases: target.aliases,
    missing: remaining,
    round: 0,
  });
  if (queries.length === 0) {
    return false;
  }
  let searched = false;
  for (const keyword of queries) {
    emit(onProgress, "searchResources", { keyword, gapResearch: true });
    const result = await asEvidence(() => sandbox.searchResources(keyword));
    if (result && typeof result === "object" && "refused" in result && result.refused) {
      return searched;
    }
    searched = true;
  }
  return searched;
}

async function transferRanked(
  sandbox: TaskSandbox,
  selected: RankedRulesCandidate[],
  onProgress?: (event: AgentToolEvent) => void,
): Promise<{ systemicBlock?: string; landed: boolean }> {
  if (selected.length === 0) {
    return { landed: false };
  }
  for (const candidate of selected) {
    emit(onProgress, "transferCandidate", {
      snapshotId: candidate.snapshotId,
      candidateId: candidate.candidateId,
    });
    const result = await asEvidence(() =>
      sandbox.transferCandidate({ snapshotId: candidate.snapshotId, candidateId: candidate.candidateId }),
    );
    if (result && typeof result === "object" && "error" in result) {
      continue;
    }
    if (result && typeof result === "object" && "systemicBlock" in result && result.systemicBlock) {
      return { systemicBlock: result.systemicBlock.reason, landed: false };
    }
    if (result && typeof result === "object" && "staging" in result && result.staging.some((file) => file.isVideo)) {
      return { landed: true };
    }
  }
  return { landed: false };
}

async function transferTvWithRefill(input: {
  sandbox: TaskSandbox;
  target: RulesSelectorTarget;
  policy: QualityLadderPolicy;
  words: readonly string[] | undefined;
  eligible: RankedRulesCandidate[];
  missing: readonly string[];
  onProgress?: (event: AgentToolEvent) => void;
}): Promise<{
  systemicBlock?: string;
  landed: boolean;
  transferred: RankedRulesCandidate[];
  remaining: string[];
  refill: boolean;
  transferCap: boolean;
}> {
  const { sandbox, target, policy, words, onProgress } = input;
  const remaining = new Set(input.missing);
  let eligible = [...input.eligible];
  const exclude = new Set<string>();
  const succeeded = new Set<string>();
  const transferred: RankedRulesCandidate[] = [];
  let refill = false;
  let transferCap = false;
  let didLightResearch = false;

  const unused = (): RankedRulesCandidate[] =>
    eligible.filter((candidate) => !exclude.has(candidate.candidateId) && !succeeded.has(candidate.candidateId));

  while (remaining.size > 0) {
    const plan = greedyCover(unused(), [...remaining]);
    if (plan.length === 0) {
      if (didLightResearch) {
        break;
      }
      didLightResearch = true;
      const searched = await lightGapSearch(sandbox, target, [...remaining], onProgress);
      if (!searched) {
        break;
      }
      const refreshed = selectWithWords(snapshotsToCandidates(sandbox), { ...target, missingEpisodes: [...remaining] }, policy, words);
      eligible = refreshed.eligible ?? refreshed.selected;
      continue;
    }

    for (const candidate of plan) {
      const gain = candidate.coveredEpisodes.filter((code) => remaining.has(code));
      if (gain.length === 0) {
        continue;
      }
      emit(onProgress, "transferCandidate", {
        snapshotId: candidate.snapshotId,
        candidateId: candidate.candidateId,
      });
      const result = await asEvidence(() =>
        sandbox.transferCandidate({ snapshotId: candidate.snapshotId, candidateId: candidate.candidateId }),
      );
      if (result && typeof result === "object" && "error" in result) {
        if (isTransferCapError(result.error)) {
          transferCap = true;
          const staging = await asEvidence(() => sandbox.inspectStaging());
          return {
            landed: Array.isArray(staging) && staging.some((file) => file.isVideo),
            transferred,
            remaining: [...remaining],
            refill,
            transferCap,
          };
        }
        exclude.add(candidate.candidateId);
        refill = true;
        const next = greedyCover(unused(), [...remaining]);
        emit(onProgress, "rulesSelectCandidates", {
          refill: true,
          shareCount: next.length,
          selected: next.map((item) => item.candidateId),
          reason: "转失败换备选",
        });
        break;
      }
      if (result && typeof result === "object" && "systemicBlock" in result && result.systemicBlock) {
        return {
          systemicBlock: result.systemicBlock.reason,
          landed: false,
          transferred,
          remaining: [...remaining],
          refill,
          transferCap,
        };
      }
      if (transferSucceeded(result)) {
        succeeded.add(candidate.candidateId);
        transferred.push(candidate);
        for (const code of gain) {
          remaining.delete(code);
        }
      } else {
        exclude.add(candidate.candidateId);
        refill = true;
        const next = greedyCover(unused(), [...remaining]);
        emit(onProgress, "rulesSelectCandidates", {
          refill: true,
          shareCount: next.length,
          selected: next.map((item) => item.candidateId),
          reason: "转失败换备选",
        });
        break;
      }
    }
  }

  const staging = await asEvidence(() => sandbox.inspectStaging());
  return {
    landed: Array.isArray(staging) && staging.some((file) => file.isVideo),
    transferred,
    remaining: [...remaining],
    refill,
    transferCap,
  };
}

async function organizeTv(
  sandbox: TaskSandbox,
  seasons: readonly number[],
  onProgress?: (event: AgentToolEvent) => void,
  words?: readonly string[],
): Promise<string[]> {
  emit(onProgress, "inspectStaging", {});
  const staging = await sandbox.inspectStaging();
  const allowed = seasons.length > 0 ? seasons : [1];
  const fallback = allowed.length === 1 ? allowed[0] : undefined;
  const bySeason = new Map<number, string[]>();
  const marked: string[] = [];

  for (const file of staging) {
    if (!file.isVideo && !file.isSubtitle) {
      continue;
    }
    const code = inferEpisodeCodeFromListingPath(file.path, fallback, allowed, words);
    if (!code) {
      continue;
    }
    const season = Number(/^S(\d+)/.exec(code)?.[1] ?? 0);
    if (!allowed.includes(season)) {
      continue;
    }
    const ids = bySeason.get(season) ?? [];
    ids.push(file.id);
    bySeason.set(season, ids);
    if (file.isVideo) {
      marked.push(code);
    }
  }

  if (bySeason.size === 0) {
    return [];
  }

  const moves = [...bySeason.entries()].map(([season, fileIds]) => ({ season, fileIds }));
  emit(onProgress, "moveToSeason", { moves });
  await sandbox.moveToSeason({ moves });
  return [...new Set(marked)];
}

async function markExistingTv(
  sandbox: TaskSandbox,
  seasons: readonly number[],
  missing: readonly string[],
  onProgress?: (event: AgentToolEvent) => void,
  words?: readonly string[],
): Promise<void> {
  const missingSet = new Set(missing);
  const found: string[] = [];
  for (const season of seasons) {
    emit(onProgress, "inspectTargetDir", { season });
    const files = await asEvidence(() => sandbox.inspectTargetDir({ season }));
    if (!Array.isArray(files)) {
      continue;
    }
    for (const file of files) {
      if (!file.isVideo) {
        continue;
      }
      const code = inferEpisodeCodeFromListingPath(file.path, season, [season], words);
      if (code && missingSet.has(code)) {
        found.push(code);
      }
    }
  }
  if (found.length > 0) {
    emit(onProgress, "markObtained", { codes: found });
    await sandbox.markObtained({ codes: found });
  }
}

async function maybeReplaceOldMovieFiles(
  sandbox: TaskSandbox,
  candidateTitle: string,
  policy: QualityLadderPolicy,
  words: readonly string[] | undefined,
): Promise<void> {
  const files = await sandbox.inspectTargetDir();
  const videos = files.filter((file) => file.isVideo);
  const worse = videos.filter((file) => shouldReplaceTitled(file.path, candidateTitle, policy, words));
  if (worse.length === 0 || worse.length === videos.length) {
    // Never wipe the only copies if the new file isn't distinguishable yet.
    const still = files.filter((file) => file.isVideo && !worse.some((item) => item.id === file.id));
    if (still.length === 0) {
      return;
    }
  }
  if (worse.length > 0) {
    await sandbox.deleteFiles({ directory: "season", fileIds: worse.map((file) => file.id) });
  }
}

export async function runRulesAcquisition(request: RunRulesAcquisitionRequest): Promise<
  AcquisitionAgentResult & { escalateToAgent?: string[] }
> {
  const { sandbox, target } = request;
  const policy = request.policy ?? {};
  const words = request.customIdentifierWords;
  const onProgress = request.onProgress;
  emit(onProgress, "rulesSelectCandidates", {
    mode: request.escalateOnLowConfidence ? "auto" : "rules",
  });

  if (target.kind === "tv" && (target.seasons?.length ?? 0) > 0) {
    await markExistingTv(sandbox, target.seasons ?? [], target.missingEpisodes ?? [], onProgress, words);
    if (sandbox.isCoverageMet() && !request.qualityUpgrade) {
      emit(onProgress, "finish", {});
      const coverage = await sandbox.finish();
      return { text: "规则选片：目标目录已有缺集，无需转存", steps: 1, coverage };
    }
  }

  let candidates = snapshotsToCandidates(sandbox);
  if (candidates.length === 0 || selectWithWords(candidates, target, policy, words).selected.length === 0) {
    await searchAliases(sandbox, target, onProgress);
    candidates = snapshotsToCandidates(sandbox);
  }

  const didGapResearch = await runGapResearch(sandbox, target, policy, words, onProgress);
  candidates = snapshotsToCandidates(sandbox);

  emit(onProgress, "viewResourceSnapshot", {});
  const selection = selectWithWords(candidates, target, policy, words);
  const reasonExtras = { gapResearch: didGapResearch };

  if (request.escalateOnLowConfidence) {
    const report = assessRulesConfidence({
      target,
      selection,
      candidateCount: candidates.length,
      ...(words && words.length > 0 ? { customWords: words } : {}),
    });
    if (report.confidence === "low") {
      emit(onProgress, "rulesSelectCandidates", {
        mode: "auto",
        fallback: "agent",
        reasons: report.reasons,
        reason: `规则选片置信度低（${report.reasons.join("、")}），改走 agent`,
      });
      return {
        text: `规则选片置信度低，改走 agent：${report.reasons.join("、")}`,
        steps: 1,
        coverage: { coverageMet: false, obtained: [], missing: [], subtitleFallback: false },
        escalateToAgent: report.reasons,
      };
    }
  }

  emit(onProgress, "rulesSelectCandidates", {
    selected: selection.selected.map((candidate) => candidate.candidateId),
    reason: target.kind === "tv"
      ? describeTvSelection(selection.selected, target.missingEpisodes ?? [], reasonExtras)
      : selection.reason,
    shareCount: selection.selected.length,
    ...(didGapResearch ? { gapResearch: true } : {}),
  });

  if (selection.selected.length === 0) {
    const reported = await asEvidence(() => sandbox.reportNoCoverage(selection.reason));
    if (reported && typeof reported === "object" && "error" in reported) {
      emit(onProgress, "finish", {});
      const coverage = await sandbox.finish();
      return { text: reported.error, steps: 1, coverage };
    }
    emit(onProgress, "reportNoCoverage", { reason: selection.reason });
    emit(onProgress, "finish", {});
    const coverage = await sandbox.finish();
    return { text: selection.reason, steps: 1, coverage };
  }

  if (request.qualityUpgrade && target.kind === "movie") {
    const existing = await asEvidence(() => sandbox.inspectTargetDir());
    if (Array.isArray(existing) && existing.some((file) => file.isVideo)) {
      const best = selection.selected[0]!;
      const anyUpgrade = existing
        .filter((file) => file.isVideo)
        .some((file) => shouldReplaceTitled(file.path, best.title, policy, words));
      if (!anyUpgrade) {
        emit(onProgress, "finish", {});
        const coverage = await sandbox.finish();
        return { text: "规则选片：已入库画质不低于候选，跳过升级", steps: 1, coverage };
      }
    }
  }

  if (target.kind === "movie") {
    const transfer = await transferRanked(sandbox, selection.selected, onProgress);
    if (transfer.systemicBlock) {
      emit(onProgress, "finish", {});
      const coverage = await sandbox.finish();
      return { text: `转存系统故障：${transfer.systemicBlock}`, steps: 1, coverage };
    }
    emit(onProgress, "flattenMovie", {});
    await asEvidence(() => sandbox.flattenMovie());
    emit(onProgress, "inspectStaging", {});
    const files = await asEvidence(() => sandbox.inspectStaging());
    const videos = Array.isArray(files) ? files.filter((file) => file.isVideo) : [];
    if (videos.length > 0) {
      if (request.qualityUpgrade) {
        await maybeReplaceOldMovieFiles(sandbox, selection.selected[0]!.title, policy, words);
      }
      const rawFallback = selection.selected[0]!.chineseScore < 0;
      emit(onProgress, "markObtained", { codes: ["MOVIE"] });
      await sandbox.markObtained({ codes: ["MOVIE"], ...(rawFallback ? { subtitleFallback: true } : {}) });
    } else {
      const reason = "规则选片：转存后未见可播放视频";
      await asEvidence(() => sandbox.reportNoCoverage(reason));
      emit(onProgress, "reportNoCoverage", { reason });
    }
    emit(onProgress, "finish", {});
    const coverage = await sandbox.finish();
    return { text: selection.reason, steps: 1, coverage };
  }

  const missing = target.missingEpisodes ?? [];
  const transfer = await transferTvWithRefill({
    sandbox,
    target,
    policy,
    words,
    eligible: selection.eligible ?? selection.selected,
    missing,
    ...(onProgress ? { onProgress } : {}),
  });
  if (transfer.systemicBlock) {
    emit(onProgress, "finish", {});
    const coverage = await sandbox.finish();
    return { text: `转存系统故障：${transfer.systemicBlock}`, steps: 1, coverage };
  }

  const tvReason = describeTvSelection(transfer.transferred.length > 0 ? transfer.transferred : selection.selected, missing, {
    ...reasonExtras,
    refill: transfer.refill,
    transferCap: transfer.transferCap,
  });
  const marked = await organizeTv(sandbox, target.seasons ?? [1], onProgress, words);
  if (marked.length > 0) {
    emit(onProgress, "markObtained", { codes: marked });
    await sandbox.markObtained({ codes: marked });
  } else if (!transfer.landed) {
    await asEvidence(() => sandbox.reportNoCoverage(tvReason));
    emit(onProgress, "reportNoCoverage", { reason: tvReason });
  }
  emit(onProgress, "discardStaging", {});
  await asEvidence(() => sandbox.discardStaging());
  emit(onProgress, "finish", {});
  const coverage = await sandbox.finish();
  return { text: tvReason, steps: 1, coverage };
}

export function movieTargetToRules(target: MovieTarget, extras?: { originCountries?: string[]; preferredLanguage?: string }): RulesSelectorTarget {
  return {
    kind: "movie",
    title: target.title,
    aliases: target.aliases,
    year: target.year,
    ...(target.tmdbId === undefined ? {} : { tmdbId: target.tmdbId }),
    ...(extras?.originCountries ? { originCountries: extras.originCountries } : {}),
    ...(extras?.preferredLanguage ? { preferredLanguage: extras.preferredLanguage } : {}),
  };
}

export function tvTargetToRules(target: TvAnimeTarget, extras?: { originCountries?: string[]; preferredLanguage?: string }): RulesSelectorTarget {
  return {
    kind: "tv",
    title: target.title,
    aliases: target.aliases,
    seasons: target.seasons,
    missingEpisodes: target.missingEpisodes,
    ...(target.tmdbId === undefined ? {} : { tmdbId: target.tmdbId }),
    ...(extras?.originCountries ? { originCountries: extras.originCountries } : {}),
    ...(extras?.preferredLanguage ? { preferredLanguage: extras.preferredLanguage } : {}),
  };
}
