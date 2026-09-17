import { describe, expect, it } from "vitest";
import pg from "pg";
import { PostgresWorkflowRepository } from "../src/postgres.js";
import { workflowPersistenceFixture } from "./workflow-fixtures.js";

/**
 * The 97% hang, reproduced against real Postgres.
 *
 * Live symptom (规则模式 + 首次获取 + 画质下限): the run sat in 获取中 at 97%
 * 「未找到资源」 forever, while its `no_coverage` notification already showed in
 * 已完成 — impossible for a worker that never finished, since the notification and
 * the run's terminal status are written by the SAME saveWorkflowRunSnapshot
 * transaction. So the terminal write DID commit and something put the run back to
 * `running` afterwards.
 *
 * That something is the progress write. Progress writes are fire-and-forget
 * (progress-sink.ts), and in 规则模式 the last two — reportNoCoverage then finish —
 * are issued microseconds before the terminal persist, with no awaited 115 I/O left
 * in between. The old implementation read the whole run payload, mutated
 * `progress` in JS, and re-upserted the WHOLE payload — so a write that had already
 * read `status: running` and then waited for the terminal transaction's row lock
 * committed `running` / `finishedAt: null` on top of `no_coverage`.
 *
 * This test recreates exactly that interleaving: the progress write reads first,
 * then blocks on the row lock the terminal write holds, then lands last.
 */
const connectionString = process.env.MEDIA_TRACK_POSTGRES_URL;
const d = connectionString ? describe : describe.skip;

d("PostgresWorkflowRepository progress write vs terminal persist", () => {
  it("a progress write that lands after the terminal persist cannot put the run back to running", async () => {
    const id = `progress_race_${Date.now()}`;
    const seasonId = `season_${id}`;
    const titleId = `title_${id}`;
    const pool = new pg.Pool({ connectionString });
    const terminal = new pg.Client({ connectionString });
    const repository = new PostgresWorkflowRepository(pool);
    const base = workflowPersistenceFixture();
    const runningRun = {
      ...base.workflowRun,
      id,
      trackedSeasonId: seasonId,
      status: "running" as const,
      finishedAt: null,
    };
    const snapshot = {
      ...base,
      title: { ...base.title, id: titleId },
      season: { ...base.season, id: seasonId, mediaTitleId: titleId },
      workflowRun: runningRun,
      episodes: [],
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    };

    try {
      await repository.saveWorkflowRunSnapshot(snapshot);
      // Mid-run progress, so the straggler below has a prior value to clamp against.
      await repository.updateWorkflowRunProgress(id, {
        activity: "正在按规则筛选候选…",
        phase: "pick",
        percent: 20,
        updatedAt: "2026-06-22T00:00:10.000Z",
      });

      // The terminal persist: saveWorkflowRunSnapshot upserts workflow_runs early
      // and then holds that row lock for the rest of its transaction (episode,
      // snapshot and notification inserts). Model it with the same upsert so the
      // lock is held while the progress write is in flight.
      await terminal.connect();
      await terminal.query("BEGIN");
      await terminal.query(
        "UPDATE workflow_runs SET payload = $2::jsonb WHERE id = $1",
        [
          id,
          JSON.stringify({
            ...runningRun,
            status: "no_coverage",
            finishedAt: "2026-06-22T00:01:00.000Z",
          }),
        ],
      );

      // The straggler `finish` progress write: it reads the pre-terminal payload
      // (READ COMMITTED cannot see the uncommitted terminal row), then blocks on the
      // row lock until the terminal transaction commits — so it writes LAST.
      const straggler = repository.updateWorkflowRunProgress(id, {
        activity: "正在收尾…",
        phase: "finalize",
        percent: 97,
        updatedAt: "2026-06-22T00:01:01.000Z",
        noCoverage: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      await terminal.query("COMMIT");
      await straggler;

      const after = await repository.getWorkflowRunSnapshot(id);
      expect(after?.workflowRun.status).toBe("no_coverage");
      expect(after?.workflowRun.finishedAt).toBe("2026-06-22T00:01:00.000Z");
      // The run must be OUT of 获取中 — this is the assertion the live bug violated.
      expect(await repository.listActiveWorkflowRuns()).toEqual([]);
    } finally {
      await terminal.query("ROLLBACK").catch(() => {});
      await terminal.end().catch(() => {});
      await pool.query("DELETE FROM workflow_runs WHERE id = $1", [id]).catch(() => {});
      await pool.query("DELETE FROM tracked_seasons WHERE id = $1", [seasonId]).catch(() => {});
      await pool.query("DELETE FROM media_titles WHERE id = $1", [titleId]).catch(() => {});
      await pool.end();
    }
  }, 15_000);

  it("still advances progress (monotonic, only the progress key) while the run is in flight", async () => {
    const id = `progress_live_${Date.now()}`;
    const seasonId = `season_${id}`;
    const titleId = `title_${id}`;
    const pool = new pg.Pool({ connectionString });
    const repository = new PostgresWorkflowRepository(pool);
    const base = workflowPersistenceFixture();
    const snapshot = {
      ...base,
      title: { ...base.title, id: titleId },
      season: { ...base.season, id: seasonId, mediaTitleId: titleId },
      workflowRun: {
        ...base.workflowRun,
        id,
        trackedSeasonId: seasonId,
        status: "running" as const,
        finishedAt: null,
      },
      episodes: [],
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    };

    try {
      await repository.saveWorkflowRunSnapshot(snapshot);
      await repository.updateWorkflowRunProgress(id, {
        activity: "正在转存到网盘…",
        phase: "transfer",
        percent: 55,
        updatedAt: "t1",
      });
      // A phase rewind keeps the bar but takes the newer text — and the rest of the
      // payload (status, auditEvents, kind) must be untouched by a progress write.
      await repository.updateWorkflowRunProgress(id, {
        activity: "正在整理到第 1 季…",
        phase: "organize",
        percent: 30,
        updatedAt: "t2",
      });

      const after = await repository.getWorkflowRunSnapshot(id);
      expect(after?.workflowRun.progress?.percent).toBe(55);
      expect(after?.workflowRun.progress?.activity).toBe("正在整理到第 1 季…");
      expect(after?.workflowRun.status).toBe("running");
      expect(after?.workflowRun.auditEvents).toEqual(snapshot.workflowRun.auditEvents);
    } finally {
      await pool.query("DELETE FROM workflow_runs WHERE id = $1", [id]).catch(() => {});
      await pool.query("DELETE FROM tracked_seasons WHERE id = $1", [seasonId]).catch(() => {});
      await pool.query("DELETE FROM media_titles WHERE id = $1", [titleId]).catch(() => {});
      await pool.end();
    }
  }, 15_000);
});
