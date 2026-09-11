import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { syncDirectory } from "@agentlive/storage";
import { sessionMetadataSchema } from "./session.js";

/** Caller must hold the store lock and have drained all session users. */
export async function cleanRemovedStorage(directory: string) {
  const metadata = sessionMetadataSchema.parse(
    JSON.parse(await readFile(join(directory, "metadata.json"), "utf8")),
  );
  if (!metadata.removed)
    throw new Error("Cleanup requires a durable removal tombstone");
  // The tombstone is the recovery intent. Every other entry is disposable;
  // restart repeats partial cleanup without reopening or rebuilding event data.
  for (const entry of await readdir(directory)) {
    if (entry === "metadata.json") continue;
    await rm(join(directory, entry), { recursive: true, force: true });
  }
  await syncDirectory(directory);
}
