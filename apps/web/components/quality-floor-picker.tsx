"use client";

import { Check, ChevronDown } from "lucide-react";
import { useState } from "react";
import {
  formatQualityFloorLabel,
  type QualityFloorBand,
  type QualityFloorSetting,
} from "@media-track/workflow/quality-ladder";

export type QualityFloorChoice = "default" | QualityFloorSetting;

const OVERRIDE_OPTIONS: Array<{ key: QualityFloorChoice; label: string; hint: string }> = [
  { key: "default", label: "用全局默认", hint: "沿用设置里的「低于此画质不下载」" },
  { key: "any", label: "不限", hint: "本次可下载更低画质，不套用全局下限" },
  { key: "720p", label: "720p 起", hint: "低于 720p 不下载" },
  { key: "1080p", label: "1080p 起", hint: "低于 1080p 不下载，留给巡检" },
  { key: "4k", label: "4K 起", hint: "低于 4K 不下载，留给巡检" },
];

export function qualityFloorActionValue(choice: QualityFloorChoice): QualityFloorSetting | undefined {
  return choice === "default" ? undefined : choice;
}

export function QualityFloorPicker({
  globalFloor,
  value,
  onChange,
  disabled = false,
}: {
  globalFloor?: QualityFloorBand | undefined;
  value: QualityFloorChoice;
  onChange: (value: QualityFloorChoice) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const globalLabel = formatQualityFloorLabel(globalFloor);
  const selected = OVERRIDE_OPTIONS.find((option) => option.key === value) ?? OVERRIDE_OPTIONS[0]!;
  const summary =
    value === "default" ? `下限：全局（${globalLabel}）` : `下限：${selected.label}`;

  return (
    <div className="acquire-floor">
      <button
        className="acquire-floor-toggle"
        type="button"
        aria-label="选择画质下限"
        aria-expanded={open}
        title="低于此画质不下载。用全局默认，或只改这一次。"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{summary}</span>
        <ChevronDown size={13} aria-hidden />
      </button>
      {open ? (
        <ul className="acquire-floor-list" role="menu">
          {OVERRIDE_OPTIONS.map((option) => (
            <li key={option.key} role="none">
              <button
                role="menuitemradio"
                aria-checked={value === option.key}
                type="button"
                onClick={() => {
                  onChange(option.key);
                  setOpen(false);
                }}
              >
                {value === option.key ? <Check size={13} aria-hidden /> : <span className="menu-spacer" />}
                <span>
                  <strong>
                    {option.key === "default" ? `用全局默认（${globalLabel}）` : option.label}
                  </strong>
                  <small>{option.hint}</small>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
