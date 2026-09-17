"use client";

import { Check, LoaderCircle } from "lucide-react";

export function SettingsSaveRow({
  dirty,
  pending,
  result,
  onSave,
}: {
  dirty: boolean;
  pending: boolean;
  result: { ok: boolean; text: string } | null;
  onSave: () => void;
}) {
  return (
    <>
      <div className="setting-row settings-save-row">
        <button
          type="button"
          className="primary-button"
          onClick={onSave}
          disabled={pending || !dirty}
          title={dirty || pending ? "保存当前更改" : "没有未保存的更改"}
        >
          {pending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Check size={14} aria-hidden />}
          {pending ? "保存中" : dirty ? "保存更改" : "保存"}
        </button>
        {!dirty && !pending && !result ? <span className="settings-save-hint">没有未保存的更改</span> : null}
      </div>
      {result ? (
        <p className={`save-result ${result.ok ? "is-ok" : "is-err"}`} role="status">
          {result.text}
        </p>
      ) : null}
    </>
  );
}
