import { changeExpansion } from "./inspection-choices.js";
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
export function ExpansionProvider({
  children,
  expanded,
  onChange,
}: {
  children: ReactNode;
  expanded?: readonly string[] | undefined;
  onChange?: ((key: string, expanded: boolean) => void) | undefined;
}) {
  const [local, setLocal] = useState<readonly string[]>([]);
  const open = new Set(expanded ?? local);
  return (
    <Expansion.Provider
      value={{
        open,
        set: (id, value) => {
          if (open.has(id) === value) return;
          if (onChange) onChange(id, value);
          else setLocal((previous) => changeExpansion(previous, id, value));
        },
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
