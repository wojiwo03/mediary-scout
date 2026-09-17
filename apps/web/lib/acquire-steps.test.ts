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

  it("search with keyword → 正在搜：关键词, optional running count", () => {
    const steps = acquireStepsFromProgress({
      activity: "正在搜索资源:兰香如敌 2024",
      phase: "search",
      searchCount: 2,
      searchTotal: 5,
      currentKeyword: "兰香如敌 2024",
    });
    expect(byId(steps, "search")).toMatchObject({
      state: "current",
      detail: "正在搜：兰香如敌 2024 · 已搜 2/5",
    });
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
    expect(byId(transfer, "pick")).toMatchObject({ state: "done", detail: "选中 2 个分享" });
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

  it("search done keeps last keyword and recall size, not selected-share count", () => {
    const steps = acquireStepsFromProgress({
      activity: "正在按规则筛选候选…",
      phase: "pick",
      searchCount: 4,
      currentKeyword: "第二季",
      candidateCount: 12,
    });
    expect(byId(steps, "search")).toMatchObject({
      state: "done",
      detail: "已搜 4 个关键词 · 第二季 · 候选 12 个",
    });
  });

  it("in-progress search shows the current keyword even without k/n", () => {
    const steps = acquireStepsFromProgress({
      activity: "正在搜索资源:兰香如敌",
      phase: "search",
      currentKeyword: "兰香如敌",
    });
    expect(byId(steps, "search").detail).toBe("正在搜：兰香如敌");
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

  it("quality-floor empty set: 选片 failed with floor reason, 转存 skipped", () => {
    const steps = acquireStepsFromProgress({
      activity: "正在收尾…",
      phase: "finalize",
      noCoverage: true,
      skippedTransfer: true,
      pickReason: "below-quality-floor",
      candidateCount: 8,
      searchCount: 5,
      currentKeyword: "兰香如敌",
    });
    expect(byId(steps, "search").detail).toBe("已搜 5 个关键词 · 兰香如敌 · 候选 8 个");
    expect(byId(steps, "pick")).toMatchObject({
      state: "failed",
      detail: "候选 8 个，均低于画质下限",
    });
    expect(byId(steps, "transfer")).toMatchObject({
      state: "skipped",
      detail: "下限空集跳过转存",
    });
    expect(acquireStepsHeadline(steps).label).toBe("选片 · 候选 8 个，均低于画质下限");
  });

  it("no-episode-coverage: 选片 says 对不上缺集, not a generic 未找到资源", () => {
    const steps = acquireStepsFromProgress({
      activity: "正在收尾…",
      phase: "finalize",
      noCoverage: true,
      pickReason: "no-episode-coverage",
      candidateCount: 6,
      searchCount: 3,
    });
    expect(byId(steps, "pick")).toMatchObject({
      state: "failed",
      detail: "候选 6 个，对不上缺集",
    });
  });

  it("empty search: 选片 says 搜索没有返回候选", () => {
    const steps = acquireStepsFromProgress({
      activity: "正在收尾…",
      phase: "finalize",
      noCoverage: true,
      pickReason: "no-candidates",
      candidateCount: 0,
      searchCount: 4,
      currentKeyword: "兰香如敌",
    });
    expect(byId(steps, "search").detail).toBe("已搜 4 个关键词 · 兰香如敌 · 没有候选");
    expect(byId(steps, "pick")).toMatchObject({
      state: "failed",
      detail: "搜索没有返回候选",
    });
  });

  it("candidates exist but none chosen → 均未达标", () => {
    const steps = acquireStepsFromProgress({
      activity: "正在收尾…",
      phase: "finalize",
      noCoverage: true,
      pickReason: "empty-selection",
      candidateCount: 9,
    });
    expect(byId(steps, "pick").detail).toBe("候选 9 个，均未达标");
  });

  it("mediaBinding mismatch is plain Chinese, not the enum", () => {
    const steps = acquireStepsFromProgress({
      activity: "正在收尾…",
      phase: "finalize",
      noCoverage: true,
      pickReason: "media-id-mismatch",
      candidateCount: 3,
    });
    expect(byId(steps, "pick").detail).toBe("候选 3 个，对不上这部片子");
    expect(byId(steps, "pick").detail).not.toMatch(/media-id|mismatch/);
  });

  it("search current lists tried keywords then the one in flight", () => {
    const steps = acquireStepsFromProgress({
      activity: "正在搜索资源:第四集",
      phase: "search",
      currentKeyword: "第四集",
      searchKeywords: ["兰香如敌", "兰香如故", "第二季", "第四集"],
      searchCount: 4,
      searchTotal: 5,
    });
    expect(byId(steps, "search").detail).toBe("已试：兰香如敌 / 兰香如故 / 第二季 · 正在搜：第四集");
  });

  it("search tried list caps last 5 plus total count", () => {
    const steps = acquireStepsFromProgress({
      activity: "正在搜索资源:第九集",
      phase: "search",
      currentKeyword: "第九集",
      searchKeywords: ["一", "二", "三", "四", "五", "六", "七", "八", "第九集"],
    });
    expect(byId(steps, "search").detail).toBe("已试：四 / 五 / 六 / 七 / 八 等 8 个 · 正在搜：第九集");
  });

  it("search done lists tried keywords instead of only the last one", () => {
    const steps = acquireStepsFromProgress({
      activity: "正在按规则筛选候选…",
      phase: "pick",
      searchCount: 3,
      searchKeywords: ["兰香如敌", "兰香如故", "第二季"],
      currentKeyword: "第二季",
      candidateCount: 12,
    });
    expect(byId(steps, "search").detail).toBe("已试：兰香如敌 / 兰香如故 / 第二季 · 候选 12 个");
  });

  it("pick failed groups reject reasons and shows 1–3 share examples", () => {
    const steps = acquireStepsFromProgress({
      activity: "正在收尾…",
      phase: "finalize",
      noCoverage: true,
      skippedTransfer: true,
      pickReason: "below-quality-floor",
      candidateCount: 10,
      pickRejectGroups: [
        { reason: "below-quality-floor", count: 8 },
        { reason: "no-episode-coverage", count: 2 },
      ],
      pickExamples: ["兰香如敌 720p WEB-DL", "兰香如故 480p"],
    });
    expect(byId(steps, "pick")).toMatchObject({
      state: "failed",
      detail: "8 个低于画质下限 · 2 个对不上缺集 · 例如：兰香如敌 720p WEB-DL / 兰香如故 480p",
    });
    expect(acquireStepsHeadline(steps).label).toBe(
      "选片 · 8 个低于画质下限 · 2 个对不上缺集 · 例如：兰香如敌 720p WEB-DL / 兰香如故 480p",
    );
  });

  it("transfer current shows the share and episode being moved", () => {
    const steps = acquireStepsFromProgress({
      activity: "正在转存到网盘…",
      phase: "transfer",
      obtained: 2,
      needed: 12,
      shareCount: 2,
      transferTitle: "兰香如敌 1080p WEB-DL 中字",
      transferEpisodes: ["S01E04"],
    });
    expect(byId(steps, "transfer").detail).toBe("正在转存 E04 · 兰香如敌 1080p WEB-DL 中字");
  });

  it("transfer done appends skipped duplicates from landed-dedup", () => {
    const steps = acquireStepsFromProgress({
      activity: "正在整理到第 1 季…",
      phase: "organize",
      obtained: 8,
      needed: 12,
      skippedDuplicates: 2,
    });
    expect(byId(steps, "transfer")).toMatchObject({
      state: "done",
      detail: "已确认 8/12 集 · 跳过重复 2 集",
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
      detail: "候选低于画质下限",
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
