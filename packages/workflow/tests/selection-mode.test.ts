import { describe, expect, it } from "vitest";
import {
  parseAcquisitionSelectionMode,
  resolveAcquisitionSelectionPath,
  selectionPathFromAudit,
  selectionPathAuditEvent,
} from "../src/acquisition-v2/selection-mode.js";

describe("parseAcquisitionSelectionMode", () => {
  it("defaults to auto", () => {
    expect(parseAcquisitionSelectionMode(undefined)).toBe("auto");
    expect(parseAcquisitionSelectionMode("")).toBe("auto");
    expect(parseAcquisitionSelectionMode("nope")).toBe("auto");
  });

  it("accepts agent / rules / non_agent alias", () => {
    expect(parseAcquisitionSelectionMode("agent")).toBe("agent");
    expect(parseAcquisitionSelectionMode("RULES")).toBe("rules");
    expect(parseAcquisitionSelectionMode("non_agent")).toBe("rules");
  });
});

describe("resolveAcquisitionSelectionPath", () => {
  it("auto uses rules-first (auto) when LLM is configured, otherwise rules", () => {
    expect(resolveAcquisitionSelectionPath("auto", true)).toBe("auto");
    expect(resolveAcquisitionSelectionPath("auto", false)).toBe("rules");
  });

  it("agent / rules ignore LLM health", () => {
    expect(resolveAcquisitionSelectionPath("agent", false)).toBe("agent");
    expect(resolveAcquisitionSelectionPath("rules", true)).toBe("rules");
  });
});

describe("selectionPath audit", () => {
  it("round-trips agent vs rules", () => {
    expect(selectionPathFromAudit([selectionPathAuditEvent("rules")])).toBe("rules");
    expect(selectionPathFromAudit([selectionPathAuditEvent("agent")])).toBe("agent");
    expect(selectionPathFromAudit([selectionPathAuditEvent("agent", { fallbackFrom: "rules", reasons: ["no-episode-coverage"] })])).toBe(
      "agent",
    );
    expect(selectionPathFromAudit([])).toBeNull();
  });
});
