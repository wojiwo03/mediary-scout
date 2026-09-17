/**
 * Bound nicety / cleanup I/O so a hung cloud listing cannot leave the run
 * `running` after the acquisition has already decided (UI stuck on 「正在收尾」).
 */

/** Wall-clock cap for post-decision work (landed-size, staging wipe, fold). */
export const POST_FINISH_IO_TIMEOUT_MS = 20_000;

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`POST_FINISH_IO_TIMEOUT: exceeded ${timeoutMs}ms`));
    }, timeoutMs);
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
