import { openRecordingHistory, SubscriberClient } from "@agentlive/client";
import { apply, initialState } from "@agentlive/playback";
import type { StoredEvent } from "@agentlive/protocol";
/** A bounded browser receipt buffer. Reload starts from zero until persistent browser caching is added. */
export class BrowserSession {
  private events: StoredEvent[] = [];
  private bytes = 0;
  private readonly objectOrder = new Map<string, number>();
  order(key: string) {
    return this.objectOrder.get(key) ?? Number.MAX_SAFE_INTEGER;
  }
  private stop = new AbortController();
  private active = true;
  private connection: AbortController | undefined;
  private wake: (() => void) | undefined;
  /** Hidden pages retain their prefix and playback intent, without relying on a background socket. */
  setActive(active: boolean) {
    if (this.stop.signal.aborted || this.active === active) return;
    this.active = active;
    this.connection?.abort();
    this.wake?.();
  }
  /** Revalidate authorization and history through a fresh subscription; never overlap receipt loops. */
  reconnect() {
    if (!this.stop.signal.aborted && this.active) this.connection?.abort();
  }
  private async receive(client: SubscriberClient, signal: AbortSignal) {
    while (!signal.aborted) {
      if (!this.active) {
        await new Promise<void>((resolve) => {
          const wake = () => {
            signal.removeEventListener("abort", wake);
            this.wake = undefined;
            resolve();
          };
          this.wake = wake;
          signal.addEventListener("abort", wake, { once: true });
          if (signal.aborted || this.active) wake();
        });
        continue;
      }
      const connection = new AbortController();
      this.connection = connection;
      try {
        await client.run(AbortSignal.any([signal, connection.signal]));
      } finally {
        this.connection = undefined;
      }
    }
  }
  private task: Promise<void> = Promise.resolve();
  state = initialState();
  time = 0;
  follow = true;
  status = "connecting";
  error = "";
  private constructor(
    readonly title: string,
    readonly streamId: string,
    readonly credential: string,
    private readonly changed: () => void,
  ) {}
  get received() {
    return this.events.length;
  }
  get duration() {
    return this.events.at(-1)?.timelineMs ?? 0;
  }
  static async open(
    streamId: string,
    credential: string,
    signal: AbortSignal,
    changed: () => void,
    origin = location.origin,
  ) {
    const metadata = (
      await openRecordingHistory({
        serverOrigin: origin,
        streamId,
        ...(credential ? { credential } : {}),
        signal,
      })
    ).metadata;
    signal.throwIfAborted();
    const session = new BrowserSession(
      metadata.title,
      streamId,
      credential,
      changed,
    );
    const client = new SubscriberClient({
      serverOrigin: origin,
      cursor: { streamId, revision: metadata.revision, serverSeq: 0 },
      ...(credential ? { credential } : {}),
      onStatus: (status) => {
        session.status =
          status === "stopped" &&
          !session.stop.signal.aborted &&
          !signal.aborted
            ? session.active
              ? "reconnecting"
              : "suspended"
            : status;
        changed();
      },
      commit: async (events) => {
        let sequence = session.received,
          time = session.duration;
        const added = events.reduce((size, event) => {
          if (event.serverSeq !== ++sequence || event.timelineMs < time)
            throw new Error("Recording history is not ordered");
          time = event.timelineMs;
          return size + new TextEncoder().encode(JSON.stringify(event)).length;
        }, 0);
        if (session.bytes + added > 64 * 1024 * 1024)
          throw new Error(
            "This browser viewer has reached its 64 MiB recording limit.",
          );
        for (const event of events) {
          const payload = event.content.payload as Record<string, unknown>;
          for (const [kind, field] of Object.entries({
            messages: "messageId",
            tools: "toolId",
            changes: "changeId",
            artifacts: "artifactId",
            agents: "agentId",
            tasks: "taskId",
            goals: "goalId",
            interactions: "interactionId",
            plans: "planId",
            monitors: "monitorId",
          })) {
            const id = payload[field];
            if (
              typeof id === "string" &&
              !session.objectOrder.has(`${kind}/${id}`)
            )
              session.objectOrder.set(`${kind}/${id}`, event.serverSeq);
          }
        }
        session.events.push(...events);
        session.bytes += added;
        if (session.follow) {
          try {
            session.seek(session.duration, true);
          } catch (error) {
            session.follow = false;
            session.error =
              error instanceof Error ? error.message : "Playback failed";
            changed();
          }
        } else changed();
      },
    });
    session.task = session
      .receive(client, AbortSignal.any([signal, session.stop.signal]))
      .catch((error: unknown) => {
        session.status = "error";
        session.error =
          error instanceof Error
            ? error.message
            : "Unable to receive recording";
        changed();
      })
      .finally(() => {
        if (!session.error) {
          session.status = "stopped";
          changed();
        }
      });
    return session;
  }
  seek(time: number, follow = false) {
    if (!Number.isFinite(time) || time < 0)
      throw new RangeError("Invalid playback position");
    const target = Math.min(time, this.duration);
    let state = target < this.time ? initialState() : this.state;
    while (state.appliedSeq < this.events.length) {
      const event = this.events[state.appliedSeq]!;
      if (event.timelineMs > target) break;
      state = apply(state, event);
    }
    this.state = state;
    this.time = target;
    this.follow = follow;
    this.changed();
  }
  close() {
    this.stop.abort();
    return this.task;
  }
}
