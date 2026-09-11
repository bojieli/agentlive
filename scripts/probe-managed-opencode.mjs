#!/usr/bin/env node
/** Native process/API acceptance only; no model request or terminal simulation. */
import { startManagedOpenCodeServer } from "../packages/cli/dist/opencode-server.js";
import { discoverNativeSessions } from "../packages/adapters/dist/index.js";
import { OpenCodeFamilyCapture } from "../packages/adapters/dist/opencode-family.js";
import { PublisherJournal } from "../packages/publisher/dist/index.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const cwd = await mkdtemp(join(tmpdir(), "agentlive-managed-opencode-"));
let server;
let nativeSessionId;
let childSessionId;
let verified = false;
try {
  server = await startManagedOpenCodeServer({
    cwd,
    signal: AbortSignal.timeout(30_000),
  });
  const created = await server.session();
  nativeSessionId = created.nativeSessionId;
  const resumed = await server.session(nativeSessionId);
  if (resumed.nativeSessionId !== nativeSessionId)
    throw new Error("Native session lookup changed identity");
  if ((await fetch(`${server.origin}/global/health`)).status !== 401)
    throw new Error("Native server accepted an unauthenticated request");
  const headers = {
    authorization: `Basic ${Buffer.from(`${server.username}:${server.password}`).toString("base64")}`,
    "content-type": "application/json",
  };
  const childResponse = await fetch(`${server.origin}/session`, {
    method: "POST",
    headers,
    body: JSON.stringify({ parentID: nativeSessionId }),
    signal: AbortSignal.timeout(5000),
  });
  if (!childResponse.ok)
    throw new Error("Native child session creation failed");
  const child = await childResponse.json();
  childSessionId = child.id;
  if (child.parentID !== nativeSessionId)
    throw new Error(
      "Native child session did not preserve explicit parent identity",
    );
  const retained = await fetch(
    `${server.origin}/session/${encodeURIComponent(childSessionId)}`,
    { headers, signal: AbortSignal.timeout(5000) },
  ).then((response) => response.json());
  if (retained.parentID !== nativeSessionId)
    throw new Error("Native session lookup lost parent identity");
  const children = await discoverNativeSessions({
    agent: "opencode",
    nativeServer: server.origin,
    password: server.password,
    parentNativeSessionId: nativeSessionId,
    signal: AbortSignal.timeout(5000),
  });
  if (
    children.truncated ||
    children.sessions.length !== 1 ||
    children.sessions[0].nativeSessionId !== childSessionId ||
    children.sessions[0].parentNativeSessionId !== nativeSessionId
  )
    throw new Error(
      "Native child discovery did not preserve the selected family",
    );
  const journal = await PublisherJournal.open(join(cwd, "family-probe"), {
    serverOrigin: "http://localhost",
    agent: "opencode",
    nativeSessionId,
  });
  let family;
  try {
    await journal.bindRemote("family_probe", "family_revision");
    family = new OpenCodeFamilyCapture({
      journal,
      origin: server.origin,
      root: nativeSessionId,
      secrets: [server.password],
      password: server.password,
    });
    await family.reconcile(AbortSignal.timeout(5000));
    const events = [];
    for await (const event of journal.pending(0)) events.push(event);
    if (
      events.filter((event) => event.content.kind === "agent.updated")
        .length !== 2
    )
      throw new Error(
        "Native family capture did not preserve both lineage entries",
      );
    const boundary = journal.capturedThrough;
    await family.reconcile(AbortSignal.timeout(5000));
    if (journal.capturedThrough !== boundary)
      throw new Error("Native family reconciliation duplicated events");
  } finally {
    await family?.close();
    await journal.close();
  }
  verified = true;
} finally {
  try {
    for (const id of [childSessionId, nativeSessionId].filter(Boolean)) {
      const response = await fetch(
        `${server.origin}/session/${encodeURIComponent(id)}`,
        {
          method: "DELETE",
          signal: AbortSignal.timeout(5000),
          headers: {
            authorization: `Basic ${Buffer.from(`${server.username}:${server.password}`).toString("base64")}`,
          },
        },
      );
      if (!response.ok)
        throw new Error("Synthetic native session cleanup failed");
      await response.body?.cancel();
    }
  } finally {
    await server?.close();
    await rm(cwd, { recursive: true, force: true });
  }
}
console.log(
  JSON.stringify({
    success: verified,
    authenticated: true,
    created: true,
    sameNativeIdentity: true,
    explicitParentIdentity: true,
    childDiscovery: true,
    familyCapture: true,
    syntheticSessionRemoved: true,
    cleanShutdown: true,
  }),
);
