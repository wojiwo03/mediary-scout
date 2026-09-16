import { describe, expect, it } from "vitest";
import { notificationCardLines } from "./notification-feed";

describe("notificationCardLines", () => {
  it("hides the redundant acquired movie line", () => {
    expect(notificationCardLines("package_initialized", "acquired", ["已获取入库"])).toEqual([]);
  });

  it("keeps quality-upgrade replacement copy even when status is acquired", () => {
    expect(
      notificationCardLines("quality_upgrade", "acquired", [
        "已用严格更高画质替换原文件（失败不会删旧文件）",
        "已获取入库",
      ]),
    ).toEqual(["已用严格更高画质替换原文件（失败不会删旧文件）", "已获取入库"]);
  });

  it("keeps season progress lines for non-acquired statuses", () => {
    expect(notificationCardLines("episodes_restored", "partial", ["缺 E03"])).toEqual(["缺 E03"]);
  });
});
