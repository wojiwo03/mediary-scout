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
    <div className="push-form" style={{ marginTop: 16 }}>
      <p className="panel-note" style={{ marginBottom: 12 }}>
        定时巡检默认只补缺（缺集 / 未入库），不会因为库里已有更低画质就全库重写。只有显式打开下面这项，巡检才会扫已完成的剧/已入库电影并尝试升级。
      </p>
      <label className="setting-check">
        <input type="checkbox" checked={value} onChange={(event) => setValue(event.target.checked)} />
        <span>
          巡检时也升级画质
          <small>默认关闭。打开后，已完结季和已入库电影也会进入巡检升级扫描。</small>
        </span>
      </label>
      <div className="setting-row" style={{ marginTop: 12 }}>
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
