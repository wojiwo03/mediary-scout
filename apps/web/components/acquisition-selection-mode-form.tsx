"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveAcquisitionSelectionModeAction } from "../app/actions";
import { runAction } from "../lib/run-action";
import type { AcquisitionSelectionMode } from "@media-track/workflow";
import { SettingsSaveRow } from "./settings-save-row";

const MODES: Array<{ key: AcquisitionSelectionMode; label: string; hint: string }> = [
  {
    key: "auto",
    label: "自动（推荐）",
    hint: "已配置 AI 时：解析明确走规则，拿不准再走 agent；没有 LLM 则只用规则选片。",
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
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [value, setValue] = useState<AcquisitionSelectionMode>(initial);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const dirty = value !== initial;

  const handleSave = () => {
    startTransition(async () => {
      const r = await runAction(
        () => saveAcquisitionSelectionModeAction(value),
        (msg) => {
          setResult({ ok: false, text: msg });
          setTimeout(() => setResult(null), 3000);
        },
      );
      if (!r.ok) return;
      const res = r.value;
      if (res.success) router.refresh();
      setResult({ ok: res.success, text: res.success ? "已保存" : (res.message ?? "保存失败") });
      setTimeout(() => setResult(null), 3000);
    });
  };

  return (
    <div className="settings-stack">
      <p className="panel-note">
        搜到片源之后<strong>怎么选出要转存的那一档</strong>。搜索和转存校验不变；规则模式按画质阶梯和中文标题/集数匹配，不按搜索结果原始顺序盲转。
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
      <SettingsSaveRow dirty={dirty} pending={isPending} result={result} onSave={handleSave} />
    </div>
  );
}
