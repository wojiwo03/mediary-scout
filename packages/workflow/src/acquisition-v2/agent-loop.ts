import { generateText, stepCountIs, type LanguageModel, type ToolSet } from "ai";
import { z } from "zod";
import type { TaskSandbox } from "./sandbox.js";
import { readSkillSection, SKILL_SECTION_NAMES } from "./skill.js";
import {
  DEFAULT_MAX_STEPS,
  buildRepetitionStop,
  buildSystemicBlockStop,
  buildFinishStop,
  buildNoCoverageStop,
  prepareStepSystemOverride,
} from "./agent-loop-guards.js";
import { interpretTool, type AgentToolEvent } from "./activity.js";
import {
  candidatesFromSnapshots,
  MAX_TV_TRANSFERS_PER_RUN,
  transferAttemptSucceeded,
} from "./cover-planner.js";
import { mapTvCoverageFromListing, pickOpaqueProbeCandidates } from "./listing-coverage.js";
import { mapTvCoverage, planTvCover, type RulesSelectorTarget } from "./rules-selector.js";
import type { QualityLadderPolicy } from "./quality-ladder.js";

/**
 * Phase 3 — the agent loop harness. The strong agent drives its own
 * observe-act-verify loop through the sandbox tools; the system only orchestrates
 * the AI SDK tool-loop and feeds each tool's result (which the sandbox already
 * force-rereads) straight back into the model context. The sandbox stays the
 * permission cage: every guard refusal comes back to the model as `{ error }`
 * text it must read and adapt to — never a crash that aborts the loop.
 */

