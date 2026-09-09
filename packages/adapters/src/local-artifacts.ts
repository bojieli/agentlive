import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { z } from "zod";
import {
  attachmentSchema,
  canonicalJson,
  ProtocolError,
  idSchema,
  hashSchema,
} from "@agentlive/protocol";
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
const checkpointSchema = z.strictObject({
  version: z.literal(1),
  requestHash: hashSchema,
  result: outcome,
});
const requestSchema = z.strictObject({
  artifactId: idSchema,
  sourceKey: z.string().min(1).max(1024),
  path: z.string().min(1),
  historical: z.boolean(),
  expectedSourceHash: hashSchema.optional(),
});
const hash = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
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
  const roots = await Promise.all(options.roots.map((root) => realpath(root)));
  const secrets = [...new Set(options.secrets)].sort();
  const baseDirectory = resolve(options.baseDirectory);
  const spool = await ArtifactSpool.open(join(options.directory, "capture"), {
    allowedRoots: roots,
    secrets,
  });
  const results = join(options.directory, "outcomes");
  try {
    await mkdir(results, { recursive: true, mode: 0o700 });
    await syncDirectory(options.directory);
  } catch (error) {
    await spool.close();
    throw error;
  }
  const resolveLocked: FileArtifactResolver = async (input) => {
    options.signal.throwIfAborted();
    const key = createHash("sha256").update(input.sourceKey).digest("hex");
    const checkpoint = join(results, key + ".json");
    const requestHash = hash({
      ...input,
      path: input.path.startsWith("file:")
        ? resolve(fileURLToPath(input.path))
        : resolve(baseDirectory, input.path),
      roots,
      filter: hash(secrets),
    });
    let result: z.infer<typeof outcome> | undefined;
    let legacy = false;
    try {
      const stored: unknown = JSON.parse(await readFile(checkpoint, "utf8"));
      const current = checkpointSchema.safeParse(stored);
      if (current.success) {
        if (current.data.requestHash !== requestHash)
          throw new ProtocolError(
            "precondition_failed",
            "Artifact outcome source identity or capture policy changed",
          );
        result = current.data.result;
      } else {
        result = outcome.parse(stored);
        legacy = true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const extension = extname(
      input.path.startsWith("file:") ? fileURLToPath(input.path) : input.path,
    ).toLowerCase();
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
          ".pdf": "application/pdf",
          ".html": "text/html",
          ".htm": "text/html",
          ".json": "application/json",
          ".csv": "text/csv",
          ".log": "text/plain",
          ".yaml": "text/yaml",
          ".yml": "text/yaml",
          ".js": "application/javascript",
          ".ts": "text/plain",
          ".css": "text/css",
        } as Record<string, string>
      )[extension] ?? "application/octet-stream";
    const captureRequest = {
      ...input,
      path: input.path.startsWith("file:")
        ? input.path
        : resolve(baseDirectory, input.path),
      mediaType,
      text: [
        ".svg",
        ".md",
        ".txt",
        ".html",
        ".htm",
        ".json",
        ".csv",
        ".log",
        ".yaml",
        ".yml",
        ".js",
        ".ts",
        ".css",
      ].includes(extension),
    };
    if (legacy) {
      if (!result || !("attachment" in result))
        throw new ProtocolError(
          "precondition_failed",
          "Legacy unavailable artifact outcome has no verifiable request binding",
        );
      if (result.attachment.artifactId !== input.artifactId)
        throw new ProtocolError(
          "precondition_failed",
          "Legacy artifact outcome identity changed",
        );
      const verified = await spool.capture(captureRequest, options.signal);
      if (canonicalJson(verified) !== canonicalJson(result.attachment))
        throw new ProtocolError(
          "precondition_failed",
          "Legacy artifact outcome differs from its durable capture",
        );
      await atomicJson(checkpoint, { version: 1, requestHash, result });
    }
    if (!result) {
      try {
        result = {
          attachment: await spool.capture(captureRequest, options.signal),
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
      await atomicJson(checkpoint, { version: 1, requestHash, result });
    }
    if ("attachment" in result)
      await uploadArtifact(spool, result.attachment, options);
    return result;
  };
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;
  const resolveArtifact: FileArtifactResolver = (input) => {
    if (closed) return Promise.reject(new Error("Artifact resolver is closed"));
    const parsed = requestSchema.parse(input);
    const { expectedSourceHash, ...rest } = parsed;
    const request = {
      ...rest,
      ...(expectedSourceHash === undefined ? {} : { expectedSourceHash }),
    };
    const operation = queue.then(() => resolveLocked(request));
    queue = operation.catch(() => {});
    return operation;
  };
  const resolveInline = async (input: InlineArtifactCapture) => {
    const attachment = await spool.captureInline(input, options.signal);
    await uploadArtifact(spool, attachment, options);
    return attachment;
  };
  return {
    resolveArtifact,
    resolveInline,
    close: async () => {
      closed = true;
      await queue;
      await spool.close();
    },
  };
}
