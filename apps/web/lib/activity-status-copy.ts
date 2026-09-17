/**
 * Activity / inline-progress copy helpers. Client-safe: no runtime imports.
 * Keeps ticker wording consistent and explains steps that otherwise look stuck.
 */

export interface ActivityStepCopy {
  label: string;
  hint?: string;
}

const WRAPPING_UP = new Set(["正在收尾…", "正在收尾", "完成收尾"]);

/**
 * Map a raw agent activity string to a label + optional helper.
 * 「正在收尾」is a normal finalize step (not a hang) — show that explicitly.
 */
export function explainActivityStep(activity: string | null | undefined): ActivityStepCopy {
  const label = activity?.trim() || "正在准备…";
  if (WRAPPING_UP.has(label) || label.startsWith("正在收尾")) {
    return { label: label.endsWith("…") ? label : "正在收尾…", hint: "核对结果，清理暂存" };
  }
  if (label === "正在准备…") {
    return { label, hint: "开始搜片和匹配候选" };
  }
  if (label === "未找到可用资源" || label === "未找到资源") {
    return { label: "未找到资源", hint: "选片没有可转存的片源，会按设置留给巡检" };
  }
  return { label };
}

export function isWrappingUpStep(activity: string | null | undefined): boolean {
  const label = activity?.trim() || "";
  return WRAPPING_UP.has(label) || label.startsWith("正在收尾");
}
