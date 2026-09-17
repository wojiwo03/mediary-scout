/**
 * User-facing 5-step acquisition progress. Pure + client-safe.
 *
 * Backend `WorkflowRunProgress.phase` is a 7-phase pipeline
 * (search/pick/transfer/verify/organize/mark/finalize). The activity card
 * collapses verify+organize+mark into 「整理入库」 so the user can read
 * the run at a glance instead of staring at a lone percent / 「正在收尾」.
 */

export type AcquireStepId = "search" | "pick" | "transfer" | "organize" | "finalize";
export type AcquireStepState = "pending" | "current" | "done" | "skipped" | "failed";

export interface AcquireStepView {
  id: AcquireStepId;
  label: string;
  state: AcquireStepState;
  detail?: string;
}

export interface AcquireStepsInput {
  activity?: string | null;
  phase?: string | null;
  obtained?: number;
  needed?: number;
  noCoverage?: boolean;
  skippedTransfer?: boolean;
  searchCount?: number;
  shareCount?: number;
  currentKeyword?: string | null;
  searchTotal?: number;
  candidateCount?: number;
  pickReason?: string | null;
  searchKeywords?: string[];
  pickRejectGroups?: Array<{ reason: string; count: number }>;
  pickExamples?: string[];
  transferTitle?: string | null;
  transferEpisodes?: string[];
  skippedDuplicates?: number;
  selectionPath?: "agent" | "rules" | null;
  /** Run already finished (demo playback 入库完成). All remaining steps become done. */
  completed?: boolean;
}

export const ACQUIRE_STEP_ORDER: readonly AcquireStepId[] = [
  "search",
  "pick",
  "transfer",
  "organize",
  "finalize",
];

export const ACQUIRE_STEP_LABEL: Record<AcquireStepId, string> = {
  search: "搜索",
  pick: "选片",
  transfer: "转存",
  organize: "整理入库",
  finalize: "收尾",
};

const FINALIZE_DETAIL = "核对结果，清理暂存";

function stepView(id: AcquireStepId, state: AcquireStepState, detail?: string): AcquireStepView {
  return detail ? { id, label: ACQUIRE_STEP_LABEL[id], state, detail } : { id, label: ACQUIRE_STEP_LABEL[id], state };
}

/** Collapse the 7 worker phases onto the 5-step UI list. Unknown/empty → 搜索. */
export function pipelineStepFromPhase(phase: string | null | undefined): AcquireStepId {
  switch (phase) {
    case "pick":
      return "pick";
    case "transfer":
      return "transfer";
    case "verify":
    case "organize":
    case "mark":
      return "organize";
    case "finalize":
      return "finalize";
    default:
      return "search";
  }
}

function isNoCoverageActivity(activity: string): boolean {
  return activity.includes("未找到可用资源") || activity.includes("未找到资源");
}

function isQualityFloorActivity(activity: string): boolean {
  return activity.includes("画质下限") || activity.includes("跳过转存");
}

function searchKeyword(activity: string): string | null {
  const match = /^(?:正在搜索资源|正在补搜缺集)[:：](.+)$/.exec(activity);
  const keyword = match?.[1]?.trim();
  return keyword ? keyword : null;
}

function resolvedKeyword(input: AcquireStepsInput, activity: string): string | null {
  const sticky = input.currentKeyword?.trim();
  if (sticky) {
    return sticky;
  }
  return searchKeyword(activity);
}

function pickPathDetail(selectionPath: AcquireStepsInput["selectionPath"]): string | undefined {
  if (selectionPath === "rules") {
    return "按规则匹配资源";
  }
  if (selectionPath === "agent") {
    return "智能选片匹配资源";
  }
  return undefined;
}

function obtainedLine(obtained: number | undefined, needed: number | undefined, prefix: string): string | undefined {
  if (needed != null && needed > 0) {
    return `${prefix}${obtained ?? 0}/${needed} 集`;
  }
  return undefined;
}

const PICK_REASON_COPY: Record<string, string> = {
  "below-quality-floor": "候选低于画质下限",
  "no-episode-coverage": "有候选但对不上缺集",
  "redundant-coverage": "候选与已有覆盖重复",
  "no-candidates": "搜索没有返回候选",
  "media-id-mismatch": "候选对不上这部片子",
  "empty-selection": "候选均未达标",
  "sequel-or-year": "候选年份或续作对不上",
};

