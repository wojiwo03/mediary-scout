/**
 * Deterministic post-land dedup for library files.
 *
 * Episode identity is SxxExx (or MOVIE when grouping a film). Rules (and the
 * agent, via a cheap post-run fold) use this so overlapping packs cannot leave
 * dual copies: only still-missing episodes are moved, then same-episode groups
 * keep one winner (larger file, or the quality ladder on an upgrade run).
 */
import { inferEpisodeCodeFromListingPath } from "./listing-coverage.js";
import { scoreReleaseQuality, type QualityLadderPolicy } from "./quality-ladder.js";
import { parseReleaseMeta, type ParseReleaseMetaOptions } from "./release-meta.js";
import { POST_FINISH_IO_TIMEOUT_MS, withTimeout } from "./best-effort.js";

export interface DedupListingFile {
  id: string;
  path: string;
  sizeBytes: number;
  isVideo: boolean;
  isSubtitle: boolean;
}

export interface LandedDedupSandbox {
  inspectTargetDir(input?: { season?: number }): Promise<DedupListingFile[]>;
  deleteFiles(input: {
    directory: "staging" | "season";
    season?: number;
    fileIds: string[];
  }): Promise<unknown>;
}

function parseOptions(words: readonly string[] | undefined): ParseReleaseMetaOptions {
  return !words || words.length === 0 ? {} : { customWords: words };
}

/**
 * Strictly-better check (equal quality is not a replacement). Custom identifier
 * words are applied before scoring so messy pan names stay comparable.
 */
export function shouldReplaceLanded(
  existingTitle: string,
  candidateTitle: string,
  policy: QualityLadderPolicy = {},
  customWords?: readonly string[],
): boolean {
  const existing = parseReleaseMeta(existingTitle, parseOptions(customWords));
  const candidate = parseReleaseMeta(candidateTitle, parseOptions(customWords));
  if (candidate.discImage && !existing.discImage) {
    return false;
  }
  return scoreReleaseQuality(candidate, policy) > scoreReleaseQuality(existing, policy);
}

/** True when at least one candidate is strictly better than at least one landed file. */
export function anyLandedUpgrade(
  existingTitles: readonly string[],
  candidateTitles: readonly string[],
  policy: QualityLadderPolicy = {},
  customWords?: readonly string[],
): boolean {
  return existingTitles.some((existing) =>
    candidateTitles.some((candidate) => shouldReplaceLanded(existing, candidate, policy, customWords)),
  );
}

function fileScore(path: string, policy: QualityLadderPolicy, words: readonly string[] | undefined): number {
  return scoreReleaseQuality(parseReleaseMeta(path, parseOptions(words)), policy);
}

function keepWinner(
  files: readonly DedupListingFile[],
  qualityUpgrade: boolean,
  policy: QualityLadderPolicy,
  customWords: readonly string[] | undefined,
): DedupListingFile {
  return [...files].sort((a, b) => {
    if (qualityUpgrade) {
      const delta = fileScore(b.path, policy, customWords) - fileScore(a.path, policy, customWords);
      if (delta !== 0) {
        return delta;
      }
    }
    if (b.sizeBytes !== a.sizeBytes) {
      return b.sizeBytes - a.sizeBytes;
    }
    return a.id.localeCompare(b.id);
  })[0]!;
}

export function indexExistingVideos(
  files: readonly DedupListingFile[],
  seasons: readonly number[],
  customWords: readonly string[] | undefined,
  policy: QualityLadderPolicy,
  qualityUpgrade: boolean,
): Map<string, DedupListingFile> {
  const allowed = seasons.length > 0 ? seasons : [1];
  const fallback = allowed.length === 1 ? allowed[0] : undefined;
  const groups = new Map<string, DedupListingFile[]>();
  for (const file of files) {
    if (!file.isVideo) {
      continue;
    }
    const code = inferEpisodeCodeFromListingPath(file.path, fallback, allowed, customWords);
    if (!code) {
      continue;
    }
    const list = groups.get(code) ?? [];
    list.push(file);
    groups.set(code, list);
  }
  const best = new Map<string, DedupListingFile>();
  for (const [code, group] of groups) {
    best.set(code, keepWinner(group, qualityUpgrade, policy, customWords));
  }
  return best;
}

function shouldTakeVideo(
  code: string,
  file: DedupListingFile,
  remainingNeed: ReadonlySet<string>,
  existingByCode: ReadonlyMap<string, DedupListingFile>,
  qualityUpgrade: boolean,
  policy: QualityLadderPolicy,
  customWords: readonly string[] | undefined,
): boolean {
  if (remainingNeed.has(code)) {
    return true;
  }
  if (!qualityUpgrade) {
    return false;
  }
  const existing = existingByCode.get(code);
  if (!existing) {
    return false;
  }
  return shouldReplaceLanded(existing.path, file.path, policy, customWords);
}

