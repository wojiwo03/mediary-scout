import { describe, expect, it } from "vitest";
import pg from "pg";
import { MockLanguageModelV3 } from "ai/test";
import { PostgresWorkflowRepository } from "../src/postgres.js";
import { queueTrackingInitialization } from "../src/commands.js";
import { runQueuedType2Workflow } from "../src/worker.js";
import { FakeStorageExecutor } from "../src/fakes.js";
import type { MediaTitle, TrackedSeason } from "../src/domain.js";

/**
 * The reported hang, end to end on production's engine: 规则模式 + 首次获取 +
 * 画质下限, every candidate below the floor, and 115 wrap-up I/O (delete / list)
 * that never returns.
 *
 * worker.test.ts already pins this against InMemory, but InMemory cannot show the
 * actual defect: it is the REAL Postgres progress write racing the terminal
 * saveWorkflowRunSnapshot. The worker returned no_coverage (so the notification
 * landed in 已完成) while the run row itself was reverted to `running` with
 * percent 97 / 「正在收尾…」 — the run stayed in 获取中 forever. On the broken
 * implementation this reproduced about two runs in three.
 */
const connectionString = process.env.MEDIA_TRACK_POSTGRES_URL;
const d = connectionString ? describe : describe.skip;

function throwingModel() {
  return new MockLanguageModelV3({
    doGenerate: async () => {
      throw new Error("forced rules path must never call the model");
    },
  });
}

/** 115 wrap-up that never returns — the delete/list calls PR #17 moved off the
 *  finish critical path. They must stay off it. */
class HangWrapUpExecutor extends FakeStorageExecutor {
  override async listVideoFiles() {
    await new Promise(() => undefined);
    return [];
  }
  override async removeDirectory() {
    await new Promise(() => undefined);
    return { removed: false };
  }
  override async listTree() {
    await new Promise(() => undefined);
    return [];
  }
}

d("forced rules + quality floor first acquire (real Postgres)", () => {
  it("persists no_coverage and drops out of 获取中, never reverting to running at 97%", async () => {
    const stamp = Date.now();
    const runId = `rules_floor_${stamp}`;
    const pool = new pg.Pool({ connectionString });
    const repository = new PostgresWorkflowRepository(pool);
    const title: MediaTitle = {
      id: `title_rules_floor_${stamp}`,
      tmdbId: 990000 + (stamp % 1000),
      type: "tv",
      title: "兰香如敌",
      originalTitle: "兰香如敌",
      year: 2024,
      aliases: [],
      originCountries: ["CN"],
    };
    const season: TrackedSeason = {
      id: `${title.id}_s1`,
      mediaTitleId: title.id,
      seasonNumber: 1,
      status: "active",
      qualityPreference: "1080p",
      storageDirectoryId: "dir_rules_floor_s1",
      totalEpisodes: 12,
      latestAiredEpisode: 12,
      latestAiredSource: "metadata",
    };
    const snapId = `snap_rules_floor_${stamp}`;
    const provider = {
      // Below the floor, plus the unmarked title PR #16's extra recipe queries
      // surface (no resolution, no episode span) — together they empty the pick.
      search: async ({ keyword }: { keyword: string }) => ({
        id: snapId,
        provider: "pansou" as const,
        keyword,
        candidates: [
          {
            id: "low-pack",
            snapshotId: snapId,
            index: 0,
            title: "兰香如敌 第一季 全12集 720p WEB-DL",
            type: "115" as const,
            source: "pansou",
            providerPayload: { url: "https://115.com/s/low-pack" },
          },
          {
            id: "opaque",
            snapshotId: snapId,
            index: 1,
            title: "兰香如敌 网盘分享",
            type: "115" as const,
            source: "pansou",
            providerPayload: { url: "https://115.com/s/opaque" },
          },
        ],
        createdAt: "2026-06-15T00:00:00.000Z",
      }),
    };

    try {
      await queueTrackingInitialization({
        title,
        season,
        keyword: "兰香如敌",
        repository,
        createWorkflowRunId: () => runId,
        now: () => "2026-06-15T00:00:00.000Z",
      });

      const result = await Promise.race([
        runQueuedType2Workflow({
          repository,
          resourceProvider: provider,
          storage: new HangWrapUpExecutor(),
          model: throwingModel(),
          storageParentDirectoryId: "library_root",
          acquisitionSelectionPath: "rules",
          qualityFloor: "1080p",
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("worker stayed running after floor-empty finish")), 8000),
        ),
      ]);
      expect(result).toMatchObject({ status: "ran", workflowRunId: runId, workflowStatus: "no_coverage" });

      // Progress writes are fire-and-forget: give the last ones time to land, then
      // assert the terminal status is still the one the user sees.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const snapshot = await repository.getWorkflowRunSnapshot(runId);
      expect(snapshot?.workflowRun.status).toBe("no_coverage");
      expect(snapshot?.workflowRun.finishedAt).not.toBeNull();
      expect((await repository.listActiveWorkflowRuns()).map((row) => row.workflowRun.id)).not.toContain(
        runId,
      );
    } finally {
      for (const [sql, param] of [
        ["DELETE FROM notifications WHERE workflow_run_id = $1", runId],
        ["DELETE FROM resource_snapshots WHERE workflow_run_id = $1", runId],
        ["DELETE FROM agent_decisions WHERE workflow_run_id = $1", runId],
        ["DELETE FROM transfer_attempts WHERE workflow_run_id = $1", runId],
        ["DELETE FROM agent_steps WHERE workflow_run_id = $1", runId],
        ["DELETE FROM workflow_runs WHERE id = $1", runId],
        ["DELETE FROM episode_states WHERE tracked_season_id = $1", season.id],
        ["DELETE FROM tracked_seasons WHERE id = $1", season.id],
        ["DELETE FROM media_titles WHERE id = $1", title.id],
      ] as const) {
        await pool.query(sql, [param]).catch(() => {});
      }
      await pool.end();
    }
  }, 30_000);
});
