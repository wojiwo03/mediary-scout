"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, LoaderCircle } from "lucide-react";
import { savePatrolQualityUpgradeAction } from "../app/actions";
import {
  emitPatrolQualityUpgradeChange,
  PATROL_QUALITY_UPGRADE_EVENT,
} from "../lib/patrol-quality-upgrade-sync";
import { runAction } from "../lib/run-action";

export function PatrolQualityUpgradeForm({ initial }: { initial: boolean }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [value, setValue] = useState(initial);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    setValue(initial);
  }, [initial]);

  useEffect(() => {
    const onChange = (event: Event) => {
      const enabled = (event as CustomEvent<boolean>).detail;
      if (typeof enabled === "boolean") {
        setValue(enabled);
      }
    };
    window.addEventListener(PATROL_QUALITY_UPGRADE_EVENT, onChange);
    return () => window.removeEventListener(PATROL_QUALITY_UPGRADE_EVENT, onChange);
  }, []);

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
      if (res.success) {
        emitPatrolQualityUpgradeChange(value);
        router.refresh();
      }
      setResult(res.success ? "✅ 保存成功" : `❌ ${res.message ?? "保存失败"}`);
      setTimeout(() => setResult(null), 3000);
    });
  };

  return (
    <>
      <div className={`patrol-task-card${value ? " is-on" : ""}`}>
        <label className="setting-check" style={{ margin: 0 }}>
          <input type="checkbox" checked={value} onChange={(event) => setValue(event.target.checked)} />
          <span>
            <strong>定时画质升级</strong>
            <small>
              对已入库电影 / 已有正片的季寻找严格更高版本。与左侧追更共用巡检时间，不另开定时器。默认关闭；失败不删旧文件。
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
      <p className="panel-note patrol-upgrade-note">
        {value
          ? "两项都会在上述时间点运行。画质升级只替换严格更高的版本；失败不会删除旧文件。盘内文件已达偏好顶部时本轮会跳过，避免空跑。"
          : "当前只跑追更补集，不会替换已入库画质。"}
      </p>
    </>
  );
}
