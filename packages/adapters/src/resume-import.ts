import {
  fileFamilyImportVersions,
  prepareFileFamilyResume,
  assertCodexResumeFormat,
} from "./resume-file-family.js";
import { inspectOpenCodeHistory } from "./opencode-history.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson, storedEventSchema } from "@agentlive/protocol";
import type { PublisherJournal } from "@agentlive/publisher";
import { atomicJson } from "@agentlive/storage";
import { request, retryable, delay } from "@agentlive/client/transport";
import { readJsonlSource } from "./jsonl.js";
const digest = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
export interface PublishIdentity {
  version: number;
  converterVersion: string;
  familyRoot?: string;
  recordFormat: string;
  baseDirectory: string;
  roots: string[];
  title: string;
  visibility: "private" | "public" | "unlisted";
  filterFingerprint: string;
}
/** Persist intent before the idempotent remote reopen, and completion before live capture. */
export async function resumeImportedRecording(options: {
  journal: PublisherJournal;
  sourcePath: string;
  identity: PublishIdentity;
  requested: boolean;
  validateOpenCodeFamily?: (sources: unknown) => Promise<void>;
  signal: AbortSignal;
}) {
  const { journal, identity, signal } = options;
  let imported;
  try {
    imported = JSON.parse(
      await readFile(join(journal.directory, "import.json"), "utf8"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (options.requested)
      throw new Error(
        "No import exists for this server and native session binding",
      );
    return;
  }
  const path = join(journal.directory, "resume-import.json");
  const transitionSchema = z.strictObject({
    version: z.literal(1),
    identityHash: z.string(),
    importHash: z.string(),
    operationId: z.string(),
    expectedLifecycleSeq: z.number().int().nonnegative().safe(),
    revision: z.string(),
    complete: z.boolean(),
  });
  let transition: z.infer<typeof transitionSchema> | undefined;
  try {
    transition = transitionSchema.parse(
      JSON.parse(await readFile(path, "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!transition && !options.requested)
    throw new Error(
      "This binding is a historical import; use --resume-import with the original import options to continue it live",
    );
  const fileFamilyVersion = fileFamilyImportVersions[identity.converterVersion];
  const isFileFamily =
    fileFamilyVersion !== undefined &&
    (journal.identity.nativeAgent === "kimi" ||
      journal.identity.nativeAgent === "claude" ||
      journal.identity.nativeAgent === "codex");
  if (
    imported.version !== 1 ||
    imported.converterVersion !==
      (isFileFamily ? fileFamilyVersion : identity.converterVersion) ||
    imported.nativeSessionId !== journal.identity.nativeSessionId ||
    imported.artifactBaseDirectory !== identity.baseDirectory ||
    canonicalJson(imported.artifactRoots) !== canonicalJson(identity.roots) ||
    imported.filterFingerprint !== identity.filterFingerprint ||
    imported.title !== identity.title ||
    imported.visibility !== identity.visibility
  )
    throw new Error(
      "Import conversion, filtering, artifact or sharing options differ; migration requires the original import options",
    );
  const cursor = z
    .strictObject({
      offset: z.number().int().nonnegative().safe(),
      prefixHash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .parse({ offset: imported.sourceBytes, prefixHash: imported.sourcePrefix });
  if (journal.identity.nativeAgent === "opencode") {
    const source = await inspectOpenCodeHistory(options.sourcePath, signal);
    if (
      source.nativeSessionId !== journal.identity.nativeSessionId ||
      source.boundary.offset !== cursor.offset ||
      source.boundary.prefixHash !== cursor.prefixHash
    )
      throw new Error("OpenCode export changed since import");
  } else {
    for await (const _ of readJsonlSource(options.sourcePath, {
      after: cursor,
      through: cursor.offset,
      signal,
    }))
      void _;
  }
  if (isFileFamily) {
    await prepareFileFamilyResume({
      agent: journal.identity.nativeAgent as "kimi" | "claude" | "codex",
      ...(identity.familyRoot ? { familyRoot: identity.familyRoot } : {}),
      recordFormat: identity.recordFormat,
      nativeSessionId: journal.identity.nativeSessionId,
      sourcePath: options.sourcePath,
      directory: journal.directory,
      sources: imported.familySources,
      signal,
    });
  } else if (
    journal.identity.nativeAgent === "opencode" &&
    identity.converterVersion === "opencode-snapshot-4-family-import-1"
  ) {
    if (!options.validateOpenCodeFamily)
      throw new Error("OpenCode family continuation requires native preflight");
    await options.validateOpenCodeFamily(imported.familySources);
  } else if (imported.familySources !== undefined) {
    throw new Error(
      "Family import continuation requires the same supported family scope",
    );
  }
  if (journal.identity.nativeAgent === "codex" && isFileFamily) {
    await assertCodexResumeFormat(
      options.sourcePath,
      cursor,
      identity.recordFormat,
      signal,
    );
  } else if (journal.identity.nativeAgent === "codex") {
    let structured = false;
    for await (const record of readJsonlSource(options.sourcePath, {
      through: cursor.offset,
      tail: "parse",
      signal,
    })) {
      const row = record.value as {
        type?: string;
        payload?: { type?: string };
      };
      if (row.type === "event_msg" && row.payload?.type === "item_completed")
        structured = true;
    }
    if (identity.recordFormat !== (structured ? "structured" : "legacy"))
      throw new Error(
        "Live record format differs from the imported Codex prefix",
      );
  }
  if (
    transition &&
    (transition.identityHash !== digest(identity) ||
      transition.importHash !== digest(imported) ||
      transition.revision !== journal.identity.revision)
  )
    throw new Error(
      "Import resume intent changed; explicit reconciliation is required",
    );
  if (transition?.complete) return;
  if (
    !journal.identity.streamId ||
    !journal.identity.revision ||
    journal.identity.acknowledgedSeq !== journal.capturedThrough ||
    !journal.identity.sharingEnabled
  )
    throw new Error("Import must be fully acknowledged before continuing live");
  const base = `${journal.identity.serverOrigin}/api/v1/streams/${journal.identity.streamId}`;
  const send = async (url: string, init: RequestInit) => {
    let attempt = 0;
    while (true) {
      try {
        return await request(fetch, url, init, signal, 16384);
      } catch (error) {
        if (signal.aborted || !retryable(error)) throw error;
        await delay(Math.min(30000, 250 * 2 ** Math.min(attempt++, 7)), signal);
      }
    }
  };
  const headers = { authorization: `Bearer ${journal.identity.writeSecret}` };
  if (!transition) {
    const metadata = z
      .object({
        revision: z.string(),
        lifecycle: z.string(),
        lifecycleSeq: z.number().int().positive().safe(),
        serverSeq: z.number().int().positive().safe(),
        title: z.string(),
        visibility: z.string(),
      })
      .parse(JSON.parse((await send(base, { headers })).text));
    if (
      metadata.revision !== journal.identity.revision ||
      metadata.lifecycle !== "ended" ||
      metadata.lifecycleSeq !== metadata.serverSeq ||
      metadata.title !== identity.title ||
      metadata.visibility !== identity.visibility
    )
      throw new Error(
        "Remote import lifecycle or sharing state differs; explicit reconciliation is required",
      );
    const url = new URL(base + "/events");
    url.searchParams.set("revision", metadata.revision);
    url.searchParams.set("afterServerSeq", String(metadata.lifecycleSeq - 1));
    url.searchParams.set("throughServerSeq", String(metadata.lifecycleSeq));
    url.searchParams.set("limit", "1");
    const ended = storedEventSchema.parse(
      JSON.parse((await send(url.toString(), { headers })).text),
    );
    if (
      ended.serverSeq !== metadata.lifecycleSeq ||
      ended.content.kind !== "recording.ended" ||
      ended.content.payload.producerEpoch !== journal.identity.producerEpoch ||
      ended.content.payload.throughProducerSeq !== journal.capturedThrough
    )
      throw new Error(
        "Remote ended import does not match the durable publisher prefix",
      );
    transition = {
      version: 1,
      identityHash: digest(identity),
      importHash: digest(imported),
      operationId: digest({
        operation: "resume-import",
        revision: metadata.revision,
        lifecycleSeq: metadata.lifecycleSeq,
      }),
      expectedLifecycleSeq: metadata.lifecycleSeq,
      revision: metadata.revision,
      complete: false,
    };
    await atomicJson(path, transition);
  }
  const response = storedEventSchema.parse(
    JSON.parse(
      (
        await send(base + "/reopen", {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: canonicalJson({
            operationId: transition.operationId,
            expectedLifecycleSeq: transition.expectedLifecycleSeq,
            content: { kind: "recording.reopened", payload: {} },
          }),
        })
      ).text,
    ),
  );
  if (
    response.content.kind !== "recording.reopened" ||
    response.serverSeq !== transition.expectedLifecycleSeq + 1 ||
    response.origin.type !== "server" ||
    response.origin.operationId !== transition.operationId
  )
    throw new Error("Unexpected import reopen acknowledgment");
  await atomicJson(path, { ...transition, complete: true });
}
