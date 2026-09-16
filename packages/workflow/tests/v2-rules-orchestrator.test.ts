import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { runAcquisitionV2 } from "../src/acquisition-v2/orchestrator.js";
import {
  RULES_DECISION_NODE,
  ACQUISITION_SELECTION_PATH_AUDIT_TYPE,
} from "../src/acquisition-v2/selection-mode.js";
import type { ResourceProvider } from "../src/ports.js";
import type { ResourceCandidate, ResourceSnapshot, VerifiedFile } from "../src/domain.js";
import { FakeStorageExecutor } from "../src/fakes.js";

function throwingModel() {
  return new MockLanguageModelV3({
    doGenerate: async () => {
      throw new Error("LLM must not be called on the rules path");
    },
  });
}

function candidate(input: {
  id: string;
  snapshotId: string;
  index: number;
  title: string;
}): ResourceCandidate {
  return {
    id: input.id,
    snapshotId: input.snapshotId,
    index: input.index,
    title: input.title,
    type: "115",
    source: "pansou",
    providerPayload: { url: `https://115.com/s/${input.id}` },
  };
}

function snapshot(id: string, keyword: string, candidates: ResourceCandidate[]): ResourceSnapshot {
  return {
    id,
    provider: "pansou",
    keyword,
    candidates,
    createdAt: "2026-06-14T00:00:00.000Z",
  };
}

function videoFile(id: string, name: string, episodeCode: string | null): VerifiedFile {
  return {
    id,
    storageDirectoryId: "staging",
    name,
    sizeBytes: 1_000_000,
    episodeCode,
    providerFileId: id,
  };
}

