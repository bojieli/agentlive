import {
  readTextPage,
  findSourceText,
  sourcePageContaining,
  type TextSource,
} from "./text-source.js";
import { TEXT_PAGE_SIZE } from "./text-page.js";
import {
  createContext,
  useContext,
  useLayoutEffect,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { pageContaining, textPage } from "./text-page.js";
type Position = number | "latest";
interface Reveal {
  query: string;
  generation: number;
}
const Pages = createContext<
  | {
      following: boolean;
      positions: ReadonlyMap<string, Position>;
      reveals: ReadonlyMap<string, Reveal>;
      handled: ReadonlyMap<string, number>;
      acknowledge: (choice: string, generation: number) => void;
      set: (choice: string, page: Position) => void;
      reveal: (group: string, query: string) => void;
    }
  | undefined
>(undefined);
export function TextPagesProvider({
  children,
  following,
}: {
  children: ReactNode;
  following: boolean;
}) {
  const [positions, setPositions] = useState<ReadonlyMap<string, Position>>(
    () => new Map(),
  );
  const [reveals, setReveals] = useState<ReadonlyMap<string, Reveal>>(
    () => new Map(),
  );
  const [handled, setHandled] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  return (
    <Pages.Provider
      value={{
        following,
        positions,
        reveals,
        handled,
        acknowledge: (choice, generation) =>
          setHandled((previous) => new Map(previous).set(choice, generation)),
        set: (choice, page) =>
          setPositions((previous) =>
            previous.get(choice) === page
              ? previous
              : new Map(previous).set(choice, page),
          ),
        reveal: (group, query) =>
          setReveals((previous) =>
            new Map(previous).set(group, {
              query,
              generation: (previous.get(group)?.generation ?? 0) + 1,
            }),
          ),
      }}
    >
      {children}
    </Pages.Provider>
  );
}
export function useRevealText() {
  const pages = useContext(Pages);
  return (group: string, query: string) => pages?.reveal(group, query);
}
/** Each mounted text field contributes at most one bounded page to the DOM. */
function MemoryText({
  text,
  choice,
  group,
  label = "Text",
}: {
  text: string;
  choice: string;
  group: string;
  label?: string;
}) {
  const pages = useContext(Pages);
  const [local, setLocal] = useState<Position>(0);
  const handled = pages?.handled.get(choice);
  const selected =
    pages?.positions.get(choice) ?? (pages?.following ? "latest" : local);
  const reveal = pages?.reveals.get(group);
  const result = textPage(
    text,
    selected === "latest" ? Number.MAX_SAFE_INTEGER : selected,
  );
  const set = (page: Position) => {
    if (pages) pages.set(choice, page);
    else setLocal(page);
  };
  useLayoutEffect(() => {
    if (pages?.following && !pages.positions.has(choice))
      pages.set(choice, "latest");
  }, [pages?.following, pages?.positions, choice]);
  useLayoutEffect(() => {
    if (!reveal || reveal.generation === handled) return;
    const offset = text.indexOf(reveal.query);
    pages?.acknowledge(choice, reveal.generation);
    if (offset >= 0) set(pageContaining(text, offset));
  }, [reveal, handled, text]);
  return (
    <div className="paged-text">
      {result.count > 1 && (
        <div className="text-navigation" aria-label={`${label} pages`}>
          <span className="muted">
            {label}: page {result.page + 1} of {result.count}
          </span>
          <button disabled={result.page === 0} onClick={() => set(0)}>
            First
          </button>
          <button
            disabled={result.page === 0}
            onClick={() => set(result.page - 1)}
          >
            Previous
          </button>
          <button
            disabled={result.page === result.count - 1}
            onClick={() => set(result.page + 1)}
          >
            Next
          </button>
          <button
            aria-pressed={selected === "latest"}
            onClick={() => set(selected === "latest" ? result.page : "latest")}
          >
            Follow latest text
          </button>
        </div>
      )}
      <pre>{result.text}</pre>
    </div>
  );
}

export function PagedText(props: {
  text: string | TextSource;
  choice: string;
  group: string;
  label?: string;
}) {
  return typeof props.text === "string" ? (
    <MemoryText {...props} text={props.text} />
  ) : (
    <StoredText {...props} text={props.text} />
  );
}
function StoredText({
  text,
  choice,
  group,
  label = "Text",
}: {
  text: TextSource;
  choice: string;
  group: string;
  label?: string;
}) {
  const [attempt, setAttempt] = useState(0);
  const pages = useContext(Pages),
    [local, setLocal] = useState<Position>(0);
  const selected =
    pages?.positions.get(choice) ?? (pages?.following ? "latest" : local);
  const count = Math.max(1, Math.ceil(text.units / TEXT_PAGE_SIZE));
  const target =
    selected === "latest" ? count - 1 : Math.min(selected, count - 1);
  const [saved, setSaved] = useState<
    | {
        key: string;
        units: number;
        page: number;
        result: Awaited<ReturnType<typeof readTextPage>>;
      }
    | undefined
  >();
  const [failure, setFailure] = useState<
    { key: string; units: number; page: number; message: string } | undefined
  >();
  const result =
    saved?.key === text.key &&
    saved.units === text.units &&
    saved.page === target
      ? saved.result
      : undefined;
  const error =
    failure?.key === text.key &&
    failure.units === text.units &&
    failure.page === target
      ? failure.message
      : undefined;
  const set = (page: Position) => {
    if (pages) pages.set(choice, page);
    else setLocal(page);
  };
  const reveal = pages?.reveals.get(group),
    handled = pages?.handled.get(choice);
  useLayoutEffect(() => {
    if (pages?.following && !pages.positions.has(choice))
      pages.set(choice, "latest");
  }, [pages?.following, pages?.positions, choice]);
  useEffect(() => {
    const stop = new AbortController(),
      signal = AbortSignal.any([stop.signal, AbortSignal.timeout(10000)]);
    setSaved(undefined);
    setFailure(undefined);
    void readTextPage(text, target, signal)
      .then((result) => {
        if (!signal.aborted)
          setSaved({ key: text.key, units: text.units, page: target, result });
      })
      .catch((error) => {
        if (!stop.signal.aborted)
          setFailure({
            key: text.key,
            units: text.units,
            page: target,
            message:
              error instanceof Error ? error.message : "Unable to read text",
          });
      });
    return () => stop.abort();
  }, [text.key, text.units, text.read, target, attempt]);
  useEffect(() => {
    if (!reveal || reveal.generation === handled) return;
    const stop = new AbortController(),
      signal = AbortSignal.any([stop.signal, AbortSignal.timeout(10000)]);
    void (async () => {
      const offset = await findSourceText(text, reveal.query, signal);
      const page =
        offset < 0
          ? undefined
          : await sourcePageContaining(text, offset, signal);
      signal.throwIfAborted();
      pages?.acknowledge(choice, reveal.generation);
      if (page !== undefined) set(page);
    })().catch((error) => {
      if (!stop.signal.aborted)
        setFailure({
          key: text.key,
          units: text.units,
          page: target,
          message:
            error instanceof Error ? error.message : "Unable to locate text",
        });
    });
    return () => stop.abort();
  }, [reveal, handled, text.key, text.units, text.read, attempt]);
  return (
    <div className="paged-text" aria-busy={!result && !error}>
      {count > 1 && (
        <div className="text-navigation" aria-label={`${label} pages`}>
          <span className="muted">
            {label}: page {target + 1} of {count}
          </span>
          <button disabled={target === 0} onClick={() => set(0)}>
            First
          </button>
          <button disabled={target === 0} onClick={() => set(target - 1)}>
            Previous
          </button>
          <button
            disabled={target === count - 1}
            onClick={() => set(target + 1)}
          >
            Next
          </button>
          <button
            aria-pressed={selected === "latest"}
            onClick={() => set(selected === "latest" ? target : "latest")}
          >
            Follow latest text
          </button>
        </div>
      )}
      {error ? (
        <div role="alert">
          <p>{error}</p>
          <button onClick={() => setAttempt((value) => value + 1)}>
            Retry text
          </button>
        </div>
      ) : (
        <pre>{result?.text ?? "Loading text…"}</pre>
      )}
    </div>
  );
}
