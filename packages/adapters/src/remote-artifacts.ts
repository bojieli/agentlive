import { canonicalJson } from "@agentlive/protocol";
import { MIMEType } from "node:util";
import { z } from "zod";
import { createHash } from "node:crypto";
export interface RemoteArtifactPolicy {
  /** Exact origins selected by the local operator; never supplied by a transcript. */
  origins: readonly { origin: string; authorization?: string }[];
  maxBytes?: number;
  timeoutMs?: number;
}
const policySchema = z.strictObject({
  origins: z
    .array(
      z.strictObject({
        origin: z.string().min(1).max(2048),
        authorization: z.string().min(1).max(8192).optional(),
      }),
    )
    .max(64),
  maxBytes: z
    .number()
    .int()
    .min(1)
    .max(24 * 1024 * 1024)
    .optional(),
  timeoutMs: z.number().int().min(1).max(60000).optional(),
});
export function validateRemoteArtifactPolicy(
  input: unknown,
): RemoteArtifactPolicy {
  const parsed = policySchema.safeParse(input);
  if (!parsed.success)
    throw new Error("Invalid remote artifact policy or limits");
  const policy = parsed.data;
  const origins = new Map<string, string | undefined>();
  for (const entry of policy.origins) {
    let origin: URL;
    try {
      origin = new URL(entry.origin);
    } catch {
      throw new Error("Invalid remote artifact origin policy");
    }
    if (
      !["https:", "http:"].includes(origin.protocol) ||
      origin.origin !== entry.origin ||
      origin.username ||
      origin.password ||
      origins.has(origin.origin)
    )
      throw new Error("Invalid or duplicate remote artifact origin policy");
    if (
      entry.authorization !== undefined &&
      (!entry.authorization || /[\r\n]/.test(entry.authorization))
    )
      throw new Error("Invalid remote artifact authorization policy");
    origins.set(origin.origin, entry.authorization);
  }
  return policy as RemoteArtifactPolicy;
}
/** Policy participates in durable filter identity even when no credential is needed. */
export function remoteArtifactSecrets(policy?: RemoteArtifactPolicy): string[] {
  return policy
    ? [
        canonicalJson(policy),
        ...policy.origins.flatMap((entry) =>
          entry.authorization ? [entry.authorization] : [],
        ),
      ]
    : [];
}
/** Fetch only from configured origins; redirects never receive credentials. */
export async function fetchRemoteArtifact(
  input: { url: string; expectedSourceHash?: string; mediaType?: string },
  policy: RemoteArtifactPolicy,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  signal.throwIfAborted();
  policy = validateRemoteArtifactPolicy(policy);
  const maximum = policy.maxBytes ?? 24 * 1024 * 1024;
  const timeout = policy.timeoutMs ?? 15000;
  const origins = new Map(
    policy.origins.map((entry) => [entry.origin, entry.authorization]),
  );
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new Error("Invalid remote artifact URL");
  }
  if (url.username || url.password || url.hash || !origins.has(url.origin))
    throw new Error("Remote artifact origin is not authorized");
  if (
    input.expectedSourceHash !== undefined &&
    !/^[a-f0-9]{64}$/.test(input.expectedSourceHash)
  )
    throw new Error("Invalid remote artifact source hash");
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Remote artifact capture timed out")),
    timeout,
  );
  const operationSignal = AbortSignal.any([signal, controller.signal]);
  let body: ReadableStream<Uint8Array> | null | undefined;
  try {
    const authorization = origins.get(url.origin);
    let response: Response;
    try {
      response = await fetcher(url.href, {
        redirect: "manual",
        credentials: "omit",
        headers: authorization ? { authorization } : {},
        signal: operationSignal,
      });
    } catch {
      operationSignal.throwIfAborted();
      throw new Error("Remote artifact request failed");
    }
    body = response.body;
    if (response.status !== 200)
      throw new Error(
        `Remote artifact request returned HTTP ${response.status}`,
      );
    if (response.url && new URL(response.url).origin !== url.origin)
      throw new Error("Remote artifact response changed origin");
    let mime: MIMEType;
    try {
      mime = new MIMEType(
        response.headers.get("content-type") ?? "application/octet-stream",
      );
    } catch {
      throw new Error("Remote artifact media type is invalid or changed");
    }
    const type = mime.essence;
    if (
      !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type) ||
      type.length > 128 ||
      (input.mediaType && input.mediaType.toLowerCase() !== type)
    )
      throw new Error("Remote artifact media type is invalid or changed");
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum))
      throw new Error("Remote artifact exceeds capture limit");
    if (!body) throw new Error("Remote artifact has no response body");
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        operationSignal.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maximum)
          throw new Error("Remote artifact exceeds capture limit");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const bytes = Buffer.concat(chunks, size);
    const sourceHash = createHash("sha256").update(bytes).digest("hex");
    if (input.expectedSourceHash && input.expectedSourceHash !== sourceHash)
      throw new Error("Remote artifact source hash changed");
    const text =
      type.startsWith("text/") ||
      [
        "application/json",
        "application/javascript",
        "application/xml",
        "image/svg+xml",
      ].includes(type) ||
      type.endsWith("+json") ||
      type.endsWith("+xml");
    if (text) {
      const charset = mime.params.get("charset")?.toLowerCase();
      if (charset && charset !== "utf-8" && charset !== "utf8")
        throw new Error("Remote text artifact requires UTF-8 charset");
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error("Remote text artifact is not valid UTF-8");
      }
    }
    return {
      bytes,
      mediaType: type,
      text,
      sourceHash,
      historical: input.expectedSourceHash !== undefined,
    };
  } finally {
    clearTimeout(timer);
    await body?.cancel().catch(() => {});
  }
}
