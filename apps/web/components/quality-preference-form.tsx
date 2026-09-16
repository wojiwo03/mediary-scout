"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, LoaderCircle } from "lucide-react";
import {
  QUALITY_UPGRADE_MODE_COPY,
  parseQualityFloorSetting,
  qualityLadderPolicyFromFlags,
  type QualityFloorSetting,
  type ResolutionPreference,
} from "@media-track/workflow/quality-ladder";
import { saveQualityPreferenceAction } from "../app/actions";
import {
  emitPatrolQualityUpgradeChange,
  PATROL_QUALITY_UPGRADE_EVENT,
} from "../lib/patrol-quality-upgrade-sync";
import { runAction } from "../lib/run-action";
import { QualityLadderVisual } from "./quality-ladder-visual";

const FLOORS: Array<{ key: QualityFloorSetting; label: string; hint: string }> = [
  { key: "any", label: "不限", hint: "没有硬性下限，找不到目标画质时仍可取更低档" },
  { key: "720p", label: "720p", hint: "低于 720p / SD 不下载，留给巡检" },
  { key: "1080p", label: "1080p", hint: "低于 1080p 不下载，哪怕是唯一候选也不凑合" },
  { key: "4k", label: "4K", hint: "低于 4K / 2160p 不下载，留给巡检" },
];

const QUALITIES = [
  { key: "any", label: "不限", hint: "有更高就挑更高，不强制 4K 或 1080p" },
  { key: "high", label: "高画质", hint: "优先约 4K / 2160p 的可播放视频" },
  { key: "medium", label: "中画质", hint: "目标约 1080p，4K/Remux 视为超标" },
] as const;

