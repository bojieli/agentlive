#!/usr/bin/env node
/** Explicit read-only native-history import into an isolated local private test server. */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { importCodexRecording } from "../packages/adapters/dist/index.js";
import { startServer } from "../packages/server/dist/index.js";
import { initialState, apply } from "../packages/playback/dist/index.js";
const sourcePath = process.argv[2];
if (!sourcePath)
  throw new Error(
    "Usage: node scripts/probe-history-import.mjs <codex-session.jsonl>",
  );
const root = await mkdtemp(join(tmpdir(), "agentlive-history-import-"));
const ownerCredential = randomBytes(32).toString("hex");
const server = await startServer({
  directory: join(root, "server"),
  ownerSecret: ownerCredential,
  port: 0,
});
const signal = AbortSignal.timeout(120_000);
const output = resolve("probe-results", "native-imports");
await mkdir(output, { recursive: true, mode: 0o700 });
const sourceId = createHash("sha256").update(resolve(sourcePath)).digest("hex");
let summary;
try {
  const secrets = Object.entries(process.env)
    .filter(
      ([name, value]) =>
        /(KEY|TOKEN|SECRET|PASSWORD)/i.test(name) &&
        value &&
        value.length >= 8 &&
        value.length <= 4096,
    )
    .map(([, value]) => value);
  const options = {
    sourcePath,
    ...(process.argv.length > 3
      ? { artifactRoots: process.argv.slice(3).map((value) => resolve(value)) }
      : {}),
    publisherRoot: join(root, "publisher"),
    serverOrigin: server.url,
    ownerCredential,
    title: "Private native-history validation",
    visibility: "private",
    secrets,
    signal,
  };
  const result = await importCodexRecording(options);
  const session = await server.store.get(result.streamId);
  let state = initialState();
  for await (const event of session.history(0, session.boundary.sequence))
    state = apply(state, event);
  let verifiedAttachments = 0;
  for (const artifact of state.artifacts.values()) {
    for (const attachment of artifact.versions.values()) {
      const response = await fetch(
        `${server.url}/api/v1/streams/${result.streamId}/attachments/${attachment.hash}`,
        { headers: { authorization: `Bearer ${ownerCredential}` } },
      );
      if (!response.ok) throw new Error("attachment_download_failed");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (
        bytes.length !== attachment.byteSize ||
        createHash("sha256").update(bytes).digest("hex") !== attachment.hash
      )
        throw new Error("attachment_download_mismatch");
      verifiedAttachments++;
    }
  }
  const before = session.boundary.sequence;
  const retried = await importCodexRecording(options);
  if (
    retried.streamId !== result.streamId ||
    session.boundary.sequence !== before
  )
    throw new Error("import_retry_changed_recording");
  if (
    (await fetch(server.url + "/api/v1/streams/" + result.streamId)).status !==
    403
  )
    throw new Error("private_import_access_failed");
  summary = {
    success: true,
    sourceId,
    records: result.report.records,
    items: result.report.items,
    producerEvents: result.producerEvents,
    serverEvents: state.appliedSeq,
    messages: state.messages.size,
    tools: state.tools.size,
    fileChanges: state.changes.size,
    gaps: state.gaps.length,
    unsupportedItemTypes: result.report.unsupportedItemTypes,
    artifacts: result.report.artifacts,
    verifiedAttachments,
    retryStable: true,
    privateAccessEnforced: true,
  };
} catch (error) {
  summary = { success: false, sourceId, errorType: error?.name ?? "Error" };
  process.exitCode = 1;
} finally {
  await server.close();
}
await writeFile(
  join(output, sourceId + ".json"),
  JSON.stringify(summary, null, 2) + "\n",
  { mode: 0o600 },
);
console.log(JSON.stringify(summary));
