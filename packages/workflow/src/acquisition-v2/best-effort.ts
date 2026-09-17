/**
 * Bound nicety / cleanup I/O so a hung cloud listing cannot leave the run
 * `running` after the acquisition has already decided (UI stuck on 「正在收尾」).
 */

/** Wall-clock cap for post-decision work (landed-size, staging wipe, fold). */
export const POST_FINISH_IO_TIMEOUT_MS = 20_000;

/**
 * Pre-search orientation (inspectTargetDir of a just-created season dir).
 * Shorter than wrap-up: first-acquire must not sit on an empty listing for 20s
 * before it can even search — and a hung list must not pin `running`.
 */
export const ORIENTATION_IO_TIMEOUT_MS = 800;

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`POST_FINISH_IO_TIMEOUT: exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    // Fire-and-forget wrap-up must not keep the process / test runner alive.
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Run `work` up to `timeoutMs`; swallow timeout and any other failure. */
export async function bestEffort(
  work: () => Promise<unknown>,
  timeoutMs: number = POST_FINISH_IO_TIMEOUT_MS,
): Promise<void> {
  try {
    await withTimeout(Promise.resolve().then(work), timeoutMs);
  } catch {
    // nicety / cleanup — never mask the real outcome
  }
}

/**
 * Start bounded cleanup without awaiting it. The worker must persist
 * `no_coverage` / leave `running` even when 115 delete/list never returns.
 */
export function kickoffBestEffort(
  work: () => Promise<unknown>,
  timeoutMs: number = POST_FINISH_IO_TIMEOUT_MS,
): void {
  void bestEffort(work, timeoutMs);
}
