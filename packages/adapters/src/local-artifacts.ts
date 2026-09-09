import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { z } from "zod";
import { attachmentSchema, ProtocolError } from "@agentlive/protocol";
import { atomicJson, syncDirectory } from "@agentlive/storage";
import {
  ArtifactSpool,
  uploadArtifact,
  type InlineArtifactCapture,
} from "@agentlive/publisher";
import type { FileArtifactResolver } from "./artifact-types.js";
const outcome = z.union([
  z.strictObject({ attachment: attachmentSchema }),
  z.strictObject({ reason: z.string() }),
]);
/** Outcome checkpoint preserves unavailable representations as well as captured versions. */
export async function localArtifactResolver(options: {
  directory: string;
  roots: readonly string[];
  baseDirectory: string;
  secrets: readonly string[];
  serverOrigin: string;
  streamId: string;
  writeSecret: string;
  signal: AbortSignal;
}) {
  const spool = await ArtifactSpool.open(join(options.directory, "capture"), {
    allowedRoots: options.roots,
    secrets: options.secrets,
  });
  const results = join(options.directory, "outcomes");
  try {
    await mkdir(results, { recursive: true, mode: 0o700 });
    await syncDirectory(options.directory);
  } catch (error) {
    await spool.close();
    throw error;
  }
  const resolveArtifact: FileArtifactResolver = async (input) => {
    options.signal.throwIfAborted();
    const key = createHash("sha256").update(input.sourceKey).digest("hex");
    const checkpoint = join(results, key + ".json");
    let result: z.infer<typeof outcome> | undefined;
    try {
      result = outcome.parse(JSON.parse(await readFile(checkpoint, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!result) {
      const extension = extname(input.path).toLowerCase();
      const mediaType =
        (
          {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".gif": "image/gif",
            ".webp": "image/webp",
            ".svg": "image/svg+xml",
            ".md": "text/markdown",
            ".txt": "text/plain",
          } as Record<string, string>
        )[extension] ?? "application/octet-stream";
      try {
        result = {
          attachment: await spool.capture(
            {
              ...input,
              path: input.path.startsWith("file:")
                ? input.path
                : resolve(options.baseDirectory, input.path),
              mediaType,
              text: [".svg", ".md", ".txt"].includes(extension),
            },
            options.signal,
          ),
        };
      } catch (error) {
        if (options.signal.aborted) throw error;
        const code = (error as NodeJS.ErrnoException).code;
        if (
          ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(code ?? "")
        )
          result = {
            reason: "Referenced historical file is missing or inaccessible",
          };
        else if (
          error instanceof ProtocolError &&
          ["invalid_request", "precondition_failed"].includes(error.code)
        )
          result = { reason: error.message };
        else throw error;
      }
      await atomicJson(checkpoint, result);
    }
    if ("attachment" in result)
      await uploadArtifact(spool, result.attachment, options);
    return result;
  };
  const resolveInline = async (input: InlineArtifactCapture) => {
    const attachment = await spool.captureInline(input, options.signal);
    await uploadArtifact(spool, attachment, options);
    return attachment;
  };
  return { resolveArtifact, resolveInline, close: () => spool.close() };
}