export function QualityPreferenceForm({
  initial,
  qualityFloor,
  preferHdrOverResolution,
  considerSourceClass,
  upgradeOnReacquire,
  patrolQualityUpgrade,
}: {
  initial: string;
  qualityFloor: string;
  preferHdrOverResolution: boolean;
  considerSourceClass: boolean;
  upgradeOnReacquire: boolean;
  patrolQualityUpgrade: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [value, setValue] = useState(initial || "any");
  const [floor, setFloor] = useState<QualityFloorSetting>(
    qualityFloor === "4k" || qualityFloor === "1080p" || qualityFloor === "720p" ? qualityFloor : "any",
  );
  const [hdrFirst, setHdrFirst] = useState(preferHdrOverResolution);
  const [sourceOn, setSourceOn] = useState(considerSourceClass);
  const [upgrade, setUpgrade] = useState(upgradeOnReacquire);
  const [patrolUpgrade, setPatrolUpgrade] = useState(patrolQualityUpgrade);
  const [advancedOpen, setAdvancedOpen] = useState(preferHdrOverResolution || !considerSourceClass);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    setPatrolUpgrade(patrolQualityUpgrade);
  }, [patrolQualityUpgrade]);

  useEffect(() => {
    const onChange = (event: Event) => {
      const enabled = (event as CustomEvent<boolean>).detail;
      if (typeof enabled === "boolean") {
        setPatrolUpgrade(enabled);
      }
    };
    window.addEventListener(PATROL_QUALITY_UPGRADE_EVENT, onChange);
    return () => window.removeEventListener(PATROL_QUALITY_UPGRADE_EVENT, onChange);
  }, []);

  const policy = useMemo(
    () => {
      const floorBand = parseQualityFloorSetting(floor);
      return qualityLadderPolicyFromFlags({
        ...(value === "high" || value === "medium"
          ? { resolutionPreference: value as ResolutionPreference }
          : {}),
        ...(hdrFirst ? { preferHdrOverResolution: true } : {}),
        ...(sourceOn ? {} : { considerSourceClass: false }),
        ...(floorBand === undefined ? {} : { resolutionFloor: floorBand }),
      });
    },
    [value, hdrFirst, sourceOn, floor],
  );

  const handleSave = () => {
    startTransition(async () => {
      // 必须 catch:server action 会 throw(demo 门禁、运行时错误、网络中断),
      // 不 catch 就是未处理 rejection,界面上什么都不变(见 runAction 注释)。
      // 业务错误(success:false)仍走下方原逻辑;这里只拦异常。
      const r = await runAction(
        () =>
          saveQualityPreferenceAction({
            quality: value,
            qualityFloor: floor,
            preferHdrOverResolution: hdrFirst,
            considerSourceClass: sourceOn,
            upgradeOnReacquire: upgrade,
            patrolQualityUpgrade: patrolUpgrade,
          }),
        (msg) => {
          setResult(`❌ ${msg}`);
          setTimeout(() => setResult(null), 3000);
        },
      );
      if (!r.ok) return;
      const res = r.value;
      if (res.success) {
        emitPatrolQualityUpgradeChange(patrolUpgrade);
        router.refresh();
      }
      setResult(res.success ? "✅ 保存成功" : `❌ ${res.message ?? "保存失败"}`);
      setTimeout(() => setResult(null), 3000);
    });
  };

  return (
    <div className="push-form">
      <p className="panel-note" style={{ marginBottom: 12 }}>
        下面的顺序只用于<strong>召回之后</strong>读候选标题选片。搜索仍用裸片名。偏好是软排序；「低于此画质不下载」才是硬性下限——低于下限的候选一律不转存，留给巡检。
      </p>

      <p className="quality-section-label">分辨率档位</p>
      <div className="quality-choice-grid" role="radiogroup" aria-label="偏好画质档位">
        {QUALITIES.map((quality) => (
          <button
            key={quality.key}
            type="button"
            role="radio"
            aria-checked={value === quality.key}
            className={`quality-choice${value === quality.key ? " is-active" : ""}`}
            onClick={() => setValue(quality.key)}
          >
            <strong>{quality.label}</strong>
            <span>{quality.hint}</span>
          </button>
        ))}
      </div>

      <p className="quality-section-label">低于此画质不下载</p>
      <p className="panel-note" style={{ marginBottom: 8 }}>
        硬性下限，不是排序。低于此档的候选一律不转存，哪怕是唯一资源也留给巡检，而不是降档凑合。未标注分辨率的标题不因此拒绝。
      </p>
      <div className="quality-choice-grid" role="radiogroup" aria-label="画质下限">
        {FLOORS.map((option) => (
          <button
            key={option.key}
            type="button"
            role="radio"
            aria-checked={floor === option.key}
            className={`quality-choice${floor === option.key ? " is-active" : ""}`}
            onClick={() => setFloor(option.key)}
          >
            <strong>{option.label}</strong>
            <span>{option.hint}</span>
          </button>
        ))}
      </div>

      <p className="quality-section-label">比较顺序（高 → 低）</p>
      <QualityLadderVisual policy={policy} />

      <button
        type="button"
        className="quality-advanced-toggle"
        aria-expanded={advancedOpen}
        onClick={() => setAdvancedOpen((open) => !open)}
      >
        <ChevronDown size={16} aria-hidden className={advancedOpen ? "is-open" : ""} />
        更多排序规则
      </button>
      {advancedOpen ? (
        <div className="quality-advanced">
          <label className="setting-check">
            <input
              type="checkbox"
              checked={hdrFirst}
              onChange={(event) => setHdrFirst(event.target.checked)}
            />
            <span>
              HDR 优先于分辨率
              <small>默认关闭：4K SDR 仍压过 1080p 杜比视界。打开后 1080p DV 可以压过 4K SDR。</small>
            </span>
          </label>
          <label className="setting-check">
            <input
              type="checkbox"
              checked={sourceOn}
              onChange={(event) => setSourceOn(event.target.checked)}
            />
            <span>
              片源 / 压制类型参与排序
              <small>默认开启：Remux &gt; 蓝光 &gt; WEB-DL / 未标注 &gt; WEBRip &gt; HDTV &gt; 枪版。关掉后只比分辨率和 HDR。</small>
            </span>
          </label>
        </div>
      ) : null}

      <p className="quality-section-label">何时用更高画质替换</p>
      <p className="panel-note" style={{ marginBottom: 8 }}>
        三种入口都只替换<strong>严格更高</strong>的版本；成功转存并回读验证后才会删掉被替换的低画质文件。失败不会动旧文件。默认全部关闭，避免默默全库重写。
      </p>
      <div className="quality-upgrade-modes">
        <div className="quality-upgrade-mode is-always">
          <span>
            <strong>{QUALITY_UPGRADE_MODE_COPY[0].title}</strong>
            <small>{QUALITY_UPGRADE_MODE_COPY[0].summary}</small>
          </span>
          <span className="quality-upgrade-mode-tag">始终可用</span>
        </div>
        <label className="quality-upgrade-mode">
          <input
            type="checkbox"
            checked={upgrade}
            onChange={(event) => setUpgrade(event.target.checked)}
          />
          <span>
            <strong>{QUALITY_UPGRADE_MODE_COPY[1].title}</strong>
            <small>{QUALITY_UPGRADE_MODE_COPY[1].summary}</small>
          </span>
        </label>
        <label className="quality-upgrade-mode">
          <input
            type="checkbox"
            checked={patrolUpgrade}
            onChange={(event) => setPatrolUpgrade(event.target.checked)}
          />
          <span>
            <strong>{QUALITY_UPGRADE_MODE_COPY[2].title}</strong>
            <small>{QUALITY_UPGRADE_MODE_COPY[2].summary}</small>
          </span>
        </label>
      </div>

      <div className="setting-row" style={{ marginTop: 16 }}>
        <button type="button" className="primary-button" onClick={handleSave} disabled={isPending}>
          {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Check size={14} aria-hidden />}
          保存
        </button>
      </div>
      {result ? (
        <p className="panel-note" style={{ marginTop: 10 }}>
          {result}
        </p>
      ) : null}
    </div>
  );
}
