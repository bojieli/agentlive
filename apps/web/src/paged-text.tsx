import {
  createContext,
  useContext,
  useLayoutEffect,
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
export function PagedText({
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
