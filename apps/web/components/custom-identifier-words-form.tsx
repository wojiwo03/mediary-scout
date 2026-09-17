"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveCustomIdentifierWordsAction } from "../app/actions";
import { runAction } from "../lib/run-action";
import { SettingsSaveRow } from "./settings-save-row";

const PLACEHOLDER = `# 一行一条；# 开头为注释
# 屏蔽（从标题去掉）
招募翻译校对
# 替换 from => to（空替换请保留 => 后的空格）
B-Blobal => B-Global
# 集数偏移 前 <> 后 >> EP±n
第 <> 集 >> EP+1
# 组合：替换且偏移
旧名 => 新名 && 第 <> 集 >> EP-1`;

export function CustomIdentifierWordsForm({ initial }: { initial: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [value, setValue] = useState(initial);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const dirty = value !== initial;

  const handleSave = () => {
    startTransition(async () => {
      const r = await runAction(
        () => saveCustomIdentifierWordsAction(value),
        (msg) => {
          setResult({ ok: false, text: msg });
          setTimeout(() => setResult(null), 4000);
        },
      );
      if (!r.ok) return;
      const res = r.value;
      if (res.success) router.refresh();
      setResult({ ok: res.success, text: res.success ? "已保存" : (res.message ?? "保存失败") });
      setTimeout(() => setResult(null), res.success ? 3000 : 6000);
    });
  };

  return (
    <div className="settings-stack">
      <p className="panel-note">
        规则选片和画质升级在读标题前会先套用这些词。内置词始终先生效，再轮到你保存的条目。一行一条；<code>#</code>{" "}
        开头当注释。
      </p>
      <ul className="settings-help-list">
        <li>
          <strong>屏蔽</strong>：整行当作正则，从标题中删除。例：<code>招募翻译校对</code>
        </li>
        <li>
          <strong>替换</strong>：<code>from =&gt; to</code>。空替换请保留 <code>=&gt;</code> 后的空格。例：
          <code>B-Blobal =&gt; B-Global</code>
        </li>
        <li>
          <strong>集偏移</strong>：<code>前 &lt;&gt; 后 &gt;&gt; EP±n</code>（也支持 <code>EP*n</code> /{" "}
          <code>EP/n</code>）。例：<code>第 &lt;&gt; 集 &gt;&gt; EP+1</code>
        </li>
      </ul>
      <textarea
        className="setting-textarea"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={PLACEHOLDER}
        rows={10}
        spellCheck={false}
        aria-label="自定义识别词"
        style={{ width: "100%", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
      />
      <SettingsSaveRow dirty={dirty} pending={isPending} result={result} onSave={handleSave} />
    </div>
  );
}
