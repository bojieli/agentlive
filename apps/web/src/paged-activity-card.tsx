import { useEffect, useState } from "react";
import { ActivityCard, type ActivityRow } from "./activity.js";
import type { Attachment } from "./attachments.js";
import type { PagedActivityView, LoadedActivity } from "./paged-activity.js";
export function PagedActivityCard({
  view,
  row,
  onAttachment,
}: {
  view: PagedActivityView;
  row: ActivityRow;
  onAttachment: (attachment: Attachment) => void;
}) {
  const [offset, setOffset] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [saved, setSaved] = useState<{
    view: PagedActivityView;
    key: string;
    offset: number;
    attempt: number;
    loaded: LoadedActivity | null;
    error?: string;
  }>();
  const current =
    saved?.view === view &&
    saved.key === row.key &&
    saved.offset === offset &&
    saved.attempt === attempt
      ? saved
      : undefined;
  useEffect(() => {
    const stop = new AbortController(),
      signal = AbortSignal.any([stop.signal, AbortSignal.timeout(10000)]);
    void view
      .load(row, signal, offset)
      .then((loaded) => {
        if (!signal.aborted)
          setSaved({ view, key: row.key, offset, attempt, loaded });
      })
      .catch((error) => {
        if (!stop.signal.aborted)
          setSaved({
            view,
            key: row.key,
            offset,
            attempt,
            loaded: null,
            error:
              error instanceof Error
                ? error.message
                : "Unable to load activity",
          });
      });
    return () => stop.abort();
  }, [view, row.key, row.kind, row.id, offset, attempt]);
  if (!current)
    return (
      <article className="card" aria-busy="true">
        Loading activity…
      </article>
    );
  if (current.error)
    return (
      <article className="card" role="alert">
        <p>{current.error}</p>
        <button onClick={() => setAttempt((value) => value + 1)}>
          Retry activity
        </button>
      </article>
    );
  if (!current.loaded) return null;
  const { state, texts, gap, versions } = current.loaded;
  return (
    <ActivityCard
      row={row}
      state={state}
      texts={texts}
      {...(gap ? { gap } : {})}
      {...(versions
        ? { artifactPage: { ...versions, select: setOffset } }
        : {})}
      onAttachment={onAttachment}
    />
  );
}
