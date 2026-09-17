import { describe, expect, it } from "vitest";
import {
  anyLandedUpgrade,
  foldLandedDuplicates,
  selectStillMissingMoves,
  shouldReplaceLanded,
  worseDuplicateIds,
  type DedupListingFile,
} from "../src/acquisition-v2/landed-dedup.js";

function file(input: {
  id: string;
  path: string;
  sizeBytes?: number;
  isVideo?: boolean;
  isSubtitle?: boolean;
}): DedupListingFile {
  return {
    id: input.id,
    path: input.path,
    sizeBytes: input.sizeBytes ?? 1_000_000,
    isVideo: input.isVideo ?? true,
    isSubtitle: input.isSubtitle ?? false,
  };
}

describe("shouldReplaceLanded / anyLandedUpgrade", () => {
  it("requires a strictly higher ladder score", () => {
    expect(shouldReplaceLanded("Show.S01E01.1080p.mkv", "Show 2160p DV WEB-DL")).toBe(true);
    expect(shouldReplaceLanded("Show.S01E01.2160p.DV.mkv", "Show 1080p WEB-DL")).toBe(false);
    expect(shouldReplaceLanded("Show.S01E01.1080p.WEB-DL.mkv", "Show 1080p WEB-DL")).toBe(false);
  });

  it("does not let a disc image replace playable video", () => {
    expect(shouldReplaceLanded("Show.S01E01.1080p.mkv", "Show 4K 蓝光原盘 ISO")).toBe(false);
  });

  it("anyLandedUpgrade is true when one candidate beats one landed file", () => {
    expect(
      anyLandedUpgrade(["Show.S01E01.1080p.mkv", "Show.S01E02.2160p.mkv"], ["Show 全集 2160p DV"]),
    ).toBe(true);
    expect(anyLandedUpgrade(["Show.S01E01.1080p.mkv"], ["Show 全集 1080p WEB-DL"])).toBe(false);
  });
});

describe("selectStillMissingMoves", () => {
  it("moves only still-missing videos and their matching subtitles", () => {
    const staging = [
      file({ id: "old-ep", path: "Show.S01E01.1080p.mkv" }),
      file({ id: "old-sub", path: "Show.S01E01.zh.ass", isVideo: false, isSubtitle: true }),
      file({ id: "new-ep", path: "Show.S01E03.1080p.mkv" }),
      file({ id: "new-sub", path: "Show.S01E03.zh.ass", isVideo: false, isSubtitle: true }),
      file({ id: "extra", path: "Show.S01E04.1080p.mkv" }),
    ];
    const result = selectStillMissingMoves({
      staging,
      remainingNeed: new Set(["S01E03"]),
      existingByCode: new Map([["S01E01", staging[0]!]]),
      seasons: [1],
      qualityUpgrade: false,
    });
    expect(result.marked).toEqual(["S01E03"]);
    expect(result.moves).toEqual([{ season: 1, fileIds: ["new-ep", "new-sub"] }]);
  });

  it("on upgrade, moves only files strictly better than the landed copy", () => {
    const existing = file({ id: "landed", path: "Show.S01E01.1080p.mkv", sizeBytes: 2_000_000 });
    const staging = [
      file({ id: "worse", path: "Show.S01E01.720p.mkv", sizeBytes: 800_000 }),
      file({ id: "better", path: "Show.S01E01.2160p.DV.mkv", sizeBytes: 1_000_000 }),
      file({ id: "other", path: "Show.S01E02.2160p.mkv" }),
    ];
    const result = selectStillMissingMoves({
      staging,
      remainingNeed: new Set(),
      existingByCode: new Map([["S01E01", existing]]),
      seasons: [1],
      qualityUpgrade: true,
    });
    expect(result.marked).toEqual(["S01E01"]);
    expect(result.moves[0]?.fileIds).toEqual(["better"]);
  });
});

describe("worseDuplicateIds", () => {
  it("keep-larger on a non-upgrade collision", () => {
    const files = [
      file({ id: "big", path: "Show.S01E01.1080p.mkv", sizeBytes: 1_200_000_000 }),
      file({ id: "small", path: "Show.S01E01 (1).mkv", sizeBytes: 800_000_000 }),
      file({ id: "only", path: "Show.S01E02.mkv", sizeBytes: 100 }),
    ];
    expect(worseDuplicateIds(files, { seasons: [1], qualityUpgrade: false })).toEqual(["small"]);
  });

  it("upgrade keeps the higher ladder file even when it is smaller", () => {
    const files = [
      file({ id: "sdr", path: "Show.S01E01.1080p.WEB-DL.mkv", sizeBytes: 3_000_000_000 }),
      file({ id: "dv", path: "Show.S01E01.2160p.DV.mkv", sizeBytes: 1_000_000_000 }),
    ];
    expect(worseDuplicateIds(files, { seasons: [1], qualityUpgrade: true })).toEqual(["sdr"]);
  });
});

describe("foldLandedDuplicates", () => {
  it("returns quickly when inspectTargetDir never settles", async () => {
    const sandbox = {
      inspectTargetDir: () => new Promise<DedupListingFile[]>(() => undefined),
      deleteFiles: async () => {
        throw new Error("must not delete while listing is hung");
      },
    };
    const deleted = await Promise.race([
      foldLandedDuplicates(sandbox, { seasons: [1], qualityUpgrade: false, timeoutMs: 40 }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("foldLandedDuplicates hung")), 500),
      ),
    ]);
    expect(deleted).toEqual([]);
  });
});
