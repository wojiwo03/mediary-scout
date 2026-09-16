/**
 * Structured quality ladder used AFTER recall (never as search keywords).
 *
 * Default comparison order (highest impact first):
 *   1. Resolution band (unless the user opts into `preferHdrOverResolution`)
 *   2. HDR format
 *   3. Encode / source class (Remux > BluRay > WEB-DL > …) when enabled
 *   4. Audio tags as a soft tiebreaker (missing labels are not punished)
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
export type SourceClass = "remux" | "bluray" | "webdl" | "webrip" | "hdtv" | "cam" | "unknown";
export type AudioClass = "atmos" | "truehd" | "dtshd" | "unknown";

export interface QualityLadderPolicy {
  /** User resolution preference. undefined = 不限 (weak 4K > 1080p > 720p). */
  resolutionPreference?: ResolutionPreference;
  /**
   * When true, HDR rank can outrank a higher resolution
   * (1080p DV may beat 4K SDR). Default false / conservative.
   */
  preferHdrOverResolution?: boolean;
  /**
   * When false, encode/source class is ignored. Default true — Remux / BluRay /
   * WEB-DL participate, but unmarked titles sit with WEB-DL so missing labels
   * are not punished.
   */
  considerSourceClass?: boolean;
}

/**
 * Spread-safe policy for exactOptionalPropertyTypes: omit default-false /
 * default-true flags instead of passing `?: boolean` holes.
 */
export function qualityLadderPolicyFromFlags(input: {
  resolutionPreference?: ResolutionPreference;
  preferHdrOverResolution?: boolean;
  considerSourceClass?: boolean;
}): QualityLadderPolicy {
  return {
    ...(input.resolutionPreference === undefined ? {} : { resolutionPreference: input.resolutionPreference }),
    ...(input.preferHdrOverResolution ? { preferHdrOverResolution: true } : {}),
    ...(input.considerSourceClass === false ? { considerSourceClass: false } : {}),
  };
}