describe("runAcquisitionV2 — rules selector (no LLM)", () => {
  it("movie: ranks by quality, transfers the winner, never calls the model", async () => {
    const snapId = "snap_movie";
    const provider: ResourceProvider = {
      search: async ({ keyword }) =>
        snapshot(snapId, keyword, [
          candidate({ id: "noise", snapshotId: snapId, index: 0, title: "流浪地球 4K" }),
          candidate({ id: "iso", snapshotId: snapId, index: 1, title: "盗梦空间 2010 4K 蓝光原盘 ISO" }),
          candidate({ id: "sdr", snapshotId: snapId, index: 2, title: "盗梦空间 2010 1080p WEB-DL 中字" }),
          candidate({ id: "dv", snapshotId: snapId, index: 3, title: "盗梦空间 2010 2160p DV REMUX 中字" }),
        ]),
    };
    const executor = new FakeStorageExecutor({
      directories: { staging: [], movie: [] },
      transferOutcomes: {
        dv: {
          status: "succeeded",
          providerMessage: "ok",
          files: [videoFile("film", "盗梦空间.2010.2160p.mkv", null)],
        },
        sdr: {
          status: "succeeded",
          providerMessage: "should not transfer",
          files: [videoFile("worse", "盗梦空间.2010.1080p.mkv", null)],
        },
      },
    });

    const result = await runAcquisitionV2({
      provider,
      executor,
      model: throwingModel(),
      workflowRunId: "run-rules-movie",
      target: {
        kind: "movie",
        title: "盗梦空间",
        aliases: ["Inception"],
        year: 2010,
        qualityPreference: "1080p",
      },
      stagingDirectoryId: "staging",
      targetMovieDirectoryId: "movie",
      acquisitionSelectionPath: "rules",
    });

    expect(result.coverage.coverageMet).toBe(true);
    expect(result.coverage.obtained).toEqual(["MOVIE"]);
    expect(result.outcome.transferAttempts.map((attempt) => attempt.candidateId)).toEqual(["dv"]);
    expect(result.outcome.decisions).toEqual([
      expect.objectContaining({
        node: RULES_DECISION_NODE,
        snapshotId: snapId,
        selectedCandidateIds: ["dv"],
      }),
    ]);
    expect(result.auditEvents.some((event) => event.type === ACQUISITION_SELECTION_PATH_AUDIT_TYPE && event.data?.["path"] === "rules")).toBe(
      true,
    );
  });

  it("movie: does not transfer a wrong-title hit even if it is first in provider order", async () => {
    const snapId = "snap_noise";
    const provider: ResourceProvider = {
      search: async ({ keyword }) =>
        snapshot(snapId, keyword, [
          candidate({ id: "first", snapshotId: snapId, index: 0, title: "流浪地球 4K REMUX" }),
        ]),
    };
    const executor = new FakeStorageExecutor({
      directories: { staging: [], movie: [] },
      transferOutcomes: {
        first: {
          status: "succeeded",
          providerMessage: "must not run",
          files: [videoFile("wrong", "流浪地球.mkv", null)],
        },
      },
    });

    const result = await runAcquisitionV2({
      provider,
      executor,
      model: throwingModel(),
      workflowRunId: "run-rules-reject",
      target: {
        kind: "movie",
        title: "盗梦空间",
        aliases: ["Inception"],
        year: 2010,
        qualityPreference: "1080p",
      },
      stagingDirectoryId: "staging",
      targetMovieDirectoryId: "movie",
      acquisitionSelectionPath: "rules",
    });

    expect(result.coverage.coverageMet).toBe(false);
    expect(result.outcome.transferAttempts).toEqual([]);
    expect(result.outcome.decisions).toEqual([]);
    expect(result.text).toMatch(/规则选片/);
  });

  it("movie: custom identifier words let a messy share title match and transfer", async () => {
    const snapId = "snap_words";
    const provider: ResourceProvider = {
      search: async ({ keyword }) =>
        snapshot(snapId, keyword, [
          candidate({ id: "messy", snapshotId: snapId, index: 0, title: "网盘乱码分享 2010 2160p DV 中字" }),
        ]),
    };
    const executor = new FakeStorageExecutor({
      directories: { staging: [], movie: [] },
      transferOutcomes: {
        messy: {
          status: "succeeded",
          providerMessage: "ok",
          files: [videoFile("film", "盗梦空间.2010.2160p.mkv", null)],
        },
      },
    });

    const result = await runAcquisitionV2({
      provider,
      executor,
      model: throwingModel(),
      workflowRunId: "run-rules-words",
      target: {
        kind: "movie",
        title: "盗梦空间",
        aliases: ["Inception"],
        year: 2010,
        qualityPreference: "1080p",
      },
      stagingDirectoryId: "staging",
      targetMovieDirectoryId: "movie",
      acquisitionSelectionPath: "rules",
      customIdentifierWords: ["网盘乱码分享 => 盗梦空间"],
    });

    expect(result.coverage.coverageMet).toBe(true);
    expect(result.outcome.transferAttempts.map((attempt) => attempt.candidateId)).toEqual(["messy"]);
  });

  it("TV: covers missing episodes from a complete pack and skips a sequel title", async () => {
    const snapId = "snap_tv";
    const provider: ResourceProvider = {
      search: async ({ keyword }) =>
        snapshot(snapId, keyword, [
          candidate({ id: "sequel", snapshotId: snapId, index: 0, title: "庆余年2 全集" }),
          candidate({ id: "full", snapshotId: snapId, index: 1, title: "庆余年 全集 1080p WEB-DL" }),
        ]),
    };
    const executor = new FakeStorageExecutor({
      directories: { staging: [], season: [] },
      transferOutcomes: {
        full: {
          status: "succeeded",
          providerMessage: "ok",
          files: [
            videoFile("e1", "庆余年.S01E01.mkv", "S01E01"),
            videoFile("e2", "庆余年.S01E02.mkv", "S01E02"),
          ],
        },
        sequel: {
          status: "succeeded",
          providerMessage: "must not run",
          files: [videoFile("bad", "庆余年2.S01E01.mkv", "S01E01")],
        },
      },
    });

    const result = await runAcquisitionV2({
      provider,
      executor,
      model: throwingModel(),
      workflowRunId: "run-rules-tv",
      target: {
        kind: "tv",
        title: "庆余年",
        aliases: [],
        seasons: [1],
        missingEpisodes: ["S01E01", "S01E02"],
        qualityPreference: "1080p",
      },
      stagingDirectoryId: "staging",
      targetSeasonDirectoryIds: { 1: "season" },
      acquisitionSelectionPath: "rules",
    });

    expect(result.coverage.coverageMet).toBe(true);
    expect(result.coverage.obtained).toEqual(["S01E01", "S01E02"]);
    expect(result.outcome.transferAttempts.map((attempt) => attempt.candidateId)).toEqual(["full"]);
    expect(result.outcome.decisions[0]?.node).toBe(RULES_DECISION_NODE);
  });

  it("TV: fills missing episodes from scattered shares and skips overlap", async () => {
    const snapId = "snap_tv_scatter";
    const provider: ResourceProvider = {
      search: async ({ keyword }) =>
        snapshot(snapId, keyword, [
          candidate({ id: "a", snapshotId: snapId, index: 0, title: "庆余年 1-2集 1080p WEB-DL" }),
          candidate({ id: "b", snapshotId: snapId, index: 1, title: "庆余年 第3集 1080p WEB-DL" }),
          candidate({ id: "c", snapshotId: snapId, index: 2, title: "庆余年 4-6集 1080p WEB-DL" }),
          candidate({ id: "dup", snapshotId: snapId, index: 3, title: "庆余年 1-2集 720p" }),
        ]),
    };
    const executor = new FakeStorageExecutor({
      directories: { staging: [], season: [] },
      transferOutcomes: {
        a: {
          status: "succeeded",
          providerMessage: "ok",
          files: [
            videoFile("e1", "庆余年.S01E01.mkv", "S01E01"),
            videoFile("e2", "庆余年.S01E02.mkv", "S01E02"),
          ],
        },
        b: {
          status: "succeeded",
          providerMessage: "ok",
          files: [videoFile("e3", "庆余年.S01E03.mkv", "S01E03")],
        },
        c: {
          status: "succeeded",
          providerMessage: "ok",
          files: [
            videoFile("e4", "庆余年.S01E04.mkv", "S01E04"),
            videoFile("e5", "庆余年.S01E05.mkv", "S01E05"),
            videoFile("e6", "庆余年.S01E06.mkv", "S01E06"),
          ],
        },
        dup: {
          status: "succeeded",
          providerMessage: "must not run",
          files: [videoFile("waste", "庆余年.S01E01.dup.mkv", "S01E01")],
        },
      },
    });

    const result = await runAcquisitionV2({
      provider,
      executor,
      model: throwingModel(),
      workflowRunId: "run-rules-tv-scatter",
      target: {
        kind: "tv",
        title: "庆余年",
        aliases: [],
        seasons: [1],
        missingEpisodes: ["S01E01", "S01E02", "S01E03", "S01E04", "S01E05", "S01E06"],
        qualityPreference: "1080p",
      },
      stagingDirectoryId: "staging",
      targetSeasonDirectoryIds: { 1: "season" },
      acquisitionSelectionPath: "rules",
    });

    expect(result.coverage.coverageMet).toBe(true);
    expect(result.coverage.obtained.sort()).toEqual([
      "S01E01",
      "S01E02",
      "S01E03",
      "S01E04",
      "S01E05",
      "S01E06",
    ]);
    expect([...result.outcome.transferAttempts.map((attempt) => attempt.candidateId)].sort()).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(result.text).toMatch(/用 3 个分享补齐/);
    expect(result.outcome.decisions[0]?.selectedCandidateIds.sort()).toEqual(["a", "b", "c"]);
  });

  it("TV: gap re-search fills later episodes that the first snapshot never recalled", async () => {
    const searches: string[] = [];
    const provider: ResourceProvider = {
      search: async ({ keyword }) => {
        searches.push(keyword);
        if (keyword === "庆余年") {
          return snapshot("snap_early", keyword, [
            candidate({ id: "early", snapshotId: "snap_early", index: 0, title: "庆余年 1-3集 1080p WEB-DL" }),
          ]);
        }
        if (/4-10集/.test(keyword)) {
          return snapshot("snap_late", keyword, [
            candidate({ id: "late", snapshotId: "snap_late", index: 0, title: "庆余年 4-10集 1080p WEB-DL" }),
          ]);
        }
        return snapshot(`snap_${keyword}`, keyword, []);
      },
    };
    const lateFiles = [4, 5, 6, 7, 8, 9, 10].map((n) =>
      videoFile(`e${n}`, `庆余年.S01E${String(n).padStart(2, "0")}.mkv`, `S01E${String(n).padStart(2, "0")}`),
    );
    const executor = new FakeStorageExecutor({
      directories: { staging: [], season: [] },
      transferOutcomes: {
        early: {
          status: "succeeded",
          providerMessage: "ok",
          files: [
            videoFile("e1", "庆余年.S01E01.mkv", "S01E01"),
            videoFile("e2", "庆余年.S01E02.mkv", "S01E02"),
            videoFile("e3", "庆余年.S01E03.mkv", "S01E03"),
          ],
        },
        late: { status: "succeeded", providerMessage: "ok", files: lateFiles },
      },
    });

    const missing = Array.from({ length: 10 }, (_, i) => `S01E${String(i + 1).padStart(2, "0")}`);
    const result = await runAcquisitionV2({
      provider,
      executor,
      model: throwingModel(),
      workflowRunId: "run-rules-gap-research",
      target: {
        kind: "tv",
        title: "庆余年",
        aliases: [],
        seasons: [1],
        missingEpisodes: missing,
        qualityPreference: "1080p",
      },
      stagingDirectoryId: "staging",
      targetSeasonDirectoryIds: { 1: "season" },
      acquisitionSelectionPath: "rules",
    });

    expect(searches.some((keyword) => /4-10集/.test(keyword))).toBe(true);
    expect(searches.length).toBeLessThanOrEqual(4);
    expect(result.coverage.coverageMet).toBe(true);
    expect(result.coverage.obtained.sort()).toEqual(missing);
    expect(result.outcome.transferAttempts.map((attempt) => attempt.candidateId).sort()).toEqual(["early", "late"]);
    expect(result.text).toMatch(/补搜/);
    expect(result.text).toMatch(/用 2 个分享补齐/);
  });

  it("TV: a failed transfer is replaced by an unused alternate (转失败换备选)", async () => {
    const snapId = "snap_refill";
    const provider: ResourceProvider = {
      search: async ({ keyword }) =>
        snapshot(snapId, keyword, [
          candidate({ id: "dead", snapshotId: snapId, index: 0, title: "庆余年 1-3集 2160p WEB-DL" }),
          candidate({ id: "alt", snapshotId: snapId, index: 1, title: "庆余年 1-3集 1080p WEB-DL" }),
          candidate({ id: "tail", snapshotId: snapId, index: 2, title: "庆余年 4-6集 1080p WEB-DL" }),
        ]),
    };
    const executor = new FakeStorageExecutor({
      directories: { staging: [], season: [] },
      transferOutcomes: {
        dead: { status: "failed", providerMessage: "链接已过期", files: [] },
        alt: {
          status: "succeeded",
          providerMessage: "ok",
          files: [
            videoFile("e1", "庆余年.S01E01.mkv", "S01E01"),
            videoFile("e2", "庆余年.S01E02.mkv", "S01E02"),
            videoFile("e3", "庆余年.S01E03.mkv", "S01E03"),
          ],
        },
        tail: {
          status: "succeeded",
          providerMessage: "ok",
          files: [
            videoFile("e4", "庆余年.S01E04.mkv", "S01E04"),
            videoFile("e5", "庆余年.S01E05.mkv", "S01E05"),
            videoFile("e6", "庆余年.S01E06.mkv", "S01E06"),
          ],
        },
      },
    });

    const result = await runAcquisitionV2({
      provider,
      executor,
      model: throwingModel(),
      workflowRunId: "run-rules-refill",
      target: {
        kind: "tv",
        title: "庆余年",
        aliases: [],
        seasons: [1],
        missingEpisodes: ["S01E01", "S01E02", "S01E03", "S01E04", "S01E05", "S01E06"],
        qualityPreference: "1080p",
      },
      stagingDirectoryId: "staging",
      targetSeasonDirectoryIds: { 1: "season" },
      acquisitionSelectionPath: "rules",
    });

    expect(result.coverage.coverageMet).toBe(true);
    expect(result.outcome.transferAttempts.map((attempt) => attempt.candidateId)).toEqual(["dead", "alt", "tail"]);
    expect(result.outcome.transferAttempts[0]?.status).toBe("failed");
    expect(result.text).toMatch(/转失败换备选/);
    expect(result.text).toMatch(/用 2 个分享补齐/);
  });

  it("TV: caps transfers so a long single-file season leaves leftovers for patrol", async () => {
    const snapId = "snap_cap";
    const singles = Array.from({ length: 15 }, (_, i) => {
      const n = i + 1;
      return candidate({
        id: `e${n}`,
        snapshotId: snapId,
        index: i,
        title: `庆余年 第${n}集 1080p WEB-DL`,
      });
    });
    const provider: ResourceProvider = {
      search: async ({ keyword }) => snapshot(snapId, keyword, singles),
    };
    const outcomes: Record<string, { status: "succeeded"; providerMessage: string; files: ReturnType<typeof videoFile>[] }> = {};
    for (let n = 1; n <= 15; n += 1) {
      const code = `S01E${String(n).padStart(2, "0")}`;
      outcomes[`e${n}`] = {
        status: "succeeded",
        providerMessage: "ok",
        files: [videoFile(`f${n}`, `庆余年.${code}.mkv`, code)],
      };
    }
    const executor = new FakeStorageExecutor({
      directories: { staging: [], season: [] },
      transferOutcomes: outcomes,
    });
    const missing = Array.from({ length: 15 }, (_, i) => `S01E${String(i + 1).padStart(2, "0")}`);

    const result = await runAcquisitionV2({
      provider,
      executor,
      model: throwingModel(),
      workflowRunId: "run-rules-transfer-cap",
      target: {
        kind: "tv",
        title: "庆余年",
        aliases: [],
        seasons: [1],
        missingEpisodes: missing,
        qualityPreference: "1080p",
      },
      stagingDirectoryId: "staging",
      targetSeasonDirectoryIds: { 1: "season" },
      acquisitionSelectionPath: "rules",
    });

    expect(result.outcome.transferAttempts).toHaveLength(12);
    expect(result.coverage.coverageMet).toBe(false);
    expect(result.coverage.obtained).toHaveLength(12);
    expect(result.coverage.missing).toHaveLength(3);
    expect(result.text).toMatch(/留给巡检/);
    expect(result.text).toMatch(/用 12 个分享补齐/);
  });

  it("default (agent) path still invokes the model", async () => {
    const provider: ResourceProvider = {
      search: async ({ keyword }) => snapshot("snap_empty", keyword, []),
    };
    const executor = new FakeStorageExecutor({ directories: { staging: [], movie: [] } });

    await expect(
      runAcquisitionV2({
        provider,
        executor,
        model: throwingModel(),
        workflowRunId: "run-agent-still",
        target: {
          kind: "movie",
          title: "盗梦空间",
          aliases: ["Inception"],
          year: 2010,
          qualityPreference: "1080p",
        },
        stagingDirectoryId: "staging",
        targetMovieDirectoryId: "movie",
      }),
    ).rejects.toThrow(/LLM must not be called/);
  });
});

