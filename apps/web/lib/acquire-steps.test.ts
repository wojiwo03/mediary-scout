import { describe, expect, it } from "vitest";
import {
  acquireStepsFromProgress,
  acquireStepsHeadline,
  pipelineStepFromPhase,
  type AcquireStepView,
} from "./acquire-steps";

function byId(steps: AcquireStepView[], id: AcquireStepView["id"]): AcquireStepView {
  return steps.find((step) => step.id === id)!;
}

describe("pipelineStepFromPhase", () => {
  it("collapses verify/organize/mark into 整理入库", () => {
    expect(pipelineStepFromPhase("search")).toBe("search");
    expect(pipelineStepFromPhase("pick")).toBe("pick");
    expect(pipelineStepFromPhase("transfer")).toBe("transfer");
    expect(pipelineStepFromPhase("verify")).toBe("organize");
    expect(pipelineStepFromPhase("organize")).toBe("organize");
    expect(pipelineStepFromPhase("mark")).toBe("organize");
    expect(pipelineStepFromPhase("finalize")).toBe("finalize");
    expect(pipelineStepFromPhase(null)).toBe("search");
    expect(pipelineStepFromPhase("weird")).toBe("search");
  });
});

describe("acquireStepsFromProgress", () => {
  it("empty / preparing → 搜索 current, later pending", () => {
    const steps = acquireStepsFromProgress({});
    expect(steps.map((s) => s.state)).toEqual(["current", "pending", "pending", "pending", "pending"]);
    expect(byId(steps, "search").detail).toBe("开始搜片和匹配候选");
  });

  it("search with keyword → 正在搜：关键词", () => {
    const steps = acquireStepsFromProgress({
      activity: "正在搜索资源:庆余年 4K",
      phase: "search",
      searchCount: 2,
    });
    expect(byId(steps, "search")).toMatchObject({ state: "current", detail: "正在搜：庆余年 4K" });
    expect(byId(steps, "pick").state).toBe("pending");
  });

  it("pick / transfer / organize advance previous steps to done", () => {
    const pick = acquireStepsFromProgress({
      activity: "正在按规则筛选候选…",
      phase: "pick",
      searchCount: 3,
      selectionPath: "rules",
    });
    expect(byId(pick, "search")).toMatchObject({ state: "done", detail: "已搜 3 个关键词" });
    expect(byId(pick, "pick")).toMatchObject({ state: "current", detail: "正在按规则筛选候选…" });

    const transfer = acquireStepsFromProgress({
      activity: "正在转存到网盘…",
      phase: "transfer",
      obtained: 2,
      needed: 12,
      searchCount: 3,
      shareCount: 2,
      selectionPath: "rules",
    });
    expect(byId(transfer, "pick")).toMatchObject({ state: "done", detail: "候选 2 个" });
    expect(byId(transfer, "transfer")).toMatchObject({ state: "current", detail: "正在转存第 2/12 集" });

    const organize = acquireStepsFromProgress({
      activity: "正在整理到第 1 季…",
      phase: "organize",
      obtained: 6,
      needed: 12,
    });
    expect(byId(organize, "transfer").state).toBe("done");
    expect(byId(organize, "organize")).toMatchObject({ state: "current", detail: "正在整理到第 1 季…" });
  });

  it("正在收尾 is the last step (核对), not a hang at 97%", () => {
    const steps = acquireStepsFromProgress({
      activity: "正在收尾…",
      phase: "finalize",
      obtained: 12,
      needed: 12,
    });
    expect(steps.map((s) => s.state)).toEqual(["done", "done", "done", "done", "current"]);
    expect(byId(steps, "finalize")).toMatchObject({
      label: "收尾",
      state: "current",
      detail: "核对结果，清理暂存",
    });
    expect(acquireStepsHeadline(steps).label).toBe("收尾 · 核对结果，清理暂存");
  });

  it("no_coverage wrap-up: 未找到资源 is the 选片 outcome, 收尾 still current", () => {
    const steps = acquireStepsFromProgress({
      activity: "正在收尾…",
      phase: "finalize",
      noCoverage: true,
      searchCount: 4,
      needed: 12,
      obtained: 0,
    });
    expect(byId(steps, "search")).toMatchObject({ state: "done", detail: "已搜 4 个关键词" });
    expect(byId(steps, "pick")).toMatchObject({ state: "failed", detail: "未找到资源" });
    expect(byId(steps, "transfer")).toMatchObject({ state: "skipped", detail: "没有可转存的片源" });
    expect(byId(steps, "organize").state).toBe("skipped");
    expect(byId(steps, "finalize")).toMatchObject({ state: "current", detail: "核对结果，清理暂存" });
    const headline = acquireStepsHeadline(steps);
    expect(headline.label).toBe("选片 · 未找到资源");
    expect(headline.hint).toBe("核对结果，清理暂存");
  });

  it("activity 未找到可用资源 (no sticky flag) still marks 选片 failed", () => {
    const steps = acquireStepsFromProgress({
      activity: "未找到可用资源",
      phase: "finalize",
    });
    expect(byId(steps, "pick").state).toBe("failed");
    expect(byId(steps, "pick").detail).toBe("未找到资源");
  });

  it("quality-floor empty set: 选片 failed + 转存 skipped with 下限空集", () => {
    const steps = acquireStepsFromProgress({
      activity: "正在收尾…",
      phase: "finalize",
      noCoverage: true,
      skippedTransfer: true,
      searchCount: 5,
    });
    expect(byId(steps, "pick")).toMatchObject({ state: "failed", detail: "未找到资源" });
    expect(byId(steps, "transfer")).toMatchObject({
      state: "skipped",
      detail: "下限空集跳过转存",
    });
  });

  it("live 画质下限 pick line stays on 选片, does not jump to 收尾", () => {
    const steps = acquireStepsFromProgress({
      activity: "候选低于画质下限，不下载…",
      phase: "pick",
      skippedTransfer: true,
    });
    expect(byId(steps, "pick")).toMatchObject({
      state: "current",
      detail: "候选低于画质下限，不下载",
    });
    expect(byId(steps, "finalize").state).toBe("pending");
  });

  it("completed demo playback marks remaining steps done", () => {
    const steps = acquireStepsFromProgress({
      activity: "入库完成",
      phase: "finalize",
      completed: true,
    });
    expect(steps.every((s) => s.state === "done")).toBe(true);
    expect(byId(steps, "finalize").detail).toBe("已核对");
  });
});
