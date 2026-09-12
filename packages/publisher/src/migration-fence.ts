import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { publisherBindingKey, type PublisherBinding } from "./journal.js";

/** Durable live-binding migration state for one binding key, outside the binding itself. */
export function liveMigrationDirectory(publisherRoot: string, key: string) {
  return join(publisherRoot, "live-migrations", key);
}

const PENDING =
  "A live-binding migration is pending for this native session; rerun agentlive migrate-live with its original arguments to complete it";

async function readOptional(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * A live-binding migration retires and replaces the binding at this key. While its
 * intent is unfinished, publishing must not create or attach another binding here.
 *
 * A migration to another server places its replacement at the destination origin's
 * key instead, so it leaves a reservation there naming the operation's own key. The
 * intent stays the single authority: once it completes or is abandoned, a stale
 * reservation stops fencing anything.
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
  await assertKeyUnclaimed(publisherRoot, key, true);
}

async function assertKeyUnclaimed(
  publisherRoot: string,
  key: string,
  followReservation: boolean,
) {
  const directory = liveMigrationDirectory(publisherRoot, key);
  const raw = await readOptional(join(directory, "intent.json"));
  if (raw !== undefined) {
    let completed = false;
    try {
      completed =
        (JSON.parse(raw) as { completed?: unknown }).completed === true;
    } catch {
      /* Malformed intent is treated as pending. */
    }
    if (!completed) throw new Error(PENDING);
  }
  if (!followReservation) return;
  const reserved = await readOptional(join(directory, "reserved.json"));
  if (reserved === undefined) return;
  let sourceKey: unknown;
  try {
    sourceKey = (JSON.parse(reserved) as { sourceKey?: unknown }).sourceKey;
  } catch {
    throw new Error(PENDING);
  }
  if (typeof sourceKey !== "string" || !/^[a-f0-9]{64}$/.test(sourceKey))
    throw new Error(PENDING);
  await assertKeyUnclaimed(publisherRoot, sourceKey, false);
}
