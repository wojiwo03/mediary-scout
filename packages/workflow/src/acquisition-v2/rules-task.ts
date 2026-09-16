import { episodeCodeFromFileName } from "../episode-code.js";
import type { AcquisitionAgentResult } from "./agent-loop.js";
import { interpretTool, type AgentToolEvent } from "./activity.js";
import type { QualityLadderPolicy } from "./quality-ladder.js";
import { shouldReplaceCoverage } from "./quality-ladder.js";
import type { TaskSandbox } from "./sandbox.js";
import {
  selectResourceCandidates,
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
  onProgress?: (event: AgentToolEvent) => void;
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
  const out: RulesSelectorCandidate[] = [];
  const seen = new Set<string>();
  for (const snapshot of sandbox.listObservedSnapshots()) {
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

function inferEpisodeCode(path: string, fallbackSeason: number | undefined, allowedSeasons: readonly number[]): string | null {
  const name = path.split("/").at(-1) ?? path;
  const parsed = episodeCodeFromFileName(name);
  if (parsed) {
    const season = Number(/^S(\d+)/.exec(parsed)?.[1] ?? 0);
    if (allowedSeasons.length === 0 || allowedSeasons.includes(season)) {
      return parsed;
    }
    return null;
  }
  if (fallbackSeason === undefined || allowedSeasons.length !== 1) {
    return null;
  }
  const bare = /(?:^|[^\d])(\d{2,3})(?:v\d+)?\.(mkv|mp4|ts|m2ts|avi)$/i.exec(name);
  if (!bare) {
    return null;
  }
  const episode = Number(bare[1]);
  if (episode < 1 || episode > 2000) {
    return null;
  }
  return `S${String(fallbackSeason).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

async function transferRanked(
  sandbox: TaskSandbox,
  selected: RankedRulesCandidate[],
  movie: boolean,
  onProgress?: (event: AgentToolEvent) => void,
): Promise<{ systemicBlock?: string; landed: boolean }> {
  if (selected.length === 0) {
    return { landed: false };
  }
  if (movie) {
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

  for (const candidate of selected) {
    emit(onProgress, "transferCandidate", { snapshotId: candidate.snapshotId, candidateId: candidate.candidateId });
    const result = await asEvidence(() =>
      sandbox.transferCandidate({ snapshotId: candidate.snapshotId, candidateId: candidate.candidateId }),
    );
    if (result && typeof result === "object" && "error" in result) {
      continue;
    }
    if (result && typeof result === "object" && "systemicBlock" in result && result.systemicBlock) {
      return { systemicBlock: result.systemicBlock.reason, landed: false };
    }
  }
  const staging = await asEvidence(() => sandbox.inspectStaging());
  const landed = Array.isArray(staging) && staging.some((file) => file.isVideo);
  return { landed };
}

async function organizeTv(sandbox: TaskSandbox, seasons: readonly number[], onProgress?: (event: AgentToolEvent) => void): Promise<string[]> {
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
    const code = inferEpisodeCode(file.path, fallback, allowed);
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

async function markExistingTv(sandbox: TaskSandbox, seasons: readonly number[], missing: readonly string[], onProgress?: (event: AgentToolEvent) => void): Promise<void> {
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
      const code = inferEpisodeCode(file.path, season, [season]);
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

async function maybeReplaceOldMovieFiles(sandbox: TaskSandbox, candidateTitle: string, policy: QualityLadderPolicy): Promise<void> {
  const files = await sandbox.inspectTargetDir();
  const videos = files.filter((file) => file.isVideo);
  const worse = videos.filter((file) => shouldReplaceCoverage(file.path, candidateTitle, policy));
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

export async function runRulesAcquisition(request: RunRulesAcquisitionRequest): Promise<AcquisitionAgentResult> {
  const { sandbox, target } = request;
  const policy = request.policy ?? {};
  const onProgress = request.onProgress;
  emit(onProgress, "rulesSelectCandidates", { mode: "rules" });

  if (target.kind === "tv" && (target.seasons?.length ?? 0) > 0) {
    await markExistingTv(sandbox, target.seasons ?? [], target.missingEpisodes ?? [], onProgress);
    if (sandbox.isCoverageMet() && !request.qualityUpgrade) {
      emit(onProgress, "finish", {});
      const coverage = await sandbox.finish();
      return { text: "规则选片：目标目录已有缺集，无需转存", steps: 1, coverage };
    }
  }

  let candidates = snapshotsToCandidates(sandbox);
  if (candidates.length === 0 || selectResourceCandidates({ candidates, target, policy }).selected.length === 0) {
    await searchAliases(sandbox, target, onProgress);
    candidates = snapshotsToCandidates(sandbox);
  }

  emit(onProgress, "viewResourceSnapshot", {});
  const selection = selectResourceCandidates({ candidates, target, policy });
  emit(onProgress, "rulesSelectCandidates", {
    selected: selection.selected.map((candidate) => candidate.candidateId),
    reason: selection.reason,
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
        .some((file) => shouldReplaceCoverage(file.path, best.title, policy));
      if (!anyUpgrade) {
        emit(onProgress, "finish", {});
        const coverage = await sandbox.finish();
        return { text: "规则选片：已入库画质不低于候选，跳过升级", steps: 1, coverage };
      }
    }
  }

  const transfer = await transferRanked(sandbox, selection.selected, target.kind === "movie", onProgress);
  if (transfer.systemicBlock) {
    emit(onProgress, "finish", {});
    const coverage = await sandbox.finish();
    return { text: `转存系统故障：${transfer.systemicBlock}`, steps: 1, coverage };
  }

  if (target.kind === "movie") {
    emit(onProgress, "flattenMovie", {});
    await asEvidence(() => sandbox.flattenMovie());
    emit(onProgress, "inspectStaging", {});
    const files = await asEvidence(() => sandbox.inspectStaging());
    const videos = Array.isArray(files) ? files.filter((file) => file.isVideo) : [];
    if (videos.length > 0) {
      if (request.qualityUpgrade) {
        await maybeReplaceOldMovieFiles(sandbox, selection.selected[0]!.title, policy);
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

  const marked = await organizeTv(sandbox, target.seasons ?? [1], onProgress);
  if (marked.length > 0) {
    emit(onProgress, "markObtained", { codes: marked });
    await sandbox.markObtained({ codes: marked });
  } else if (!transfer.landed) {
    const reason = selection.reason;
    await asEvidence(() => sandbox.reportNoCoverage(reason));
    emit(onProgress, "reportNoCoverage", { reason });
  }
  emit(onProgress, "discardStaging", {});
  await asEvidence(() => sandbox.discardStaging());
  emit(onProgress, "finish", {});
  const coverage = await sandbox.finish();
  return { text: selection.reason, steps: 1, coverage };
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
