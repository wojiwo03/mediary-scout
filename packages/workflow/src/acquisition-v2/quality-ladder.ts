/**
 * Structured quality ladder used AFTER recall (never as search keywords).
 *
 * Resolution is the primary axis; HDR is a tiebreaker inside the same
 * resolution band unless the user opts into `preferHdrOverResolution`.
 *
 * HDR ladder (highest first):
 *   1. Dolby Vision / DoVi / DV / 杜比视界
 *   2. HDR10+
 *   3. HDR10 / HDR
 *   4. SDR / unmarked
 *
 * Documented combination rule (default):
 *   prefer 4K DV over 4K SDR;
 *   do NOT prefer 1080p DV over 4K SDR unless `preferHdrOverResolution`.
 */

export type ResolutionBand = "4k" | "1080p" | "720p" | "sd" | "unknown";
export type HdrFormat = "dv" | "hdr10plus" | "hdr10" | "sdr";
export type ResolutionPreference = "high" | "medium";

export interface QualityLadderPolicy {
  /** User resolution preference. undefined = 不限 (weak 4K > 1080p > 720p). */
  resolutionPreference?: ResolutionPreference;
  /**
   * When true, HDR rank can outrank a higher resolution
   * (1080p DV may beat 4K SDR). Default false / conservative.
   */
  preferHdrOverResolution?: boolean;
}

export interface ParsedReleaseQuality {
  resolution: ResolutionBand;
  hdr: HdrFormat;
  /** ISO / BDMV / 原盘 — not a playable single video; always loses to video. */
  discImage: boolean;
}

const RESOLUTION_RANK_HIGH: Record<ResolutionBand, number> = {
  "4k": 4,
  "1080p": 3,
  "720p": 2,
  sd: 1,
  unknown: 0,
};

/** Medium targets 1080p and treats 4K/REMUX as over-spec (ceiling). */
const RESOLUTION_RANK_MEDIUM: Record<ResolutionBand, number> = {
  "1080p": 4,
  "720p": 2,
  sd: 1,
  unknown: 0,
  "4k": 0,
};

const HDR_RANK: Record<HdrFormat, number> = {
  dv: 3,
  hdr10plus: 2,
  hdr10: 1,
  sdr: 0,
};

const DV_RE =
  /杜比视界|dolby[\s._-]*vision|\bdovi\b|\bdv\b|\bdo\s*vi\b/i;
const HDR10_PLUS_RE = /hdr\s*10\s*\+|hdr10plus|hdr10\s*plus/i;
const HDR10_RE = /\bhdr\s*10\b|\bhdr\b/i;
const DISC_RE = /\.iso\b|\bbdmv\b|蓝光原盘|原盘|\biso\b/i;
const RES_4K_RE = /2160p|\b4k\b|\buhd\b|3840\s*[x×]\s*2160/i;
const RES_1080_RE = /1080\s*[pi]|\bfhd\b/i;
const RES_720_RE = /720\s*[pi]/i;
const RES_SD_RE = /480\s*[pi]|576\s*[pi]|540p|\bsd\b/i;

export function parseHdrFormat(title: string): HdrFormat {
  if (DV_RE.test(title)) {
    return "dv";
  }
  if (HDR10_PLUS_RE.test(title)) {
    return "hdr10plus";
  }
  if (HDR10_RE.test(title)) {
    return "hdr10";
  }
  return "sdr";
}

export function parseResolutionBand(title: string): ResolutionBand {
  if (RES_4K_RE.test(title)) {
    return "4k";
  }
  if (RES_1080_RE.test(title)) {
    return "1080p";
  }
  if (RES_720_RE.test(title)) {
    return "720p";
  }
  if (RES_SD_RE.test(title)) {
    return "sd";
  }
  return "unknown";
}

export function parseReleaseQuality(title: string): ParsedReleaseQuality {
  return {
    resolution: parseResolutionBand(title),
    hdr: parseHdrFormat(title),
    discImage: DISC_RE.test(title),
  };
}

function resolutionRank(band: ResolutionBand, preference: ResolutionPreference | undefined): number {
  return preference === "medium" ? RESOLUTION_RANK_MEDIUM[band] : RESOLUTION_RANK_HIGH[band];
}

/**
 * Numeric score for a parsed release. Higher is better. Disc images sit far
 * below any playable video so they never win an upgrade.
 */
export function scoreReleaseQuality(parsed: ParsedReleaseQuality, policy: QualityLadderPolicy = {}): number {
  const res = resolutionRank(parsed.resolution, policy.resolutionPreference);
  const hdr = HDR_RANK[parsed.hdr];
  const combined = policy.preferHdrOverResolution ? hdr * 10 + res : res * 10 + hdr;
  return parsed.discImage ? combined - 1000 : combined;
}