export interface ParsedReleaseQuality {
  resolution: ResolutionBand;
  hdr: HdrFormat;
  source: SourceClass;
  audio: AudioClass;
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

/** Unmarked sits with WEB-DL so a missing source tag is not a downgrade. */
const SOURCE_RANK: Record<SourceClass, number> = {
  remux: 5,
  bluray: 4,
  webdl: 3,
  unknown: 3,
  webrip: 2,
  hdtv: 1,
  cam: 0,
};

/** Soft tiebreaker only. Unmarked = 0 so we never force-upgrade on a missing tag. */
const AUDIO_RANK: Record<AudioClass, number> = {
  atmos: 3,
  truehd: 2,
  dtshd: 1,
  unknown: 0,
};

const RES_WEIGHT = 1000;
const HDR_WEIGHT = 100;
const SOURCE_WEIGHT = 10;
const AUDIO_WEIGHT = 1;
/** Larger than any playable combined score so a disc image never wins an upgrade. */
const DISC_PENALTY = 10_000;

const DV_RE =
  /杜比视界|dolby[\s._-]*vision|\bdovi\b|\bdv\b|\bdo\s*vi\b/i;
const HDR10_PLUS_RE = /hdr\s*10\s*\+|hdr10plus|hdr10\s*plus/i;
const HDR10_RE = /\bhdr\s*10\b|\bhdr\b/i;
const DISC_RE = /\.iso\b|\bbdmv\b|蓝光原盘|原盘|\biso\b/i;
const RES_4K_RE = /2160p|\b4k\b|\buhd\b|3840\s*[x×]\s*2160/i;
const RES_1080_RE = /1080\s*[pi]|\bfhd\b/i;
const RES_720_RE = /720\s*[pi]/i;
const RES_SD_RE = /480\s*[pi]|576\s*[pi]|540p|\bsd\b/i;

const REMUX_RE = /\bremux\b/i;
const BLURAY_RE = /\bblu-?ray\b|\bbdrip\b|\bbd-?rip\b|\bbluray\b|蓝光/i;
const WEBDL_RE = /\bweb-?dl\b|\bwebdl\b/i;
const WEBRIP_RE = /\bweb-?rip\b|\bwebrip\b/i;
const HDTV_RE = /\bhdtv\b/i;
const CAM_RE = /\bcamrip\b|\bhdcams?\b|\bcam\b|枪版|抢版/i;

const ATMOS_RE = /\batmos\b|杜比全景声/i;
const TRUEHD_RE = /\btrue-?hd\b/i;
const DTSHD_RE = /\bdts-?hd(?:\s*ma)?\b|\bdts:?x\b/i;

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

export function parseSourceClass(title: string): SourceClass {
  if (REMUX_RE.test(title)) {
    return "remux";
  }
  if (CAM_RE.test(title)) {
    return "cam";
  }
  if (BLURAY_RE.test(title)) {
    return "bluray";
  }
  if (WEBDL_RE.test(title)) {
    return "webdl";
  }
  if (WEBRIP_RE.test(title)) {
    return "webrip";
  }
  if (HDTV_RE.test(title)) {
    return "hdtv";
  }
  return "unknown";
}

export function parseAudioClass(title: string): AudioClass {
  if (ATMOS_RE.test(title)) {
    return "atmos";
  }
  if (TRUEHD_RE.test(title)) {
    return "truehd";
  }
  if (DTSHD_RE.test(title)) {
    return "dtshd";
  }
  return "unknown";
}

export function parseReleaseQuality(title: string): ParsedReleaseQuality {
  return {
    resolution: parseResolutionBand(title),
    hdr: parseHdrFormat(title),
    source: parseSourceClass(title),
    audio: parseAudioClass(title),
    discImage: DISC_RE.test(title),
  };
}

function resolutionRank(band: ResolutionBand, preference: ResolutionPreference | undefined): number {
  return preference === "medium" ? RESOLUTION_RANK_MEDIUM[band] : RESOLUTION_RANK_HIGH[band];
}

function sourceParticipates(policy: QualityLadderPolicy): boolean {
  return policy.considerSourceClass !== false;
}

/**
 * Numeric score for a parsed release. Higher is better. Disc images sit far
 * below any playable video so they never win an upgrade.
 */
export function scoreReleaseQuality(parsed: ParsedReleaseQuality, policy: QualityLadderPolicy = {}): number {
  const res = resolutionRank(parsed.resolution, policy.resolutionPreference);
  const hdr = HDR_RANK[parsed.hdr];
  const source = sourceParticipates(policy) ? SOURCE_RANK[parsed.source] : 0;
  const audio = AUDIO_RANK[parsed.audio];
  const combined = policy.preferHdrOverResolution
    ? hdr * RES_WEIGHT + res * HDR_WEIGHT + source * SOURCE_WEIGHT + audio * AUDIO_WEIGHT
    : res * RES_WEIGHT + hdr * HDR_WEIGHT + source * SOURCE_WEIGHT + audio * AUDIO_WEIGHT;
  return parsed.discImage ? combined - DISC_PENALTY : combined;
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

export const SOURCE_LADDER_LINES = [
  "片源/压制阶梯(召回后读标题判,缺标签不惩罚): 1. Remux  2. BluRay/BDRip/蓝光  3. WEB-DL / 未标注  4. WEBRip  5. HDTV  6. CAM/枪版。默认参与排序,可在设置关闭。",
] as const;

export const AUDIO_LADDER_LINES = [
  "音轨仅作同分决胜(缺标签不强制升级): Atmos / 杜比全景声 > TrueHD > DTS-HD > 未标注。",
] as const;

export const QUALITY_SEARCH_TOKEN_LAW =
  "画质/HDR/片源/音轨词(4K/1080P/DV/DoVi/HDR10+/HDR/杜比视界/蓝光/Remux/WEB-DL/WEBRip/Atmos)只在召回后读标题判,绝不进搜索关键词(系统也会 strip;要从预搜活期文档里选)。";

export const QUALITY_UPGRADE_LINES = [
  "QUALITY UPGRADE(本次已开启替换):已入库的正片/集也可以被更高阶候选替换,不只补缺。",
  "先 inspectTargetDir 读现有文件名,再在活期文档里找【严格更高】的候选(默认分辨率优先,其次 HDR,再次片源/压制,音轨仅同分决胜;同等或更低不要换)。",
  "更高阶候选转存并回读验证落盘后,删除被替换的低画质文件,保持库/覆盖状态与网盘文件一致。升级失败不得删除旧文件。不要只比体积;阶梯比 keep-larger 优先。",
  "未开启升级时巡检只补缺,不会全库重写。画质词(含 DV/HDR/Remux/WEB-DL)不进搜索关键词。",
] as const;

export const PATROL_GAP_ONLY_LINE =
  "定时巡检默认只补缺(缺集 / 未入库);不会因为库里已有更低画质就自动全库升级。要巡检也升级,须在设置里显式打开「巡检时也升级画质」。";

export function formatHdrLadderGuidance(policy: QualityLadderPolicy = {}): string {
  const cross =
    policy.preferHdrOverResolution === true
      ? "已开启「HDR 优先于分辨率」:HDR 阶梯先于分辨率,因此 1080p DV 可以压过 4K SDR。"
      : HDR_LADDER_LINES[1];
  const source =
    policy.considerSourceClass === false
      ? "片源/压制阶梯已关闭,不参与排序。"
      : SOURCE_LADDER_LINES[0];
  return `${HDR_LADDER_LINES[0]}${cross}${source}${AUDIO_LADDER_LINES[0]}${QUALITY_SEARCH_TOKEN_LAW}`;
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
 * preference (existing) + HDR / source / audio ladder + optional upgrade mandate.
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

export interface QualityLadderRung {
  key: string;
  label: string;
}

export interface QualityLadderAxisView {
  id: "resolution" | "hdr" | "source" | "audio";
  title: string;
  hint: string;
  rungs: QualityLadderRung[];
  /** 1 = compared first. */
  order: number;
  enabled: boolean;
}

/** Visual / agent-readable ladder for Settings and config summary. */
export function describeQualityLadder(policy: QualityLadderPolicy = {}): QualityLadderAxisView[] {
  const hdrFirst = policy.preferHdrOverResolution === true;
  const sourceOn = sourceParticipates(policy);
  const resPref = policy.resolutionPreference;
  const resolutionRungs: QualityLadderRung[] =
    resPref === "medium"
      ? [
          { key: "1080p", label: "1080p（目标）" },
          { key: "720p", label: "720p" },
          { key: "sd", label: "SD" },
          { key: "4k", label: "4K / Remux（超标，尽量避开）" },
        ]
      : resPref === "high"
        ? [
            { key: "4k", label: "4K / 2160p" },
            { key: "1080p", label: "1080p" },
            { key: "720p", label: "720p" },
            { key: "sd", label: "SD" },
          ]
        : [
            { key: "4k", label: "4K / 2160p（弱优先）" },
            { key: "1080p", label: "1080p" },
            { key: "720p", label: "720p" },
            { key: "sd", label: "SD" },
          ];

  const axes: QualityLadderAxisView[] = [
    {
      id: "resolution",
      title: "分辨率",
      hint:
        resPref === "medium"
          ? "中档以 1080p 为目标，4K 视为超标"
          : resPref === "high"
            ? "高档优先约 4K"
            : "不限：有更高分辨率仍优先，但不强制某一档",
      rungs: resolutionRungs,
      order: hdrFirst ? 2 : 1,
      enabled: true,
    },
    {
      id: "hdr",
      title: "HDR",
      hint: hdrFirst ? "已开启：HDR 可压过更高分辨率" : "同分辨率内再比 HDR",
      rungs: [
        { key: "dv", label: "杜比视界 / DV / DoVi" },
        { key: "hdr10plus", label: "HDR10+" },
        { key: "hdr10", label: "HDR10 / HDR" },
        { key: "sdr", label: "SDR / 未标注" },
      ],
      order: hdrFirst ? 1 : 2,
      enabled: true,
    },
    {
      id: "source",
      title: "片源 / 压制",
      hint: sourceOn ? "缺标签按 WEB-DL 看待，不因没写来源就降级" : "已关闭，不参与排序",
      rungs: [
        { key: "remux", label: "Remux" },
        { key: "bluray", label: "BluRay / BDRip / 蓝光" },
        { key: "webdl", label: "WEB-DL / 未标注" },
        { key: "webrip", label: "WEBRip" },
        { key: "hdtv", label: "HDTV" },
        { key: "cam", label: "CAM / 枪版" },
      ],
      order: 3,
      enabled: sourceOn,
    },
    {
      id: "audio",
      title: "音轨",
      hint: "只在前面都相同时作决胜，缺标签不强制升级",
      rungs: [
        { key: "atmos", label: "Atmos / 杜比全景声" },
        { key: "truehd", label: "TrueHD" },
        { key: "dtshd", label: "DTS-HD" },
        { key: "unknown", label: "未标注" },
      ],
      order: 4,
      enabled: true,
    },
  ];
  return axes.sort((a, b) => a.order - b.order);
}

export function formatQualityLadderSummary(policy: QualityLadderPolicy = {}): string {
  const axes = describeQualityLadder(policy).filter((axis) => axis.enabled);
  const order = axes.map((axis) => axis.title).join(" → ");
  const lines = axes.map((axis) => `${axis.title}（${axis.hint}）：${axis.rungs.map((rung) => rung.label).join(" > ")}`);
  return `比较顺序：${order}。${lines.join("。")}。覆盖优先；画质词不进搜索关键词。`;
}

export function formatTargetQualityLabel(policy: QualityLadderPolicy = {}): string {
  const res =
    policy.resolutionPreference === "high"
      ? "高画质（约 4K）"
      : policy.resolutionPreference === "medium"
        ? "中画质（约 1080p）"
        : "不限分辨率";
  const hdr = policy.preferHdrOverResolution
    ? "HDR 优先于分辨率"
    : "同分辨率再比杜比视界 > HDR10+ > HDR10";
  const source = sourceParticipates(policy) ? "片源 Remux > 蓝光 > WEB-DL" : "不考虑片源类型";
  return `${res} · ${hdr} · ${source}`;
}

const RES_LABEL: Record<ResolutionBand, string> = {
  "4k": "4K",
  "1080p": "1080p",
  "720p": "720p",
  sd: "SD",
  unknown: "分辨率未标注",
};

const HDR_LABEL: Record<HdrFormat, string> = {
  dv: "杜比视界",
  hdr10plus: "HDR10+",
  hdr10: "HDR10",
  sdr: "SDR",
};

const SOURCE_LABEL: Record<SourceClass, string> = {
  remux: "Remux",
  bluray: "蓝光",
  webdl: "WEB-DL",
  webrip: "WEBRip",
  hdtv: "HDTV",
  cam: "枪版",
  unknown: "片源未标注",
};

const AUDIO_LABEL: Record<AudioClass, string> = {
  atmos: "Atmos",
  truehd: "TrueHD",
  dtshd: "DTS-HD",
  unknown: "",
};

/** Plain-language label for a parsed filename, used on the detail page. */
export function formatReleaseQualityLabel(parsed: ParsedReleaseQuality): string {
  const parts = [RES_LABEL[parsed.resolution], HDR_LABEL[parsed.hdr], SOURCE_LABEL[parsed.source]];
  const audio = AUDIO_LABEL[parsed.audio];
  if (audio) {
    parts.push(audio);
  }
  if (parsed.discImage) {
    parts.push("原盘/ISO（不可直接当正片）");
  }
  return parts.join(" · ");
}

export const QUALITY_UPGRADE_MODE_COPY = [
  {
    id: "manual" as const,
    title: "详情页「升级画质」",
    summary: "对单部已入库作品点一次。始终可用，不会默默全库替换。失败不会删掉现有文件。",
  },
  {
    id: "reacquire" as const,
    title: "重新获取时允许画质升级",
    summary: "打开后，对已入库标题再点获取 / Agent acquire 会排队升级，而不是提示已经入库。仅严格更高才替换。",
  },
  {
    id: "patrol" as const,
    title: "巡检时也升级画质",
    summary: "打开后，定时巡检才会扫已完结季和已入库电影。默认巡检仍然只补缺。",
  },
] as const;
