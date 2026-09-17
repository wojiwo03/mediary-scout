"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { savePreferredLanguageAction } from "../app/actions";
import { runAction } from "../lib/run-action";
import { SettingsSaveRow } from "./settings-save-row";

const LANGUAGES = [
  { key: "中文", label: "中文（默认）" },
  { key: "English", label: "English" },
  { key: "日本語", label: "日本語" },
  { key: "any", label: "不限（最大化覆盖）" },
] as const;

export function PreferredLanguageForm({ initial }: { initial: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [value, setValue] = useState(initial || "中文");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const dirty = value !== (initial || "中文");

  const handleSave = () => {
    startTransition(async () => {
      // 必须 catch:server action 会 throw(demo 门禁、运行时错误、网络中断),
      // 不 catch 就是未处理 rejection,界面上什么都不变(见 runAction 注释)。
      // 业务错误(success:false)仍走下方原逻辑;这里只拦异常。
      const r = await runAction(
        () => savePreferredLanguageAction(value),
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
        资源用什么语言起名，就更可能带那个语言的字幕。规则选片和智能选片都会优先你能看的语言。
      </p>
      <div className="setting-row">
        <select
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className="setting-control"
          aria-label="偏好语言"
        >
          {LANGUAGES.map((lang) => (
            <option key={lang.key} value={lang.key}>
              {lang.label}
            </option>
          ))}
        </select>
      </div>
      <SettingsSaveRow dirty={dirty} pending={isPending} result={result} onSave={handleSave} />
    </div>
  );
}