/** Wrap a sandbox call so a guard refusal becomes evidence, not an exception. */
async function asEvidence(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return await run();
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Opt-in observability (MEDIA_TRACK_AGENT_LOG=1): log every sandbox tool call the
 * agent makes — the keyword it searches, the candidate it transfers, what it
 * moves/marks, and the evidence that comes back. Off by default (silent in
 * tests); turned on for live e2e so the agent loop is not a black box.
 */
/**
 * Wrap every tool's execute so each call can (a) emit a cleaned progress event for
 * the activity page (always, when `onToolCall` is given) and (b) log the raw
 * call/result to stdout (opt-in via MEDIA_TRACK_AGENT_LOG=1). The wrapper is a
 * passthrough when neither is active. The progress emit is best-effort — a throw
 * in `onToolCall` must never break the agent's tool execution.
 */
function wrapTools(
  tools: ToolSet,
  options: { onToolCall?: (toolName: string, args: Record<string, unknown>) => void; log: boolean },
): ToolSet {
  if (!options.onToolCall && !options.log) {
    return tools;
  }
  const wrapped: Record<string, unknown> = {};
  for (const [name, tool] of Object.entries(tools)) {
    const execute = (tool as { execute: (args: unknown, options: unknown) => Promise<unknown> }).execute;
    wrapped[name] = {
      ...(tool as object),
      execute: async (args: unknown, executeOptions: unknown) => {
        if (options.onToolCall) {
          try {
            options.onToolCall(name, (args && typeof args === "object" ? args : {}) as Record<string, unknown>);
          } catch {
            // progress is a display nicety — never let it break a tool call
          }
        }
        if (options.log) {
          const argStr =
            args && typeof args === "object" && Object.keys(args).length > 0
              ? ` ${JSON.stringify(args).slice(0, 240)}`
              : "";
          console.log(`[agent] → ${name}${argStr}`);
        }
        const result = await execute(args, executeOptions);
        if (options.log) {
          console.log(`[agent] ← ${name}: ${JSON.stringify(result).slice(0, 400)}`);
        }
        return result;
      },
    };
  }
  return wrapped as ToolSet;
}

export interface CoverPlanContext {
  target: RulesSelectorTarget;
  policy?: QualityLadderPolicy;
  customIdentifierWords?: readonly string[];
}

interface LastCoverPlan {
  selectedIds: string[];
  redundantIds: string[];
}

class AgentCoverSession {
  readonly exclude = new Set<string>();
  readonly used = new Set<string>();
  readonly covered = new Set<string>();
  lastPlan: LastCoverPlan | null = null;
  private readonly probedCoverage = new Map<string, string[]>();
  private probesStarted = false;

  constructor(
    private readonly sandbox: TaskSandbox,
    private readonly context: CoverPlanContext,
  ) {}

  remainingMissing(): string[] {
    const marked = this.sandbox.remainingNeed();
    return marked.filter((code) => !this.covered.has(code));
  }

  private coverageFor(title: string, candidateId: string, remaining: readonly string[]): string[] {
    const probed = this.probedCoverage.get(candidateId);
    if (probed) {
      return probed.filter((code) => remaining.includes(code));
    }
    return mapTvCoverage({
      title,
      seasons: this.context.target.seasons ?? [1],
      missingEpisodes: [...remaining],
      ...(this.context.customIdentifierWords && this.context.customIdentifierWords.length > 0
        ? { customWords: this.context.customIdentifierWords }
        : {}),
    });
  }

  /**
   * Listing-only opaque probe (planEpisodeCover is documented read-only).
   * Staging-transfer fallback stays on the rules worker, not the Agent tool.
   */
  private async ensureListingProbes(): Promise<void> {
    if (this.probesStarted || this.context.target.kind !== "tv") {
      return;
    }
    this.probesStarted = true;
    const remaining = this.remainingMissing();
    if (remaining.length === 0) {
      return;
    }
    const candidates = candidatesFromSnapshots(this.sandbox.listObservedSnapshots());
    const first = planTvCover({
      candidates,
      target: this.context.target,
      ...(this.context.policy ? { policy: this.context.policy } : {}),
      ...(this.context.customIdentifierWords && this.context.customIdentifierWords.length > 0
        ? { customIdentifierWords: this.context.customIdentifierWords }
        : {}),
      remainingMissing: remaining,
    });
    const picks = pickOpaqueProbeCandidates({
      candidates,
      target: { ...this.context.target, missingEpisodes: remaining },
      ...(this.context.policy ? { policy: this.context.policy } : {}),
      ...(this.context.customIdentifierWords && this.context.customIdentifierWords.length > 0
        ? { customWords: this.context.customIdentifierWords }
        : {}),
      titleMapped: first.selection.eligible ?? first.selection.selected,
    });
    const seasons = this.context.target.seasons ?? [1];
    const words = this.context.customIdentifierWords;
    for (const candidate of picks) {
      const listing = await this.sandbox.listCandidateListing(candidate.candidateId);
      if (!listing) {
        continue;
      }
      const covered = mapTvCoverageFromListing({
        paths: listing.map((row) => row.path),
        seasons,
        missingEpisodes: remaining,
        ...(words && words.length > 0 ? { customWords: words } : {}),
      });
      this.probedCoverage.set(candidate.candidateId, covered);
    }
  }

  async plan(gapRound = 0) {
    await this.ensureListingProbes();
    const remaining = this.remainingMissing();
    const result = planTvCover({
      candidates: candidatesFromSnapshots(this.sandbox.listObservedSnapshots()),
      target: this.context.target,
      ...(this.context.policy ? { policy: this.context.policy } : {}),
      ...(this.context.customIdentifierWords && this.context.customIdentifierWords.length > 0
        ? { customIdentifierWords: this.context.customIdentifierWords }
        : {}),
      excludeIds: new Set([...this.exclude, ...this.used]),
      remainingMissing: remaining,
      gapRound,
      ...(this.probedCoverage.size > 0 ? { coverageOverrides: this.probedCoverage } : {}),
    });
    this.lastPlan = {
      selectedIds: result.selection.selected.map((candidate) => candidate.candidateId),
      redundantIds: result.redundantCandidateIds,
    };
    const transfersLeft = this.sandbox.tvTransfersRemaining();
    const finiteLeft = Number.isFinite(transfersLeft) ? transfersLeft : MAX_TV_TRANSFERS_PER_RUN;
    return {
      selected: result.selection.selected.map((candidate) => ({
        snapshotId: candidate.snapshotId,
        candidateId: candidate.candidateId,
        title: candidate.title,
        coveredEpisodes: candidate.coveredEpisodes,
      })),
      uncovered: result.uncovered,
      gapQueries: result.gapQueries,
      redundantCandidateIds: result.redundantCandidateIds,
      reason: result.selection.reason,
      maxTransfers: MAX_TV_TRANSFERS_PER_RUN,
      transfersLeft: finiteLeft,
      note:
        "按 selected 转存，不要改选 redundantCandidateIds（重叠、不补新缺集）。转失败则再调用 planEpisodeCover 换备选。" +
        (result.uncovered.length > 0
          ? ` 仍缺集时最多按 gapQueries 补搜 ${result.gapQueries.length} 条，然后重新规划。本轮转存上限 ${MAX_TV_TRANSFERS_PER_RUN}，超出留给巡检。`
          : ` 本轮转存上限 ${MAX_TV_TRANSFERS_PER_RUN}，超出留给巡检。`),
    };
  }

  guardTransfer(candidateId: string): string | null {
    if (this.used.has(candidateId) || this.exclude.has(candidateId)) {
      return "SANDBOX_REDUNDANT_COVERAGE: 已转存或已失败的分享不要重转。请再次 planEpisodeCover 换备选。";
    }
    if (!this.lastPlan) {
      return null;
    }
    if (this.lastPlan.selectedIds.includes(candidateId)) {
      return null;
    }
    if (this.lastPlan.redundantIds.includes(candidateId)) {
      return "SANDBOX_REDUNDANT_COVERAGE: 该分享与规划集合重叠、不补新缺集。请按 planEpisodeCover 的 selected 转存；转失败则再调用 planEpisodeCover。";
    }
    const remaining = new Set(this.remainingMissing());
    const snapshots = this.sandbox.listObservedSnapshots();
    const found = snapshots.flatMap((snapshot) =>
      snapshot.candidates
        .filter((candidate) => candidate.id === candidateId)
        .map((candidate) => ({ title: candidate.title })),
    )[0];
    if (!found) {
      return null;
    }
    const covered = this.coverageFor(found.title, candidateId, [...remaining]);
    if (covered.length === 0) {
      return "SANDBOX_REDUNDANT_COVERAGE: 该分享不覆盖仍缺集。请按 planEpisodeCover 的 selected 转存，或先补搜后再规划。";
    }
    return null;
  }

  noteAttempt(candidateId: string, result: unknown): void {
    if (transferAttemptSucceeded(result)) {
      this.used.add(candidateId);
      const snapshots = this.sandbox.listObservedSnapshots();
      const found = snapshots.flatMap((snapshot) =>
        snapshot.candidates.filter((candidate) => candidate.id === candidateId).map((candidate) => candidate.title),
      )[0];
      if (found) {
        const remaining = this.context.target.missingEpisodes ?? this.sandbox.remainingNeed();
        for (const code of this.coverageFor(found, candidateId, remaining)) {
          this.covered.add(code);
        }
      }
    } else if (!result || typeof result !== "object" || !("systemicBlock" in result && (result as { systemicBlock?: unknown }).systemicBlock)) {
      if (result && typeof result === "object" && "error" in result) {
        const message = String((result as { error: unknown }).error);
        if (message.includes("SANDBOX_REDUNDANT") || message.includes("SANDBOX_TRANSFER_CAP") || message.includes("SANDBOX_COVERAGE")) {
          return;
        }
      }
      this.exclude.add(candidateId);
    }
  }
}
export function buildSandboxToolSet(
  sandbox: TaskSandbox,
  options: {
    movie?: boolean;
    /** When true, register viewSubtitleSnapshot + transferSubtitle (the "tool
     *  exists = this run needs subtitles" signal). Set by the orchestrator only
     *  when assrtToken is configured AND the title is non-CN AND the executor
     *  can land external subtitle urls (transferSubtitleUrl capability probe —
     *  today 115; any brand lights up by implementing the method). */
    subtitle?: boolean;
    onToolCall?: (toolName: string, args: Record<string, unknown>) => void;
    /** The run's drive brand — selects the brand-specific dead-links section. */
    storageProvider?: string;
    /** TV/anime: shared complementary-cover planner (same greedyCover as rules). */
    coverPlan?: CoverPlanContext;
  } = {},
): ToolSet {
  const coverSession = options.coverPlan && !options.movie ? new AgentCoverSession(sandbox, options.coverPlan) : null;
  const tools: Record<string, unknown> = {
    readSkill: {
      description:
        // Section list derived from SKILL_SECTION_NAMES — the single source of
        // truth — so adding a section can never leave this description stale.
        `Read a section of your domain skill manual ON DEMAND — the hard-won playbook for HOW to act. Sections: ${SKILL_SECTION_NAMES.join(", ")}. Read your sections before you act, and re-read the relevant one the moment its situation arises. Acting from memory instead of the skill is how the old agent hammered the drive and corrupted libraries.`,
      inputSchema: z.object({ section: z.string() }),
      execute: (args: { section: string }) =>
        Promise.resolve({ section: args.section, body: readSkillSection(args.section, options.storageProvider) }),
    },
    viewResourceSnapshot: {
      description:
        "View the system's pre-warmed raw snapshot (活期文档). Read-only, free, repeatable — does NOT consume search budget. The system already searched the raw keyword (bare title) for you; this returns all those candidates (id + title). Use this FIRST to see what's available. Do NOT use searchResources to re-search the raw keyword — searchResources is ONLY for 繁体/英文 upgrades when the raw snapshot is insufficient.",
      inputSchema: z.object({}),
      execute: () => Promise.resolve(sandbox.viewResourceSnapshot()),
    },
    searchResources: {
      description:
        "Search the resource provider with ONE keyword. Read-only. Returns the full snapshot of candidates (no slicing). Repeats are deduped; the search budget is capped — decide from gathered evidence when refused. NOTE: raw keyword already pre-searched (see viewResourceSnapshot). Use searchResources ONLY for 繁体/英文/原名 upgrades.",
      inputSchema: z.object({ keyword: z.string() }),
      execute: (args: { keyword: string }) => asEvidence(() => sandbox.searchResources(args.keyword)),
    },
    inspectStaging: {
      description: "Read-only: the full raw file tree currently in this task's staging. Judge identity/dupes/extras from these real files.",
      inputSchema: z.object({}),
      execute: () => asEvidence(() => sandbox.inspectStaging()),
    },
    inspectTargetDir: {
      description:
        "Read-only ground truth for what has landed. Pass `season` to see that season's directory (so you know what it already holds before moving/deduping); omit it to see all target seasons at once. Multi-season tasks: check each season here.",
      inputSchema: z.object({ season: z.number().int().positive().optional() }),
      execute: (args: { season?: number }) => asEvidence(() => sandbox.inspectTargetDir(args)),
    },
    transferCandidate: {
      description:
        "Transfer ONE snapshot-bound candidate into staging, then read back the TRUE materialized files. The candidate must come from a snapshot you searched this task. Refused once coverage is already met. TV/anime: transfer the planEpisodeCover selected set; redundant overlaps are refused. Below the run's hard quality floor (SANDBOX_BELOW_QUALITY_FLOOR) is refused even if it is the only candidate.",
      inputSchema: z.object({ snapshotId: z.string(), candidateId: z.string() }),
      execute: async (args: { snapshotId: string; candidateId: string }) => {
        if (coverSession) {
          const blocked = coverSession.guardTransfer(args.candidateId);
          if (blocked) {
            return { error: blocked };
          }
        }
        const result = await asEvidence(() => sandbox.transferCandidate(args));
        coverSession?.noteAttempt(args.candidateId, result);
        return result;
      },
    },
    moveToSeason: {
      description:
        "Submit your WHOLE distribution plan in ONE call: `{moves:[{season,fileIds},...]}` — which files go into which season's directory. Each video's SUBTITLES go in the SAME season's fileIds (never leave subtitles behind — they must land beside their video). Move ONLY still-missing episodes; never recopy a season the library already has. A movie move OMITS `season` (the file lands in the movie directory). Returns every touched season dir + the remaining staging so you verify the whole distribution at once and fix any misplacement with another call. Every fileId must currently be in staging.",
      inputSchema: z.object({
        moves: z.array(z.object({ season: z.number().int().positive().optional(), fileIds: z.array(z.string()) })),
      }),
      execute: (args: { moves: Array<{ season?: number; fileIds: string[] }> }) =>
        asEvidence(() => sandbox.moveToSeason(args)),
    },
    deleteFiles: {
      description:
        "Delete files you confirmed (dedup keep-larger, or residue) from a named scoped directory. For directory='season' on a multi-season task, pass `season` to name which season's dir. Every id must currently be in that directory. Rereads it.",
      inputSchema: z.object({
        directory: z.enum(["staging", "season"]),
        season: z.number().int().positive().optional(),
        fileIds: z.array(z.string()),
      }),
      execute: (args: { directory: "staging" | "season"; season?: number; fileIds: string[] }) =>
        asEvidence(() => sandbox.deleteFiles(args)),
    },
    flattenMovie: {
      description:
        'Movie only — AUTOMATIC: pull every video AND subtitle file out of the resource wrapper(s) up into the movie directory and remove the wrappers, in one call (no file selection — a movie is one film, take it all, subtitles included). Then delete any extras (trailers/花絮) with deleteFiles and markObtained(["MOVIE"]).',
      inputSchema: z.object({}),
      execute: () => asEvidence(() => sandbox.flattenMovie()),
    },
    discardStaging: {
      description:
        "TV/anime clean-up, your final step: after every needed episode (with its subtitles) is moved into its season directory and marked, wipe the WHOLE staging directory — leftovers you didn't need are discarded. You may only delete your own staging (never a season/show/root dir).",
      inputSchema: z.object({}),
      execute: () => asEvidence(() => sandbox.discardStaging()),
    },
    markObtained: {
      description:
        "Your FINAL action: declare the episode codes you have obtained (e.g. [\"S01E13\"], or [\"MOVIE\"] for a film). Do this LAST — only after you have moved the files into the target dir, flattened the wrapper, and confirmed from your inspect that the real films are in place. Pure agent judgment: no fileId, the system does not re-read to second-guess you. MOVIE last-resort fallback: if you landed a raw-name match of the correct film WITHOUT a confirmed 中文 sub track (中字 budget exhausted), pass subtitleFallback:true so the system flags 可能无中文字幕.",
      inputSchema: z.object({ codes: z.array(z.string()), subtitleFallback: z.boolean().optional() }),
      execute: (args: { codes: string[]; subtitleFallback?: boolean }) =>
        asEvidence(() => sandbox.markObtained(args)),
    },
    finish: {
      description:
        "Declare the task done. Returns the honest coverage summary (what is obtained, what remains). TERMINAL: a successful finish ENDS the task immediately — do all clean-up BEFORE calling it, and never call it twice.",
      inputSchema: z.object({}),
      execute: () => asEvidence(() => sandbox.finish()),
    },
    reportNoCoverage: {
      description:
        "Honestly report you cannot cover the target. Valid only after a real search ran; backs the report with real provider evidence. TERMINAL: a successful report ENDS the task immediately — do NOT call finish after it, and do NOT report twice.",
      inputSchema: z.object({ reason: z.string() }),
      execute: (args: { reason: string }) => asEvidence(() => sandbox.reportNoCoverage(args.reason)),
    },
  };
  if (coverSession) {
    tools["planEpisodeCover"] = {
      description:
        "TV/anime complementary-cover planner (same greedyCover the rules path uses). Free, read-only. May list share contents for a few high-confidence opaque titles (剧名 第一季 / no episode span) when the drive exposes listing without transfer — never a lucky-dip transfer. Returns the fewest shares that cover remaining missing episodes, leftover holes, and bounded gapQueries for 补搜. Call AFTER viewResourceSnapshot (and after a failed transfer / 补搜) BEFORE transferring. Transfer ONLY the selected set — redundant overlaps are refused. If uncovered remains, search at most the returned gapQueries, then call again. If a transfer fails, call again to 转失败换备选. If transfersLeft is 0, leave leftovers for patrol.",
      inputSchema: z.object({ gapRound: z.number().int().min(0).max(1).optional() }),
      execute: (args: { gapRound?: number } = {}) => coverSession.plan(args?.gapRound ?? 0),
    };
  }
  if (options.movie) {
    tools["transferUntilLanded"] = {
      description:
        'Movie only. Transfer a PRIORITY-ORDERED list of candidates you judged to be the SAME target film (best resource first), stopping at the FIRST that 秒传-lands; the rest are abandoned. FAIL-LOUD SHARE LINKS ONLY (115/夸克/天翼/123 转存分享 all qualify) — magnets do NOT fail loud, so for a magnet use transferCandidate and verify via inspectStaging. YOU pick the set (a keyword search returns same-named DIFFERENT works — never hand it everything); the system just burns through the dead links for you (链接已过期/分享已取消/错误的链接 are common). Candidates below this run\'s hard quality floor are skipped (not transferred) and recorded as SANDBOX_BELOW_QUALITY_FLOOR. Returns {landed, transferredCandidateId, attempts}. If an attempt reports no_target_change with nothing landed (a large share\'s async server-side copy can outlast the settle window — a possible FALSE miss), the tool STOPS instead of burning the next candidate: re-read via inspectStaging first, then decide. Use this when several shares for the one film may be dead/black-box; for a single obvious share, transferCandidate is fine.',
      inputSchema: z.object({ candidateIds: z.array(z.string()) }),
      execute: (args: { candidateIds: string[] }) => asEvidence(() => sandbox.transferUntilLanded(args)),
    };
  }
  if (options.subtitle) {
    tools["viewSubtitleSnapshot"] = {
      description:
        "View the system's pre-warmed assrt.net subtitle snapshot (活期文档). Read-only, free, repeatable. The system already searched assrt for this title's bare name; this returns the candidate subtitle packages (id + title + language tag, plus community evidence when available: ★vote score / 字幕组 / upload time). THIS TOOL APPEARING IN YOUR TOOLSET means this run needs external Chinese subtitles — read it and pick a package whose language covers your need (简/繁/双语), weighing higher ★ and a known 字幕组 as community-validated quality, then transferSubtitle to land its files.",
      inputSchema: z.object({}),
      execute: () => Promise.resolve(sandbox.viewSubtitleSnapshot()),
    };
    tools["transferSubtitle"] = {
      description:
        "Land a chosen assrt subtitle package's files into staging. Pass the candidateId from viewSubtitleSnapshot. The system resolves the package's filelist (per-episode .ass/.srt with SxxExx filenames) and lands each via the drive's offline-task path. Returns the filenames that landed. Then RENAME each landed subtitle to match its video (same prefix, different extension) — subtitles are the ONLY files you may rename (a documented exception to the keep-original-name rule) so the scraper auto-loads them. Subtitle miss/empty filelist is a SOFT fail — it does NOT block video coverage; just proceed without subtitles.",
      inputSchema: z.object({ candidateId: z.number().int().positive() }),
      execute: (args: { candidateId: number }) =>
        asEvidence(() => sandbox.transferSubtitle({ candidateId: args.candidateId })),
    };
    tools["renameSubtitle"] = {
      description:
        "Rename landed subtitle files to match their videos, in ONE BATCH: decide EVERY subtitle↔episode pairing first (fileIds from inspectStaging), then submit them all as renames:[{fileId,newName},…] — same filename prefix as each episode's video, keep the subtitle extension (video Show.S02E01.mkv → subtitle Show.S02E01.ass; 简/繁 variants keep their .sc/.tc infix). NEVER rename one file per call — at 77 episodes that collapses; the batch is one call regardless of count. Subtitles are the ONLY files you may rename (the documented exception) so the scraper auto-loads them. Per-item guard violations come back in `errors` without aborting the rest. Then move each subtitle into its season with its video via moveToSeason.",
      inputSchema: z.object({
        renames: z.array(z.object({ fileId: z.string(), newName: z.string() })).min(1),
      }),
      execute: (args: { renames: Array<{ fileId: string; newName: string }> }) =>
        asEvidence(() => sandbox.renameSubtitle(args)),
    };
  }
  const toolSet = tools as ToolSet;
  return wrapTools(toolSet, {
    ...(options.onToolCall ? { onToolCall: options.onToolCall } : {}),
    log: process.env.MEDIA_TRACK_AGENT_LOG === "1",
  });
}

export interface AcquisitionAgentRequest {
  sandbox: TaskSandbox;
  model: LanguageModel;
  system: string;
  prompt: string;
  /** Hard ceiling on tool-loop steps. The loop also ends earlier when the model
   *  stops calling tools, or when a stop fires (repetition / systemic block /
   *  successful reportNoCoverage — the terminal no-coverage declaration). */
  maxSteps?: number;
  /** Movie task → expose the movie-only transferUntilLanded tool. */
  movie?: boolean;
  /** When true, register the subtitle tools (viewSubtitleSnapshot + transferSubtitle).
   *  Set by the orchestrator only when the subtitle gates pass. */
  subtitle?: boolean;
  /** The run's drive brand — selects the brand-specific dead-links skill section. */
  storageProvider?: string;
  /** Per-tool-call live progress for the activity page (cleaned activity + phase
   *  + raw name/args). Best-effort; absent in tests/headless. */
  onProgress?: (event: AgentToolEvent) => void;
  /** TV/anime: inject the shared complementary-cover planner tool. */
  coverPlan?: CoverPlanContext;
  /** Cumulative 115 API calls so far (real 115 only). Lets prepareStep inject the
   *  budget soft-warning, the same way it injects the step-cap wind-down. Absent
   *  (fakes/sim) → no budget nudge. */
  apiCallCount?: () => number | undefined;
  /** SOFT-warning threshold, derived from the configured HARD budget upstream
   *  (budgetSoftThreshold). Absent → falls back to BUDGET_SOFT_REMIND_AT. */
  budgetSoftAt?: number;
}

export interface AcquisitionAgentResult {
  /** The model's final free text (after it stopped calling tools). */
  text: string;
  /** Number of loop steps the model took. */
  steps: number;
  /** Final honest coverage picture, read from the sandbox after the loop. */
  coverage: { coverageMet: boolean; obtained: string[]; missing: string[]; subtitleFallback: boolean };
}

function transferTitleFromSandbox(
  sandbox: TaskSandbox,
  args: Record<string, unknown>,
): string | undefined {
  const candidateId = typeof args.candidateId === "string" ? args.candidateId : "";
  const snapshotId = typeof args.snapshotId === "string" ? args.snapshotId : "";
  const fallbackIds = Array.isArray(args.candidateIds) ? args.candidateIds.map(String) : [];
  const want = candidateId || fallbackIds[0] || "";
  if (!want) {
    return undefined;
  }
  const snapshots = sandbox.listObservedSnapshots();
  const scoped = snapshotId ? snapshots.find((snapshot) => snapshot.id === snapshotId) : undefined;
  const pool = scoped ? scoped.candidates : snapshots.flatMap((snapshot) => snapshot.candidates);
  return pool.find((candidate) => candidate.id === want)?.title;
}

/** Run the strong agent's self-driven loop over the sandbox tools. */
export async function runAcquisitionAgent(
  request: AcquisitionAgentRequest,
): Promise<AcquisitionAgentResult> {
  const onProgress = request.onProgress;
  const tools = buildSandboxToolSet(request.sandbox, {
    movie: request.movie ?? false,
    ...(request.subtitle ? { subtitle: true } : {}),
    ...(request.storageProvider === undefined ? {} : { storageProvider: request.storageProvider }),
    ...(request.coverPlan ? { coverPlan: request.coverPlan } : {}),
    ...(onProgress
      ? {
          onToolCall: (toolName: string, args: Record<string, unknown>) => {
            let next = args;
            if (toolName === "transferCandidate" || toolName === "transferUntilLanded") {
              const title = transferTitleFromSandbox(request.sandbox, args);
              if (title) {
                next = { ...args, title };
              }
            }
            onProgress({ toolName, args: next, ...interpretTool(toolName, next) });
          },
        }
      : {}),
  });
  const maxSteps = request.maxSteps ?? DEFAULT_MAX_STEPS;
  const result = await generateText({
    model: request.model,
    system: request.system,
    prompt: request.prompt,
    tools,
    // Five stops: step cap (cost/runaway), repetition (agent crazy), systemic
    // transfer block (account quota/auth — every candidate will fail, stop grinding),
    // successful reportNoCoverage (terminal declaration — no second report), and
    // successful finish (the symmetric terminal declaration — 复联4 live showed
    // finish ×3 tail steps without a mechanical stop). The stops are independent
    // and OR'd — each fires under disjoint conditions, so ordering is not semantic.
    stopWhen: [
      stepCountIs(maxSteps),
      buildRepetitionStop(),
      buildSystemicBlockStop(),
      buildNoCoverageStop(),
      buildFinishStop(),
    ],
    // Last ~10 steps before the cap: inject a calm "wrap up + clean staging" nudge
    // so a step-capped run doesn't leave the 一人之下-style half-done mess.
    prepareStep: ({ stepNumber }) => {
      const spent = request.apiCallCount?.();
      const system = prepareStepSystemOverride({
        stepNumber,
        maxSteps,
        baseSystem: request.system,
        ...(typeof spent === "number" ? { apiCallsSpent: spent } : {}),
        ...(typeof request.budgetSoftAt === "number" ? { budgetSoftAt: request.budgetSoftAt } : {}),
      });
      return system ? { system } : undefined;
    },
  });
  const steps = result.steps?.length ?? 0;
  if (process.env.MEDIA_TRACK_AGENT_LOG === "1") {
    const total = result.totalUsage?.totalTokens;
    const perStep = total ? ` ~${Math.round(total / Math.max(steps, 1))}/step` : "";
    // peakContext = the LAST step's input — the single-request window usage that
    // decides whether context condensation/compact is ever needed (vs the 1M
    // window). totalTokens above is the cumulative BILLED count, not window usage.
    const peak = result.usage?.inputTokens;
    const peakStr = peak ? ` peakContext=${peak}` : "";
    console.log(
      `[agent] loop done: steps=${steps} tokens=${total ?? "n/a"}${perStep}${peakStr} finish=${result.finishReason}`,
    );
  }
  return {
    text: result.text,
    steps,
    coverage: await request.sandbox.finish(),
  };
}
