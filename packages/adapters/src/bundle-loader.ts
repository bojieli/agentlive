import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { extname, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ARTIFACT_BUNDLE_MAX_CONTENT_BYTES } from "@agentlive/protocol";
import { decodeArtifactDataUrl } from "./data-url.js";
import {
  fetchRemoteArtifact,
  validateRemoteArtifactPolicy,
  type RemoteArtifactPolicy,
} from "./remote-artifacts.js";
import type { BundleLoadResult } from "./artifact-bundle.js";
/** Read only explicitly allowed roots/origins. Recheck the opened file after a bounded copy. */
export async function createBundleLoader(options: {
  roots: readonly string[];
  remoteArtifacts?: RemoteArtifactPolicy;
}) {
  const roots = await Promise.all(options.roots.map((root) => realpath(root)));
  const policy = options.remoteArtifacts
    ? validateRemoteArtifactPolicy(options.remoteArtifacts)
    : undefined;
  return async (
    input: string,
    signal: AbortSignal,
  ): Promise<BundleLoadResult> => {
    signal.throwIfAborted();
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      return { unavailable: "unsupported" };
    }
    if (url.protocol === "data:")
      return decodeArtifactDataUrl(input) ?? { unavailable: "unsupported" };
    if (["https:", "http:"].includes(url.protocol)) {
      if (!policy?.origins.some((entry) => entry.origin === url.origin))
        return { unavailable: "outside-scope" };
      return fetchRemoteArtifact(
        { url: input },
        {
          ...policy,
          maxBytes: Math.min(
            policy.maxBytes ?? ARTIFACT_BUNDLE_MAX_CONTENT_BYTES,
            ARTIFACT_BUNDLE_MAX_CONTENT_BYTES,
          ),
        },
        signal,
      );
    }
    if (url.protocol !== "file:" || url.search || url.hash)
      return { unavailable: "outside-scope" };
    try {
      const path = await realpath(fileURLToPath(url));
      if (
        !roots.some((root) => {
          const rel = relative(root, path);
          return (
            rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel)
          );
        })
      )
        return { unavailable: "outside-scope" };
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await file.stat({ bigint: true });
        if (!before.isFile()) return { unavailable: "unsupported" };
        if (before.size > BigInt(ARTIFACT_BUNDLE_MAX_CONTENT_BYTES))
          throw new Error("Bundle source exceeds file limit");
        const bytes = Buffer.alloc(Number(before.size));
        let offset = 0;
        while (offset < bytes.length) {
          signal.throwIfAborted();
          const result = await file.read(
            bytes,
            offset,
            bytes.length - offset,
            offset,
          );
          if (!result.bytesRead)
            throw new Error("Bundle source changed during capture");
          offset += result.bytesRead;
        }
        const after = await file.stat({ bigint: true });
        if (
          before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs ||
          before.ctimeNs !== after.ctimeNs
        )
          throw new Error("Bundle source changed during capture");
        const current = await stat(path, { bigint: true });
        if (
          (await realpath(path)) !== path ||
          current.dev !== after.dev ||
          current.ino !== after.ino
        )
          throw new Error("Bundle source path changed during capture");
        signal.throwIfAborted();
        const mediaType =
          (
            {
              ".html": "text/html",
              ".htm": "text/html",
              ".css": "text/css",
              ".js": "application/javascript",
              ".mjs": "application/javascript",
              ".json": "application/json",
              ".svg": "image/svg+xml",
              ".png": "image/png",
              ".jpg": "image/jpeg",
              ".jpeg": "image/jpeg",
              ".gif": "image/gif",
              ".webp": "image/webp",
              ".woff": "font/woff",
              ".woff2": "font/woff2",
              ".txt": "text/plain",
              ".pdf": "application/pdf",
            } as Record<string, string>
          )[extname(path).toLowerCase()] ?? "application/octet-stream";
        return { bytes, mediaType };
      } finally {
        await file.close();
      }
    } catch (error) {
      if (signal.aborted) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(code ?? ""))
        return { unavailable: "missing" };
      if (code === "ELOOP") return { unavailable: "outside-scope" };
      throw error;
    }
  };
}
