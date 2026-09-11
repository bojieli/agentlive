import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { originOf } from "@agentlive/client/transport";
import { idSchema } from "@agentlive/protocol";
import { openArchive } from "@agentlive/storage";
export async function importArchiveRecording(options: {
  source: string;
  serverOrigin: string;
  credential: string;
  operationId?: string;
  signal: AbortSignal;
}) {
  const archive = await openArchive(options.source, options.signal);
  await archive.close();
  const size = (await stat(options.source)).size;
  if (size > 9 * 1024 ** 3) throw new Error("Archive upload exceeds limit");
  const response = await fetch(
    `${originOf(options.serverOrigin)}/api/v1/imports`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.credential}`,
        ...(options.operationId
          ? { "idempotency-key": idSchema.parse(options.operationId) }
          : {}),
        "content-type": "application/octet-stream",
        "content-length": String(size),
      },
      body: createReadStream(options.source) as any,
      duplex: "half",
      redirect: "error",
      signal: options.signal,
    } as RequestInit & { duplex: "half" },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Archive import failed (HTTP ${response.status})`);
  }
  const value = (await response.json()) as {
    streamId?: unknown;
    revision?: unknown;
    lifecycle?: unknown;
  };
  if (value.lifecycle !== "ended")
    throw new Error("Imported recording is not ended");
  return {
    streamId: idSchema.parse(value.streamId),
    revision: idSchema.parse(value.revision),
    lifecycle: "ended",
  };
}
