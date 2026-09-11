import { z } from "zod";
import { canonicalJson } from "./index.js";
export const ARTIFACT_BUNDLE_MEDIA_TYPE =
  "application/vnd.agentlive.artifact-bundle+json";
export const ARTIFACT_BUNDLE_MAX_BYTES = 24 * 1024 * 1024;
export const ARTIFACT_BUNDLE_MAX_CONTENT_BYTES = 16 * 1024 * 1024;
export const ARTIFACT_BUNDLE_MAX_FILES = 256;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
// Portable ASCII paths: no URL interpretation, escapes, empty segments, dot segments or drive letters.
export const artifactBundlePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (path) =>
      path.split("/").length <= 9 &&
      path
        .split("/")
        .every(
          (part) =>
            /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part) &&
            part !== "." &&
            part !== ".." &&
            !part.endsWith(".") &&
            !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
        ),
  );
const fileSchema = z.strictObject({
  path: artifactBundlePathSchema,
  hash: digest,
  mediaType: z
    .string()
    .max(128)
    .regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/),
  byteSize: z.number().int().min(0).max(ARTIFACT_BUNDLE_MAX_CONTENT_BYTES),
});
export const artifactBundleManifestSchema = z.strictObject({
  format: z.literal("agentlive.artifact-bundle"),
  version: z.literal(1),
  entrypoint: artifactBundlePathSchema,
  files: z.array(fileSchema).min(1).max(ARTIFACT_BUNDLE_MAX_FILES),
  unavailable: z
    .array(
      z.strictObject({
        from: artifactBundlePathSchema,
        target: artifactBundlePathSchema,
        reason: z.enum([
          "outside-scope",
          "missing",
          "depth-limit",
          "unsupported",
        ]),
      }),
    )
    .max(2048),
});
const envelopeSchema = z.strictObject({
  manifest: artifactBundleManifestSchema,
  manifestHash: digest,
  blobs: z.record(digest, z.string().max(24 * 1024 * 1024)),
});
export type ArtifactBundleManifest = z.infer<
  typeof artifactBundleManifestSchema
>;
export async function artifactBundleHash(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
/** Validate every leaf before exposing any file. Safe for browser and server consumers. */
export async function decodeArtifactBundle(bytes: Uint8Array) {
  if (bytes.byteLength > ARTIFACT_BUNDLE_MAX_BYTES)
    throw new Error("Artifact bundle exceeds encoded limit");
  let input: unknown;
  try {
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Invalid artifact bundle JSON");
  }
  const { manifest, manifestHash, blobs } = envelopeSchema.parse(input);
  if (
    (await artifactBundleHash(
      new TextEncoder().encode(canonicalJson(manifest)),
    )) !== manifestHash
  )
    throw new Error("Artifact bundle manifest hash mismatch");
  const files = new Map<string, Uint8Array>();
  const decoded = new Map<string, Uint8Array>();
  let total = 0;
  for (const file of manifest.files) {
    if (files.has(file.path)) throw new Error("Duplicate artifact bundle path");
    total += file.byteSize;
    if (total > ARTIFACT_BUNDLE_MAX_CONTENT_BYTES)
      throw new Error("Artifact bundle exceeds content limit");
    let content = decoded.get(file.hash);
    if (!content) {
      const encoded = blobs[file.hash];
      if (
        encoded === undefined ||
        encoded.length !== 4 * Math.ceil(file.byteSize / 3) ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
      )
        throw new Error("Invalid artifact bundle blob encoding");
      const binary = atob(encoded);
      if (btoa(binary) !== encoded)
        throw new Error("Noncanonical artifact bundle blob");
      content = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      if ((await artifactBundleHash(content)) !== file.hash)
        throw new Error("Artifact bundle leaf hash mismatch");
      decoded.set(file.hash, content);
    }
    if (content.byteLength !== file.byteSize)
      throw new Error("Artifact bundle leaf size mismatch");
    files.set(file.path, content);
  }
  if (Object.keys(blobs).length !== decoded.size)
    throw new Error("Artifact bundle contains unreferenced blobs");
  if (!files.has(manifest.entrypoint))
    throw new Error("Artifact bundle entrypoint is missing");
  for (const missing of manifest.unavailable)
    if (!files.has(missing.from) || files.has(missing.target))
      throw new Error("Invalid unavailable artifact bundle reference");
  return { manifest, manifestHash, files };
}
