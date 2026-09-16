"use client";

import { Check, DownloadCloud, Layers, LoaderCircle, Sparkles } from "lucide-react";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  requestQualityUpgradeAction,
  requestRemainingAction,
  requestSeasonAction,
  type RequestTrackingActionResult,
} from "../app/actions";
import { runAction } from "../lib/run-action";
import { useAcquisitionLock } from "./acquisition-lock";
import { AcquireResultNotice, isLockedResult } from "./request-state";
import { isDemoModeClient } from "../lib/demo-mode";
import { DemoAcquirePlayback } from "./demo-acquire-playback";
import type { DemoAcquisitionEntry } from "../lib/demo-session";
import { useDemoAcquiredTmdbIds } from "../lib/use-demo-session";

export function RequestSeasonButton({
  tmdbId,
  seasonNumber,
  storageId,
  titleAcquiring = false,
  demoEntry,
}: {
  tmdbId: number;
  seasonNumber: number;
  /** Tree model: the active workspace drive — acquisition lands HERE. REQUIRED
   *  (value may be undefined = primary) so the workspace is always threaded. */
  storageId: string | undefined;
  /** Server truth: this title already has an acquisition run in flight. */
  titleAcquiring?: boolean;
  /** Demo only: recorded to the session library when the scripted playback ends. */
  demoEntry?: DemoAcquisitionEntry | undefined;
}) {
  const router = useRouter();
  const lock = useAcquisitionLock();
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<RequestTrackingActionResult | null>(null);
  const scope = `season-${seasonNumber}`;
  const isLocked = isLockedResult(result);
  const mine = lock?.acquiring === scope;
  const othersAcquiring = (lock != null && lock.acquiring != null && !mine) || titleAcquiring;
  const inFlight = isPending || mine;
  const demo = isDemoModeClient();
  const [demoPlaying, setDemoPlaying] = useState(false);
  const acquiredIds = useDemoAcquiredTmdbIds();

  if (demo && demoPlaying) {
    return <DemoAcquirePlayback entry={demoEntry} />;
  }

  if (demo && acquiredIds.has(tmdbId)) {
    return (
      <span className="hub-badge tone-green">
        <Check size={13} aria-hidden />
        已获取
      </span>
    );
  }

  return (
    <>
      <button
        className="season-request-button"
        type="button"
        title={
          othersAcquiring && !inFlight ? "该剧正在获取中，请稍候" : result?.message ?? `获取第 ${seasonNumber} 季`
        }
        disabled={isPending || isLocked || othersAcquiring}
        onClick={() => {
          if (demo) {
            setDemoPlaying(true);
            return;
          }
          lock?.lock(scope);
          startTransition(async () => {
            const r = await runAction(
              () => requestSeasonAction({ tmdbId, seasonNumber, storageId }),
              (msg) => {
                setResult({ status: "unsupported", message: msg });
                // 必须 refresh:lock.acquiring 是前端 state,靠重挂载重置。
                // 失败不刷新,锁永远卡住,兄弟按钮全禁用(Copilot round 1)。
                router.refresh();
              },
            );
            if (!r.ok) return;
            setResult(r.value);
            router.refresh();
          });
        }}
      >
        {inFlight ? (
          <LoaderCircle size={13} className="spin" aria-hidden />
        ) : isLocked ? (
          <Check size={13} aria-hidden />
        ) : (
          <DownloadCloud size={13} aria-hidden />
        )}
        {inFlight ? "获取中" : isLocked ? "已请求" : "获取本季"}
      </button>
      <AcquireResultNotice result={result} />
    </>
  );
}

