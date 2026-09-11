import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { PublisherJournal, readPublisherOperation } from "@agentlive/publisher";
import { atomicJson, openArchive } from "@agentlive/storage";
import { idSchema, cursorSchema, canonicalJson } from "@agentlive/protocol";
import { originOf, request } from "@agentlive/client/transport";
import { listRecordings, removeRecording } from "@agentlive/client";
import { exportRecording } from "./export.js";
import { importArchiveRecording } from "./import-archive.js";
const hash = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
const targetSchema = z.strictObject({
  streamId: idSchema,
  revision: idSchema,
  lifecycle: z.literal("ended"),
});
const intentSchema = z.strictObject({
  version: z.literal(1),
  operationId: idSchema,
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceServerSeq: cursorSchema,
  archiveHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  target: targetSchema.optional(),
  completed: z.boolean(),
});
/** Transfer an ended committed recording, preserving its filtered history without native files. */
export async function migrateRecording(options: {
  directory: string;
  operationId: string;
  targetServerOrigin: string;
  sourceCredential: string;
  targetCredential: string;
  disposition: "retain" | "remove";
  confirmRemoval?: boolean;
  signal: AbortSignal;
}) {
  idSchema.parse(options.operationId);
  z.enum(["retain", "remove"]).parse(options.disposition);
  if (options.disposition === "remove" && !options.confirmRemoval)
    throw new Error("Recording migration removal requires --confirm-removal");
  const destination = originOf(options.targetServerOrigin);
  const journal = await PublisherJournal.openExisting(options.directory);
  try {
    const source = journal.identity;
    if (
      !source.streamId ||
      !source.revision ||
      source.pendingCredentialRotation
    )
      throw new Error(
        "Migration requires a bound publisher without credential rotation",
      );
    if (source.serverOrigin === destination)
      throw new Error(
        "Recording transfer requires a different destination server",
      );
    if (source.acknowledgedSeq !== journal.capturedThrough)
      throw new Error(
        "Finish the publisher to drain its pending captured events before transfer",
      );
    const raw = await readPublisherOperation(
      journal.directory,
      "archive-transfer.json",
    );
    const parsed = raw === undefined ? undefined : intentSchema.safeParse(raw);
    if (parsed && !parsed.success)
      throw new Error("Invalid archive transfer intent");
    let intent = parsed?.data;
    const requestHash = hash({
      operationId: options.operationId,
      sourceServerOrigin: source.serverOrigin,
      sourceStreamId: source.streamId,
      sourceRevision: source.revision,
      producerEpoch: source.producerEpoch,
      producerEvents: journal.capturedThrough,
      destination,
      disposition: options.disposition,
    });
    if (intent && intent.requestHash !== requestHash)
      throw new Error("Recording transfer retry differs from saved intent");
    const base = `${source.serverOrigin}/api/v1/streams/${source.streamId}`;
    const sourceHeaders = {
      authorization: `Bearer ${options.sourceCredential}`,
    };
    if (!intent?.target) {
      await request(
        fetch,
        base + "/visibility",
        { headers: sourceHeaders },
        options.signal,
        4096,
      );
      const metadata = z
        .object({
          revision: z.literal(source.revision),
          lifecycle: z.literal("ended"),
          serverSeq: cursorSchema,
        })
        .safeParse(
          JSON.parse(
            (
              await request(
                fetch,
                base,
                { headers: sourceHeaders },
                options.signal,
                4096,
              )
            ).text,
          ),
        );
      if (!metadata.success)
        throw new Error(
          "Finish the open publisher before migrating its recording, and verify the source revision",
        );
      if (intent && intent.sourceServerSeq !== metadata.data.serverSeq)
        throw new Error("Source recording changed during migration");
      await listRecordings({
        serverOrigin: destination,
        credential: options.targetCredential,
        signal: options.signal,
        limit: 1,
      });
      if (!intent) {
        intent = {
          version: 1,
          operationId: options.operationId,
          requestHash,
          sourceServerSeq: metadata.data.serverSeq,
          completed: false,
        };
        await atomicJson(
          join(journal.directory, "archive-transfer.json"),
          intent,
        );
      }
    }
    if (!intent) throw new Error("Missing archive transfer intent");
    const staging = join(
      journal.directory,
      "transfers",
      hash(options.operationId),
    );
    await mkdir(staging, { recursive: true, mode: 0o700 });
    const archivePath = join(staging, "recording.agentlive");
    let archive;
    try {
      archive = await openArchive(archivePath, options.signal);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" ||
        intent.archiveHash ||
        intent.target
      )
        throw error;
      await exportRecording({
        serverOrigin: source.serverOrigin,
        streamId: source.streamId,
        credential: options.sourceCredential,
        output: archivePath,
        signal: options.signal,
      });
      archive = await openArchive(archivePath, options.signal);
    }
    try {
      const recording = archive.manifest.recording;
      if (
        recording.streamId !== source.streamId ||
        recording.revision !== source.revision ||
        recording.lifecycle !== "ended" ||
        recording.throughServerSeq !== intent.sourceServerSeq
      )
        throw new Error(
          "Staged archive differs from the migration source boundary",
        );
    } finally {
      await archive.close();
    }
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(archivePath, {
      signal: options.signal,
    }))
      digest.update(chunk);
    const archiveHash = digest.digest("hex");
    if (intent.archiveHash && intent.archiveHash !== archiveHash)
      throw new Error("Staged migration archive changed");
    intent = { ...intent, archiveHash };
    await atomicJson(join(journal.directory, "archive-transfer.json"), intent);
    const target = targetSchema.parse(
      await importArchiveRecording({
        source: archivePath,
        operationId: hash({
          migration: options.operationId,
          source: requestHash,
        }),
        serverOrigin: destination,
        credential: options.targetCredential,
        signal: options.signal,
      }),
    );
    if (intent.target && canonicalJson(intent.target) !== canonicalJson(target))
      throw new Error("Destination recording identity changed during retry");
    const targetMetadata = z
      .object({
        revision: z.literal(target.revision),
        lifecycle: z.literal("ended"),
        visibility: z.literal("private"),
      })
      .safeParse(
        JSON.parse(
          (
            await request(
              fetch,
              `${destination}/api/v1/streams/${target.streamId}`,
              {
                headers: {
                  authorization: `Bearer ${options.targetCredential}`,
                },
              },
              options.signal,
              4096,
            )
          ).text,
        ),
      );
    if (!targetMetadata.success)
      throw new Error("Destination recording boundary or visibility changed");
    intent = { ...intent, target };
    await atomicJson(join(journal.directory, "archive-transfer.json"), intent);
    if (options.disposition === "remove")
      await removeRecording({
        serverOrigin: source.serverOrigin,
        streamId: source.streamId,
        revision: source.revision,
        expectedServerSeq: intent.sourceServerSeq,
        operationId: hash({
          migration: options.operationId,
          action: "remove-archived-source",
        }),
        credential: options.sourceCredential,
        signal: options.signal,
      });
    await atomicJson(join(journal.directory, "archive-transfer.json"), {
      ...intent,
      completed: true,
    });
    return {
      operationId: options.operationId,
      sourceServerOrigin: source.serverOrigin,
      sourceStreamId: source.streamId,
      sourceRevision: source.revision,
      targetServerOrigin: destination,
      target,
      archiveHash,
      disposition: options.disposition,
      completed: true,
    };
  } finally {
    await journal.close();
  }
}
