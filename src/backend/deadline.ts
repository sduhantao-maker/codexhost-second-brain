/**
 * Time limits for work the backend waits on. codexhost gives every call to the backend 10 seconds
 * and stopping it 1 second, and kills a backend that overruns: a call waits at most HANDLER_BUDGET_MS
 * in all, and longer work goes on in the background.
 */

/** What a call to the backend may wait for in all, with room left before codexhost's 10 s. */
export const HANDLER_BUDGET_MS = 8_000;

/** Thrown when a wait ran out of time; the work waited for may still be going on. */
export class DeadlineError extends Error {
  constructor(message = "no answer in time") {
    super(message);
    this.name = "DeadlineError";
  }
}

/**
 * Settles as `promise` does, or rejects with a DeadlineError once `ms` have passed. The promise
 * goes on either way; a failure of it after the time ran out is ignored here.
 */
export function within<T>(promise: Promise<T>, ms: number, error: () => Error = () => new DeadlineError()): Promise<T> {
  promise.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(error()), Math.max(0, ms));
    timer.unref?.();
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

/** What everything under way is stopped with when the backend stops. */
export class StoppedError extends Error {
  constructor() {
    super("the backend is stopping");
    this.name = "StoppedError";
  }
}

/** Whether a failure is (or was caused by) the backend stopping. */
export function isStopped(error: unknown): boolean {
  for (let current = error, depth = 0; current instanceof Error && depth < 4; current = current.cause, depth += 1) if (current instanceof StoppedError) return true;
  return false;
}

/** `run`, cut off when `signal` aborts: the call then fails at once with the signal's reason (the work itself is left to end on its own). */
export function untilAborted<A extends unknown[], T>(run: (...args: A) => Promise<T>, signal: AbortSignal): (...args: A) => Promise<T> {
  return (...args) => {
    if (signal.aborted) return Promise.reject(signal.reason as Error);
    return new Promise<T>((resolve, reject) => {
      const stop = () => reject(signal.reason as Error);
      signal.addEventListener("abort", stop, { once: true });
      run(...args)
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", stop));
    });
  };
}

/** Milliseconds left of a budget that started at `startedAt`. */
export function leftOf(startedAt: number, budget = HANDLER_BUDGET_MS, now = Date.now()): number {
  return Math.max(0, budget - (now - startedAt));
}
