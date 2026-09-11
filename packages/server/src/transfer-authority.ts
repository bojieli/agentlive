import { ProtocolError } from "@agentlive/protocol";

interface Entry {
  stillAuthorized: () => boolean;
  finish: (reason: unknown) => void;
}

/** Bounded registry of in-flight HTTP transfers authorized by revocable principals
 * (account sessions, device credentials, publisher credentials). Revocation points
 * call `revalidate`; entries whose request would no longer be authorized abort.
 * A coarse periodic sweep also covers expiry and any mutation made outside HTTP. */
export class TransferAuthority {
  private readonly entries = new Map<AbortController, Entry>();
  private sweep: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  constructor(
    private readonly options: { limit?: number; sweepMs?: number } = {},
  ) {}
  get size(): number {
    return this.entries.size;
  }
  /** Consumers must abort work on `signal` and call `close` after finishing. */
  register(stillAuthorized: () => boolean, parent?: AbortSignal) {
    if (this.closed)
      throw new ProtocolError("retry_later", "Server is closing");
    parent?.throwIfAborted();
    if (this.entries.size >= (this.options.limit ?? 4096))
      throw new ProtocolError("retry_later", "Too many active transfers");
    const stop = new AbortController();
    const finish = (reason: unknown) => {
      if (!this.entries.delete(stop)) return;
      parent?.removeEventListener("abort", cancel);
      if (!this.entries.size) {
        clearInterval(this.sweep);
        this.sweep = undefined;
      }
      stop.abort(reason);
    };
    const cancel = () => finish(parent!.reason);
    this.entries.set(stop, { stillAuthorized, finish });
    parent?.addEventListener("abort", cancel, { once: true });
    if (!this.sweep) {
      this.sweep = setInterval(
        () => this.revalidate(),
        this.options.sweepMs ?? 5000,
      );
      this.sweep.unref();
    }
    return {
      signal: stop.signal,
      close: () => finish(new Error("Transfer finished")),
    };
  }
  /** Abort every registered transfer whose authorization no longer holds. */
  revalidate(): void {
    for (const entry of [...this.entries.values()]) {
      let authorized = false;
      try {
        authorized = entry.stillAuthorized();
      } catch {
        /* A failing check is treated as lost authorization. */
      }
      if (!authorized)
        entry.finish(
          new ProtocolError("forbidden", "Transfer authorization ended"),
        );
    }
  }
  close(): void {
    this.closed = true;
    for (const entry of [...this.entries.values()])
      entry.finish(new ProtocolError("retry_later", "Server is closing"));
  }
}