/** Short labels for `N 个…` grouped rejects. */
const PICK_REJECT_GROUP_COPY: Record<string, string> = {
  "below-quality-floor": "低于画质下限",
  "no-episode-coverage": "对不上缺集",
  "media-id-mismatch": "对不上这部片子",
  "redundant-coverage": "与已有覆盖重复",
  "title-mismatch": "标题对不上",
  "sequel-or-year": "年份或续作对不上",
  "raw-foreign": "外语原盘",
  "disc-image": "碟片镜像",
  "tv-pack": "剧集合集",
  extra: "花絮预告",
};

const KEYWORD_DISPLAY_CAP = 5;
const KEYWORD_ITEM_MAX = 16;
const SHARE_NAME_MAX = 24;

function clipText(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max - 1)}…`;
}

function formatKeywordList(keywords: readonly string[]): string {
  const clean = keywords.map((item) => item.trim()).filter(Boolean);
  if (clean.length === 0) {
    return "";
  }
  const shown = clean.slice(-KEYWORD_DISPLAY_CAP).map((item) => clipText(item, KEYWORD_ITEM_MAX));
  const joined = shown.join(" / ");
  return clean.length > KEYWORD_DISPLAY_CAP ? `${joined} 等 ${clean.length} 个` : joined;
}

function triedKeywords(input: AcquireStepsInput, current?: string | null): string[] {
  const raw = (input.searchKeywords ?? []).map((item) => item.trim()).filter(Boolean);
  if (!current) {
    return raw;
  }
  return raw.filter((item) => item !== current);
}

function compactEpisodeLabel(codes: readonly string[]): string | undefined {
  const unique = [...new Set(codes.map((code) => code.trim()).filter(Boolean))];
  if (unique.length === 0) {
    return undefined;
  }
  const sxe: Array<{ season: number; episode: number }> = [];
  for (const code of unique) {
    const match = /^S(\d+)E(\d+)$/i.exec(code);
    if (!match) {
      return unique[0];
    }
    sxe.push({ season: Number(match[1]), episode: Number(match[2]) });
  }
  sxe.sort((a, b) => a.season - b.season || a.episode - b.episode);
  const pad = (value: number) => String(value).padStart(2, "0");
  const dropSeason = new Set(sxe.map((row) => row.season)).size === 1;
  const fmt = (row: { season: number; episode: number }) =>
    dropSeason ? `E${pad(row.episode)}` : `S${pad(row.season)}E${pad(row.episode)}`;
  const first = sxe[0]!;
  const last = sxe[sxe.length - 1]!;
  if (sxe.length === 1) {
    return fmt(first);
  }
  const consecutive =
    dropSeason && last.episode - first.episode + 1 === sxe.length;
  if (consecutive) {
    return `${fmt(first)}–E${pad(last.episode)}`;
  }
  return `${fmt(first)} 等 ${unique.length} 集`;
}

function pickGroupLine(input: AcquireStepsInput): string | undefined {
  const groups = input.pickRejectGroups ?? [];
  if (groups.length === 0) {
    return undefined;
  }
  const bits: string[] = [];
  for (const group of groups.slice(0, 3)) {
    const label = PICK_REJECT_GROUP_COPY[group.reason];
    if (!label || group.count <= 0) {
      continue;
    }
    bits.push(`${group.count} 个${label}`);
  }
  if (bits.length === 0) {
    return undefined;
  }
  const examples = (input.pickExamples ?? [])
    .map((title) => clipText(title, SHARE_NAME_MAX))
    .filter(Boolean)
    .slice(0, 3);
  if (examples.length > 0) {
    bits.push(`例如：${examples.join(" / ")}`);
  }
  return bits.join(" · ");
}

function resolvedPickReason(
  input: AcquireStepsInput,
  activity: string,
  skippedTransfer: boolean,
): string | undefined {
  const coded = input.pickReason?.trim();
  if (coded && PICK_REASON_COPY[coded]) {
    return coded;
  }
  if (skippedTransfer || isQualityFloorActivity(activity) || coded === "below-quality-floor") {
    return "below-quality-floor";
  }
  if (activity.includes("no-episode-coverage")) {
    return "no-episode-coverage";
  }
  return coded || undefined;
}

function pickFailedDetail(input: AcquireStepsInput, activity: string, skippedTransfer: boolean): string {
  const grouped = pickGroupLine(input);
  if (grouped) {
    return grouped;
  }
  const reason = resolvedPickReason(input, activity, skippedTransfer);
  const n = input.candidateCount;
  if (reason === "no-candidates" || (n === 0 && reason !== "below-quality-floor")) {
    return PICK_REASON_COPY["no-candidates"]!;
  }
  if (n != null && n > 0) {
    if (reason === "below-quality-floor") {
      return `候选 ${n} 个，均低于画质下限`;
    }
    if (reason === "no-episode-coverage") {
      return `候选 ${n} 个，对不上缺集`;
    }
    if (reason === "media-id-mismatch") {
      return `候选 ${n} 个，对不上这部片子`;
    }
    if (reason === "redundant-coverage") {
      return `候选 ${n} 个，与已有覆盖重复`;
    }
    return `候选 ${n} 个，均未达标`;
  }
  if (reason && PICK_REASON_COPY[reason]) {
    return PICK_REASON_COPY[reason]!;
  }
  return "未找到资源";
}

function searchDetail(input: AcquireStepsInput, activity: string, state: AcquireStepState): string | undefined {
  const keyword = resolvedKeyword(input, activity);
  const searched = input.searchCount;
  const total = input.searchTotal;
  const tried = triedKeywords(input, state === "current" ? keyword : null);
  const allTried = triedKeywords(input, null);
  if (state === "current") {
    const gap = activity.includes("补搜");
    const lead = keyword ? (gap ? `正在补搜：${keyword}` : `正在搜：${keyword}`) : null;
    if (tried.length > 0 && lead) {
      return `已试：${formatKeywordList(tried)} · ${lead}`;
    }
    if (lead) {
      if (searched != null && total != null && total > 0 && searched <= total && !gap) {
        return `${lead} · 已搜 ${searched}/${total}`;
      }
      if (searched != null && searched > 0) {
        return `${lead} · 已搜 ${searched} 个`;
      }
      return lead;
    }
    if (activity && activity !== "正在准备…") {
      return activity;
    }
    return "开始搜片和匹配候选";
  }
  if (state === "done") {
    const parts: string[] = [];
    if (allTried.length > 0) {
      parts.push(`已试：${formatKeywordList(allTried)}`);
    } else if (searched != null && searched > 0) {
      parts.push(`已搜 ${searched} 个关键词`);
      if (keyword) {
        parts.push(keyword);
      }
    } else if (keyword) {
      parts.push(keyword);
    }
    if (input.candidateCount != null) {
      parts.push(input.candidateCount > 0 ? `候选 ${input.candidateCount} 个` : "没有候选");
    }
    return parts.length > 0 ? parts.join(" · ") : undefined;
  }
  return undefined;
}

function pickDetail(
  input: AcquireStepsInput,
  activity: string,
  state: AcquireStepState,
  skippedTransfer: boolean,
): string | undefined {
  if (state === "failed") {
    return pickFailedDetail(input, activity, skippedTransfer);
  }
  if (state === "current") {
    const reason = resolvedPickReason(input, activity, skippedTransfer);
    if (reason === "below-quality-floor" || isQualityFloorActivity(activity)) {
      return pickFailedDetail(input, activity, true);
    }
    if (activity && !activity.startsWith("正在收尾") && !isNoCoverageActivity(activity)) {
      return activity;
    }
    return pickPathDetail(input.selectionPath);
  }
  if (state === "done") {
    if (input.shareCount != null && input.shareCount > 0) {
      return `选中 ${input.shareCount} 个分享`;
    }
    return pickPathDetail(input.selectionPath);
  }
  return undefined;
}

function transferDetail(
  input: AcquireStepsInput,
  activity: string,
  state: AcquireStepState,
  skippedTransfer: boolean,
): string | undefined {
  if (state === "skipped") {
    return skippedTransfer ? "下限空集跳过转存" : "没有可转存的片源";
  }
  if (state === "current") {
    if (isQualityFloorActivity(activity)) {
      return "低于画质下限，跳过转存";
    }
    const episode = compactEpisodeLabel(input.transferEpisodes ?? []);
    const share = input.transferTitle ? clipText(input.transferTitle, SHARE_NAME_MAX) : "";
    if (episode && share) {
      return `正在转存 ${episode} · ${share}`;
    }
    if (episode) {
      return `正在转存 ${episode}`;
    }
    if (share) {
      return `正在转存 · ${share}`;
    }
    return obtainedLine(input.obtained, input.needed, "正在转存第 ") ?? (activity || "正在转存到网盘…");
  }
  if (state === "done") {
    const moved = obtainedLine(input.obtained, input.needed, "已确认 ");
    const skip = input.skippedDuplicates;
    if (skip != null && skip > 0) {
      return moved ? `${moved} · 跳过重复 ${skip} 集` : `跳过重复 ${skip} 集`;
    }
    return moved;
  }
  return undefined;
}

function organizeDetail(input: AcquireStepsInput, activity: string, state: AcquireStepState): string | undefined {
  if (state === "skipped") {
    return undefined;
  }
  if (state === "current") {
    if (activity && !activity.startsWith("正在收尾") && !isNoCoverageActivity(activity)) {
      return activity;
    }
    return obtainedLine(input.obtained, input.needed, "已确认 ");
  }
  if (state === "done") {
    return obtainedLine(input.obtained, input.needed, "已确认 ");
  }
  return undefined;
}

function finalizeDetail(activity: string, state: AcquireStepState): string | undefined {
  if (state === "pending" || state === "skipped") {
    return undefined;
  }
  if (activity.includes("清理暂存")) {
    return "正在清理暂存目录";
  }
  if (state === "done") {
    return "已核对";
  }
  return FINALIZE_DETAIL;
}

/**
 * Derive the 5-step list from the live progress row. Does not invent worker
 * stages: skipped/failed only when no_coverage or quality-floor skip is known.
 */
export function acquireStepsFromProgress(input: AcquireStepsInput): AcquireStepView[] {
  const activity = input.activity?.trim() || "";
  const noCoverage = input.noCoverage === true || isNoCoverageActivity(activity);
  const skippedTransfer = input.skippedTransfer === true || isQualityFloorActivity(activity);
  const currentId = pipelineStepFromPhase(input.phase);
  const currentIndex = ACQUIRE_STEP_ORDER.indexOf(currentId);

  return ACQUIRE_STEP_ORDER.map((id, index) => {
    let state: AcquireStepState;
    if (noCoverage) {
      if (id === "search") {
        state = currentId === "search" ? "current" : "done";
      } else if (id === "pick") {
        state = currentIndex < 1 ? "pending" : "failed";
      } else if (id === "transfer" || id === "organize") {
        state = currentIndex < 1 ? "pending" : "skipped";
      } else {
        state = currentId === "finalize" ? "current" : index < currentIndex ? "done" : "pending";
      }
    } else if (skippedTransfer && (id === "transfer" || id === "organize") && currentIndex >= 2) {
      if (id === "transfer") {
        state = currentId === "transfer" ? "current" : "skipped";
      } else {
        state = currentId === "organize" ? "current" : currentIndex > 3 ? "skipped" : "pending";
      }
    } else if (index < currentIndex) {
      state = "done";
    } else if (index === currentIndex) {
      state = "current";
    } else {
      state = "pending";
    }
    if (input.completed === true && (state === "current" || state === "pending")) {
      state = "done";
    }

    let detail: string | undefined;
    if (id === "search") {
      detail = searchDetail(input, activity, state);
    } else if (id === "pick") {
      detail = pickDetail(input, activity, state, skippedTransfer);
    } else if (id === "transfer") {
      detail = transferDetail(input, activity, state, skippedTransfer);
    } else if (id === "organize") {
      detail = organizeDetail(input, activity, state);
    } else {
      detail = finalizeDetail(activity, state);
    }
    return stepView(id, state, detail);
  });
}

/** Compact one-line label for the media-detail badge / ticker. */
export function acquireStepsHeadline(steps: readonly AcquireStepView[]): { label: string; hint?: string } {
  const failed = steps.find((step) => step.state === "failed");
  const current = steps.find((step) => step.state === "current");
  if (failed) {
    const label = failed.detail ? `${failed.label} · ${failed.detail}` : failed.label;
    return current?.detail ? { label, hint: current.detail } : { label };
  }
  if (current) {
    const label = current.detail ? `${current.label} · ${current.detail}` : current.label;
    return { label };
  }
  return { label: "正在准备…" };
}
