import { createWriteStream } from "node:fs";
import { mkdtemp, rm, link, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { idSchema } from "@agentlive/protocol";
import { originOf } from "@agentlive/client/transport";
import { openArchive, syncDirectory } from "@agentlive/storage";
export async function exportRecording(options: {
  serverOrigin: string;
  streamId: string;
  output: string;
  credential?: string;
  signal: AbortSignal;
}) {
  const directory = await mkdtemp(
    join(dirname(options.output), ".agentlive-download-"),
  );
  try {
    const url = `${originOf(options.serverOrigin)}/api/v1/streams/${idSchema.parse(options.streamId)}/export`;
    const response = await fetch(url, {
      signal: options.signal,
      redirect: "error",
      headers: options.credential
        ? { authorization: `Bearer ${options.credential}` }
        : {},
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`Recording export failed (HTTP ${response.status})`);
    }
    let bytes = 0;
    const bounded = new Transform({
      transform(chunk, _encoding, done) {
        bytes += chunk.length;
        done(
          bytes > 9 * 1024 ** 3
            ? new Error("Archive download exceeds limit")
            : null,
          chunk,
        );
      },
    });
    const path = join(directory, "recording.agentlive");
    await pipeline(
      Readable.fromWeb(response.body as any),
      bounded,
      createWriteStream(path, { flags: "wx", mode: 0o600 }),
      { signal: options.signal },
    );
    const archive = await openArchive(path, options.signal);
    const manifest = archive.manifest;
    await archive.close();
    options.signal.throwIfAborted();
    const file = await open(path, "r");
    try {
      await file.sync();
    } finally {
      await file.close();
    }
    await link(path, options.output);
    await syncDirectory(dirname(options.output));
    return {
      output: options.output,
      throughServerSeq: manifest.recording.throughServerSeq,
      bytes,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
