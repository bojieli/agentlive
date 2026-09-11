import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  idSchema,
  cursorSchema,
  storedEventSchema,
  canonicalJson,
} from "@agentlive/protocol";
import { atomicJson } from "@agentlive/storage";
import { request, delay } from "@agentlive/client/transport";
import { PublisherJournal } from "./journal.js";
import { PublisherNetwork } from "./network.js";

export async function readPublisherOperation(
  directory: string,
  name: string,
): Promise<unknown | undefined> {
  const file = await open(
    join(directory, name),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!file) return undefined;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 16384 || (info.mode & 0o077) !== 0)
      throw new Error("Invalid publisher operation metadata");
    const bytes = Buffer.alloc(16385);
    let length = 0;
    while (length < bytes.length) {
      const chunk = await file.read(
        bytes,
        length,
        bytes.length - length,
        length,
      );
      if (!chunk.bytesRead) break;
      length += chunk.bytesRead;
    }
    if (length > 16384) throw new Error("Publisher operation exceeds limit");
    try {
      return JSON.parse(bytes.subarray(0, length).toString("utf8"));
    } catch {
      throw new Error("Invalid publisher operation JSON");
    }
  } finally {
    await file.close();
  }
}
export async function assertPublisherNotFinished(directory: string) {
  if (
    (await readPublisherOperation(directory, "finish-publish.json")) !==
      undefined ||
    (await readPublisherOperation(directory, "archive-transfer.json")) !==
      undefined
  )
    throw new Error(
      "Publisher has a pending or completed finish operation; finish its retry or use a new recording",
    );
}
const intentSchema = z.strictObject({
  version: z.literal(1),
  operationId: idSchema,
  streamId: idSchema,
  revision: idSchema,
  producerEpoch: idSchema,
  producerEvents: cursorSchema,
  expectedLifecycleSeq: cursorSchema,
  completed: z.boolean(),
  endServerSeq: cursorSchema.optional(),
});
/** Finish exactly the already captured local journal, without reading or reconverting native sources. */
export async function finishPublisher(options: {
  directory: string;
  operationId: string;
  ownerCredential: string;
  signal: AbortSignal;
}) {
  idSchema.parse(options.operationId);
  const journal = await PublisherJournal.openExisting(options.directory);
  const controller = new AbortController();
  let running: Promise<void> | undefined;
  try {
    const binding = journal.identity;
    if (
      !binding.streamId ||
      !binding.revision ||
      binding.pendingCredentialRotation
    )
      throw new Error(
        "Finish requires a bound publisher without credential rotation",
      );
    const path = join(journal.directory, "finish-publish.json");
    const saved = await readPublisherOperation(
      journal.directory,
      "finish-publish.json",
    );
    let intent = saved === undefined ? undefined : intentSchema.parse(saved);
    if (
      intent &&
      (intent.operationId !== options.operationId ||
        intent.streamId !== binding.streamId ||
        intent.revision !== binding.revision ||
        intent.producerEpoch !== binding.producerEpoch ||
        intent.producerEvents !== journal.capturedThrough)
    )
      throw new Error("Finish retry differs from saved publisher boundary");
    const base = `${binding.serverOrigin}/api/v1/streams/${binding.streamId}`;
    const headers = { authorization: `Bearer ${options.ownerCredential}` };
    await request(
      fetch,
      base + "/visibility",
      { headers },
      options.signal,
      4096,
    );
    const metadata = z
      .object({
        revision: z.literal(binding.revision),
        title: z.string().max(500),
        visibility: z.enum(["private", "public", "unlisted"]),
        lifecycle: z.enum(["open", "ended"]),
        lifecycleSeq: cursorSchema,
      })
      .parse(
        JSON.parse(
          (await request(fetch, base, { headers }, options.signal, 4096)).text,
        ),
      );
    if (!intent) {
      if (metadata.lifecycle !== "open")
        throw new Error("Recording is already ended");
      intent = {
        version: 1,
        operationId: options.operationId,
        streamId: binding.streamId,
        revision: binding.revision,
        producerEpoch: binding.producerEpoch,
        producerEvents: journal.capturedThrough,
        expectedLifecycleSeq: metadata.lifecycleSeq,
        completed: false,
      };
      await atomicJson(path, intent);
    }
    if (metadata.lifecycle === "open") {
      let resumed = false,
        failure: unknown;
      const network = new PublisherNetwork({
        journal,
        ownerCredential: options.ownerCredential,
        title: metadata.title,
        visibility: metadata.visibility,
        onStatus: (status) => {
          if (status === "live") resumed = true;
        },
      });
      const signal = AbortSignal.any([options.signal, controller.signal]);
      running = network.run(signal).catch((error) => {
        failure = error;
      });
      while (
        !resumed ||
        journal.identity.acknowledgedSeq < intent.producerEvents
      ) {
        options.signal.throwIfAborted();
        if (failure) throw failure;
        await delay(25, options.signal);
      }
      controller.abort();
      await running;
      if (failure) throw failure;
    }
    const response = await request(
      fetch,
      base + "/end",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${binding.writeSecret}`,
          "content-type": "application/json",
        },
        body: canonicalJson({
          operationId: intent.operationId,
          expectedLifecycleSeq: intent.expectedLifecycleSeq,
          content: {
            kind: "recording.ended",
            payload: {
              producerEpoch: intent.producerEpoch,
              throughProducerSeq: intent.producerEvents,
            },
          },
        }),
      },
      options.signal,
      8192,
    );
    const ended = storedEventSchema.parse(JSON.parse(response.text));
    if (
      ended.content.kind !== "recording.ended" ||
      ended.origin.type !== "server" ||
      ended.origin.operationId !== intent.operationId ||
      ended.content.payload.producerEpoch !== intent.producerEpoch ||
      ended.content.payload.throughProducerSeq !== intent.producerEvents ||
      (intent.endServerSeq !== undefined &&
        intent.endServerSeq !== ended.serverSeq)
    )
      throw new Error("Finish receipt differs from captured boundary");
    await atomicJson(path, {
      ...intent,
      completed: true,
      endServerSeq: ended.serverSeq,
    });
    return {
      operationId: intent.operationId,
      serverOrigin: binding.serverOrigin,
      streamId: binding.streamId,
      revision: binding.revision,
      producerEvents: intent.producerEvents,
      endServerSeq: ended.serverSeq,
      completed: true as const,
    };
  } finally {
    controller.abort();
    await running;
    await journal.close();
  }
}
