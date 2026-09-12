import { delay } from "@agentlive/client/transport";
import type { PublisherJournal } from "@agentlive/publisher";

/**
 * Resolve once `ensureRemote` has durably bound a remote recording.
 *
 * Capture never waits for this: events journaled before the binding exist carry
 * a placeholder stream identity and are bound when they are read back. Only the
 * things that genuinely address the remote recording — `onReady`, attachment
 * uploads — wait here.
 */
/**
 * Wait for a binding that is expected to arrive, bounded so a shutdown can
 * never hang: the caller's signal still cancels, and an unreachable server
 * gives up after `timeoutMs` leaving the captured events for the next attach.
 */
export async function settleBinding(
  journal: PublisherJournal,
  signal: AbortSignal,
  timeoutMs = 30_000,
): Promise<void> {
  if (journal.identity.streamId) return;
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  await whenBound(journal, deadline).catch(() => {});
}
export async function whenBound(
  journal: PublisherJournal,
  signal: AbortSignal,
): Promise<{ streamId: string; revision: string }> {
  while (!journal.identity.streamId) await delay(25, signal);
  const identity = journal.identity;
  return { streamId: identity.streamId!, revision: identity.revision! };
}

/**
 * Report the recording identity as soon as it exists, without blocking capture
 * and without depending on the publisher still running: `flush` reports a
 * binding that completed while the publisher was shutting down. Reporting is
 * idempotent, so a caller learns its recording exactly once however the run
 * ended. A failing `onReady` aborts the publisher, as it did when it ran inline.
 */
export function reportWhenBound(
  journal: PublisherJournal,
  signal: AbortSignal,
  onReady:
    ((recording: { streamId: string; revision: string }) => void) | undefined,
  fail: (error: unknown) => void,
): { reported: Promise<void>; flush: () => void } {
  let done = false;
  const report = () => {
    const identity = journal.identity;
    if (done || !identity.streamId) return;
    done = true;
    try {
      onReady?.({ streamId: identity.streamId, revision: identity.revision! });
    } catch (error) {
      fail(error);
    }
  };
  return {
    reported: whenBound(journal, signal).then(report, () => {
      /* Aborted before the recording existed; `flush` retries after shutdown. */
    }),
    flush: report,
  };
}
