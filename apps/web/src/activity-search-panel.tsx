import { useEffect, useRef, useState } from "react";
import type { RecordingState } from "@agentlive/playback";
import type { ActivityRow } from "./activity.js";
import { searchActivity, type ActivitySearchPage } from "./activity-search.js";
export function ActivitySearchPanel({
  state,
  rows,
  onSelect,
  onPause,
}: {
  state: RecordingState;
  rows: readonly ActivityRow[];
  onSelect: (index: number) => void;
  onPause: () => void;
}) {
  const [query, setQuery] = useState("");
  const [saved, setSaved] = useState<{
    page: ActivitySearchPage;
    sequence: number;
    query: string;
  }>();
  const page =
    saved?.sequence === state.appliedSeq && saved.query === query
      ? saved.page
      : undefined;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | undefined>(undefined);
  const sequence = state.appliedSeq;
  useEffect(() => {
    request.current?.abort();
    setSaved(undefined);
    setBusy(false);
    return () => request.current?.abort();
  }, [sequence]);
  async function search(start = 0) {
    request.current?.abort();
    const abort = new AbortController();
    request.current = abort;
    onPause();
    setBusy(true);
    setError("");
    setSaved(undefined);
    try {
      const result = await searchActivity(
        state,
        rows,
        query,
        abort.signal,
        start,
      );
      if (!abort.signal.aborted) setSaved({ page: result, sequence, query });
    } catch (error) {
      if (!abort.signal.aborted)
        setError(error instanceof Error ? error.message : "Search failed");
    } finally {
      if (request.current === abort) setBusy(false);
    }
  }
  return (
    <div className="activity-search">
      <form
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <label>
          Search activity at this playback position
          <input
            type="search"
            value={query}
            maxLength={256}
            onChange={(event) => {
              request.current?.abort();
              setBusy(false);
              setSaved(undefined);
              setQuery(event.target.value);
            }}
            placeholder="Case-sensitive text"
          />
        </label>
        <button disabled={!query.length || busy}>Search</button>
        {busy && (
          <button
            type="button"
            onClick={() => {
              request.current?.abort();
              setBusy(false);
            }}
          >
            Cancel search
          </button>
        )}
      </form>
      <p className="muted" role="status">
        {busy
          ? "Searching…"
          : page
            ? `${page.matches.length} matching items on this page${page.nextIndex !== null ? "; more available" : ""}.`
            : "Search pauses playback and includes offscreen items. Attachment contents are excluded."}
      </p>
      {error && <p role="alert">{error}</p>}
      {page && (
        <>
          <ul>
            {page.matches.map((match) => (
              <li key={match.key}>
                <button onClick={() => onSelect(match.index)}>
                  <strong>{rows[match.index]?.kind}</strong>
                  <span>{match.excerpt}</span>
                </button>
              </li>
            ))}
          </ul>
          {page.nextIndex !== null && (
            <button onClick={() => void search(page.nextIndex!)}>
              Next results
            </button>
          )}
        </>
      )}
    </div>
  );
}
