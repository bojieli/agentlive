import {
  createContext,
  useContext,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
const Expansion = createContext<
  | {
      open: ReadonlySet<string>;
      set: (id: string, open: boolean) => void;
    }
  | undefined
>(undefined);
/** Inspection choices survive virtual row unmounting, scoped to one viewer. */
export function ExpansionProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  return (
    <Expansion.Provider
      value={{
        open,
        set: (id, expanded) =>
          setOpen((previous) => {
            if (previous.has(id) === expanded) return previous;
            const next = new Set(previous);
            if (expanded) next.add(id);
            else next.delete(id);
            return next;
          }),
      }}
    >
      {children}
    </Expansion.Provider>
  );
}
export function Disclosure({
  choice,
  ...props
}: Omit<ComponentProps<"details">, "open" | "onToggle"> & { choice: string }) {
  const expansion = useContext(Expansion);
  const [local, setLocal] = useState(false);
  return (
    <details
      {...props}
      open={expansion ? expansion.open.has(choice) : local}
      onToggle={(event) => {
        const open = event.currentTarget.open;
        if (expansion) expansion.set(choice, open);
        else setLocal(open);
      }}
    />
  );
}

export function useRevealDisclosure() {
  const expansion = useContext(Expansion);
  return (choice: string) => expansion?.set(choice, true);
}
