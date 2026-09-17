import type { WorkflowRepository } from "../repository.js";
import { phaseProgress, type AgentToolEvent } from "./activity.js";

const PICK_REASON_CODES = new Set([
  "below-quality-floor",
  "no-episode-coverage",
  "redundant-coverage",
  "no-candidates",
  "media-id-mismatch",
  "empty-selection",
  "sequel-or-year",
]);

const SEARCH_KEYWORDS_CAP = 12;

type PickRejectGroup = { reason: string; count: number };

function stringList(value: unknown, cap: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    const text = String(item ?? "").replace(/\s+/g, " ").trim();
    if (text) {
      out.push(text);
    }
    if (out.length >= cap) {
      break;
    }
  }
  return out;
}

function parseRejectGroups(value: unknown): PickRejectGroup[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: PickRejectGroup[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const rec = row as Record<string, unknown>;
    const reason = typeof rec.reason === "string" ? rec.reason.trim() : "";
    const count = typeof rec.count === "number" ? rec.count : 0;
    if (reason && count > 0) {
      out.push({ reason, count });
    }
    if (out.length >= 4) {
      break;
    }
  }
  return out;
}

function rememberKeyword(list: string[], keyword: string): string[] {
  const next = [...list.filter((item) => item !== keyword), keyword];
  return next.length > SEARCH_KEYWORDS_CAP ? next.slice(-SEARCH_KEYWORDS_CAP) : next;
}

function pickReasonFromEvent(event: AgentToolEvent): string | null {
  const coded = event.args.pickReason;
  if (typeof coded === "string" && PICK_REASON_CODES.has(coded)) {
    return coded;
  }
  const listed = Array.isArray(event.args.reasons)
    ? event.args.reasons.map((value) => String(value))
    : [];
  for (const reason of listed) {
    if (PICK_REASON_CODES.has(reason)) {
      return reason;
    }
  }
  const blob = `${String(event.args.reason ?? "")} ${event.activity}`;
  if (blob.includes("画质下限") || blob.includes("BELOW_QUALITY_FLOOR") || blob.includes("below-quality-floor")) {
    return "below-quality-floor";
  }
  if (blob.includes("no-episode-coverage")) {
    return "no-episode-coverage";
  }
  if (blob.includes("media-id-mismatch") || blob.includes("对不上这部")) {
    return "media-id-mismatch";
  }
  if (blob.includes("没有返回候选") || blob.includes("no-candidates")) {
    return "no-candidates";
  }
  return null;
}

/**
 * Build the per-tool-call progress sink the runner wires into the agent loop. It
 * turns each real tool event into a monotonic, phase-weighted progress write on
 * the run (for the activity page). Fire-and-forget + error-swallowing: a progress
 * write must NEVER throw and fail an otherwise-good acquisition.
 *
 * `neededHint` (the run's missing-episode count) lets the mark phase show a real
 * obtained/needed fraction. For every other phase the bar advances WITHIN the band
 * by an asymptotic step-count fraction (n/(n+2)) — so a long phase (several searches
 * / transfer retries) creeps forward instead of freezing at the midpoint, while
 * never escaping the band. `obtained` accumulates across markObtained calls (the
 * MOVIE sentinel is not an episode and is not counted).
 */