export function RequestRemainingButton({
  tmdbId,
  label,
  storageId,
  titleAcquiring = false,
  demoEntry,
}: {
  tmdbId: number;
  label: string;
  /** Tree model: the active workspace drive — acquisition lands HERE. REQUIRED
   *  (value may be undefined = primary) so the workspace is always threaded. */
  storageId: string | undefined;
  /** Server truth: this title already has an acquisition run in flight. */
  titleAcquiring?: boolean;
  /** Demo only: recorded to the session library when the scripted playback ends. */
  demoEntry?: DemoAcquisitionEntry | undefined;
}) {
  const router = useRouter();
  const lock = useAcquisitionLock();
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<RequestTrackingActionResult | null>(null);
  const scope = "remaining";
  const isLocked = isLockedResult(result);
  const mine = lock?.acquiring === scope;
  const othersAcquiring = (lock != null && lock.acquiring != null && !mine) || titleAcquiring;
  const inFlight = isPending || mine;
  const demo = isDemoModeClient();
  const [demoPlaying, setDemoPlaying] = useState(false);
  const acquiredIds = useDemoAcquiredTmdbIds();

  if (demo && demoPlaying) {
    return <DemoAcquirePlayback entry={demoEntry} />;
  }

  if (demo && acquiredIds.has(tmdbId)) {
    return (
      <span className="hub-badge tone-green">
        <Check size={13} aria-hidden />
        已获取
      </span>
    );
  }

  return (
    <>
      <button
        className="primary-button"
        type="button"
        title={othersAcquiring && !inFlight ? "该剧正在获取中，请稍候" : result?.message ?? label}
        disabled={isPending || isLocked || othersAcquiring}
        onClick={() => {
          if (demo) {
            setDemoPlaying(true);
            return;
          }
          lock?.lock(scope);
          startTransition(async () => {
            const r = await runAction(
              () => requestRemainingAction({ tmdbId, storageId }),
              (msg) => {
                setResult({ status: "unsupported", message: msg });
                // 同上一处:失败必须 refresh 清锁,否则 sibling 全禁用。
                router.refresh();
              },
            );
            if (!r.ok) return;
            setResult(r.value);
            router.refresh();
          });
        }}
      >
        {inFlight ? (
          <LoaderCircle size={14} className="spin" aria-hidden />
        ) : isLocked ? (
          <Check size={14} aria-hidden />
        ) : (
          <Layers size={14} aria-hidden />
        )}
        {inFlight ? "获取中" : isLocked ? "已请求" : label}
      </button>
      <AcquireResultNotice result={result} />
    </>
  );
}

export function QualityUpgradeButton({
  candidateId,
  storageId,
  titleAcquiring = false,
}: {
  candidateId: string;
  storageId: string | undefined;
  titleAcquiring?: boolean;
}) {
  const router = useRouter();
  const lock = useAcquisitionLock();
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<RequestTrackingActionResult | null>(null);
  const scope = `upgrade-${candidateId}`;
  const isLocked = isLockedResult(result);
  const mine = lock?.acquiring === scope;
  const othersAcquiring = (lock != null && lock.acquiring != null && !mine) || titleAcquiring;
  const inFlight = isPending || mine;
  const demo = isDemoModeClient();

  if (demo) {
    return null;
  }

  return (
    <>
      <button
        className="season-request-button"
        type="button"
        title={othersAcquiring && !inFlight ? "该剧正在获取中，请稍候" : (result?.message ?? "按偏好寻找严格更高的版本并替换")}
        disabled={isPending || isLocked || othersAcquiring}
        onClick={() => {
          lock?.lock(scope);
          startTransition(async () => {
            const r = await runAction(
              () => requestQualityUpgradeAction({ candidateId, storageId }),
              (msg) => {
                setResult({ status: "unsupported", message: msg });
                router.refresh();
              },
            );
            if (!r.ok) return;
            setResult(r.value);
            router.refresh();
          });
        }}
      >
        {inFlight ? (
          <LoaderCircle size={13} className="spin" aria-hidden />
        ) : isLocked ? (
          <Check size={13} aria-hidden />
        ) : (
          <Sparkles size={13} aria-hidden />
        )}
        {inFlight ? "升级中" : isLocked ? "已请求" : "升级画质"}
      </button>
      <AcquireResultNotice result={result} />
    </>
  );
}

export function QualityUpgradePanel({
  candidateId,
  storageId,
  titleAcquiring = false,
  targetLabel,
}: {
  candidateId: string;
  storageId: string | undefined;
  titleAcquiring?: boolean;
  targetLabel: string;
}) {
  return (
    <div className="quality-upgrade-panel">
      <p className="quality-upgrade-copy">
        目标偏好：{targetLabel}
        <small>按阶梯寻找严格更高的版本替换现有文件。找不到或转存失败都不会删除旧文件。</small>
      </p>
      <QualityUpgradeButton
        candidateId={candidateId}
        storageId={storageId}
        titleAcquiring={titleAcquiring}
      />
    </div>
  );
}
