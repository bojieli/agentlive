import { Readable } from "node:stream";
import { z } from "zod";
import { idSchema, ProtocolError } from "@agentlive/protocol";
import {
  delay,
  originOf,
  request,
  retryable,
} from "@agentlive/client/transport";
import type { ArtifactSpool, CapturedAttachment } from "./artifacts.js";

/** Retries from immutable local bytes, checking durable server state after lost ACKs. */
export async function uploadArtifact(
  spool: ArtifactSpool,
  attachment: CapturedAttachment,
  options: {
    serverOrigin: string;
    streamId: string;
    writeSecret: string;
    signal: AbortSignal;
    fetch?: typeof fetch;
    retryMinMs?: number;
  },
): Promise<void> {
  const endpoint = `${originOf(options.serverOrigin)}/api/v1/streams/${idSchema.parse(options.streamId)}/attachments`;
  const fetcher = options.fetch ?? fetch;
  const headers = { Authorization: `Bearer ${options.writeSecret}` };
  let failures = 0;
  while (true) {
    options.signal.throwIfAborted();
    try {
      const status = await request(
        fetcher,
        `${endpoint}/${attachment.hash}/status?byteSize=${attachment.byteSize}`,
        { headers },
        options.signal,
      );
      if (
        z
          .strictObject({ available: z.boolean() })
          .parse(JSON.parse(status.text)).available
      )
        return;
      const file = await spool.openFile(attachment);
      const source = file.createReadStream({ autoClose: false });
      try {
        const init: RequestInit & { duplex: "half" } = {
          method: "POST",
          duplex: "half",
          headers: {
            ...headers,
            "Content-Type": "application/octet-stream",
            "X-Attachment-Sha256": attachment.hash,
            "X-Attachment-Bytes": String(attachment.byteSize),
          },
          body: Readable.toWeb(source) as ReadableStream<Uint8Array>,
        };
        const result = await request(fetcher, endpoint, init, options.signal);
        const received = z
          .object({ hash: z.string(), byteSize: z.number() })
          .parse(JSON.parse(result.text));
        if (
          received.hash !== attachment.hash ||
          received.byteSize !== attachment.byteSize
        )
          throw new ProtocolError(
            "precondition_failed",
            "Server attachment acknowledgment does not match upload",
          );
        return;
      } finally {
        source.destroy();
        await file.close();
      }
    } catch (error) {
      if (options.signal.aborted || !retryable(error)) throw error;
      const cap = Math.min(
        30000,
        (options.retryMinMs ?? 250) * 2 ** Math.min(failures++, 8),
      );
      await delay(cap * (0.5 + Math.random() * 0.5), options.signal);
    }
  }
}
