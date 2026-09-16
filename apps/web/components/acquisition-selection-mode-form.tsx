"use client";

import { useState, useTransition } from "react";
import { Check, LoaderCircle } from "lucide-react";
import { saveAcquisitionSelectionModeAction } from "../app/actions";
import { runAction } from "../lib/run-action";
import type { AcquisitionSelectionMode } from "@media-track/workflow";

const MODES: Array<{ key: AcquisitionSelectionMode; label: string; hint: string }> = [
  {
    key: "auto",
    label: "自动（推荐）",
    hint: "已配置 AI 模型时走智能 agent；否则用规则选片，没有 LLM key 也能获取。",
  },
  {
    key: "agent",
    label: "智能 agent",
    hint: "现有行为。需要可用的 LLM，语义判断片名、季集与转存。",
  },
  {
    key: "rules",
    label: "规则模式",
    hint: "无需 LLM。按画质阶梯 + 中文标题/文件名解析匹配候选，覆盖优先。",
  },
];

export function AcquisitionSelectionModeForm({ initial }: { initial: AcquisitionSelectionMode }) {
  const [isPending, startTransition] = useTransition();
  const [value, setValue] = useState<AcquisitionSelectionMode>(initial);
  const [result, setResult] = useState<string | null>(null);

  const handleSave = () => {
    startTransition(async () => {
      const r = await runAction(
        () => saveAcquisitionSelectionModeAction(value),
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
        控制片源查询之后<strong>如何选出要转存的候选</strong>。搜索（PanSou / Prowlarr）和转存校验轨道不变；规则模式优化画质阶梯、标题匹配与集数覆盖，不按搜索结果原始顺序盲转。
      </p>
      <div className="quality-choice-grid" role="radiogroup" aria-label="片源选片方式">
        {MODES.map((mode) => (
          <button
            key={mode.key}
            type="button"
            role="radio"
            aria-checked={value === mode.key}
            className={`quality-choice${value === mode.key ? " is-active" : ""}`}
            onClick={() => setValue(mode.key)}
          >
            <strong>{mode.label}</strong>
            <span>{mode.hint}</span>
          </button>
        ))}
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
