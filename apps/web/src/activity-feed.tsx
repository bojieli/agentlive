import { loadActivityWindow } from "./activity-window.js";
import { PagedActivityCard } from "./paged-activity-card.js";
import type { PagedActivityView } from "./paged-activity.js";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  completenessSummary,
  unfinishedActivity,
  type CompletenessSummary,
  type RecordingState,
} from "@agentlive/playback";
import { CompletenessNotice } from "./completeness-notice.js";
import type { Attachment } from "./attachments.js";
import { ActivityCard, activityRows, type ActivityRow } from "./activity.js";
import { TextPagesProvider, useRevealText } from "./paged-text.js";
import { ActivitySearchPanel } from "./activity-search-panel.js";
import { activityRange } from "./activity-range.js";
import { ExpansionProvider, useRevealDisclosure } from "./disclosure.js";
export function ActivityFeed(props: {
  state: RecordingState;
  view?: PagedActivityView;
  textPages?: readonly import("./inspection-choices.js").TextPageChoice[];
  onTextPage?: (
    key: string,
    page: import("./inspection-choices.js").TextPosition,
  ) => void;
  expandedDisclosures?: readonly string[];
  onDisclosure?: (key: string, expanded: boolean) => void;
  following: boolean;
  onPause: () => void;
  order: (key: string) => number;
  onAttachment: (attachment: Attachment) => void;
}) {
  // Replacing the presentation view remounts the feed body; the announcement
  // baseline must not restart, or every remount would read out the recording.
  const progress = useRef<AnnounceProgress>({ seen: -1, primed: false });
  return (
    <ExpansionProvider
      expanded={props.expandedDisclosures}
      onChange={props.onDisclosure}
    >
      <TextPagesProvider
        following={props.following}
        saved={props.textPages}
        onChange={props.onTextPage}
      >
        {props.view && props.view.sequence !== props.state.appliedSeq ? (
          <p role="alert">
            Activity view does not match the selected playback position.
          </p>
        ) : (
          <VirtualActivity {...props} progress={progress} />
        )}
      </TextPagesProvider>
    </ExpansionProvider>
  );
}
/** One coalesced announcement for arriving activity, outside the feed. */
const ANNOUNCE_INTERVAL_MS = 2000;
interface AnnounceProgress {
  seen: number;
  primed: boolean;
}
function ActivityAnnouncer({
  count,
  progress,
}: {
  count: number;
  progress: { current: AnnounceProgress };
}) {
  const [message, setMessage] = useState("");
  const latest = useRef(count);
  if (count > 0) latest.current = count;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    // A replaced presentation reports no rows for an instant. That gap is
    // neither new activity nor a seek: it must not move the baseline, and a
    // flush landing inside it must still compare against the last real count.
    if (count === 0) return;
    // Seeking backward reduces the count; that is not new activity.
    if (count <= progress.current.seen) {
      if (timer.current === undefined) progress.current.seen = count;
      return;
    }
    if (timer.current !== undefined) return;
    timer.current = setTimeout(() => {
      timer.current = undefined;
      const added = latest.current - progress.current.seen;
      progress.current.seen = latest.current;
      // The first settled batch is the feed itself arriving, not new work.
      if (!progress.current.primed) {
        progress.current.primed = true;
        return;
      }
      if (added > 0)
        setMessage(
          `${added} new activity item${added === 1 ? "" : "s"}; ${latest.current} in view.`,
        );
    }, ANNOUNCE_INTERVAL_MS);
  }, [count, progress]);
  return (
    <p className="visually-hidden" role="status" aria-atomic="true">
      {message}
    </p>
  );
}
function VirtualActivity({
  state,
  view,
  following,
  onPause,
  order,
  onAttachment,
  progress,
}: Parameters<typeof ActivityFeed>[0] & {
  progress: { current: AnnounceProgress };
}) {
  const rows = useMemo(
    () => (view ? [] : activityRows(state, order)),
    [state, state.appliedSeq, order, view],
  );
  const revealDisclosure = useRevealDisclosure();
  const revealText = useRevealText();
  const parent = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState<string>();
  const [pending, setPending] = useState<string>();
  const navigationTarget = useRef<string | undefined>(undefined);
  const mounted = useRef(-1);
  const [pagedFocus, setPagedFocus] = useState(-1);
  const [loaded, setLoaded] = useState<{
    view: PagedActivityView;
    rows: Map<number, ActivityRow>;
  }>();
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [pagedCompleteness, setPagedCompleteness] = useState<{
    view: PagedActivityView;
    summary: CompletenessSummary | undefined;
  }>();
  useEffect(() => {
    if (!view) return;
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]);
    void view
      .completeness(signal)
      .then((summary) => {
        if (!signal.aborted) setPagedCompleteness({ view, summary });
      })
      // The persisted notice remains available from the view summary.
      .catch(() => {});
    return () => abort.abort();
  }, [view]);
  const completeness = useMemo(
    () =>
      view
        ? pagedCompleteness?.view === view
          ? pagedCompleteness.summary
          : completenessSummary(view.summary)
        : completenessSummary(state, unfinishedActivity(state)),
    [view, pagedCompleteness, state, state.appliedSeq],
  );
  const count = view ? view.rowCount : rows.length;
  const rowAt = useCallback(
    (index: number) =>
      view
        ? loaded?.view === view
          ? loaded.rows.get(index)
          : undefined
        : rows[index],
    [view, loaded, rows],
  );
  const focusedIndex = view
    ? pagedFocus
    : rows.findIndex((row) => row.key === focused);
  const getItemKey = useCallback(
    (index: number) =>
      view ? `paged:${view.sequence}:${index}` : rows[index]!.key,
    [view, rows],
  );
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count,
    getScrollElement: () => parent.current,
    getItemKey,
    estimateSize: () => 180,
    overscan: 4,
    anchorTo: following ? "end" : "start",
    followOnAppend: following,
    scrollEndThreshold: 48,
    rangeExtractor: (range) => activityRange(range, focusedIndex),
  });
  const items = virtualizer.getVirtualItems();
  const rangeKey = items
    .map((item) => Math.floor(item.index / 32) * 32)
    .filter((value, index, all) => all.indexOf(value) === index)
    .sort((a, b) => a - b)
    .join(",");
  useEffect(() => {
    if (!view) return;
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]);
    setLoadError("");
    void (async () => {
      const selected = await loadActivityWindow(
        view,
        rangeKey ? rangeKey.split(",").map(Number) : [],
        signal,
      );
      setLoaded({ view, rows: selected });
    })().catch((error) => {
      if (!abort.signal.aborted)
        setLoadError(
          error instanceof Error ? error.message : "Activity loading failed",
        );
    });
    return () => abort.abort();
  }, [view, rangeKey, attempt]);
  const navigation = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => navigation.current?.abort(), [view]);
  useEffect(() => {
    if (!view || !focused) {
      setPagedFocus(-1);
      return;
    }
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]);
    void view
      .position(focused, signal)
      .then((index) => {
        if (!signal.aborted) {
          setPagedFocus(index ?? -1);
          if (index === undefined) {
            setFocused(undefined);
            setPending(undefined);
            parent.current?.focus({ preventScroll: true });
          }
        }
      })
      .catch((error) => {
        if (!abort.signal.aborted)
          setLoadError(
            error instanceof Error ? error.message : "Activity position failed",
          );
      });
    return () => abort.abort();
  }, [view, focused]);
  const handledHash = useRef<string | undefined>(undefined);
  const navigate = useCallback(
    (index: number, query?: string) => {
      if (index < 0 || index >= count) return;
      navigation.current?.abort();
      const abort = new AbortController();
      navigation.current = abort;
      const signal = AbortSignal.any([
        abort.signal,
        AbortSignal.timeout(10000),
      ]);
      void (async () => {
        const row = view ? (await view.rows(index, 1, signal))[0] : rows[index];
        signal.throwIfAborted();
        if (!row) return;
        if (query !== undefined) {
          revealText(row.key, query);
          revealDisclosure(row.key);
          revealDisclosure(`${row.key}/recorded-data`);
        }
        setFocused(row.key);
        navigationTarget.current = row.key;
        mounted.current = index;
        if (view) setPagedFocus(index);
        setPending(row.key);
        virtualizer.scrollToIndex(index, { align: "start" });
      })().catch((error) => {
        if (!abort.signal.aborted)
          setLoadError(
            error instanceof Error
              ? error.message
              : "Activity navigation failed",
          );
      });
    },
    [view, rows, count, virtualizer, revealText, revealDisclosure],
  );
  const hashIndex = useCallback(
    async (hash: string, signal: AbortSignal) => {
      if (!view) return rows.findIndex((row) => `#${row.anchor}` === hash);
      const match = /^#([a-z]+)-(.*)$/.exec(hash);
      if (!match) return -1;
      let id: string;
      try {
        id = decodeURIComponent(match[2]!);
      } catch {
        return -1;
      }
      return (await view.position(`${match[1]}/${id}`, signal)) ?? -1;
    },
    [view, rows],
  );
  useEffect(() => {
    let active: AbortController | undefined;
    const reveal = () => {
      active?.abort();
      const hash = location.hash;
      if (!hash) {
        handledHash.current = undefined;
        return;
      }
      if (handledHash.current === hash) return;
      const abort = new AbortController();
      active = abort;
      const signal = AbortSignal.any([
        abort.signal,
        AbortSignal.timeout(10000),
      ]);
      void hashIndex(hash, signal)
        .then((index) => {
          if (signal.aborted || index < 0) return;
          handledHash.current = hash;
          navigate(index);
        })
        .catch((error) => {
          if (!abort.signal.aborted)
            setLoadError(
              error instanceof Error ? error.message : "Activity link failed",
            );
        });
    };
    reveal();
    window.addEventListener("hashchange", reveal);
    return () => {
      active?.abort();
      window.removeEventListener("hashchange", reveal);
    };
  }, [hashIndex, navigate]);
  useLayoutEffect(() => {
    if (!pending) return;
    const index = view
      ? pagedFocus
      : rows.findIndex((row) => row.key === pending);
    if (rowAt(index)?.key !== pending) return;
    const element = parent.current?.querySelector<HTMLDivElement>(
      `[data-index="${index}"]`,
    );
    if (element) {
      virtualizer.scrollToIndex(index, { align: "start" });
      element.focus({ preventScroll: true });
      setPending(undefined);
    }
  }, [pending, rows, view, pagedFocus, rowAt, virtualizer, items]);
  // Async card measurements can shift an explicit navigation target after the
  // virtualizer considers its initial scroll settled. Use committed geometry
  // until the user takes over scrolling or moves focus away.
  useLayoutEffect(() => {
    if (!focused || navigationTarget.current !== focused) return;
    const viewport = parent.current;
    const element = viewport?.querySelector<HTMLElement>(
      `[data-index="${focusedIndex}"]`,
    );
    if (!viewport || !element || !element.contains(document.activeElement))
      return;
    const row = element.getBoundingClientRect();
    const frame = viewport.getBoundingClientRect();
    if (row.bottom <= frame.top || row.top >= frame.bottom)
      virtualizer.scrollToOffset(viewport.scrollTop + row.top - frame.top, {
        align: "start",
      });
  }, [focused, focusedIndex, items, virtualizer]);
  // Removing the focused element does not reliably produce a blur event, and
  // live receipt replaces every virtual row element under the focused item.
  // Whenever focus was inside the region and the document holds it instead,
  // return it to the remounted row, or to the region itself.
  useLayoutEffect(() => {
    const viewport = parent.current;
    const index = mounted.current;
    // An explicit navigation owns focus until it commits on its target row.
    if (!viewport || index < 0 || pending) return;
    const active = viewport.ownerDocument.activeElement;
    if (
      active &&
      active !== viewport.ownerDocument.body &&
      active !== viewport.ownerDocument.documentElement
    )
      return;
    const row = viewport.querySelector<HTMLElement>(`[data-index="${index}"]`);
    (row ?? viewport).focus({ preventScroll: true });
  });
  // A seek may remove the focused object; return focus to the activity region.
  useLayoutEffect(() => {
    if (!view && focused && focusedIndex < 0) {
      setFocused(undefined);
      setPending(undefined);
      parent.current?.focus({ preventScroll: true });
    }
  }, [view, focused, focusedIndex]);
  return (
    <section className="activity" aria-label="Session activity">
      <ActivityAnnouncer count={count} progress={progress} />
      <ActivitySearchPanel
        state={state}
        rows={rows}
        view={view}
        onSelect={(index, query) => navigate(index, query)}
        onPause={onPause}
      />
      <CompletenessNotice summary={completeness} />
      {loadError && (
        <p role="alert">
          {loadError}{" "}
          <button onClick={() => setAttempt((value) => value + 1)}>
            Retry loading
          </button>
        </p>
      )}
      <div className="activity-navigation">
        <span className="muted">{count} activity items</span>
        <button disabled={!count} onClick={() => navigate(0)}>
          First item
        </button>
        <button disabled={!count} onClick={() => navigate(count - 1)}>
          Latest item
        </button>
      </div>
      <div
        ref={parent}
        className="activity-viewport"
        role="region"
        aria-label="Scrollable session activity; use arrow keys to move between items"
        tabIndex={0}
        onWheel={() => {
          navigationTarget.current = undefined;
        }}
        onTouchStart={() => {
          navigationTarget.current = undefined;
        }}
        onPointerDown={() => {
          navigationTarget.current = undefined;
        }}
        onFocusCapture={(event) => {
          const item = (event.target as Element).closest<HTMLElement>(
            "[data-index]",
          );
          if (item) {
            const index = Number(item.dataset.index);
            mounted.current = index;
            const row = rowAt(index);
            if (row) {
              setFocused(row.key);
              if (view) setPagedFocus(index);
            }
          }
        }}
        onBlurCapture={(event) => {
          const viewport = event.currentTarget;
          const next = event.relatedTarget as Node | null;
          if (next && viewport.contains(next)) return;
          const target = event.target as HTMLElement;
          const index = mounted.current;
          if (next || index < 0) {
            navigationTarget.current = undefined;
            mounted.current = -1;
            setFocused(undefined);
            return;
          }
          // Live receipt replaces virtual row elements under the focused
          // item, and the browser then drops focus on the document body.
          // Restore it to the replacement row, or to the region.
          queueMicrotask(() => {
            if (!viewport.isConnected) return;
            const active = viewport.ownerDocument.activeElement;
            if (
              active &&
              active !== viewport.ownerDocument.body &&
              active !== viewport.ownerDocument.documentElement
            )
              return;
            if (target.isConnected) {
              navigationTarget.current = undefined;
              mounted.current = -1;
              setFocused(undefined);
              return;
            }
            const row = viewport.querySelector<HTMLElement>(
              `[data-index="${index}"]`,
            );
            (row ?? viewport).focus({ preventScroll: true });
          });
        }}
        onClick={(event) => {
          const link = (event.target as Element).closest<HTMLAnchorElement>(
            'a[href^="#"]',
          );
          if (
            !link ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          )
            return;
          const hash = link.getAttribute("href")!;
          event.preventDefault();
          handledHash.current = undefined;
          if (location.hash !== hash) history.pushState(null, "", hash);
          window.dispatchEvent(new HashChangeEvent("hashchange"));
        }}
        onKeyDown={(event) => {
          // Paging keys scroll the region natively; that is the viewer taking
          // over scrolling, exactly like a wheel or touch gesture.
          if (event.key === "PageDown" || event.key === "PageUp")
            navigationTarget.current = undefined;
          if (
            (event.target as Element).closest(
              "button,a,summary,input,select,textarea",
            )
          )
            return;
          const index =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? count - 1
                : event.key === "ArrowDown"
                  ? Math.min(count - 1, focusedIndex + 1)
                  : event.key === "ArrowUp"
                    ? Math.max(0, focusedIndex - 1)
                    : undefined;
          if (index === undefined) return;
          event.preventDefault();
          navigate(index);
        }}
      >
        <div
          role="list"
          style={{ height: virtualizer.getTotalSize(), position: "relative" }}
        >
          {items.map((item) => {
            const row = rowAt(item.index);
            return (
              <div
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                role="listitem"
                aria-setsize={count}
                aria-posinset={item.index + 1}
                // Roving tab stop: mounted rows must not add a dozen empty
                // stops to the page's Tab order. The region is the entry
                // point and arrow keys move between items.
                tabIndex={item.index === focusedIndex ? 0 : -1}
                className="activity-row"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${item.start}px)`,
                }}
              >
                {!row ? (
                  // Never a live region: virtual rows mount and unmount
                  // constantly, and a screen reader would read every one.
                  <p className="muted">Loading activity…</p>
                ) : view ? (
                  <PagedActivityCard
                    row={row}
                    view={view}
                    onAttachment={onAttachment}
                  />
                ) : (
                  <ActivityCard
                    row={row}
                    state={state}
                    onAttachment={onAttachment}
                  />
                )}
              </div>
            );
          })}
        </div>
        {!count && <p className="muted">No activity at this position.</p>}
      </div>
    </section>
  );
}
