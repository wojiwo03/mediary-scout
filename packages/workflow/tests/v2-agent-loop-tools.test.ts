import type { ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import { buildSandboxToolSet } from "../src/acquisition-v2/agent-loop.js";
import { TaskSandbox } from "../src/acquisition-v2/sandbox.js";
import { FakeResourceProviderV2 } from "../src/acquisition-v2/fake-provider.js";
import { Storage115Simulator } from "../src/acquisition-v2/storage-115-simulator.js";

async function setup(need: string[] = ["S01E01"]) {
  const provider = new FakeResourceProviderV2({
    results: { show: [{ id: "cand", title: "Show" }] },
  });
  const storage = new Storage115Simulator({ packs: { cand: { files: [{ path: "Show - 01.mkv", sizeBytes: 9 }] } } });
  const stagingDirectoryId = await storage.createDirectory({ name: "staging", parentId: "root" });
  const targetSeasonDirectoryId = await storage.createDirectory({ name: "Season 1", parentId: "root" });
  const sandbox = new TaskSandbox({ provider, storage, stagingDirectoryId, targetSeasonDirectoryIds: { 1: targetSeasonDirectoryId }, need });
  return { sandbox };
}

async function call(tool: ToolSet[string] | undefined, args: unknown) {
  const execute = tool?.execute as
    | ((args: unknown, opts: unknown) => PromiseLike<unknown>)
    | undefined;
  if (!execute) {
    throw new Error("Expected sandbox tool to expose execute()");
  }
  return execute(args, { toolCallId: "t", messages: [] }) as PromiseLike<Record<string, unknown>>;
}

describe("buildSandboxToolSet — the agent's tool surface over the cage", () => {
  it("exposes exactly the sandbox tools the loop drives", async () => {
    const { sandbox } = await setup();
    const tools = buildSandboxToolSet(sandbox);
    expect(Object.keys(tools).sort()).toEqual(
      [
        "deleteFiles",
        "discardStaging",
        "finish",
        "flattenMovie",
        "inspectStaging",
        "inspectTargetDir",
        "markObtained",
        "moveToSeason",
        "readSkill",
        "reportNoCoverage",
        "searchResources",
        "transferCandidate",
        "viewResourceSnapshot",
      ].sort(),
    );
  });

  it("adds the movie-only transferUntilLanded tool ONLY for a movie task (TV/anime never gets it)", async () => {
    const { sandbox } = await setup();
    expect(Object.keys(buildSandboxToolSet(sandbox))).not.toContain("transferUntilLanded");
    expect(Object.keys(buildSandboxToolSet(sandbox, { movie: true }))).toContain("transferUntilLanded");
  });

  it("readSkill returns the requested manual section on demand (progressive disclosure)", async () => {
    const { sandbox } = await setup();
    const tools = buildSandboxToolSet(sandbox);

    const movie = (await call(tools.readSkill, { section: "movie" })) as unknown as { section: string; body: string };
    expect(movie.section).toBe("movie");
    expect(movie.body).toMatch(/Movie acquisition playbook/);

    const unknown = (await call(tools.readSkill, { section: "nope" })) as unknown as { body: string };
    expect(unknown.body).toMatch(/Unknown skill section/); // recoverable, not a crash
  });

  it("drives the sandbox: search → transfer returns forced-reread evidence", async () => {
    const { sandbox } = await setup();
    const tools = buildSandboxToolSet(sandbox);

    const search = await call(tools.searchResources, { keyword: "show" });
    const snapshotId = (search.snapshot as { id: string }).id;
    const transfer = await call(tools.transferCandidate, { snapshotId, candidateId: "cand" });

    expect((transfer.attempt as { status: string }).status).toBe("succeeded");
    expect((transfer.staging as unknown[]).length).toBe(1);
  });

  it("surfaces a guard refusal as {error} the agent can read and adapt to (no loop crash)", async () => {
    const { sandbox } = await setup();
    const tools = buildSandboxToolSet(sandbox);

    // A scoped-guard violation (moving a file that is not in this task's staging)
    // must come back as an error string, not throw out of the tool loop.
    const result = await call(tools.moveToSeason, { moves: [{ season: 1, fileIds: ["ghost"] }] });

    expect(result.error).toMatch(/FILES_NOT_IN_STAGING/);
  });

  it("finish returns the honest coverage summary through the tool surface", async () => {
    const { sandbox } = await setup(["S01E01", "S01E02"]);
    const tools = buildSandboxToolSet(sandbox);
    const search = await call(tools.searchResources, { keyword: "show" });
    const snapshotId = (search.snapshot as { id: string }).id;
    const transfer = await call(tools.transferCandidate, { snapshotId, candidateId: "cand" });
    const staging = transfer.staging as Array<{ id: string }>;
    await call(tools.moveToSeason, { moves: [{ season: 1, fileIds: staging.map((f) => f.id) }] });
    await call(tools.markObtained, { codes: ["S01E01"] });

    const summary = await call(tools.finish, {});
    expect(summary.coverageMet).toBe(false);
    expect(summary.missing).toEqual(["S01E02"]);
  });

  it("TV planEpisodeCover uses the shared greedyCover set and refuses redundant overlaps", async () => {
    const provider = new FakeResourceProviderV2({
      results: {
        Show: [
          { id: "a", title: "Show 1-2集 1080p WEB-DL" },
          { id: "b", title: "Show 第3集 1080p WEB-DL" },
          { id: "c", title: "Show 4-6集 1080p WEB-DL" },
          { id: "dup", title: "Show 1-2集 720p WEB-DL" },
        ],
      },
    });
    const storage = new Storage115Simulator({
      packs: {
        a: { files: [{ path: "Show - 01.mkv", sizeBytes: 9 }, { path: "Show - 02.mkv", sizeBytes: 9 }] },
        b: { files: [{ path: "Show - 03.mkv", sizeBytes: 9 }] },
        c: { files: [{ path: "Show - 04.mkv", sizeBytes: 9 }] },
        dup: { files: [{ path: "Show - 01.dup.mkv", sizeBytes: 4 }] },
      },
    });
    const stagingDirectoryId = await storage.createDirectory({ name: "staging", parentId: "root" });
    const targetSeasonDirectoryId = await storage.createDirectory({ name: "Season 1", parentId: "root" });
    const missing = ["S01E01", "S01E02", "S01E03", "S01E04", "S01E05", "S01E06"];
    const sandbox = new TaskSandbox({
      provider,
      storage,
      stagingDirectoryId,
      targetSeasonDirectoryIds: { 1: targetSeasonDirectoryId },
      need: missing,
      titleTerms: ["Show"],
    });
    await sandbox.primeRawSnapshot("Show");
    const tools = buildSandboxToolSet(sandbox, {
      coverPlan: {
        target: {
          kind: "tv",
          title: "Show",
          aliases: [],
          seasons: [1],
          missingEpisodes: missing,
          originCountries: ["CN"],
        },
      },
    });
    expect(Object.keys(tools)).toContain("planEpisodeCover");

    const plan = (await call(tools.planEpisodeCover, {})) as {
      selected: Array<{ candidateId: string }>;
      redundantCandidateIds: string[];
      reason: string;
    };
    expect(plan.selected.map((row) => row.candidateId).sort()).toEqual(["a", "b", "c"]);
    expect(plan.redundantCandidateIds).toContain("dup");
    expect(plan.reason).toMatch(/用 3 个分享补齐/);

    const snapshotId = sandbox.listObservedSnapshots()[0]!.id;
    const refused = await call(tools.transferCandidate, { snapshotId, candidateId: "dup" });
    expect(refused.error).toMatch(/REDUNDANT_COVERAGE|不补新缺集|重叠/);
  });
});

describe("readSkill description — section list derived from the single source of truth", () => {
  it("lists EVERY registered skill section (cannot drift when sections are added)", async () => {
    const { SKILL_SECTION_NAMES } = await import("../src/acquisition-v2/skill.js");
    const { sandbox } = await setup();
    const tools = buildSandboxToolSet(sandbox);
    const description = (tools["readSkill"] as { description?: string }).description ?? "";
    for (const section of SKILL_SECTION_NAMES) {
      expect(description).toContain(section);
    }
  });
});
