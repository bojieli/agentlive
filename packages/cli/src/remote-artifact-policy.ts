import { open } from "node:fs/promises";
import { validateRemoteArtifactPolicy } from "@agentlive/adapters";

/** Configuration contains environment variable names, never literal credentials. */
export async function loadRemoteArtifactPolicy(
  path: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const file = await open(path, "r");
  let input: unknown;
  try {
    if (!(await file.stat()).isFile())
      throw new Error("Artifact policy must be a file");
    const bytes = Buffer.alloc(65537);
    let size = 0;
    while (size < bytes.length) {
      const read = await file.read(bytes, size, bytes.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > 65536) throw new Error("Artifact policy exceeds 64 KiB");
    try {
      input = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(0, size),
        ),
      );
    } catch {
      throw new Error("Invalid artifact policy JSON");
    }
  } finally {
    await file.close();
  }
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid artifact policy");
  const config = input as Record<string, unknown>;
  if (!Array.isArray(config.origins) || config.origins.length > 64)
    throw new Error("Invalid artifact policy origins");
  const origins = config.origins.map((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid artifact policy origin");
    const entry = value as Record<string, unknown>;
    if (
      Object.keys(entry).some(
        (key) => !["origin", "authorizationEnv"].includes(key),
      )
    )
      throw new Error(
        "Artifact policy origins accept only origin and authorizationEnv",
      );
    const variable = entry.authorizationEnv;
    if (variable === undefined) return { origin: entry.origin };
    if (
      typeof variable !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(variable)
    )
      throw new Error("Invalid artifact authorization environment name");
    const authorization = environment[variable];
    if (!authorization)
      throw new Error(
        "Artifact authorization environment variable is missing or empty",
      );
    return { origin: entry.origin, authorization };
  });
  return validateRemoteArtifactPolicy({ ...config, origins });
}
