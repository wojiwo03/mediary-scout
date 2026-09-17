"use client";

import { Loader2 } from "lucide-react";
import type { AcquireStepView } from "../lib/acquire-steps";

/** Vertical 5-step acquisition list for the activity running card. */
export function AcquireStepList({ steps }: { steps: readonly AcquireStepView[] }) {
  return (
    <ol className="act-steps" aria-label="获取步骤">
      {steps.map((step) => (
        <li
          key={step.id}
          className={`act-step is-${step.state}`}
          {...(step.state === "current" ? { "aria-current": "step" as const } : {})}
        >
          <span className="act-step-mark" aria-hidden>
            {step.state === "current" ? <Loader2 size={12} className="act-spin" /> : null}
          </span>
          <div className="act-step-copy">
            <span className="act-step-label">{step.label}</span>
            {step.detail ? <span className="act-step-detail">{step.detail}</span> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Compact 5-dot stepper for the media-detail acquire badge. */
export function AcquireStepDots({ steps }: { steps: readonly AcquireStepView[] }) {
  return (
    <span className="acquire-step-dots" aria-hidden>
      {steps.map((step) => (
        <span key={step.id} className={`acquire-step-dot is-${step.state}`} />
      ))}
    </span>
  );
}
