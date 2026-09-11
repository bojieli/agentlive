import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { canonicalJson } from "@agentlive/protocol";
import { atomicJson } from "@agentlive/storage";
import { isFileFamilyExpansion } from "./expand-family.js";
import type { PublishIdentity } from "./resume-import.js";
const digest = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
/** Keep original import-resume provenance while an explicitly authorized scope grows. */
export async function prepareImportedFileExpansion(
  directory: string,
  identity: PublishIdentity,
  requested: boolean,
) {
  const read = async (name: string) => {
    try {
      return JSON.parse(await readFile(join(directory, name), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return undefined;
    }
  };
  const imported = await read("import.json");
  if (!imported) return undefined;
  const marker = await read("import-family-expansion.json");
  if (!marker && !requested) return undefined;
  const transition = await read("resume-import.json");
  if (!transition?.complete)
    throw new Error(
      "Resume the original single-session import before expanding its family scope",
    );
  const original = marker?.original ?? (await read("publish.json"));
  if (
    !original ||
    !isFileFamilyExpansion(original, { ...identity }) ||
    transition.identityHash !== digest(original) ||
    transition.importHash !== digest(imported)
  )
    throw new Error(
      "Imported family expansion conflicts with verified resume provenance or capture policies",
    );
  if (
    marker &&
    (marker.version !== 1 ||
      marker.importHash !== digest(imported) ||
      canonicalJson(marker.expanded) !== canonicalJson(identity))
  )
    throw new Error("Imported family expansion identity changed");
  return {
    original: original as PublishIdentity,
    commit: async () => {
      if (!marker)
        await atomicJson(join(directory, "import-family-expansion.json"), {
          version: 1,
          original,
          expanded: identity,
          importHash: digest(imported),
        });
    },
  };
}

/** OpenCode's import identity differs from its live manifest; pin both policies. */
export async function prepareImportedOpenCodeExpansion(
  directory: string,
  resumeIdentity: PublishIdentity,
  liveIdentity: Record<string, unknown>,
  requested: boolean,
) {
  const markerPath = join(directory, "import-family-expansion.json");
  let marker:
    | {
        version: number;
        previous: Record<string, unknown>;
        expanded: Record<string, unknown>;
        importHash: string;
      }
    | undefined;
  try {
    marker = JSON.parse(await readFile(markerPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!marker && !requested) return undefined;
  const imported = JSON.parse(
    await readFile(join(directory, "import.json"), "utf8"),
  );
  const transition = JSON.parse(
    await readFile(join(directory, "resume-import.json"), "utf8").catch(
      (error) => {
        if (error.code === "ENOENT") return "{}";
        throw error;
      },
    ),
  );
  if (!transition.complete)
    throw new Error(
      "Resume the original single-session import before expanding its family scope",
    );
  const original = {
    ...resumeIdentity,
    converterVersion: "opencode-snapshot-4",
  };
  if (
    imported.converterVersion !== original.converterVersion ||
    liveIdentity.includeChildren !== true ||
    transition.identityHash !== digest(original) ||
    transition.importHash !== digest(imported)
  )
    throw new Error(
      "OpenCode expansion conflicts with verified import resume provenance",
    );
  const previous =
    marker?.previous ??
    JSON.parse(await readFile(join(directory, "publish.json"), "utf8"));
  if (
    previous.includeChildren !== undefined ||
    canonicalJson({ ...previous, includeChildren: true }) !==
      canonicalJson(liveIdentity)
  )
    throw new Error(
      "OpenCode expansion changes policies other than family scope",
    );
  if (
    marker &&
    (marker.version !== 1 ||
      marker.importHash !== digest(imported) ||
      canonicalJson(marker.expanded) !== canonicalJson(liveIdentity))
  )
    throw new Error("OpenCode import expansion identity changed");
  return {
    original,
    commit: async () => {
      if (!marker)
        await atomicJson(markerPath, {
          version: 1,
          previous,
          expanded: liveIdentity,
          importHash: digest(imported),
        });
    },
  };
}