export function scoreReleaseTitle(title: string, policy: QualityLadderPolicy = {}): number {
  return scoreReleaseQuality(parseReleaseQuality(title), policy);
}

/**
 * Positive → `a` is better than `b`. Zero → equivalent on the ladder.
 */
export function compareReleaseQuality(
  aTitle: string,
  bTitle: string,
  policy: QualityLadderPolicy = {},
): number {
  return scoreReleaseTitle(aTitle, policy) - scoreReleaseTitle(bTitle, policy);
}

/**
 * Whether an already-landed file should be replaced by a candidate. Strictly
 * better only — equal quality is not an upgrade (no silent rewrite).
 */
export function shouldReplaceCoverage(
  existingTitle: string,
  candidateTitle: string,
  policy: QualityLadderPolicy = {},
): boolean {
  const existing = parseReleaseQuality(existingTitle);
  const candidate = parseReleaseQuality(candidateTitle);
  if (candidate.discImage && !existing.discImage) {
    return false;
  }
  return scoreReleaseQuality(candidate, policy) > scoreReleaseQuality(existing, policy);
}

/** Shared wording so prompt, skill, and tests cannot drift. */
export const HDR_LADDER_LINES = [
  "HDR 阶梯(召回后读候选标题判,绝不进搜索词): 1. Dolby Vision / DoVi / DV / 杜比视界  2. HDR10+  3. HDR10 / HDR  4. SDR / 未标注。",
  "与分辨率组合(默认分辨率优先):同分辨率下按 HDR 阶梯挑(4K DV > 4K SDR);不要用 1080p DV 压过 4K SDR,除非设置开启「HDR 优先于分辨率」。",
] as const;

export const QUALITY_SEARCH_TOKEN_LAW =
  "画质/HDR 词(4K/1080P/DV/DoVi/HDR10+/HDR/杜比视界/蓝光)只在召回后读标题判,绝不进搜索关键词(系统也会 strip;要从预搜活期文档里选)。";

export const QUALITY_UPGRADE_LINES = [
  "QUALITY UPGRADE(本次已开启替换):已入库的正片/集也可以被更高阶候选替换,不只补缺。",
  "先 inspectTargetDir 读现有文件名,再在活期文档里找【严格更高】的候选(分辨率优先,其次 HDR 阶梯;同等或更低不要换)。",
  "更高阶候选转存并回读验证落盘后,删除被替换的低画质文件,保持库/覆盖状态与网盘文件一致。不要只比体积;阶梯比 keep-larger 优先。",
  "未开启升级时巡检只补缺,不会全库重写。画质词(含 DV/HDR)不进搜索关键词。",
] as const;

export const PATROL_GAP_ONLY_LINE =
  "定时巡检默认只补缺(缺集 / 未入库);不会因为库里已有更低画质就自动全库升级。要巡检也升级,须在设置里显式打开「巡检时也升级画质」。";

export function formatHdrLadderGuidance(policy: QualityLadderPolicy = {}): string {
  const cross =
    policy.preferHdrOverResolution === true
      ? "已开启「HDR 优先于分辨率」:HDR 阶梯先于分辨率,因此 1080p DV 可以压过 4K SDR。"
      : HDR_LADDER_LINES[1];
  return `${HDR_LADDER_LINES[0]}${cross}${QUALITY_SEARCH_TOKEN_LAW}`;
}

export function formatQualityUpgradeGuidance(): string {
  return QUALITY_UPGRADE_LINES.join("");
}

export const QUALITY_UPGRADE_AUDIT_TYPE = "quality_upgrade";

export function isQualityUpgradeAudit(events: ReadonlyArray<{ type: string }>): boolean {
  return events.some((event) => event.type === QUALITY_UPGRADE_AUDIT_TYPE);
}

/**
 * Full post-recall guidance injected into the agent prompt: resolution
 * preference (existing) + HDR ladder + optional upgrade mandate.
 */
export function composeAcquisitionQualityGuidance(input: {
  resolutionGuidance: string;
  policy?: QualityLadderPolicy;
  qualityUpgrade?: boolean;
}): string {
  const parts = [
    input.resolutionGuidance,
    formatHdrLadderGuidance(input.policy ?? {}),
    input.qualityUpgrade ? formatQualityUpgradeGuidance() : PATROL_GAP_ONLY_LINE,
  ];
  return parts.filter((part) => part !== "").join("");
}
