import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { startServer } from "../../packages/server/src/http.js";
import { Accounts } from "../../packages/server/src/accounts.js";
import { AccountSessions } from "../../packages/server/src/account-sessions.js";
import type { PublishedEvent } from "../../packages/protocol/src/index.js";

const { WebSocket } = createRequire(
  new URL("../../packages/server/package.json", import.meta.url),
)("ws") as typeof import("ws");
const ownerSecret = "a".repeat(64);
const password = "p".repeat(64),
  issuer = "https://id.example",
  origin = "https://app.example";
const sockets: import("ws").WebSocket[] = [];

function connect(url: string, secret?: string) {
  const ws = new WebSocket(url.replace(/^http/, "ws"), {
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
  sockets.push(ws);
  const inbox: any[] = [];
  const waiters: {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];
  ws.on("message", (data: Buffer) => {
    const value = JSON.parse(data.toString());
    const waiter = waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(value);
    } else inbox.push(value);
  });
  ws.on("error", (error: Error) => {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  });
  const closed = new Promise<number>((resolve) => ws.once("close", resolve));
  return {
    ws,
    closed,
    send: (value: unknown) => ws.send(JSON.stringify(value)),
    next: () =>
      inbox.length
        ? Promise.resolve(inbox.shift())
        : new Promise<any>((resolve, reject) => {
            const waiter = {
              resolve,
              reject,
              timer: setTimeout(() => {
                const index = waiters.indexOf(waiter);
                if (index >= 0) waiters.splice(index, 1);
                reject(new Error("Frame timeout"));
              }, 5000),
            };
            waiters.push(waiter);
          }),
  };
}
const event = (streamId: string, producerSeq: number): PublishedEvent => ({
  protocolVersion: 1,
  streamId,
  producerEpoch: "epoch",
  producerSeq,
  observedAt: "2026-09-09T00:00:00.000Z",
  clockSegmentId: "clock_1",
  elapsedMs: producerSeq,
  fidelity: "delta",
  source: { agent: "synthetic", sessionId: "native_1" },
  content: {
    kind: "message.started",
    payload: { messageId: `m${producerSeq}`, role: "assistant" },
  },
});
async function publish(
  url: string,
  writeSecret: string,
  recording: { streamId: string; revision: string },
  attempt: number,
  producerSeq: number,
) {
  const socket = connect(url + "/api/v1/publish", writeSecret);
  expect((await socket.next()).type).toBe("hello");
  socket.send({
    type: "resume",
    protocolVersion: 1,
    requestId: "resume",
    streamId: recording.streamId,
    revision: recording.revision,
    publisherId: "pub",
    producerEpoch: "epoch",
    attempt,
  });
  const resumed = await socket.next();
  if (resumed.type !== "resumed") return { socket, resumed, ack: undefined };
  socket.send({
    type: "batch",
    protocolVersion: 1,
    requestId: "batch",
    events: [event(recording.streamId, producerSeq)],
  });
  return { socket, resumed, ack: await socket.next() };
}

async function hostedServer(root: string) {
  const accounts = await Accounts.open(join(root, "accounts"));
  const sessions = await AccountSessions.open(
    join(root, "account-sessions.json"),
    accounts,
    password,
  );
  const alice = await accounts.resolveVerifiedIdentity({
    issuer,
    subject: "alice-subject",
    displayName: "Alice",
  });
  const bob = await accounts.resolveVerifiedIdentity({
    issuer,
    subject: "bob-subject",
    displayName: "Bob",
  });
  const aliceDevice = await sessions.issueDevice(alice.id);
  const bobDevice = await sessions.issueDevice(bob.id);
  await sessions.close();
  await accounts.close();
  const server = await startServer({
    directory: root,
    ownerSecret,
    port: 0,
    publicOrigin: origin,
    hosted: {
      issuer,
      clientId: "client",
      clientSecret: "secret",
      cookiePassword: password,
      fetch: async () =>
        Response.json({
          issuer,
          authorization_endpoint: issuer + "/authorize",
          token_endpoint: issuer + "/token",
          jwks_uri: issuer + "/jwks",
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
        }),
    },
  });
  return { server, alice, bob, aliceDevice, bobDevice };
}

it("suspends a disabled account's recordings for publishing and serving, and restores them when it is enabled again", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-account-suspension-"));
  const { server, alice, aliceDevice, bobDevice } = await hostedServer(root);
  const operator = { authorization: `Bearer ${ownerSecret}` };
  const aliceSecret = "b".repeat(64),
    bobSecret = "c".repeat(64),
    localSecret = "d".repeat(64);
  const create = (credential: string, requestId: string, writeSecret: string) =>
    fetch(server.url + "/api/v1/streams", {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        requestId,
        requestedAt: new Date().toISOString(),
        publisherId: "pub",
        producerEpoch: "epoch",
        writeSecret,
        title: requestId,
        visibility: "public",
      }),
    }).then((response) => response.json());
  const listedIds = async () =>
    (
      await (await fetch(server.url + "/api/v1/public-recordings")).json()
    ).recordings.map((recording: { id: string }) => recording.id);
  try {
    const aliceRecording = await create(
      aliceDevice.token,
      "alice-public",
      aliceSecret,
    );
    const bobRecording = await create(bobDevice.token, "bob-public", bobSecret);
    const localRecording = await create(
      ownerSecret,
      "local-public",
      localSecret,
    );
    const aliceUrl = `${server.url}/api/v1/streams/${aliceRecording.streamId}`;

    // Everything works before the disable: publishing, anonymous reads, listing.
    const alicePublisher = await publish(
      server.url,
      aliceSecret,
      aliceRecording,
      1,
      1,
    );
    expect(alicePublisher.ack.type).toBe("ack");
    const bobPublisher = await publish(
      server.url,
      bobSecret,
      bobRecording,
      1,
      1,
    );
    expect(bobPublisher.ack.type).toBe("ack");
    const localPublisher = await publish(
      server.url,
      localSecret,
      localRecording,
      1,
      1,
    );
    expect(localPublisher.ack.type).toBe("ack");
    expect((await fetch(aliceUrl)).status).toBe(200);
    expect(await listedIds()).toEqual(
      expect.arrayContaining([
        aliceRecording.streamId,
        bobRecording.streamId,
        localRecording.streamId,
      ]),
    );
    const viewer = connect(server.url + "/api/v1/watch");
    expect((await viewer.next()).type).toBe("hello");
    viewer.send({
      type: "subscribe",
      protocolVersion: 1,
      requestId: "sub",
      streamId: aliceRecording.streamId,
      revision: aliceRecording.revision,
      afterServerSeq: 0,
    });
    expect((await viewer.next()).type).toBe("subscribed");

    const status = (disabled: boolean, expectedVersion: number) =>
      fetch(`${server.url}/api/v1/admin/accounts/${alice.id}/status`, {
        method: "POST",
        headers: { ...operator, "content-type": "application/json" },
        body: JSON.stringify({ disabled, expectedVersion }),
      }).then((response) => response.json());
    const disabled = await status(true, alice.version);
    expect(disabled).toMatchObject({ disabled: true });

    // The open publisher and the anonymous viewer are closed at the same moment.
    expect(await alicePublisher.socket.closed).toBe(1008);
    expect(await viewer.closed).toBe(1008);

    // A fresh publishing lease is refused; the publisher stops on a non-retryable code.
    const refused = await publish(
      server.url,
      aliceSecret,
      aliceRecording,
      2,
      2,
    );
    expect(refused.resumed).toMatchObject({
      type: "error",
      code: "forbidden",
    });

    // Attachment upload and lifecycle changes are refused with the same code.
    const bytes = Buffer.from("suspended attachment");
    const upload = await fetch(aliceUrl + "/attachments", {
      method: "POST",
      headers: {
        authorization: `Bearer ${aliceSecret}`,
        "x-attachment-sha256": createHash("sha256").update(bytes).digest("hex"),
        "x-attachment-bytes": String(bytes.length),
      },
      body: bytes,
    });
    expect(upload.status).toBe(403);
    expect((await upload.json()).error.code).toBe("forbidden");
    const ended = await fetch(aliceUrl + "/end", {
      method: "POST",
      headers: {
        authorization: `Bearer ${aliceSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        operationId: "end-while-disabled",
        expectedLifecycleSeq: 1,
        content: {
          kind: "recording.ended",
          payload: { producerEpoch: "epoch", throughProducerSeq: 1 },
        },
      }),
    });
    expect(ended.status).toBe(403);

    // The read side is suspended too: direct reads, listing, tickets and sockets.
    for (const path of ["", "/export"])
      expect((await fetch(aliceUrl + path)).status).toBe(403);
    expect(
      (
        await fetch(
          `${aliceUrl}/events?revision=${aliceRecording.revision}&throughServerSeq=1`,
        )
      ).status,
    ).toBe(403);
    const ticket = await fetch(aliceUrl + "/watch-ticket", { method: "POST" });
    expect(ticket.status).toBe(403);
    const suspendedListing = await listedIds();
    expect(suspendedListing).not.toContain(aliceRecording.streamId);
    expect(suspendedListing).toEqual(
      expect.arrayContaining([bobRecording.streamId, localRecording.streamId]),
    );
    const rejoin = connect(server.url + "/api/v1/watch");
    expect((await rejoin.next()).type).toBe("hello");
    rejoin.send({
      type: "subscribe",
      protocolVersion: 1,
      requestId: "sub",
      streamId: aliceRecording.streamId,
      revision: aliceRecording.revision,
      afterServerSeq: 0,
    });
    expect(await rejoin.next()).toMatchObject({
      type: "error",
      code: "forbidden",
    });

    // The operator still reads the suspended recording to review the content.
    expect((await fetch(aliceUrl, { headers: operator })).status).toBe(200);
    // Alice's own credentials stopped authenticating with the disable.
    expect(
      (
        await fetch(aliceUrl, {
          headers: { authorization: `Bearer ${aliceDevice.token}` },
        })
      ).status,
    ).toBe(403);

    // The other account and the local owner are untouched.
    for (const [recording, publisher, producerSeq] of [
      [bobRecording, bobPublisher, 2],
      [localRecording, localPublisher, 2],
    ] as const) {
      const url = `${server.url}/api/v1/streams/${recording.streamId}`;
      expect((await fetch(url)).status).toBe(200);
      publisher.socket.send({
        type: "batch",
        protocolVersion: 1,
        requestId: "after-disable",
        events: [event(recording.streamId, producerSeq)],
      });
      expect(await publisher.socket.next()).toMatchObject({
        type: "ack",
        throughProducerSeq: producerSeq,
      });
    }
    expect(
      (
        await fetch(server.url + "/api/v1/streams?limit=1", {
          headers: { authorization: `Bearer ${bobDevice.token}` },
        })
      ).status,
    ).toBe(200);

    // Enabling the account again restores publishing and serving of the same recording.
    const enabled = await status(false, disabled.version);
    expect(enabled).toMatchObject({ disabled: false });
    const resumed = await publish(
      server.url,
      aliceSecret,
      aliceRecording,
      3,
      2,
    );
    expect(resumed.ack).toMatchObject({ type: "ack", throughProducerSeq: 2 });
    expect((await fetch(aliceUrl)).status).toBe(200);
    expect(
      (
        await fetch(aliceUrl + "/attachments", {
          method: "POST",
          headers: {
            authorization: `Bearer ${aliceSecret}`,
            "x-attachment-sha256": createHash("sha256")
              .update(bytes)
              .digest("hex"),
            "x-attachment-bytes": String(bytes.length),
          },
          body: bytes,
        })
      ).status,
    ).toBe(201);
    expect(await listedIds()).toEqual(
      expect.arrayContaining([
        aliceRecording.streamId,
        bobRecording.streamId,
        localRecording.streamId,
      ]),
    );
    // Re-enabling does not revive the credentials issued before the disable: the
    // recording is public again, but Alice's old device no longer authenticates.
    expect(
      (
        await fetch(server.url + "/api/v1/streams?limit=1", {
          headers: { authorization: `Bearer ${aliceDevice.token}` },
        })
      ).status,
    ).toBe(401);
  } finally {
    for (const socket of sockets.splice(0)) socket.terminate();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

it("leaves a standalone server without accounts entirely unchanged", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "agentlive-account-suspension-so-"),
  );
  const server = await startServer({ directory: root, ownerSecret, port: 0 });
  const writeSecret = "e".repeat(64);
  try {
    const recording = await (
      await fetch(server.url + "/api/v1/streams", {
        method: "POST",
        headers: {
          authorization: `Bearer ${ownerSecret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          requestId: "standalone-public",
          requestedAt: new Date().toISOString(),
          publisherId: "pub",
          producerEpoch: "epoch",
          writeSecret,
          title: "Standalone",
          visibility: "public",
        }),
      })
    ).json();
    const published = await publish(server.url, writeSecret, recording, 1, 1);
    expect(published.ack).toMatchObject({ type: "ack", throughProducerSeq: 1 });
    expect(
      (await fetch(`${server.url}/api/v1/streams/${recording.streamId}`))
        .status,
    ).toBe(200);
    const listing = await (
      await fetch(server.url + "/api/v1/public-recordings")
    ).json();
    expect(listing.recordings.map((entry: { id: string }) => entry.id)).toEqual(
      [recording.streamId],
    );
  } finally {
    for (const socket of sockets.splice(0)) socket.terminate();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
