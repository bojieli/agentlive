import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { publisherBindingKey, type PublisherBinding } from "./journal.js";

/** Durable live-binding migration state for one binding key, outside the binding itself. */
export function liveMigrationDirectory(publisherRoot: string, key: string) {
  return join(publisherRoot, "live-migrations", key);
}

/**
 * A live-binding migration retires and replaces the binding at this key. While its
 * intent is unfinished, publishing must not create or attach another binding here.
 */
export async function assertNoPendingLiveMigration(
  publisherRoot: string,
  input: {
    serverOrigin: string;
    agent: PublisherBinding["nativeAgent"];
    nativeSessionId: string;
  },
) {
  let key: string;
  try {
    key = publisherBindingKey(input);
  } catch {
    return; // Opening the journal reports invalid origins.
  }
  let raw: string;
  try {
    raw = await readFile(
      join(liveMigrationDirectory(publisherRoot, key), "intent.json"),
      "utf8",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  let completed = false;
  try {
    completed = (JSON.parse(raw) as { completed?: unknown }).completed === true;
  } catch {
    /* Malformed intent is treated as pending. */
  }
  if (!completed)
    throw new Error(
      "A live-binding migration is pending for this native session; rerun agentlive migrate-live with its original arguments to complete it",
    );
}
