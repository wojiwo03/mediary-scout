import type { ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import { interpretTool } from "../src/acquisition-v2/activity.js";
import { FakeResourceProviderV2 } from "../src/acquisition-v2/fake-provider.js";
import { runRulesAcquisition } from "../src/acquisition-v2/rules-task.js";
import { TaskSandbox } from "../src/acquisition-v2/sandbox.js";
import { Storage115Simulator } from "../src/acquisition-v2/storage-115-simulator.js";
import { buildSandboxToolSet } from "../src/acquisition-v2/agent-loop.js";

const missing = ["S01E01", "S01E02"];

const target = {
  kind: "tv" as const,
  title: "庆余年",
  aliases: [] as string[],
  seasons: [1],
  missingEpisodes: missing,
  originCountries: ["CN"],
};

async function call(tool: ToolSet[string] | undefined, args: unknown) {
  const execute = tool?.execute as
    | ((args: unknown, opts: unknown) => PromiseLike<unknown>)
    | undefined;
  if (!execute) {
    throw new Error("Expected sandbox tool to expose execute()");
  }
  return execute(args, { toolCallId: "t", messages: [] }) as Promise<Record<string, unknown>>;
}

async function setupRules(options: {
  results: Record<string, Array<{ id: string; title: string }>>;
  packs: Record<string, { files: Array<{ path: string; sizeBytes: number }> }>;
  disableShareListing?: boolean;
}) {
  const provider = new FakeResourceProviderV2({ results: options.results });
  const storage = new Storage115Simulator({
    packs: options.packs,
    ...(options.disableShareListing ? { disableShareListing: true } : {}),
  });
  const stagingDirectoryId = await storage.createDirectory({ name: "staging", parentId: "root" });
  const seasonId = await storage.createDirectory({ name: "Season 1", parentId: "root" });
  const sandbox = new TaskSandbox({
    provider,
    storage,
    stagingDirectoryId,
    targetSeasonDirectoryIds: { 1: seasonId },
    need: missing,
    titleTerms: ["庆余年"],
  });
  await sandbox.primeRawSnapshot("庆余年");
  return { sandbox, storage };
}

describe("runRulesAcquisition — bounded black-box directory probe", () => {
  it("season-folder files inside an opaque title cover missing episodes (listing, no lucky-dip)", async () => {
    const { sandbox } = await setupRules({
      results: {
        庆余年: [{ id: "box", title: "庆余年 1080p" }],
      },
      packs: {
        box: {
          files: [
            { path: "庆余年 第一季/E01.mkv", sizeBytes: 9 },
            { path: "庆余年 第一季/E02.mkv", sizeBytes: 9 },
          ],
        },
      },
    });

    const result = await runRulesAcquisition({ sandbox, target });
    expect(result.coverage.coverageMet).toBe(true);
    expect(result.coverage.obtained.sort()).toEqual(["S01E01", "S01E02"]);
    expect(result.text).toMatch(/按文件名补齐集数|补齐/);
  });

  it("wrong-show title never probes or transfers", async () => {
    const { sandbox } = await setupRules({
      results: {
        庆余年: [{ id: "wrong", title: "琅琊榜 1080p" }],
      },
      packs: {
        wrong: {
          files: [
            { path: "琅琊榜 第一季/E01.mkv", sizeBytes: 9 },
            { path: "琅琊榜 第一季/E02.mkv", sizeBytes: 9 },
          ],
        },
      },
    });

    const result = await runRulesAcquisition({ sandbox, target });
    expect(result.coverage.coverageMet).toBe(false);
    expect(result.coverage.obtained).toEqual([]);
    const staging = await sandbox.inspectStaging().catch(() => []);
    expect(staging.filter((file) => file.isVideo)).toEqual([]);
  });

  it("staging-transfer fallback still maps inner filenames when listing is unavailable", async () => {
    const { sandbox } = await setupRules({
      results: {
        庆余年: [{ id: "box", title: "庆余年 1080p" }],
      },
      packs: {
        box: {
          files: [
            { path: "庆余年 第一季/E01.mkv", sizeBytes: 9 },
            { path: "庆余年 第一季/E02.mkv", sizeBytes: 9 },
          ],
        },
      },
      disableShareListing: true,
    });

    const result = await runRulesAcquisition({ sandbox, target });
    expect(result.coverage.coverageMet).toBe(true);
    expect(result.coverage.obtained.sort()).toEqual(["S01E01", "S01E02"]);
  });

  it("composes complementary opaque packs through the shared cover planner", async () => {
    const { sandbox } = await setupRules({
      results: {
        庆余年: [
          { id: "early", title: "庆余年 1080p" },
          { id: "late", title: "庆余年 第一季" },
        ],
      },
      packs: {
        early: {
          files: [{ path: "庆余年 第一季/E01.mkv", sizeBytes: 9 }],
        },
        late: {
          files: [{ path: "庆余年 第一季/E02.mkv", sizeBytes: 9 }],
        },
      },
    });

    const result = await runRulesAcquisition({ sandbox, target });
    expect(result.coverage.coverageMet).toBe(true);
    expect(result.coverage.obtained.sort()).toEqual(["S01E01", "S01E02"]);
  });
});

describe("planEpisodeCover — listing probe feeds the shared planner", () => {
  it("selects an opaque pack once share listing reveals E01/E02", async () => {
    const { sandbox } = await setupRules({
      results: {
        庆余年: [{ id: "box", title: "庆余年 1080p" }],
      },
      packs: {
        box: {
          files: [
            { path: "庆余年 第一季/E01.mkv", sizeBytes: 9 },
            { path: "庆余年 第一季/E02.mkv", sizeBytes: 9 },
          ],
        },
      },
    });
    const tools = buildSandboxToolSet(sandbox, { coverPlan: { target } });
    const plan = (await call(tools.planEpisodeCover, {})) as {
      selected: Array<{ candidateId: string; coveredEpisodes: string[] }>;
    };
    expect(plan.selected.map((row) => row.candidateId)).toEqual(["box"]);
    expect(plan.selected[0]?.coveredEpisodes.sort()).toEqual(["S01E01", "S01E02"]);
  });
});

describe("activity — 探查分享目录 / 按文件名补齐集数", () => {
  it("maps probe tools to the requested Chinese ticker lines", () => {
    expect(interpretTool("probeShareListing", { title: "庆余年 1080p" })).toEqual({
      activity: "探查分享目录…",
      phase: "pick",
    });
    expect(interpretTool("probeShareFiles", { episodeCount: 2 })).toEqual({
      activity: "按文件名补齐集数…",
      phase: "pick",
    });
  });
});
