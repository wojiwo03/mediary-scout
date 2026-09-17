import type { AcquisitionAgentResult } from "./agent-loop.js";
import { interpretTool, type AgentToolEvent } from "./activity.js";
import type { QualityLadderPolicy } from "./quality-ladder.js";
import { customIdentifierWordsSpread } from "./release-meta.js";
import {
  candidatesFromSnapshots,
  describeTvSelection,
  gapSearchQueries,
  greedyCover,
  isTransferCapError,
  MAX_GAP_RESEARCH_ROUNDS,
  transferAttemptSucceeded,
} from "./cover-planner.js";
import {
  foldLandedDuplicates,
  indexExistingVideos,
  selectStillMissingMoves,
  shouldReplaceLanded,
  anyLandedUpgrade,
} from "./landed-dedup.js";
import { POST_FINISH_IO_TIMEOUT_MS, withTimeout } from "./best-effort.js";
import {
  inferEpisodeCodeFromListingPath,
  mapTvCoverageFromListing,
  pickOpaqueProbeCandidates,
} from "./listing-coverage.js";
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

export { inferEpisodeCodeFromListingPath } from "./listing-coverage.js";

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

function selectWithWords(
  candidates: readonly RulesSelectorCandidate[],
  target: RulesSelectorTarget,
  policy: QualityLadderPolicy,
  words: readonly string[] | undefined,
  coverageOverrides?: ReadonlyMap<string, readonly string[]>,
) {
  return selectResourceCandidates({
    candidates,
    target,
    policy,
    ...customIdentifierWordsSpread(words ? [...words] : undefined),
    ...(coverageOverrides ? { coverageOverrides } : {}),
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

async function probeOpaqueTvShares(input: {
  sandbox: TaskSandbox;
  candidates: readonly RulesSelectorCandidate[];
  target: RulesSelectorTarget;
  policy: QualityLadderPolicy;
  words: readonly string[] | undefined;
  titleMapped: RankedRulesCandidate[];
  onProgress?: (event: AgentToolEvent) => void;
  listingOnly?: boolean;
}): Promise<{
  overrides: Map<string, string[]>;
  transferredIds: Set<string>;
  transferredFiles: Map<string, string[]>;
}> {
  const overrides = new Map<string, string[]>();
  const transferredIds = new Set<string>();
  const transferredFiles = new Map<string, string[]>();
  const missing = input.target.missingEpisodes ?? [];
  const seasons = input.target.seasons ?? [1];
  if (input.target.kind !== "tv" || missing.length === 0) {
    return { overrides, transferredIds, transferredFiles };
  }
  const picks = pickOpaqueProbeCandidates({
    candidates: input.candidates,
    target: input.target,
    policy: input.policy,
    titleMapped: input.titleMapped,
    ...(input.words && input.words.length > 0 ? { customWords: input.words } : {}),
  });
  if (picks.length === 0) {
    return { overrides, transferredIds, transferredFiles };
  }

  const listingWords = {
    seasons,
    missingEpisodes: missing,
    ...(input.words && input.words.length > 0 ? { customWords: input.words } : {}),
  };

  for (const candidate of picks) {
    emit(input.onProgress, "probeShareListing", { title: candidate.title });
    const listing = await asEvidence(() => input.sandbox.listCandidateListing(candidate.candidateId));
    if (Array.isArray(listing)) {
      const covered = mapTvCoverageFromListing({
        paths: listing.map((row) => row.path),
        ...listingWords,
      });
      overrides.set(candidate.candidateId, covered);
      if (covered.length > 0) {
        emit(input.onProgress, "probeShareFiles", { episodeCount: covered.length });
      }
      continue;
    }
    if (input.listingOnly) {
      continue;
    }

    let beforeIds = new Set<string>();
    const before = await asEvidence(() => input.sandbox.inspectStaging());
    if (Array.isArray(before)) {
      beforeIds = new Set(before.map((file) => file.id));
    }
    emit(input.onProgress, "transferCandidate", {
      snapshotId: candidate.snapshotId,
      candidateId: candidate.candidateId,
    });
    const result = await asEvidence(() =>
      input.sandbox.transferCandidate({
        snapshotId: candidate.snapshotId,
        candidateId: candidate.candidateId,
      }),
    );
    if (result && typeof result === "object" && "error" in result) {
      overrides.set(candidate.candidateId, []);
      if (isTransferCapError(result.error)) {
        break;
      }
      continue;
    }
    if (result && typeof result === "object" && "systemicBlock" in result && result.systemicBlock) {
      break;
    }
    const staging = await asEvidence(() => input.sandbox.inspectStaging());
    const newFiles = Array.isArray(staging) ? staging.filter((file) => !beforeIds.has(file.id)) : [];
    const covered = mapTvCoverageFromListing({
      paths: newFiles.filter((file) => file.isVideo).map((file) => file.path),
      ...listingWords,
    });
    overrides.set(candidate.candidateId, covered);
    if (covered.length === 0) {
      if (newFiles.length > 0) {
        await asEvidence(() =>
          input.sandbox.deleteFiles({ directory: "staging", fileIds: newFiles.map((file) => file.id) }),
        );
      }
      continue;
    }
    emit(input.onProgress, "probeShareFiles", { episodeCount: covered.length });
    transferredIds.add(candidate.candidateId);
    transferredFiles.set(
      candidate.candidateId,
      newFiles.map((file) => file.id),
    );
  }
  return { overrides, transferredIds, transferredFiles };
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
  alreadyTransferred?: ReadonlySet<string>;
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
  const alreadyTransferred = input.alreadyTransferred ?? new Set<string>();
  const succeeded = new Set<string>();
  const transferred: RankedRulesCandidate[] = [];
  let refill = false;
  let transferCap = false;
  let didLightResearch = false;

  const unused = (): RankedRulesCandidate[] =>
    eligible.filter(
      (candidate) =>
        !exclude.has(candidate.candidateId) && !transferred.some((row) => row.candidateId === candidate.candidateId),
    );

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
      if (alreadyTransferred.has(candidate.candidateId) || succeeded.has(candidate.candidateId)) {
        succeeded.add(candidate.candidateId);
        transferred.push(candidate);
        for (const code of gain) {
          remaining.delete(code);
        }
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

async function organizeTv(input: {
  sandbox: TaskSandbox;
  seasons: readonly number[];
  remainingNeed: readonly string[];
  qualityUpgrade: boolean;
  policy: QualityLadderPolicy;
  onProgress?: (event: AgentToolEvent) => void;
  words?: readonly string[];
}): Promise<string[]> {
  emit(input.onProgress, "inspectStaging", {});
  const stagingResult = await asEvidence(() =>
    withTimeout(input.sandbox.inspectStaging(), POST_FINISH_IO_TIMEOUT_MS),
  );
  const staging = Array.isArray(stagingResult) ? stagingResult : [];
  // Nothing to place: skip season-dir listing. inspectTargetDir after an unmet
  // transfer used to hang the worker before finish could persist.
  if (!staging.some((file) => file.isVideo || file.isSubtitle)) {
    return [];
  }
  const allowed = input.seasons.length > 0 ? input.seasons : [1];
  const existingFiles = [];
  for (const season of allowed) {
    emit(input.onProgress, "inspectTargetDir", { season });
    const files = await asEvidence(() =>
      withTimeout(input.sandbox.inspectTargetDir({ season }), POST_FINISH_IO_TIMEOUT_MS),
    );
    if (!Array.isArray(files)) {
      // Listing failed/hung: do not move blindly (would re-copy already-landed
      // episodes). Leave staging for discard; honest gap for patrol.
      return [];
    }
    existingFiles.push(...files);
  }
  const existingByCode = indexExistingVideos(
    existingFiles,
    allowed,
    input.words,
    input.policy,
    input.qualityUpgrade,
  );
  const selected = selectStillMissingMoves({
    staging,
    remainingNeed: new Set(input.remainingNeed),
    existingByCode,
    seasons: allowed,
    qualityUpgrade: input.qualityUpgrade,
    policy: input.policy,
    ...(input.words && input.words.length > 0 ? { customWords: input.words } : {}),
  });
  if (selected.moves.length === 0) {
    return [];
  }

  emit(input.onProgress, "moveToSeason", { moves: selected.moves });
  await input.sandbox.moveToSeason({ moves: selected.moves });
  await foldLandedDuplicates(input.sandbox, {
    seasons: allowed,
    qualityUpgrade: input.qualityUpgrade,
    ...(Object.keys(input.policy).length > 0 ? { policy: input.policy } : {}),
    ...(input.words && input.words.length > 0 ? { customWords: input.words } : {}),
  });
  return selected.marked;
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
    const files = await asEvidence(() =>
      withTimeout(sandbox.inspectTargetDir({ season }), POST_FINISH_IO_TIMEOUT_MS),
    );
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

async function markExistingMovie(
  sandbox: TaskSandbox,
  onProgress?: (event: AgentToolEvent) => void,
): Promise<void> {
  emit(onProgress, "inspectTargetDir", {});
  const files = await asEvidence(() => withTimeout(sandbox.inspectTargetDir(), POST_FINISH_IO_TIMEOUT_MS));
  if (!Array.isArray(files) || !files.some((file) => file.isVideo)) {
    return;
  }
  emit(onProgress, "markObtained", { codes: ["MOVIE"] });
  await sandbox.markObtained({ codes: ["MOVIE"] });
}

async function maybeReplaceOldMovieFiles(
  sandbox: TaskSandbox,
  candidateTitle: string,
  policy: QualityLadderPolicy,
  words: readonly string[] | undefined,
): Promise<void> {
  const files = await sandbox.inspectTargetDir();
  const videos = files.filter((file) => file.isVideo);
  const worse = videos.filter((file) => shouldReplaceLanded(file.path, candidateTitle, policy, words));
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

  if (target.kind === "movie") {
    await markExistingMovie(sandbox, onProgress);
    if (sandbox.isCoverageMet() && !request.qualityUpgrade) {
      emit(onProgress, "finish", {});
      const coverage = await sandbox.finish();
      return { text: "规则选片：目标目录已有正片，无需转存", steps: 1, coverage };
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
  let selection = selectWithWords(candidates, target, policy, words);
  const confidenceInput = {
    target,
    selection,
    candidateCount: candidates.length,
    ...(words && words.length > 0 ? { customWords: words } : {}),
  };
  // High-confidence empty (hard quality floor) must NOT probe opaque shares —
  // 115 has no listing-without-transfer, so probe would 转存偷看, then finish
  // with leftover staging and the wrap-up delete hung the UI on 「正在收尾」.
  const preProbeConfidence = assessRulesConfidence(confidenceInput);
  const skipOpaqueProbe =
    target.kind === "tv" && selection.selected.length === 0 && preProbeConfidence.confidence === "high";
  const probe =
    target.kind === "tv" && !skipOpaqueProbe
      ? await probeOpaqueTvShares({
          sandbox,
          candidates,
          target,
          policy,
          words,
          titleMapped: selection.eligible ?? selection.selected,
          ...(onProgress ? { onProgress } : {}),
        })
      : { overrides: new Map<string, string[]>(), transferredIds: new Set<string>(), transferredFiles: new Map<string, string[]>() };
  if (probe.overrides.size > 0) {
    selection = selectWithWords(candidates, target, policy, words, probe.overrides);
    const selectedIds = new Set(selection.selected.map((candidate) => candidate.candidateId));
    for (const [candidateId, fileIds] of probe.transferredFiles) {
      if (selectedIds.has(candidateId) || fileIds.length === 0) {
        continue;
      }
      await asEvidence(() => sandbox.deleteFiles({ directory: "staging", fileIds }));
      probe.transferredIds.delete(candidateId);
    }
  }
  const didProbe = selection.selected.some((candidate) => candidate.coverageSource === "probe");
  const reasonExtras = { gapResearch: didGapResearch, ...(didProbe ? { probe: true as const } : {}) };

  if (request.escalateOnLowConfidence) {
    const report = assessRulesConfidence({
      ...confidenceInput,
      selection,
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
    // Probe (115 staging-peek) may have left files; wipe them before finish so
    // wrap-up delete cannot pin the UI on 「正在收尾」. Floor-empty skips probe,
    // so skip this extra 115 call — the harness still discards empty staging.
    if (target.kind === "tv" && !skipOpaqueProbe) {
      emit(onProgress, "discardStaging", {});
      await asEvidence(() => withTimeout(sandbox.discardStaging(), POST_FINISH_IO_TIMEOUT_MS));
    }
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
        .some((file) => shouldReplaceLanded(file.path, best.title, policy, words));
      if (!anyUpgrade) {
        emit(onProgress, "finish", {});
        const coverage = await sandbox.finish();
        return { text: "规则选片：已入库画质不低于候选，跳过升级", steps: 1, coverage };
      }
    }
  }

  if (request.qualityUpgrade && target.kind === "tv") {
    const existingTitles: string[] = [];
    for (const season of target.seasons ?? []) {
      const existing = await asEvidence(() => sandbox.inspectTargetDir({ season }));
      if (Array.isArray(existing)) {
        existingTitles.push(...existing.filter((file) => file.isVideo).map((file) => file.path));
      }
    }
    if (existingTitles.length > 0) {
      const candidateTitles = selection.selected.map((candidate) => candidate.title);
      if (!anyLandedUpgrade(existingTitles, candidateTitles, policy, words)) {
        emit(onProgress, "discardStaging", {});
        await asEvidence(() => sandbox.discardStaging());
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
    ...(probe.transferredIds.size > 0 ? { alreadyTransferred: probe.transferredIds } : {}),
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
  const marked = transfer.landed
    ? await organizeTv({
        sandbox,
        seasons: target.seasons ?? [1],
        remainingNeed: sandbox.remainingNeed(),
        qualityUpgrade: request.qualityUpgrade === true,
        policy,
        ...(onProgress ? { onProgress } : {}),
        ...(words && words.length > 0 ? { words } : {}),
      })
    : [];
  if (marked.length > 0) {
    emit(onProgress, "markObtained", { codes: marked });
    await sandbox.markObtained({ codes: marked });
  } else {
    await asEvidence(() => sandbox.reportNoCoverage(tvReason));
    emit(onProgress, "reportNoCoverage", { reason: tvReason });
  }
  emit(onProgress, "discardStaging", {});
  await asEvidence(() => withTimeout(sandbox.discardStaging(), POST_FINISH_IO_TIMEOUT_MS));
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
