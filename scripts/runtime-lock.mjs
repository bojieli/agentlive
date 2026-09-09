/** Reject direct dependency drift and lock entries that are not pinned registry artifacts. */
export function validateRuntimeLock(locked, manifest) {
  const lockedRoot = locked.packages?.[""];
  const ordered = (value) =>
    JSON.stringify(Object.fromEntries(Object.entries(value ?? {}).sort()));
  if (
    locked.lockfileVersion !== 3 ||
    locked.name !== manifest.name ||
    locked.version !== manifest.version ||
    !lockedRoot ||
    lockedRoot.name !== manifest.name ||
    lockedRoot.version !== manifest.version ||
    lockedRoot.license !== manifest.license ||
    ["dependencies", "engines", "bin"].some(
      (key) => ordered(lockedRoot[key]) !== ordered(manifest[key]),
    )
  )
    throw new Error(
      "Runtime lock differs from package metadata; run pnpm package:lock and review the lock update",
    );
  for (const [path, dependency] of Object.entries(locked.packages)) {
    if (!path) continue;
    if (
      dependency.link ||
      typeof dependency.resolved !== "string" ||
      !dependency.resolved.startsWith("https://registry.npmjs.org/") ||
      typeof dependency.integrity !== "string" ||
      !dependency.integrity.startsWith("sha512-")
    )
      throw new Error(
        "Runtime lock contains an unpinned or unsupported dependency source",
      );
  }
}
