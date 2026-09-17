import { describe, expect, it } from "vitest";
import { explainActivityStep, isWrappingUpStep } from "./activity-status-copy";

describe("explainActivityStep", () => {
  it("空/空白 → 正在准备…", () => {
    expect(explainActivityStep(null).label).toBe("正在准备…");
    expect(explainActivityStep("   ").label).toBe("正在准备…");
    expect(explainActivityStep(undefined).hint).toBe("开始搜片和匹配候选");
  });

  it("正在收尾 标明是正常收尾，不是卡住", () => {
    expect(explainActivityStep("正在收尾…")).toEqual({
      label: "正在收尾…",
      hint: "核对结果，清理暂存",
    });
    expect(explainActivityStep("正在收尾")).toEqual({
      label: "正在收尾…",
      hint: "核对结果，清理暂存",
    });
    expect(isWrappingUpStep("正在收尾…")).toBe(true);
    expect(isWrappingUpStep("转存中…")).toBe(false);
  });

  it("其他步骤原样返回，不硬加 hint", () => {
    expect(explainActivityStep("正在转存到网盘…")).toEqual({ label: "正在转存到网盘…" });
    expect(explainActivityStep("未找到可用资源")).toEqual({
      label: "未找到资源",
      hint: "选片没有可转存的片源，会按设置留给巡检",
    });
  });
});
