import { expect, it } from "vitest";
import { TerminalKeys } from "../packages/cli/src/terminal-keys.js";
it("decodes split arrows without emitting the bracket seek command", () => {
  for (const sequence of ["\u001b[C", "\u001bOC", "\u001b[D", "\u001bOD"]) {
    for (let split = 0; split <= sequence.length; split++) {
      const keys = new TerminalKeys();
      expect([
        ...keys.feed(sequence.slice(0, split)),
        ...keys.feed(sequence.slice(split)),
      ]).toEqual([sequence.endsWith("C") ? "right" : "left"]);
    }
  }
  const keys = new TerminalKeys();
  expect(keys.feed("\u001b[A\u001b[B\u001b[1;5C\u001b[3~")).toEqual([]);
  expect(keys.feed("[]0 .+-lq")).toEqual([..."[]0 .+-lq"]);
});
it("ignores bracketed paste commands across chunks while retaining Ctrl-C", () => {
  const keys = new TerminalKeys();
  const paste = "\u001b[200~q [ ] l . +\n\u001b[201~";
  expect([...paste].flatMap((character) => keys.feed(character))).toEqual([]);
  expect(keys.feed(".")).toEqual(["."]);
  expect(keys.feed("\u001b[200~pasted\u0003q")).toEqual(["\u0003", "q"]);
});
it("bounds ignored escape parameters and never reinterprets them as seeks", () => {
  const keys = new TerminalKeys();
  expect(keys.feed("\u001b[" + "1;".repeat(10000) + "C")).toEqual([]);
  expect(keys.feed("q")).toEqual(["q"]);
  expect(keys.feed("\u001bq")).toEqual([]);
});
