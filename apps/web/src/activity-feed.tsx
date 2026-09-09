import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { RecordingState } from "@agentlive/playback";
import type { Attachment } from "./attachments.js";
import { ActivityCard, activityRows } from "./activity.js";
import { ActivitySearchPanel } from "./activity-search-panel.js";
import { activityRange } from "./activity-range.js";
import { ExpansionProvider, useRevealDisclosure } from "./disclosure.js";
export function ActivityFeed(props: {
  state: RecordingState;
  following: boolean;
  onPause: () => void;
  order: (key: string) => number;
  onAttachment: (attachment: Attachment) => void;
}) {
  return (
    <ExpansionProvider>
      <VirtualActivity {...props} />
    </ExpansionProvider>
  );
}
function VirtualActivity({
  state,
  following,
  onPause,
  order,
  onAttachment,
}: Parameters<typeof ActivityFeed>[0]) {
  const rows = useMemo(
    () => activityRows(state, order),
    [state, state.appliedSeq, order],
  );
  const revealDisclosure = useRevealDisclosure();
  const parent = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState<string>();
  const [pending, setPending] = useState<string>();
  const focusedIndex = rows.findIndex((row) => row.key === focused);
  const getItemKey = useCallback((index: number) => rows[index]!.key, [rows]);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: rows.length,
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
  const handledHash = useRef<string | undefined>(undefined);
  const navigate = useCallback(
    (index: number) => {
      const row = rows[index];
      if (!row) return;
      setFocused(row.key);
      setPending(row.key);
      virtualizer.scrollToIndex(index, { align: "start" });
    },
    [rows, virtualizer],
  );
  useEffect(() => {
    const reveal = () => {
      const hash = location.hash;
      if (!hash) {
        handledHash.current = undefined;
        return;
      }
      if (handledHash.current === hash) return;
      const index = rows.findIndex((row) => `#${row.anchor}` === hash);
      if (index < 0) {
        handledHash.current = undefined;
        return;
      }
      handledHash.current = hash;
      navigate(index);
    };
    reveal();
    window.addEventListener("hashchange", reveal);
    return () => window.removeEventListener("hashchange", reveal);
  }, [rows, navigate]);
  useLayoutEffect(() => {
    if (!pending) return;
    const index = rows.findIndex((row) => row.key === pending);
    const element = parent.current?.querySelector<HTMLDivElement>(
      `[data-index="${index}"]`,
    );
    if (element) {
      virtualizer.scrollToIndex(index, { align: "start" });
      element.focus({ preventScroll: true });
      setPending(undefined);
    }
  }, [pending, rows, virtualizer, items]);
  // A seek may remove the focused object; return focus to the activity region.
  useLayoutEffect(() => {
    if (focused && focusedIndex < 0) {
      setFocused(undefined);
      setPending(undefined);
      parent.current?.focus({ preventScroll: true });
    }
  }, [focused, focusedIndex]);
  return (
    <section className="activity" aria-label="Session activity">
      <ActivitySearchPanel
        state={state}
        rows={rows}
        onSelect={(index) => {
          const row = rows[index];
          if (!row) return;
          revealDisclosure(row.key);
          revealDisclosure(`${row.key}/recorded-data`);
          navigate(index);
        }}
        onPause={onPause}
      />
      <div className="activity-navigation">
        <span className="muted">{rows.length} activity items</span>
        <button disabled={!rows.length} onClick={() => navigate(0)}>
          First item
        </button>
        <button
          disabled={!rows.length}
          onClick={() => navigate(rows.length - 1)}
        >
          Latest item
        </button>
      </div>
      <div
        ref={parent}
        className="activity-viewport"
        role="region"
        aria-label="Scrollable session activity; use arrow keys to move between items"
        tabIndex={0}
        onFocusCapture={(event) => {
          const item = (event.target as Element).closest<HTMLElement>(
            "[data-index]",
          );
          if (item) setFocused(rows[Number(item.dataset.index)]?.key);
        }}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            setFocused(undefined);
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
          const index = rows.findIndex(
            (row) => `#${row.anchor}` === link.getAttribute("href"),
          );
          if (index < 0) return;
          event.preventDefault();
          const hash = link.getAttribute("href")!;
          handledHash.current = hash;
          if (location.hash !== hash) history.pushState(null, "", hash);
          navigate(index);
        }}
        onKeyDown={(event) => {
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
                ? rows.length - 1
                : event.key === "ArrowDown"
                  ? Math.min(rows.length - 1, focusedIndex + 1)
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
            const row = rows[item.index]!;
            return (
              <div
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                role="listitem"
                aria-setsize={rows.length}
                aria-posinset={item.index + 1}
                tabIndex={0}
                className="activity-row"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${item.start}px)`,
                }}
              >
                <ActivityCard
                  row={row}
                  state={state}
                  onAttachment={onAttachment}
                />
              </div>
            );
          })}
        </div>
        {!rows.length && <p className="muted">No activity at this position.</p>}
      </div>
    </section>
  );
}
