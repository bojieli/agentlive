import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicJson } from "@agentlive/storage";

/** On-disk layout version of a server data directory. Bump only with an explicit migration. */
export const SERVER_DATA_FORMAT = 1;
const markerSchema = z.strictObject({
  format: z.literal("agentlive-server-data"),
  version: z.number().int().positive().safe(),
});

export class UnsupportedDataFormatError extends Error {
  readonly code = "unsupported_data_format";
  constructor(readonly version: number) {
    super(
      `Server data format ${version} was written by a newer AgentLive (this version supports format ${SERVER_DATA_FORMAT}). Run a release that supports it, or restore a backup taken before the upgrade into a new directory.`,
    );
    this.name = "UnsupportedDataFormatError";
  }
}

/** Return the recorded format, or undefined for directories created before the marker existed. */
export async function readDataFormat(
  directory: string,
): Promise<number | undefined> {
  let text: string;
  try {
    text = await readFile(join(directory, "format.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let parsed;
  try {
    parsed = markerSchema.safeParse(JSON.parse(text));
  } catch {
    parsed = undefined;
  }
  if (!parsed?.success) throw new Error("Invalid server data format marker");
  return parsed.data.version;
}

export async function assertSupportedDataFormat(directory: string) {
  const version = await readDataFormat(directory);
  if (version !== undefined && version > SERVER_DATA_FORMAT)
    throw new UnsupportedDataFormatError(version);
  return version;
}

/**
 * Called under the server lock before any other state is read. Refuses data
 * from a newer release, so rolling back to an older binary cannot silently
 * reinterpret it, and stamps unmarked (format 1) directories.
 */
export async function ensureDataFormat(directory: string): Promise<number> {
  const version = await assertSupportedDataFormat(directory);
  if (version === SERVER_DATA_FORMAT) return version;
  // Future formats migrate here, one explicit version step at a time.
  await atomicJson(join(directory, "format.json"), {
    format: "agentlive-server-data",
    version: SERVER_DATA_FORMAT,
  });
  return SERVER_DATA_FORMAT;
}
