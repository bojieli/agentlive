import { captureArtifactBundle } from "./artifact-bundle.js";
import { createBundleLoader } from "./bundle-loader.js";
import { ARTIFACT_BUNDLE_MEDIA_TYPE } from "@agentlive/protocol";
import { pathToFileURL } from "node:url";
import { basename } from "node:path";
import {
  fetchRemoteArtifact,
  type RemoteArtifactPolicy,
} from "./remote-artifacts.js";
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
  StreamingRedactor,
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
  artifactBundles?: boolean;
  remoteArtifacts?: RemoteArtifactPolicy;
  roots: readonly string[];
  baseDirectory: string;
  secrets: readonly string[];
  serverOrigin: string;
  streamId: string;
  writeSecret: string;
  signal: AbortSignal;
}) {
  const roots = await Promise.all(options.roots.map((root) => realpath(root)));
  const secrets = [
    ...new Set([
      ...options.secrets,
      ...(options.artifactBundles
        ? ["agentlive-artifact-bundle-policy-v2"]
        : []),
      ...(options.remoteArtifacts?.origins.flatMap((entry) =>
        entry.authorization ? [entry.authorization] : [],
      ) ?? []),
    ]),
  ].sort();
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
  const captureBundle = async (
    input: {
      artifactId: string;
      sourceKey: string;
      url: string;
      filename: string;
      expectedSourceHash?: string;
    },
    entry?: { bytes: Uint8Array; mediaType: string },
  ) => {
    const load = await createBundleLoader({
      roots,
      ...(options.remoteArtifacts
        ? { remoteArtifacts: options.remoteArtifacts }
        : {}),
    });
    const captured = await captureArtifactBundle({
      entrypoint: input.url,
      signal: options.signal,
      load: async (url, signal) => {
        const source =
          url === input.url && entry ? entry : await load(url, signal);
        if (url === input.url && "unavailable" in source)
          throw new ProtocolError(
            "precondition_failed",
            "Artifact bundle entrypoint is missing, inaccessible or outside capture scope",
          );
        if (
          url === input.url &&
          input.expectedSourceHash &&
          !("unavailable" in source) &&
          createHash("sha256").update(source.bytes).digest("hex") !==
            input.expectedSourceHash
        )
          throw new ProtocolError(
            "precondition_failed",
            "Artifact bundle entrypoint source hash changed",
          );
        return source;
      },
      filter: (text) => {
        const redactor = new StreamingRedactor(secrets);
        return redactor.push(text) + redactor.finish();
      },
    });
    return spool.captureInline(
      {
        artifactId: input.artifactId,
        sourceKey: input.sourceKey,
        bytes: captured.bytes,
        filename:
          (input.filename.slice(0, 220) || "artifact") +
          ".agentlive-bundle.json",
        mediaType: ARTIFACT_BUNDLE_MEDIA_TYPE,
        text: false,
        historical: false,
      },
      options.signal,
    );
  };
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
          attachment:
            options.artifactBundles && mediaType === "text/html"
              ? await captureBundle({
                  artifactId: input.artifactId,
                  sourceKey: input.sourceKey,
                  url: pathToFileURL(
                    captureRequest.path.startsWith("file:")
                      ? fileURLToPath(captureRequest.path)
                      : captureRequest.path,
                  ).href,
                  filename: basename(captureRequest.path),
                  ...(input.expectedSourceHash
                    ? { expectedSourceHash: input.expectedSourceHash }
                    : {}),
                })
              : await spool.capture(captureRequest, options.signal),
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
  let queuedInlineBytes = 0;
  const resolveInline = (input: InlineArtifactCapture) => {
    if (closed) return Promise.reject(new Error("Artifact resolver is closed"));
    const inputBytes = input.bytes.byteLength;
    if (inputBytes + queuedInlineBytes > 24 * 1024 * 1024)
      return Promise.reject(
        new Error("Inline artifact queue exceeds byte limit"),
      );
    input = { ...input, bytes: Buffer.from(input.bytes) };
    queuedInlineBytes += inputBytes;
    const operation = queue.then(async () => {
      if (!options.artifactBundles || input.mediaType !== "text/html") {
        const attachment = await spool.captureInline(input, options.signal);
        await uploadArtifact(spool, attachment, options);
        return attachment;
      }
      const checkpoint = join(
        results,
        `inline-bundle-${hash(input.sourceKey)}.json`,
      );
      const { bytes, ...metadata } = input;
      const requestHash = hash({
        metadata,
        sourceHash: createHash("sha256").update(bytes).digest("hex"),
        roots,
        baseDirectory,
        filter: hash(secrets),
        policy: options.remoteArtifacts ?? null,
      });
      let attachment;
      try {
        const saved = checkpointSchema.parse(
          JSON.parse(await readFile(checkpoint, "utf8")),
        );
        if (
          saved.requestHash !== requestHash ||
          !("attachment" in saved.result)
        )
          throw new Error("Inline bundle source or capture policy changed");
        attachment = saved.result.attachment;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (!attachment) {
        attachment = await captureBundle(
          {
            artifactId: input.artifactId,
            sourceKey: input.sourceKey,
            url: pathToFileURL(join(baseDirectory, basename(input.filename)))
              .href,
            filename: input.filename,
          },
          input,
        );
        await atomicJson(checkpoint, {
          version: 1,
          requestHash,
          result: { attachment },
        });
      }
      await uploadArtifact(spool, attachment, options);
      return attachment;
    });
    const settled = operation.finally(() => {
      queuedInlineBytes -= inputBytes;
    });
    queue = settled.catch(() => {});
    return settled;
  };
  const resolveRemote = (input: {
    artifactId: string;
    sourceKey: string;
    url: string;
    filename: string;
    mediaType?: string;
    expectedSourceHash?: string;
  }) => {
    if (closed) return Promise.reject(new Error("Artifact resolver is closed"));
    const operation = queue.then(async () => {
      if (!options.remoteArtifacts)
        return {
          reason: "Remote artifact capture has no configured origin policy",
        };
      idSchema.parse(input.artifactId);
      if (!input.sourceKey || input.sourceKey.length > 1024)
        throw new Error("Invalid remote artifact source key");
      const checkpoint = join(results, `remote-${hash(input.sourceKey)}.json`);
      const requestHash = hash({
        input,
        policy: options.remoteArtifacts,
        filter: hash(secrets),
      });
      let attachment;
      try {
        const saved = checkpointSchema.parse(
          JSON.parse(await readFile(checkpoint, "utf8")),
        );
        if (
          saved.requestHash !== requestHash ||
          !("attachment" in saved.result)
        )
          throw new Error("Remote artifact capture policy or identity changed");
        attachment = saved.result.attachment;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (!attachment) {
        const captured = await fetchRemoteArtifact(
          input,
          options.remoteArtifacts,
          options.signal,
        );
        attachment =
          options.artifactBundles && captured.mediaType === "text/html"
            ? await captureBundle(input, captured)
            : await spool.captureInline(
                {
                  ...captured,
                  artifactId: input.artifactId,
                  sourceKey: input.sourceKey,
                  filename: input.filename,
                },
                options.signal,
              );
        await atomicJson(checkpoint, {
          version: 1,
          requestHash,
          result: { attachment },
        });
      }
      await uploadArtifact(spool, attachment, options);
      return { attachment };
    });
    queue = operation.catch(() => {});
    return operation;
  };
  return {
    resolveArtifact,
    resolveInline,
    ...(options.remoteArtifacts ? { resolveRemote } : {}),
    close: async () => {
      closed = true;
      await queue;
      await spool.close();
    },
  };
}
