import type { AuditEvent } from "../domain.js";

/**
 * User-facing acquisition candidate-selection mode (Settings + Agent API).
 * `non_agent` is accepted as a write alias of `rules`.
 */
export const ACQUISITION_SELECTION_MODES = ["auto", "agent", "rules"] as const;
export type AcquisitionSelectionMode = (typeof ACQUISITION_SELECTION_MODES)[number];

/** The path that actually selected candidates this run. */
export const ACQUISITION_SELECTION_PATHS = ["agent", "rules"] as const;
export type AcquisitionSelectionPath = (typeof ACQUISITION_SELECTION_PATHS)[number];

export const AGENT_DECISION_NODE = "acquisition_v2_sandbox_agent";
export const RULES_DECISION_NODE = "acquisition_v2_rules_selector";

export const ACQUISITION_SELECTION_PATH_AUDIT_TYPE = "acquisition_selection_path";

export function parseAcquisitionSelectionMode(
  value: string | null | undefined,
): AcquisitionSelectionMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "agent" || normalized === "rules") {
    return normalized;
  }
  if (normalized === "non_agent") {
    return "rules";
  }
  return "auto";
}

/**
 * Resolve which selector runs this acquisition.
 * `auto` uses the agent when an LLM is configured (baseURL + modelId); otherwise
 * falls back to deterministic rules so acquire/patrol still work without a key.
 */
export function resolveAcquisitionSelectionPath(
  mode: AcquisitionSelectionMode,
  llmConfigured: boolean,
): AcquisitionSelectionPath {
  if (mode === "rules") {
    return "rules";
  }
  if (mode === "agent") {
    return "agent";
  }
  return llmConfigured ? "agent" : "rules";
}

export function selectionPathAuditEvent(path: AcquisitionSelectionPath): AuditEvent {
  return {
    type: ACQUISITION_SELECTION_PATH_AUDIT_TYPE,
    message:
      path === "rules"
        ? "片源候选由规则选片器选出（画质阶梯 + 标题/集数匹配，无需 LLM）"
        : "片源候选由沙箱 agent 选出",
    data: { path },
  };
}

export function selectionPathFromAudit(
  events: ReadonlyArray<{ type: string; data?: Record<string, unknown> }>,
): AcquisitionSelectionPath | null {
  const hit = events.find((event) => event.type === ACQUISITION_SELECTION_PATH_AUDIT_TYPE);
  const path = hit?.data?.["path"];
  return path === "agent" || path === "rules" ? path : null;
}