describe("runAcquisitionV2 — auto path confidence fallback", () => {
  it("auto + high-confidence movie stays on rules and never calls the model", async () => {
    const snapId = "snap_auto_high";
    const provider: ResourceProvider = {
      search: async ({ keyword }) =>
        snapshot(snapId, keyword, [
          candidate({ id: "dv", snapshotId: snapId, index: 0, title: "盗梦空间 2010 2160p DV REMUX 中字" }),
        ]),
    };
    const executor = new FakeStorageExecutor({
      directories: { staging: [], movie: [] },
      transferOutcomes: {
        dv: {
          status: "succeeded",
          providerMessage: "ok",
          files: [videoFile("film", "盗梦空间.2010.2160p.mkv", null)],
        },
      },
    });

    const result = await runAcquisitionV2({
      provider,
      executor,
      model: throwingModel(),
      workflowRunId: "run-auto-high",
      target: {
        kind: "movie",
        title: "盗梦空间",
        aliases: ["Inception"],
        year: 2010,
        qualityPreference: "1080p",
      },
      stagingDirectoryId: "staging",
      targetMovieDirectoryId: "movie",
      acquisitionSelectionPath: "auto",
    });

    expect(result.coverage.coverageMet).toBe(true);
    expect(result.outcome.transferAttempts.map((attempt) => attempt.candidateId)).toEqual(["dv"]);
    expect(result.outcome.decisions[0]?.node).toBe(RULES_DECISION_NODE);
    expect(
      result.auditEvents.some(
        (event) => event.type === ACQUISITION_SELECTION_PATH_AUDIT_TYPE && event.data?.["path"] === "rules",
      ),
    ).toBe(true);
  });

  it("auto + low-confidence empty TV coverage falls back to the agent", async () => {
    const snapId = "snap_auto_low";
    const provider: ResourceProvider = {
      search: async ({ keyword }) =>
        snapshot(snapId, keyword, [
          candidate({ id: "date", snapshotId: snapId, index: 0, title: "快乐大本营 2024.03.15 1080p" }),
        ]),
    };
    const executor = new FakeStorageExecutor({ directories: { staging: [], season: [] } });

    await expect(
      runAcquisitionV2({
        provider,
        executor,
        model: throwingModel(),
        workflowRunId: "run-auto-low",
        target: {
          kind: "tv",
          title: "快乐大本营",
          aliases: [],
          seasons: [1],
          missingEpisodes: ["S01E01"],
          qualityPreference: "1080p",
        },
        stagingDirectoryId: "staging",
        targetSeasonDirectoryIds: { 1: "season" },
        acquisitionSelectionPath: "auto",
      }),
    ).rejects.toThrow(/LLM must not be called/);
  });

  it("forced rules never escalates to the agent on low confidence", async () => {
    const snapId = "snap_rules_low";
    const provider: ResourceProvider = {
      search: async ({ keyword }) =>
        snapshot(snapId, keyword, [
          candidate({ id: "date", snapshotId: snapId, index: 0, title: "快乐大本营 2024.03.15 1080p" }),
        ]),
    };
    const executor = new FakeStorageExecutor({ directories: { staging: [], season: [] } });

    const result = await runAcquisitionV2({
      provider,
      executor,
      model: throwingModel(),
      workflowRunId: "run-rules-no-escalate",
      target: {
        kind: "tv",
        title: "快乐大本营",
        aliases: [],
        seasons: [1],
        missingEpisodes: ["S01E01"],
        qualityPreference: "1080p",
      },
      stagingDirectoryId: "staging",
      targetSeasonDirectoryIds: { 1: "season" },
      acquisitionSelectionPath: "rules",
    });

    expect(result.coverage.coverageMet).toBe(false);
    expect(result.outcome.transferAttempts).toEqual([]);
    expect(
      result.auditEvents.some(
        (event) => event.type === ACQUISITION_SELECTION_PATH_AUDIT_TYPE && event.data?.["path"] === "rules",
      ),
    ).toBe(true);
  });

  it("movie: quality floor refuses a 720p-only set instead of transferring the only option", async () => {
    const snapId = "snap_floor";
    const provider: ResourceProvider = {
      search: async ({ keyword }) =>
        snapshot(snapId, keyword, [
          candidate({ id: "low", snapshotId: snapId, index: 0, title: "盗梦空间 2010 720p WEB-DL 中字" }),
        ]),
    };
    const executor = new FakeStorageExecutor({
      directories: { staging: [], movie: [] },
      transferOutcomes: {
        low: {
          status: "succeeded",
          providerMessage: "must not run",
          files: [videoFile("film", "盗梦空间.2010.720p.mkv", null)],
        },
      },
    });

    const result = await runAcquisitionV2({
      provider,
      executor,
      model: throwingModel(),
      workflowRunId: "run-rules-floor",
      target: {
        kind: "movie",
        title: "盗梦空间",
        aliases: ["Inception"],
        year: 2010,
        qualityPreference: "1080p",
      },
      stagingDirectoryId: "staging",
      targetMovieDirectoryId: "movie",
      acquisitionSelectionPath: "rules",
      qualityPolicy: { resolutionFloor: "1080p" },
    });

    expect(result.coverage.coverageMet).toBe(false);
    expect(result.outcome.transferAttempts).toEqual([]);
    expect(result.text).toMatch(/画质下限/);
  });

  it("auto + quality-floor empty set stays on rules (does not escalate to a hanging agent finish)", async () => {
    const snapId = "snap_auto_floor";
    const provider: ResourceProvider = {
      search: async ({ keyword }) =>
        snapshot(snapId, keyword, [
          candidate({ id: "low", snapshotId: snapId, index: 0, title: "盗梦空间 2010 720p WEB-DL 中字" }),
        ]),
    };
    const executor = new FakeStorageExecutor({
      directories: { staging: [], movie: [] },
      transferOutcomes: {
        low: {
          status: "succeeded",
          providerMessage: "must not run",
          files: [videoFile("film", "盗梦空间.2010.720p.mkv", null)],
        },
      },
    });

    const result = await runAcquisitionV2({
      provider,
      executor,
      model: throwingModel(),
      workflowRunId: "run-auto-floor",
      target: {
        kind: "movie",
        title: "盗梦空间",
        aliases: ["Inception"],
        year: 2010,
        qualityPreference: "1080p",
      },
      stagingDirectoryId: "staging",
      targetMovieDirectoryId: "movie",
      acquisitionSelectionPath: "auto",
      qualityPolicy: { resolutionFloor: "1080p" },
    });

    expect(result.coverage.coverageMet).toBe(false);
    expect(result.outcome.transferAttempts).toEqual([]);
    expect(result.text).toMatch(/画质下限/);
    expect(
      result.auditEvents.some(
        (event) => event.type === ACQUISITION_SELECTION_PATH_AUDIT_TYPE && event.data?.["path"] === "rules",
      ),
    ).toBe(true);
  });
});
