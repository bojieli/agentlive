import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { idSchema } from "@agentlive/protocol";
import { atomicJson } from "@agentlive/storage";
import { readJsonlSource } from "./jsonl.js";
import { discoverCodexFamily } from "./codex-family.js";
import { inspectCodexHistory } from "./codex-history.js";
import { kimiFamilyRoot } from "./kimi-family.js";

export const fileFamilyImportVersions: Readonly<Record<string, string>> = {
  "kimi-history-4-main-family-1": "kimi-history-4-main-family-import-1",
  "claude-history-4-family-1": "claude-history-4-family-import-1",
  "codex-history-4-family-1": "codex-history-4-family-import-1",
};
const cursorSchema = z.strictObject({
  offset: z.number().int().nonnegative().safe(),
  prefixHash: z.string().regex(/^[a-f0-9]{64}$/),
});
const familySchema = z
  .array(
    z.strictObject({
      sourcePath: z.string().min(1),
      nativeAgent: idSchema,
      boundary: cursorSchema,
    }),
  )
  .max(199);

/** Empty prefixes do not select a format; captured response content does. */
export async function assertCodexResumeFormat(
  path: string,
  boundary: z.infer<typeof cursorSchema>,
  format: string,
  signal: AbortSignal,
) {
  if (format !== "structured" && format !== "legacy")
    throw new Error("Unsupported Codex live record format");
  let structured = false,
    legacy = false;
  for await (const record of readJsonlSource(path, {
    through: boundary.offset,
    tail: "parse",
    signal,
  })) {
    const row = record.value as { type?: string; payload?: { type?: string } };
    if (row.type === "event_msg" && row.payload?.type === "item_completed")
      structured = true;
    if (row.type === "response_item") legacy = true;
  }
  if (
    (structured && format !== "structured") ||
    (!structured && legacy && format !== "legacy")
  )
    throw new Error(
      "Live record format differs from an imported Codex family prefix",
    );
}

/** Verify all imported children before seeding recoverable live-prefix guards. */
export async function prepareFileFamilyResume(options: {
  agent: "kimi" | "claude" | "codex";
  familyRoot?: string;
  recordFormat?: string;
  nativeSessionId: string;
  sourcePath: string;
  directory: string;
  sources: unknown;
  signal: AbortSignal;
}) {
  const sources = familySchema.parse(options.sources);
  const agents = new Set<string>();
  const pending: { path: string; cursor: z.infer<typeof cursorSchema> }[] = [];
  if (
    options.agent === "codex" &&
    (!options.familyRoot || !options.recordFormat)
  )
    throw new Error(
      "Codex family continuation requires its source root and record format",
    );
  const threads =
    options.agent === "codex"
      ? await discoverCodexFamily(
          options.familyRoot!,
          options.nativeSessionId,
          options.sourcePath,
          options.signal,
        )
      : undefined;
  if (threads) {
    for (const [id, candidate] of threads) {
      const manifest = await inspectCodexHistory(
        candidate.source!,
        options.signal,
        "defer",
      );
      if (
        manifest.nativeSessionId !== options.nativeSessionId ||
        manifest.nativeThreadIds[0] !== id ||
        (id !== options.nativeSessionId &&
          manifest.nativeThreadParents?.[id] !== candidate.parentNativeThreadId)
      )
        throw new Error(
          "Codex family source identity changed before continuation",
        );
      const ancestors = new Set<string>();
      let ancestor = candidate.parentNativeThreadId;
      while (ancestor) {
        ancestors.add(ancestor);
        if (ancestor === options.nativeSessionId) break;
        ancestor = threads.get(ancestor)?.parentNativeThreadId;
      }
      if (
        id !== options.nativeSessionId &&
        manifest.nativeThreadIds.some(
          (thread) => thread !== id && !ancestors.has(thread),
        )
      )
        throw new Error("Codex child contains unrelated thread metadata");
      if (
        options.recordFormat === "legacy" &&
        (manifest.structuredItems ||
          (id !== options.nativeSessionId &&
            manifest.nativeThreadIds.length > 1))
      )
        throw new Error(
          "Codex source conflicts with legacy family continuation",
        );
    }
  }
  const root =
    options.agent === "kimi"
      ? kimiFamilyRoot(options.sourcePath, options.nativeSessionId)
      : join(
          dirname(resolve(options.sourcePath)),
          options.nativeSessionId,
          "subagents",
        );
  const verify = async (path: string, cursor: z.infer<typeof cursorSchema>) => {
    for await (const _ of readJsonlSource(path, {
      after: cursor,
      through: cursor.offset,
      signal: options.signal,
    }))
      void _;
  };
  for (const child of sources) {
    if (
      agents.has(child.nativeAgent) ||
      (options.agent === "kimi" && child.nativeAgent === "main")
    )
      throw new Error(
        "Imported family has duplicate or invalid child identity",
      );
    agents.add(child.nativeAgent);
    if (
      options.agent === "codex" &&
      (child.nativeAgent === options.nativeSessionId ||
        !threads?.get(child.nativeAgent)?.source)
    )
      throw new Error("Imported Codex child is missing or invalid");
    const expected =
      options.agent === "codex"
        ? threads!.get(child.nativeAgent)!.source!
        : options.agent === "kimi"
          ? join(root, "agents", child.nativeAgent, "wire.jsonl")
          : join(root, `agent-${child.nativeAgent}.jsonl`);
    if (resolve(child.sourcePath) !== expected)
      throw new Error(
        "Imported child source does not match the live family layout",
      );
    await verify(expected, child.boundary);
    if (options.agent === "codex")
      await assertCodexResumeFormat(
        expected,
        child.boundary,
        options.recordFormat!,
        options.signal,
      );
    const checkpoint = join(
      options.directory,
      `${options.agent}-child-${createHash("sha256").update(child.nativeAgent).digest("hex")}.json`,
    );
    let retained: z.infer<typeof cursorSchema> | undefined;
    try {
      retained = cursorSchema.parse(
        JSON.parse(await readFile(checkpoint, "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (retained) {
      if (retained.offset < child.boundary.offset)
        throw new Error("Retained child cursor precedes its imported prefix");
      await verify(expected, retained);
    } else {
      pending.push({ path: checkpoint, cursor: child.boundary });
    }
  }
  for (const checkpoint of pending)
    await atomicJson(checkpoint.path, checkpoint.cursor);
}
