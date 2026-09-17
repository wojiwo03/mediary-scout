import { describe, expect, it } from "vitest";
import { withStagingCleanup } from "../src/index.js";

function recordingExecutor(behavior?: () => Promise<void>) {
  const removed: string[] = [];
  return {
    removed,
    executor: {
      async removeDirectory(id: string) {
        removed.push(id);
        if (behavior) await behavior();
        return { removed: true };
      },
    },
  };
}

async function flushCleanup(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe("withStagingCleanup", () => {
  it("removes the run's staging dir after the body succeeds", async () => {
    const { executor, removed } = recordingExecutor();
    const result = await withStagingCleanup(
      { executor, stagingDirectoryId: "stg" },
      async () => "coverage-result",
    );
    expect(result).toBe("coverage-result");
    await flushCleanup();
    expect(removed).toEqual(["stg"]);
  });

  it("removes staging EVEN WHEN the body throws — the harness-level leak guard", async () => {
    // This is the 斗破苍穹 fix: the agent reportNoCoverage'd / the loop blew up and
    // never discardStaging'd, leaking 335 files. The finally cleans it regardless.
    const { executor, removed } = recordingExecutor();
    await expect(
      withStagingCleanup({ executor, stagingDirectoryId: "stg" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await flushCleanup();
    expect(removed).toEqual(["stg"]);
  });

  it("is idempotent — a removeDirectory failure (agent already discarded) is swallowed", async () => {
    const { executor } = recordingExecutor(async () => {
      throw new Error("PAN115_DIRECTORY_NOT_FOUND: already gone");
    });
    const result = await withStagingCleanup({ executor, stagingDirectoryId: "stg" }, async () => "ok");
    expect(result).toBe("ok"); // cleanup error must not mask the real result
  });

  it("does not wait forever if removeDirectory hangs — finish must still return", async () => {
    const { executor } = recordingExecutor(() => new Promise(() => undefined));
    const result = await Promise.race([
      withStagingCleanup({ executor, stagingDirectoryId: "stg", timeoutMs: 40 }, async () => "coverage"),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("cleanup hang leaked into the result")), 500),
      ),
    ]);
    expect(result).toBe("coverage");
  });

  it("does not await a hung default-timeout delete before returning the result", async () => {
    // Production wrap-up used POST_FINISH_IO_TIMEOUT (20s). Awaiting that left
    // the worker `running` at 97% 「未找到资源」/「正在收尾」 after finish().
    const { executor } = recordingExecutor(() => new Promise(() => undefined));
    const result = await Promise.race([
      withStagingCleanup({ executor, stagingDirectoryId: "stg" }, async () => "no_coverage"),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("default cleanup timeout still blocked persist")), 500),
      ),
    ]);
    expect(result).toBe("no_coverage");
  });
});
