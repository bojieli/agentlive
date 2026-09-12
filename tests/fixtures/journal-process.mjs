import { PublisherJournal } from "../../packages/publisher/dist/index.js";

const [root, target] = process.argv.slice(2);
const payload = "x".repeat(1024);
let journal;
let killed = false;

/** Die exactly at one durable rotation/compaction step, reporting the durable boundary. */
const die = () =>
  new Promise(() => {
    killed = true;
    process.send({ captured: journal.capturedThrough, killed: true }, () =>
      process.kill(process.pid, "SIGKILL"),
    );
  });

journal = await PublisherJournal.open(
  root,
  {
    serverOrigin: "https://example.test",
    agent: "synthetic",
    nativeSessionId: "native_1",
  },
  {
    retention: { segmentBytes: 4096, retainAcknowledgedBytes: 4096 },
    faultInjection: (step) => (step === target ? die() : undefined),
  },
);
await journal.bindRemote("stream_1", "revision_1");
for (let n = 1; n <= 400 && !killed; n++) {
  await journal.capture({
    sourceKey: `source_${n}`,
    observedAt: "2026-09-10T00:00:00.000Z",
    clockSegmentId: "clock_1",
    elapsedMs: n,
    fidelity: "delta",
    adapterState: { cursor: n },
    content: [
      {
        kind: "message.text.append",
        payload: { messageId: `m${n}`, text: `${n}:${payload}` },
      },
    ],
  });
  await journal.acknowledge(journal.capturedThrough);
}
process.send({ captured: journal.capturedThrough, killed: false }, () =>
  process.exit(0),
);
