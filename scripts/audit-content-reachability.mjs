/** Synthetic-workload diagnostic only. Never use this generic reference scan to authorize deletion. */
export async function auditContentReachability(content, roots) {
  const visited = new Map(),
    manifests = new Set();
  const pending = [...roots];
  function references(value) {
    if (!value || typeof value !== "object") return;
    if (
      Object.keys(value).sort().join(",") === "byteSize,hash,units" &&
      /^[a-f0-9]{64}$/.test(value.hash)
    ) {
      pending.push(value);
      return;
    }
    for (const item of Object.values(value)) references(item);
  }
  while (pending.length) {
    const ref = pending.pop();
    if (manifests.has(ref.hash)) continue;
    manifests.add(ref.hash);
    // Codec tracing validates manifest and page semantics as well as backend integrity.
    for (const blob of await content.trace(ref)) {
      if (visited.has(blob.hash) && visited.get(blob.hash) !== blob.byteSize)
        throw new Error("Conflicting reference sizes");
      visited.set(blob.hash, blob.byteSize);
    }
    // This diagnostic deliberately bounds reconstructed metadata and its in-memory traversal.
    if (ref.units > 1048576 || manifests.size > 100000)
      throw new Error("Diagnostic traversal limit exceeded");
    let text = "";
    for (let offset = 0; offset < ref.units; offset += 65536)
      text += await content.read(
        ref,
        offset,
        Math.min(65536, ref.units - offset),
      );
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      continue;
    }
    references(value);
  }
  return {
    roots: roots.length,
    manifests: manifests.size,
    blobFiles: visited.size,
    bytes: [...visited.values()].reduce((sum, size) => sum + size, 0),
  };
}

/** Format-aware reducer checkpoint diagnostic. Pins and reclamation remain the caller's responsibility. */
export async function auditPagedContentReachability(content, roots, binding) {
  const { PagedReducer } = await import("../packages/playback/dist/index.js");
  const reducer = new PagedReducer(content),
    manifests = new Set(),
    blobs = new Map();
  for (const root of roots) {
    await reducer.trace(root, binding, async (ref) => {
      if (manifests.has(ref.hash)) return;
      for (const blob of await content.trace(ref)) {
        const previous = blobs.get(blob.hash);
        if (previous !== undefined && previous !== blob.byteSize)
          throw new Error("Conflicting codec reference sizes");
        blobs.set(blob.hash, blob.byteSize);
      }
      manifests.add(ref.hash);
    });
  }
  return {
    roots: roots.length,
    manifests: manifests.size,
    blobFiles: blobs.size,
    bytes: [...blobs.values()].reduce((sum, size) => sum + size, 0),
  };
}