/**
 * Staging files that may enter a season directory: still-missing coverage, or
 * (upgrade runs only) a file that is strictly better than the landed copy.
 * Matching subtitles ride with a taken video of the same episode code.
 */
export function selectStillMissingMoves(input: {
  staging: readonly DedupListingFile[];
  remainingNeed: ReadonlySet<string>;
  existingByCode: ReadonlyMap<string, DedupListingFile>;
  seasons: readonly number[];
  qualityUpgrade: boolean;
  policy?: QualityLadderPolicy;
  customWords?: readonly string[];
}): { moves: Array<{ season: number; fileIds: string[] }>; marked: string[] } {
  const policy = input.policy ?? {};
  const allowed = input.seasons.length > 0 ? [...input.seasons] : [1];
  const fallback = allowed.length === 1 ? allowed[0] : undefined;
  const taken = new Set<string>();
  const bySeason = new Map<number, string[]>();
  const seenIds = new Set<string>();

  const push = (season: number, fileId: string) => {
    if (seenIds.has(fileId)) {
      return;
    }
    seenIds.add(fileId);
    const ids = bySeason.get(season) ?? [];
    ids.push(fileId);
    bySeason.set(season, ids);
  };

  for (const file of input.staging) {
    if (!file.isVideo) {
      continue;
    }
    const code = inferEpisodeCodeFromListingPath(file.path, fallback, allowed, input.customWords);
    if (!code) {
      continue;
    }
    const season = Number(/^S(\d+)/.exec(code)?.[1] ?? 0);
    if (!allowed.includes(season)) {
      continue;
    }
    if (
      !shouldTakeVideo(
        code,
        file,
        input.remainingNeed,
        input.existingByCode,
        input.qualityUpgrade,
        policy,
        input.customWords,
      )
    ) {
      continue;
    }
    taken.add(code);
    push(season, file.id);
  }

  for (const file of input.staging) {
    if (!file.isSubtitle) {
      continue;
    }
    const code = inferEpisodeCodeFromListingPath(file.path, fallback, allowed, input.customWords);
    if (!code || !taken.has(code)) {
      continue;
    }
    const season = Number(/^S(\d+)/.exec(code)?.[1] ?? 0);
    if (!allowed.includes(season)) {
      continue;
    }
    push(season, file.id);
  }

  return {
    moves: [...bySeason.entries()].map(([season, fileIds]) => ({ season, fileIds })),
    marked: [...taken],
  };
}

/**
 * Ids of same-episode videos that lose keep-larger (or the ladder on upgrade).
 * Always keeps at least one file per episode group.
 */
export function worseDuplicateIds(
  files: readonly DedupListingFile[],
  input: {
    seasons: readonly number[];
    qualityUpgrade: boolean;
    policy?: QualityLadderPolicy;
    customWords?: readonly string[];
  },
): string[] {
  const policy = input.policy ?? {};
  const allowed = input.seasons.length > 0 ? input.seasons : [1];
  const fallback = allowed.length === 1 ? allowed[0] : undefined;
  const groups = new Map<string, DedupListingFile[]>();
  for (const file of files) {
    if (!file.isVideo) {
      continue;
    }
    const code = inferEpisodeCodeFromListingPath(file.path, fallback, allowed, input.customWords);
    if (!code) {
      continue;
    }
    const list = groups.get(code) ?? [];
    list.push(file);
    groups.set(code, list);
  }
  const worse: string[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) {
      continue;
    }
    const keep = keepWinner(group, input.qualityUpgrade, policy, input.customWords);
    for (const file of group) {
      if (file.id !== keep.id) {
        worse.push(file.id);
      }
    }
  }
  return worse;
}

/** Best-effort: never throw — a good acquisition must not fail on cleanup.
 *  Bounded so a hung inspectTargetDir after finish cannot pin the UI on 「正在收尾」. */
export async function foldLandedDuplicates(
  sandbox: LandedDedupSandbox,
  input: {
    seasons: readonly number[];
    qualityUpgrade: boolean;
    policy?: QualityLadderPolicy;
    customWords?: readonly string[];
    timeoutMs?: number;
  },
): Promise<string[]> {
  const deleted: string[] = [];
  try {
    await withTimeout(
      (async () => {
        for (const season of input.seasons) {
          const files = await sandbox.inspectTargetDir({ season });
          const worse = worseDuplicateIds(files, {
            seasons: [season],
            qualityUpgrade: input.qualityUpgrade,
            ...(input.policy ? { policy: input.policy } : {}),
            ...(input.customWords && input.customWords.length > 0 ? { customWords: input.customWords } : {}),
          });
          if (worse.length === 0) {
            continue;
          }
          await sandbox.deleteFiles({ directory: "season", season, fileIds: worse });
          deleted.push(...worse);
        }
      })(),
      input.timeoutMs ?? POST_FINISH_IO_TIMEOUT_MS,
    );
  } catch {
    return deleted;
  }
  return deleted;
}
