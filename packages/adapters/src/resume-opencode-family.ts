import { discoverNativeSessions } from "./discovery.js";
import { z } from "zod";
import { canonicalJson, idSchema } from "@agentlive/protocol";
import { request } from "@agentlive/client/transport";
import { inspectOpenCodeHistory } from "./opencode-history.js";
import { OpenCodeCapture } from "./opencode-capture.js";
import type { PublisherJournal } from "@agentlive/publisher";
const sourcesSchema = z
  .array(
    z.strictObject({
      sourcePath: z.string().min(1),
      nativeAgent: idSchema,
      boundary: z.strictObject({
        offset: z.number().int().nonnegative().safe(),
        prefixHash: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    }),
  )
  .max(199);
/** Verify immutable exports, native lineage, and all retained converter policies before reopen. */
export async function prepareOpenCodeFamilyResume(options: {
  journal: PublisherJournal;
  sources: unknown;
  sourcePath: string;
  origin: string;
  password?: string;
  username?: string;
  secrets: readonly string[];
  signal: AbortSignal;
}) {
  const sources = sourcesSchema.parse(options.sources);
  const root = await inspectOpenCodeHistory(options.sourcePath, options.signal);
  const family = new Map([
    [root.nativeSessionId, { manifest: root, sourcePath: options.sourcePath }],
  ]);
  for (const child of sources) {
    if (family.has(child.nativeAgent))
      throw new Error("Imported OpenCode family has duplicate identities");
    const manifest = await inspectOpenCodeHistory(
      child.sourcePath,
      options.signal,
    );
    if (
      manifest.nativeSessionId !== child.nativeAgent ||
      canonicalJson(manifest.boundary) !== canonicalJson(child.boundary)
    )
      throw new Error("OpenCode child export changed since import");
    family.set(child.nativeAgent, { manifest, sourcePath: child.sourcePath });
  }
  const queue = [{ id: root.nativeSessionId, depth: 0 }];
  const liveParents = new Map<string, string>();
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index]!;
    const found = await discoverNativeSessions({
      agent: "opencode",
      nativeServer: options.origin,
      parentNativeSessionId: current.id,
      limit: 200,
      signal: options.signal,
      ...(options.password ? { password: options.password } : {}),
      ...(options.username ? { username: options.username } : {}),
    });
    if (found.truncated || found.skipped)
      throw new Error(
        "Native OpenCode family discovery is incomplete before continuation",
      );
    for (const child of found.sessions) {
      if (
        child.nativeSessionId === root.nativeSessionId ||
        liveParents.has(child.nativeSessionId) ||
        current.depth >= 8 ||
        queue.length >= 200
      )
        throw new Error(
          "Native OpenCode family is cyclic, ambiguous or exceeds capture limits",
        );
      liveParents.set(child.nativeSessionId, current.id);
      queue.push({ id: child.nativeSessionId, depth: current.depth + 1 });
    }
  }
  const headers = options.password
    ? {
        authorization: `Basic ${Buffer.from(`${options.username ?? "opencode"}:${options.password}`).toString("base64")}`,
      }
    : {};
  for (const [id, { manifest }] of family) {
    if (id !== root.nativeSessionId) {
      if (liveParents.get(id) !== manifest.parentNativeSessionId)
        throw new Error(
          "Imported OpenCode child is missing or reparented in native discovery",
        );
      const seen = new Set([id]);
      let parent = manifest.parentNativeSessionId;
      while (parent !== root.nativeSessionId) {
        if (!parent || seen.has(parent) || seen.size >= 8)
          throw new Error("Imported OpenCode family has invalid lineage");
        seen.add(parent);
        parent = family.get(parent)?.manifest.parentNativeSessionId;
      }
    }
    const live = z
      .object({
        id: idSchema,
        parentID: idSchema.optional(),
        time: z.object({ created: z.number().int().nonnegative() }),
      })
      .parse(
        JSON.parse(
          (
            await request(
              fetch,
              `${options.origin}/session/${encodeURIComponent(id)}`,
              { headers },
              options.signal,
              1024 * 1024,
            )
          ).text,
        ),
      );
    if (
      live.id !== id ||
      live.parentID !== manifest.parentNativeSessionId ||
      new Date(live.time.created).toISOString() !== manifest.createdAt
    )
      throw new Error(
        "Native OpenCode family identity or lineage changed since import",
      );
    const capture = await OpenCodeCapture.open(
      options.journal,
      options.secrets,
      undefined,
      id === root.nativeSessionId
        ? undefined
        : {
            nativeSessionId: id,
            parentNativeSessionId: manifest.parentNativeSessionId!,
          },
    );
    await capture.close();
  }
}
