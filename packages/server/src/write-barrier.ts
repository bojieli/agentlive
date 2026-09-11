import { AsyncLocalStorage } from "node:async_hooks";
import { ProtocolError } from "@agentlive/protocol";

/** Process-wide admission gate for durable server-state mutations.
 *
 * Mutations run as shared holders. An exclusive holder (online backup) stops
 * admitting new shared holders, waits for already admitted holders to finish,
 * then runs alone. Shared work started inside an admitted mutation is reentrant,
 * so nested store/session/ledger calls cannot deadlock against a pending
 * exclusive holder. Reads never enter the gate. */
export class WriteBarrier {
  private active = 0;
  private held = false;
  private readonly waiting: (() => void)[] = [];
  private idle: (() => void) | undefined;
  private readonly context = new AsyncLocalStorage<{ admitted: boolean }>();

  /** True while an exclusive holder is pending or running. */
  get paused(): boolean {
    return this.held;
  }

  async shared<T>(operation: () => Promise<T>): Promise<T> {
    if (this.context.getStore()?.admitted) return operation();
    while (this.held)
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    // Continuations that outlive this mutation must not inherit admission.
    const scope = { admitted: true };
    try {
      return await this.context.run(scope, operation);
    } finally {
      scope.admitted = false;
      if (--this.active === 0) this.idle?.();
    }
  }

  /** Fire-and-forget mutations scheduled from inside an admitted mutation must
   * be admitted on their own; they may run after the parent has finished. */
  detached<T>(operation: () => Promise<T>): Promise<T> {
    return this.context.exit(() => this.shared(operation));
  }

  /** Run `operation` with no admitted mutation in progress. Always reopens
   * admission, including after cancellation or failure. */
  async exclusive<T>(
    operation: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    signal.throwIfAborted();
    if (this.held)
      throw new ProtocolError(
        "retry_later",
        "Another operation holds the server write barrier",
      );
    this.held = true;
    try {
      if (this.active)
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            this.idle = undefined;
            reject(signal.reason);
          };
          this.idle = () => {
            this.idle = undefined;
            signal.removeEventListener("abort", abort);
            resolve();
          };
          signal.addEventListener("abort", abort, { once: true });
        });
      signal.throwIfAborted();
      return await operation();
    } finally {
      this.held = false;
      for (const resume of this.waiting.splice(0)) resume();
    }
  }
}
