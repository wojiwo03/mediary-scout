"use client";

import { useState, useTransition } from "react";
import { Check, LoaderCircle } from "lucide-react";
import { saveCustomIdentifierWordsAction } from "../app/actions";
import { runAction } from "../lib/run-action";

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
  const [isPending, startTransition] = useTransition();
  const [value, setValue] = useState(initial);
  const [result, setResult] = useState<string | null>(null);

  const handleSave = () => {
    startTransition(async () => {
      const r = await runAction(
        () => saveCustomIdentifierWordsAction(value),
        (msg) => {
          setResult(`❌ ${msg}`);
          setTimeout(() => setResult(null), 4000);
        },
      );
      if (!r.ok) return;
      const res = r.value;
      setResult(res.success ? "✅ 保存成功" : `❌ ${res.message ?? "保存失败"}`);
      setTimeout(() => setResult(null), res.success ? 3000 : 6000);
    });
  };

  return (
    <div className="push-form">
      <p className="panel-note" style={{ marginBottom: 12 }}>
        规则选片与画质升级在解析标题前会先套用这些识别词。内置词始终先生效，再应用你保存的条目。一行一条，可直接粘贴多行；以{" "}
        <code>#</code> 开头的行当作注释保留。
      </p>
      <ul className="panel-note" style={{ margin: "0 0 12px", paddingLeft: 18, lineHeight: 1.6 }}>
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
