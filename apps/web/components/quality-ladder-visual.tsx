"use client";

import {
  describeQualityLadder,
  type QualityLadderPolicy,
} from "@media-track/workflow/quality-ladder";

export function QualityLadderVisual({ policy }: { policy: QualityLadderPolicy }) {
  const axes = describeQualityLadder(policy);
  return (
    <ol className="quality-ladder" aria-label="当前画质比较顺序">
      {axes.map((axis, index) => (
        <li
          key={axis.id}
          className={`quality-ladder-axis${axis.enabled ? "" : " is-off"}`}
        >
          <div className="quality-ladder-axis-head">
            <span className="quality-ladder-step">{index + 1}</span>
            <div>
              <strong>{axis.title}</strong>
              <small>{axis.hint}</small>
            </div>
          </div>
          <ol className="quality-ladder-rungs">
            {axis.rungs.map((rung) => (
              <li key={rung.key}>{rung.label}</li>
            ))}
          </ol>
        </li>
      ))}
    </ol>
  );
}
