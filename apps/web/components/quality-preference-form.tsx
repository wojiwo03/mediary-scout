"use client";

import { useState, useTransition } from "react";
import { Check, LoaderCircle } from "lucide-react";
import { saveQualityPreferenceAction } from "../app/actions";
import { runAction } from "../lib/run-action";

const QUALITIES = [
  { key: "any", label: "不限（默认）" },
  { key: "high", label: "高画质（≈4K）" },
  { key: "medium", label: "中画质（≈1080p）" },
] as const;

export function QualityPreferenceForm({
  initial,
  preferHdrOverResolution,
  upgradeOnReacquire,
}: {
  initial: string;
  preferHdrOverResolution: boolean;
  upgradeOnReacquire: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const [value, setValue] = useState(initial || "any");
  const [hdrFirst, setHdrFirst] = useState(preferHdrOverResolution);
  const [upgrade, setUpgrade] = useState(upgradeOnReacquire);
  const [result, setResult] = useState<string | null>(null);

  const handleSave = () => {
    startTransition(async () => {
      // 必须 catch:server action 会 throw(demo 门禁、运行时错误、网络中断),
      // 不 catch 就是未处理 rejection,界面上什么都不变(见 runAction 注释)。
      // 业务错误(success:false)仍走下方原逻辑;这里只拦异常。
      const r = await runAction(
        () =>
          saveQualityPreferenceAction({
            quality: value,
            preferHdrOverResolution: hdrFirst,
            upgradeOnReacquire: upgrade,
          }),
        (msg) => {
          setResult(`❌ ${msg}`);
          setTimeout(() => setResult(null), 3000);
        },
      );
      if (!r.ok) return;
      const res = r.value;
      setResult(res.success ? "✅ 保存成功" : `❌ ${res.message ?? "保存失败"}`);
      setTimeout(() => setResult(null), 3000);
    });
  };

  return (
    <div className="push-form">
      <p className="panel-note" style={{ marginBottom: 12 }}>
        偏好的画质档位会作为「召回后选片优先级」传给
        AI；找不到目标画质时仍优先保证入库完整（覆盖优先）。画质 / DV / HDR
        不进搜索关键词，只从预搜候选标题里挑。
      </p>
      <div className="setting-row">
        <select
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className="setting-control"
          aria-label="偏好画质"
        >
          {QUALITIES.map((quality) => (
            <option key={quality.key} value={quality.key}>
              {quality.label}
            </option>
          ))}
        </select>
        <button type="button" className="primary-button" onClick={handleSave} disabled={isPending}>
          {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Check size={14} aria-hidden />}
          保存
        </button>
      </div>
      <label className="setting-check">
        <input
          type="checkbox"
          checked={hdrFirst}
          onChange={(event) => setHdrFirst(event.target.checked)}
        />
        <span>
          HDR 优先于分辨率
          <small>默认关闭：同分辨率再按 DV &gt; HDR10+ &gt; HDR10 &gt; SDR；打开后 1080p DV 可以压过 4K SDR。</small>
        </span>
      </label>
      <label className="setting-check">
        <input
          type="checkbox"
          checked={upgrade}
          onChange={(event) => setUpgrade(event.target.checked)}
        />
        <span>
          重新获取时允许画质升级
          <small>默认关闭。打开后，对已入库标题再点获取会排队替换任务（仅当候选严格更高）。详情页也有显式「升级画质」。</small>
        </span>
      </label>
      {result ? (
        <p className="panel-note" style={{ marginTop: 10 }}>
          {result}
        </p>
      ) : null}
    </div>
  );
}
