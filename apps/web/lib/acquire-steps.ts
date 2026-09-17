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

function searchDetail(input: AcquireStepsInput, activity: string, state: AcquireStepState): string | undefined {
  if (state === "current") {
    const keyword = searchKeyword(activity);
    if (keyword) {
      return activity.includes("补搜") ? `正在补搜：${keyword}` : `正在搜：${keyword}`;
    }
    if (activity && activity !== "正在准备…") {
      return activity;
    }
    return "开始搜片和匹配候选";
  }
  if (state === "done" && input.searchCount != null && input.searchCount > 0) {
    const extra =
      input.shareCount != null && input.shareCount > 0 ? `，候选 ${input.shareCount} 个` : "";
    return `已搜 ${input.searchCount} 个关键词${extra}`;
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
    return skippedTransfer && isQualityFloorActivity(activity)
      ? "候选低于画质下限"
      : "未找到资源";
  }
  if (state === "current") {
    if (isQualityFloorActivity(activity)) {
      return "候选低于画质下限，不下载";
    }
    if (activity && !activity.startsWith("正在收尾") && !isNoCoverageActivity(activity)) {
      return activity;
    }
    return pickPathDetail(input.selectionPath);
  }
  if (state === "done") {
    if (input.shareCount != null && input.shareCount > 0) {
      return `候选 ${input.shareCount} 个`;
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
    return obtainedLine(input.obtained, input.needed, "正在转存第 ") ?? activity || "正在转存到网盘…";
  }
  if (state === "done") {
    return obtainedLine(input.obtained, input.needed, "已确认 ");
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
