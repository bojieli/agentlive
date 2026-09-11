import { expect, it } from "vitest";
import { openCodeFrozenCompleteness } from "../packages/adapters/src/import-opencode.js";
import { parseOpenCodeSnapshot } from "../packages/adapters/src/opencode-history.js";
const snapshot = (text: string, completed = false) =>
  parseOpenCodeSnapshot({
    info: { id: "session", time: { created: 1 } },
    messages: [
      {
        info: {
          id: "message",
          sessionID: "session",
          role: "assistant",
          time: { created: 1, ...(completed ? { completed: 2 } : {}) },
        },
        parts: [
          {
            id: "part",
            messageID: "message",
            sessionID: "session",
            type: "text",
            text,
          },
        ],
      },
    ],
  });
it("reports unfinished and withheld text independently without returning the suffix", () => {
  const input = snapshot("Visible secret_pre");
  expect(openCodeFrozenCompleteness(input, ["secret_prefix"])).toEqual({
    unfinishedMessages: 1,
    withheldTextMessages: 1,
  });
  expect(
    openCodeFrozenCompleteness(snapshot("Visible complete text"), [
      "secret_prefix",
    ]),
  ).toEqual({ unfinishedMessages: 1, withheldTextMessages: 0 });
  expect(
    openCodeFrozenCompleteness(snapshot("Visible secret_pre", true), [
      "secret_prefix",
    ]),
  ).toEqual({ unfinishedMessages: 0, withheldTextMessages: 0 });
  expect(input.messages[0]!.parts[0]!.text).toBe("Visible secret_pre");
  input.info.revert = { messageID: "message" };
  expect(openCodeFrozenCompleteness(input, ["secret_prefix"])).toEqual({
    unfinishedMessages: 0,
    withheldTextMessages: 0,
  });
});
it("accounts for unfinished native error text buffered by the converter", () => {
  const input = snapshot("");
  input.messages[0]!.info.error = { data: { message: "secret_pre" } };
  expect(openCodeFrozenCompleteness(input, ["secret_prefix"])).toEqual({
    unfinishedMessages: 1,
    withheldTextMessages: 1,
  });
});
