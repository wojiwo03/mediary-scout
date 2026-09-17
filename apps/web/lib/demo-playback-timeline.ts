export interface PlaybackStep {
  label: string;
  /** Milliseconds from playback start when this step becomes active. */
  atMs: number;
  /** Progress bar value (0–100) at this step. */
  progress: number;
  /** Worker phase so the demo reuses the same 5-step UI mapper as live runs. */
  phase: "search" | "pick" | "transfer" | "verify" | "organize" | "mark" | "finalize";
}

/** A canned, believable agent-acquisition timeline for the read-only demo. Pure
 *  client-side playback — drives a scripted progress bar + action ticker without
 *  ever touching the DB / a real workflow. */
export const DEMO_PLAYBACK_STEPS: PlaybackStep[] = [
  { label: "搜索资源…", atMs: 0, progress: 8, phase: "search" },
  { label: "正在按规则筛选候选…", atMs: 6000, progress: 20, phase: "pick" },
  { label: "转存到网盘…", atMs: 12000, progress: 48, phase: "transfer" },
  { label: "验证落盘文件…", atMs: 20000, progress: 80, phase: "verify" },
  { label: "正在收尾…", atMs: 24000, progress: 97, phase: "finalize" },
  { label: "入库完成", atMs: 27000, progress: 100, phase: "finalize" },
];

export const DEMO_PLAYBACK_TOTAL_MS = DEMO_PLAYBACK_STEPS[DEMO_PLAYBACK_STEPS.length - 1]!.atMs;

/** The active step at time t (ms): the last step whose atMs <= t. */
export function playbackStateAt(t: number, steps: PlaybackStep[] = DEMO_PLAYBACK_STEPS): PlaybackStep {
  let current = steps[0]!;
  for (const step of steps) {
    if (t >= step.atMs) {
      current = step;
    }
  }
  return current;
}
