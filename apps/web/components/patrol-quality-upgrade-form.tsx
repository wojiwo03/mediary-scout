"use client";

import { useState, useTransition } from "react";
import { Check, LoaderCircle } from "lucide-react";
import { savePatrolQualityUpgradeAction } from "../app/actions";
import { runAction } from "../lib/run-action";

export function PatrolQualityUpgradeForm({ initial }: { initial: boolean }) {
  const [isPending, startTransition] = useTransition();
  const [value, setValue] = useState(initial);
  const [result, setResult] = useState<string | null>(null);

  const handleSave = () => {
    startTransition(async () => {
      const r = await runAction(
        () => savePatrolQualityUpgradeAction(value),
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
    <div className={`patrol-task-card${value ? " is-on" : ""}`}>
      <label className="setting-check" style={{ margin: 0 }}>
        <input type="checkbox" checked={value} onChange={(event) => setValue(event.target.checked)} />
        <span>
          <strong>定时画质升级</strong>
          <small>
            对已入库电影 / 已有正片的季寻找严格更高的版本。与左侧追更共用上面的巡检时间，不另开定时器。默认关闭。
          </small>
        </span>
      </label>
      <div className="setting-row" style={{ marginTop: 8 }}>
        <button type="button" className="primary-button" onClick={handleSave} disabled={isPending}>
          {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Check size={14} aria-hidden />}
          保存
        </button>
      </div>
      {result ? (
        <p className="panel-note" style={{ marginTop: 8 }}>
          {result}
        </p>
      ) : null}
    </div>
  );
}