export function makeProgressSink(input: {
  repository: Pick<WorkflowRepository, "updateWorkflowRunProgress">;
  workflowRunId: string;
  neededHint?: number;
  now?: () => string;
}): (event: AgentToolEvent) => void {
  const now = input.now ?? (() => new Date().toISOString());
  const needed = input.neededHint ?? 0;
  let percent = 0;
  let obtained = 0;
  // Track how many tool calls the agent has made in the CURRENT phase, so the bar
  // creeps forward within a long phase (e.g., several searches / transfer retries)
  // instead of freezing at the band midpoint — it should reflect ongoing work.
  let currentPhase: AgentToolEvent["phase"] | null = null;
  let stepsInPhase = 0;
  // Sticky display facts: `finish` rewrites activity to 「正在收尾」, but the UI
  // still needs to know 选片 ended with no_coverage / transfer was skipped.
  let noCoverage = false;
  let skippedTransfer = false;
  let searchCount = 0;
  let shareCount = 0;
  let currentKeyword = "";
  let searchTotal = 0;
  let candidateCount: number | null = null;
  let pickReason = "";
  let searchKeywords: string[] = [];
  let pickRejectGroups: PickRejectGroup[] = [];
  let pickExamples: string[] = [];
  let transferTitle = "";
  let transferEpisodes: string[] = [];
  let skippedDuplicates: number | null = null;

  return (event: AgentToolEvent) => {
    if (event.toolName === "markObtained") {
      const codes = Array.isArray(event.args.codes) ? event.args.codes : [];
      obtained += codes.filter((code) => code !== "MOVIE").length;
    }
    if (event.toolName === "searchResources") {
      searchCount += 1;
      const keyword = String(event.args.keyword ?? "").trim();
      if (keyword) {
        currentKeyword = keyword;
        searchKeywords = rememberKeyword(searchKeywords, keyword);
      }
      if (typeof event.args.searchTotal === "number" && event.args.searchTotal > 0) {
        searchTotal = event.args.searchTotal;
      }
    }
    if (event.toolName === "transferCandidate" || event.toolName === "transferUntilLanded") {
      const title = String(event.args.title ?? "").replace(/\s+/g, " ").trim();
      if (title) {
        transferTitle = title;
      }
      const episodes = stringList(event.args.episodes, 8);
      if (episodes.length > 0) {
        transferEpisodes = episodes;
      }
    }
    if (typeof event.args.skippedDuplicates === "number" && event.args.skippedDuplicates >= 0) {
      skippedDuplicates = event.args.skippedDuplicates;
    }
    const nextGroups = parseRejectGroups(event.args.rejectGroups);
    if (nextGroups.length > 0) {
      pickRejectGroups = nextGroups;
    }
    const nextExamples = stringList(event.args.rejectExamples, 3);
    if (nextExamples.length > 0) {
      pickExamples = nextExamples;
    }
    if (event.toolName === "reportNoCoverage" || event.activity.includes("未找到可用资源")) {
      noCoverage = true;
    }
    if (
      event.activity.includes("画质下限") ||
      event.activity.includes("跳过转存") ||
      String(event.args.error ?? event.args.refused ?? "").includes("BELOW_QUALITY_FLOOR")
    ) {
      skippedTransfer = true;
    }
    const argShare = event.args.shareCount;
    if (typeof argShare === "number" && argShare > 0) {
      shareCount = argShare;
    }
    if (typeof event.args.candidateCount === "number" && event.args.candidateCount >= 0) {
      candidateCount = event.args.candidateCount;
    }
    const nextPick = pickReasonFromEvent(event);
    if (nextPick) {
      pickReason = nextPick;
    }
    if (event.phase !== currentPhase) {
      currentPhase = event.phase;
      stepsInPhase = 0;
    }
    stepsInPhase += 1;
    // The mark phase uses its REAL obtained/needed fraction; every other phase uses
    // an asymptotic step-count fraction n/(n+2) (1st≈0.33, climbing toward — but
    // never reaching — the band end, so it stays honest within the band).
    const subFraction =
      event.phase === "mark" && needed > 0 ? obtained / needed : stepsInPhase / (stepsInPhase + 2);
    percent = Math.max(percent, phaseProgress(event.phase, subFraction));
    void Promise.resolve(
      input.repository.updateWorkflowRunProgress(input.workflowRunId, {
        activity: event.activity,
        phase: event.phase,
        percent,
        updatedAt: now(),
        ...(needed > 0 ? { obtained, needed } : {}),
        ...(noCoverage ? { noCoverage: true } : {}),
        ...(skippedTransfer ? { skippedTransfer: true } : {}),
        ...(searchCount > 0 ? { searchCount } : {}),
        ...(shareCount > 0 ? { shareCount } : {}),
        ...(currentKeyword ? { currentKeyword } : {}),
        ...(searchTotal > 0 ? { searchTotal } : {}),
        ...(candidateCount !== null ? { candidateCount } : {}),
        ...(pickReason ? { pickReason } : {}),
        ...(searchKeywords.length > 0 ? { searchKeywords } : {}),
        ...(pickRejectGroups.length > 0 ? { pickRejectGroups } : {}),
        ...(pickExamples.length > 0 ? { pickExamples } : {}),
        ...(transferTitle ? { transferTitle } : {}),
        ...(transferEpisodes.length > 0 ? { transferEpisodes } : {}),
        ...(skippedDuplicates !== null ? { skippedDuplicates } : {}),
      }),
    ).catch(() => {
      // Progress is a display nicety; never let its write failure surface.
    });
  };
}
