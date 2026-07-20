// A minimal FIFO async mutex: serializes async critical sections within one
// process. The pipeline passes (send/poll/fetch) do read-modify-write sequences
// against the store; a scheduled pass and a manual "Run now" (or two manual
// clicks) can otherwise interleave and race — double-processing an inbound, a
// lost `put()` on a 409 conflict, or over-quota sends. Routing every pass entry
// point through one shared Mutex makes them run one-at-a-time instead.
//
// Overlapping callers QUEUE (run in turn), they are not dropped: a "Run now"
// clicked mid-pass still runs, just after the in-flight pass finishes.

export class Mutex {
  // The tail of the promise chain. Each run() links its task after the current
  // tail and becomes the new tail. Errors are swallowed on the chain itself so
  // one failing task never blocks the queue — the error still reaches its caller.
  private tail: Promise<unknown> = Promise.resolve();

  /** Queue `task` behind any in-flight/waiting task; resolve (or reject) with its result. */
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
