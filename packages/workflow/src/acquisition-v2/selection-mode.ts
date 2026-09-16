import type { AuditEvent } from "../domain.js";

/**
 * User-facing acquisition candidate-selection mode (Settings + Agent API).
 * `non_agent` is accepted as a write alias of `rules`.
 */
export const ACQUISITION_SELECTION_MODES = ["auto", "agent", "rules"] as const;
export type AcquisitionSelectionMode = (typeof ACQUISITION_SELECTION_MODES)[number];

/**
 * Requested selector for this run. `auto` tries deterministic rules first and
 * falls back to the sandbox agent when parse/coverage confidence is low
 * (only when an LLM is configured). Audit records the path that actually ran.
 */
export const ACQUISITION_SELECTION_PATHS = ["agent", "rules", "auto"] as const;
export type AcquisitionSelectionPath = (typeof ACQUISITION_SELECTION_PATHS)[number];

/** Path that actually selected candidates (never `auto`). */
export type ResolvedAcquisitionSelectionPath = "agent" | "rules";

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
 * Resolve which selector this acquisition should start with.
 * - `rules` / `agent`: forced, ignore LLM health.
 * - `auto` + no LLM: rules (acquire still works).
 * - `auto` + LLM: `auto` — orchestrator prefers rules when parse confidence is
 *   high, otherwise falls back to the agent.
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
  return llmConfigured ? "auto" : "rules";
}

export function selectionPathAuditEvent(
  path: ResolvedAcquisitionSelectionPath,
  extras?: { fallbackFrom?: "rules"; reasons?: readonly string[] },
): AuditEvent {
  const fromRules = extras?.fallbackFrom === "rules";
  const reasonText = extras?.reasons && extras.reasons.length > 0 ? extras.reasons.join("、") : "";
  return {
    type: ACQUISITION_SELECTION_PATH_AUDIT_TYPE,
    message:
      path === "rules"
        ? "片源候选由规则选片器选出（画质阶梯 + 标题/集数匹配，无需 LLM）"
        : fromRules
          ? `规则选片置信度低${reasonText ? `（${reasonText}）` : ""}，改走沙箱 agent`
          : "片源候选由沙箱 agent 选出",
    data: {
      path,
      ...(fromRules ? { fallbackFrom: "rules" } : {}),
      ...(extras?.reasons && extras.reasons.length > 0 ? { reasons: [...extras.reasons] } : {}),
    },
  };
}

export function selectionPathFromAudit(
  events: ReadonlyArray<{ type: string; data?: Record<string, unknown> }>,
): ResolvedAcquisitionSelectionPath | null {
  const hit = events.find((event) => event.type === ACQUISITION_SELECTION_PATH_AUDIT_TYPE);
  const path = hit?.data?.["path"];
  return path === "agent" || path === "rules" ? path : null;
}
