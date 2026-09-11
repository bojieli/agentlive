import { decodeArtifactBundle } from "../../packages/protocol/src/index.js";
import { afterEach, expect, it } from "vitest";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishOpenCodeRecording } from "../../packages/adapters/src/index.js";
import { startServer } from "../../packages/server/src/http.js";
import { initialState, apply } from "../../packages/playback/src/index.js";
import { exportRecording } from "../../packages/cli/src/export.js";
import { importArchiveRecording } from "../../packages/cli/src/import-archive.js";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function nativeServer(family = false, remote = false, bundle = false) {
  let artifactRequests = 0;
  let artifactsEnabled = true;
  let text = "retained";
  let hideChild = false;
  let childParent = "ses_test";
  const clients = new Set<ServerResponse>();
  const server = createServer((req, res) => {
    if (
      req.headers.authorization !==
      `Basic ${Buffer.from("opencode:native-password").toString("base64")}`
    ) {
      res.writeHead(401).end();
      return;
    }
    if (req.url?.startsWith("/artifact/")) {
      artifactRequests++;
      if (!artifactsEnabled) {
        res.writeHead(410).end();
        return;
      }
      res.writeHead(200, {
        "content-type": bundle ? "text/html" : "text/plain; charset=utf-8",
      });
      res.end(bundle ? `<p>child bytes ${text}</p>` : "child bytes " + text);
      return;
    }
    if (req.url === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"type":"server.connected"}\n\n');
      clients.add(res);
      res.on("close", () => clients.delete(res));
      return;
    }
    res.setHeader("content-type", "application/json");
    if (family && req.url?.endsWith("/children")) {
      res.end(
        JSON.stringify(
          req.url === "/session/ses_test/children" && !hideChild
            ? [{ id: "ses_child", parentID: "ses_test", time: { created: 1 } }]
            : [],
        ),
      );
      return;
    }
    if (family && req.url === "/session/ses_child") {
      res.end(
        JSON.stringify({
          id: "ses_child",
          parentID: childParent,
          time: { created: 1 },
        }),
      );
      return;
    }
    if (family && req.url === "/session/ses_child/message") {
      res.end(
        JSON.stringify([
          {
            info: {
              id: "msg1",
              sessionID: "ses_child",
              role: "assistant",
              time: { created: 1, completed: 2 },
            },
            parts: [
              {
                id: "part1",
                type: "text",
                sessionID: "ses_child",
                messageID: "msg1",
                text: "child " + text,
              },
              {
                id: "file1",
                type: "file",
                sessionID: "ses_child",
                messageID: "msg1",
                mime: bundle ? "text/html" : "text/plain",
                filename: bundle ? "child.html" : "child.txt",
                url: remote
                  ? `http://127.0.0.1:${(server.address() as { port: number }).port}/artifact/${text}`
                  : `data:${bundle ? "text/html" : "text/plain"};base64,` +
                    Buffer.from(
                      bundle
                        ? `<p>child bytes ${text}</p>`
                        : "child bytes " + text,
                    ).toString("base64"),
              },
            ],
          },
        ]),
      );
      return;
    }
    if (req.url === "/session/ses_test")
      res.end(JSON.stringify({ id: "ses_test", time: { created: 1 } }));
    else if (req.url === "/session/ses_test/message")
      res.end(
        JSON.stringify([
          {
            info: {
              id: "msg1",
              sessionID: "ses_test",
              role: "assistant",
              time: { created: 1, completed: 2 },
            },
            parts: [
              {
                id: "part1",
                type: "text",
                sessionID: "ses_test",
                messageID: "msg1",
                text,
              },
            ],
          },
        ]),
      );
    else res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const stop = async () => {
    for (const res of clients) res.destroy();
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  cleanup.push(stop);
  return {
    url: `http://127.0.0.1:${port}`,
    stop,
    artifactRequests: () => artifactRequests,
    enableArtifacts: (enabled: boolean) => {
      artifactsEnabled = enabled;
    },
    hideChild: (value: boolean) => {
      hideChild = value;
    },
    reparentChild: (value: string) => {
      childParent = value;
    },
    start: () =>
      new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve)),
    update: (value: string) => {
      text = value;
      for (const res of clients)
        res.write('data: {"type":"message.updated"}\n\n');
    },
  };
}
it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])(
  "publishes child transcripts and immutable attachment revisions through server replay and restart (remote=%s, bundle=%s)",
  async (remote, bundle) => {
    const root = await mkdtemp(join(tmpdir(), "agentlive-family-artifacts-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const native = await nativeServer(true, remote, bundle);
    const owner = "b".repeat(64);
    const server = await startServer({
      directory: join(root, "server"),
      ownerSecret: owner,
      port: 0,
    });
    cleanup.push(() => server.close());
    const options = {
      publisherRoot: join(root, "publisher"),
      serverOrigin: server.url,
      ownerCredential: owner,
      nativeServerOrigin: native.url,
      nativeSessionId: "ses_test",
      nativePassword: "native-password",
      ...(remote
        ? {
            remoteArtifacts: {
              origins: [
                {
                  origin: native.url,
                  authorization: `Basic ${Buffer.from("opencode:native-password").toString("base64")}`,
                },
              ],
            },
          }
        : {}),
      artifactBundles: bundle,
      title: "Family",
      visibility: "private" as const,
      includeChildren: true,
    };
    const artifactText = async (response: Response) => {
      if (!bundle) return response.text();
      const decoded = await decodeArtifactBundle(
        new Uint8Array(await response.arrayBuffer()),
      );
      const html = Buffer.from(
        decoded.files.get(decoded.manifest.entrypoint)!,
      ).toString();
      return /<p>([^<]*)<\/p>/.exec(html)?.[1];
    };
    let streamId = "",
      previousCount = 0;
    let firstHash: string | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      native.enableArtifacts(attempt !== 1);
      if (attempt === 2) native.update("revised");
      const abort = new AbortController();
      let captured = 0,
        failure: unknown;
      const running = publishOpenCodeRecording({
        ...options,
        signal: abort.signal,
        onReady: (recording) => {
          if (streamId) expect(recording.streamId).toBe(streamId);
          streamId = recording.streamId;
        },
        onCaptured: (boundary) => {
          captured = boundary.producerEvents;
        },
      }).catch((error) => {
        failure = error;
      });
      let state = initialState();
      try {
        await expect
          .poll(
            async () => {
              if (failure) throw failure;
              if (!streamId || !captured) return false;
              const session = await server.store.get(streamId);
              let through = 0;
              state = initialState();
              try {
                for await (const event of session.history(
                  0,
                  session.boundary.sequence,
                )) {
                  state = apply(state, event);
                  if (event.origin.type === "publisher")
                    through = event.origin.event.producerSeq;
                }
              } finally {
                server.store.release(session);
              }
              return through >= captured;
            },
            { timeout: 10000 },
          )
          .toBe(true);
        expect(
          [...state.messages.values()].map((message) => message.text),
        ).toEqual(
          attempt === 2
            ? ["revised", "child revised"]
            : ["retained", "child retained"],
        );
        if (attempt === 1) expect(captured).toBe(previousCount);
        previousCount = captured;
        if (remote)
          expect(native.artifactRequests()).toBe(attempt === 2 ? 2 : 1);
        const versions = [...state.artifacts.values()].flatMap((artifact) => [
          ...artifact.versions.values(),
        ]);
        expect(versions.length).toBe(attempt === 2 ? 2 : 1);
        const latest = versions.at(-1)!;
        const hash = latest.hash;
        if (!firstHash) firstHash = hash;
        const response = await fetch(
          `${server.url}/api/v1/streams/${streamId}/attachments/${hash}`,
          { headers: { authorization: `Bearer ${owner}` } },
        );
        expect(response.status).toBe(200);
        expect(await artifactText(response)).toBe(
          attempt === 2 ? "child bytes revised" : "child bytes retained",
        );
        if (attempt === 2) {
          expect(hash).not.toBe(firstHash);
          const old = await fetch(
            `${server.url}/api/v1/streams/${streamId}/attachments/${firstHash}`,
            { headers: { authorization: `Bearer ${owner}` } },
          );
          expect(await artifactText(old)).toBe("child bytes retained");
        }
      } finally {
        abort.abort();
        await running;
      }
    }
    await expect(
      publishOpenCodeRecording({
        ...options,
        includeChildren: false,
        signal: AbortSignal.timeout(5000),
      }),
    ).rejects.toThrow("options changed");
    const archive = join(root, "family.agentlive");
    await exportRecording({
      serverOrigin: server.url,
      streamId,
      output: archive,
      credential: owner,
      signal: AbortSignal.timeout(10000),
    });
    const imported = await importArchiveRecording({
      source: archive,
      serverOrigin: server.url,
      credential: owner,
      signal: AbortSignal.timeout(10000),
    });
    expect(imported.streamId).not.toBe(streamId);
    const restored = await server.store.get(imported.streamId);
    let replay = initialState();
    try {
      for await (const event of restored.history(0, restored.info.serverSeq))
        replay = apply(replay, event);
    } finally {
      server.store.release(restored);
    }
    expect(
      [...replay.messages.values()].map((message) => message.text),
    ).toEqual(["revised", "child revised"]);
    const agents = [...replay.agents.values()];
    const parent = agents.find(
      (agent) => agent.nativeSessionId === "ses_test",
    )!;
    expect(
      agents.find((agent) => agent.nativeSessionId === "ses_child")
        ?.parentAgentId,
    ).toBe(parent.agentId);
    const versions = [...replay.artifacts.values()].flatMap((artifact) => [
      ...artifact.versions.values(),
    ]);
    expect(versions).toHaveLength(2);
    for (const version of versions) {
      const response = await fetch(
        `${server.url}/api/v1/streams/${imported.streamId}/attachments/${version.hash}`,
        { headers: { authorization: `Bearer ${owner}` } },
      );
      expect(response.status).toBe(200);
      expect(await artifactText(response)).toBe(
        version.hash === firstHash
          ? "child bytes retained"
          : "child bytes revised",
      );
    }
  },
);

it("publishes retained OpenCode history, recovers native disconnects, and resumes the same recording", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-opencode-publish-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const native = await nativeServer();
  const server = await startServer({
    directory: join(root, "server"),
    ownerSecret: "b".repeat(64),
    port: 0,
  });
  cleanup.push(() => server.close());
  const options = {
    publisherRoot: join(root, "publisher"),
    serverOrigin: server.url,
    ownerCredential: "b".repeat(64),
    nativeServerOrigin: native.url,
    nativeSessionId: "ses_test",
    nativePassword: "native-password",
    title: "OpenCode live",
    visibility: "private" as const,
  };
  await expect(
    publishOpenCodeRecording({
      ...options,
      nativePassword: "incorrect",
      signal: AbortSignal.timeout(5000),
    }),
  ).rejects.toThrow("401");
  let streamId = "";
  let captured = 0;
  let failure: unknown;
  let controller = new AbortController();
  let running: Promise<void>;
  const begin = () => {
    running = publishOpenCodeRecording({
      ...options,
      signal: controller.signal,
      onReady: (recording) => {
        if (streamId) expect(recording.streamId).toBe(streamId);
        streamId = recording.streamId;
      },
      onCaptured: (boundary) => {
        captured = boundary.producerEvents;
      },
    }).catch((error) => {
      failure = error;
    });
  };
  const until = async (text: string) => {
    await expect
      .poll(
        async () => {
          if (failure) throw failure;
          if (!streamId || !captured) return false;
          const session = await server.store.get(streamId);
          let state = initialState();
          let through = 0;
          for await (const event of session.history(
            0,
            session.boundary.sequence,
          )) {
            state = apply(state, event);
            if (event.origin.type === "publisher")
              through = event.origin.event.producerSeq;
          }
          return (
            through >= captured &&
            [...state.messages.values()].some(
              (message) => message.text === text,
            )
          );
        },
        { timeout: 10000 },
      )
      .toBe(true);
  };
  begin();
  try {
    await until("retained");
    await native.stop();
    native.update("after native reconnect");
    await native.start();
    await until("after native reconnect");
    controller.abort();
    await running!;
    const baseline = (await server.store.get(streamId)).boundary.sequence;
    const { PublisherJournal } =
      await import("../../packages/publisher/src/index.js");
    const saved = await PublisherJournal.open(options.publisherRoot, {
      serverOrigin: server.url,
      agent: "opencode",
      nativeSessionId: "ses_test",
    });
    const manifestPath = join(saved.directory, "publish.json");
    const previous = JSON.parse(await readFile(manifestPath, "utf8"));
    previous.converterVersion = "opencode-live-1";
    await writeFile(manifestPath, JSON.stringify(previous));
    const identityBefore = {
      streamId: saved.identity.streamId,
      writeSecret: saved.identity.writeSecret,
      producerEpoch: saved.identity.producerEpoch,
    };
    await saved.close();

    controller = new AbortController();
    captured = 0;
    begin();
    await until("after native reconnect");
    expect((await server.store.get(streamId)).boundary.sequence).toBe(baseline);
    expect(
      JSON.parse(await readFile(manifestPath, "utf8")).converterVersion,
    ).toBe("opencode-live-2");
    expect(streamId).toBe(identityBefore.streamId);
    expect(
      JSON.parse(await readFile(join(saved.directory, "binding.json"), "utf8")),
    ).toMatchObject(identityBefore);

    native.update("continued after publisher restart");
    await until("continued after publisher restart");
    expect(
      (await fetch(`${server.url}/api/v1/streams/${streamId}`)).status,
    ).toBe(403);
  } finally {
    controller.abort();
    await running!;
  }
  const { PublisherJournal } =
    await import("../../packages/publisher/src/index.js");
  const retained = await PublisherJournal.open(options.publisherRoot, {
    serverOrigin: server.url,
    agent: "opencode",
    nativeSessionId: "ses_test",
  });
  const policyPath = join(retained.directory, "publish.json");
  const policy = JSON.parse(await readFile(policyPath, "utf8"));
  await retained.close();
  policy.converterVersion = "opencode-live-1";
  await writeFile(policyPath, JSON.stringify(policy));
  await expect(
    publishOpenCodeRecording({
      ...options,
      title: "changed",
      signal: AbortSignal.timeout(5000),
    }),
  ).rejects.toThrow("options changed");
  expect(JSON.parse(await readFile(policyPath, "utf8"))).toEqual(policy);
  policy.converterVersion = "opencode-live-unknown";
  await writeFile(policyPath, JSON.stringify(policy));
  await expect(
    publishOpenCodeRecording({ ...options, signal: AbortSignal.timeout(5000) }),
  ).rejects.toThrow("options changed");
  expect(JSON.parse(await readFile(policyPath, "utf8"))).toEqual(policy);
}, 30000);

it("exposes OpenCode publishing through the CLI without a source file or password argument", async () => {
  const { spawn } = await import("node:child_process");
  const { resolve } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "agentlive-opencode-cli-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const native = await nativeServer();
  const server = await startServer({
    directory: join(root, "server"),
    ownerSecret: "b".repeat(64),
    port: 0,
  });
  cleanup.push(() => server.close());
  const child = spawn(
    process.execPath,
    [
      resolve("packages/cli/dist/main.js"),
      "publish",
      "--agent",
      "opencode",
      "--native-server",
      native.url,
      "--native-session",
      "ses_test",
      "--server",
      server.url,
      "--state-dir",
      root,
    ],
    {
      env: {
        PATH: process.env.PATH ?? "",
        AGENTLIVE_OWNER_SECRET: "b".repeat(64),
        OPENCODE_SERVER_PASSWORD: "native-password",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  let diagnostic = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    diagnostic += chunk.toString();
  });
  const exited = new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  try {
    await expect
      .poll(
        () => {
          if (diagnostic) throw new Error(diagnostic);
          return output;
        },
        { timeout: 10000 },
      )
      .toContain('"status":"observing"');
    expect(output).toContain('"event":"publishing"');
    expect(output).not.toContain("native-password");
    expect(output).not.toContain("b".repeat(64));
  } finally {
    child.kill("SIGTERM");
    expect(await exited).toBe(143);
  }
}, 20000);
it("continues durable capture while the AgentLive server is offline and sends the backlog after recovery", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "agentlive-opencode-offline-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const native = await nativeServer();
  let server = await startServer({
    directory: join(root, "server"),
    ownerSecret: "b".repeat(64),
    port: 0,
  });
  cleanup.push(() => server.close());
  const origin = server.url;
  const controller = new AbortController();
  let streamId = "";
  let captured = 0;
  let failure: unknown;
  const running = publishOpenCodeRecording({
    publisherRoot: join(root, "publisher"),
    serverOrigin: origin,
    ownerCredential: "b".repeat(64),
    nativeServerOrigin: native.url,
    nativeSessionId: "ses_test",
    nativePassword: "native-password",
    title: "Offline recovery",
    visibility: "private",
    signal: controller.signal,
    onReady: (recording) => {
      streamId = recording.streamId;
    },
    onCaptured: (boundary) => {
      captured = boundary.producerEvents;
    },
  }).catch((error) => {
    failure = error;
  });
  try {
    await expect
      .poll(
        () => {
          if (failure) throw failure;
          return captured;
        },
        { timeout: 10000 },
      )
      .toBeGreaterThan(0);
    const before = captured;
    await server.close();
    native.update("durable while offline");
    await expect
      .poll(
        () => {
          if (failure) throw failure;
          return captured;
        },
        { timeout: 10000 },
      )
      .toBeGreaterThan(before);
    const directory = (await readdir(join(root, "publisher")))[0]!;
    expect(
      await readFile(
        join(root, "publisher", directory, "capture.jsonl"),
        "utf8",
      ),
    ).toContain("durable while offline");
    server = await startServer({
      directory: join(root, "server"),
      ownerSecret: "b".repeat(64),
      port: Number(new URL(origin).port),
    });
    await expect
      .poll(
        async () => {
          if (failure) throw failure;
          const session = await server.store.get(streamId);
          let state = initialState();
          let through = 0;
          for await (const event of session.history(
            0,
            session.boundary.sequence,
          )) {
            state = apply(state, event);
            if (event.origin.type === "publisher")
              through = event.origin.event.producerSeq;
          }
          return (
            through >= captured &&
            [...state.messages.values()].some(
              (message) => message.text === "durable while offline",
            )
          );
        },
        { timeout: 10000 },
      )
      .toBe(true);
  } finally {
    controller.abort();
    await running;
  }
  if (failure) throw failure;
}, 20000);

it.each([false, true])(
  "continues a snapshot import in the same stream and deduplicates restart (family=%s)",
  async (family) => {
    const { importOpenCodeRecording } =
      await import("../../packages/adapters/src/index.js");
    const root = await mkdtemp(
      join(tmpdir(), "agentlive-opencode-resume-import-"),
    );
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const native = await nativeServer(family);
    const server = await startServer({
      directory: join(root, "server"),
      ownerSecret: "b".repeat(64),
      port: 0,
    });
    cleanup.push(() => server.close());
    const headers = {
      authorization: `Basic ${Buffer.from("opencode:native-password").toString("base64")}`,
    };
    const info = await (
      await fetch(native.url + "/session/ses_test", { headers })
    ).json();
    const messages = await (
      await fetch(native.url + "/session/ses_test/message", { headers })
    ).json();
    const exportsDirectory = join(root, "exports");
    await mkdir(exportsDirectory);
    const sourcePath = join(exportsDirectory, "export.json");
    let childPath = join(exportsDirectory, "child.json");
    if (family) {
      const info = await (
        await fetch(native.url + "/session/ses_child", { headers })
      ).json();
      const messages = await (
        await fetch(native.url + "/session/ses_child/message", { headers })
      ).json();
      await writeFile(childPath, JSON.stringify({ info, messages }));
    }
    await writeFile(sourcePath, JSON.stringify({ info, messages }));
    const options = {
      publisherRoot: join(root, "publisher"),
      serverOrigin: server.url,
      ownerCredential: "b".repeat(64),
      title: "Imported then live",
      visibility: "private" as const,
      secrets: ["native-password"],
      sourcePath,
    };
    const imported = await importOpenCodeRecording({
      ...options,
      ...(family ? { familyRoot: exportsDirectory } : {}),
      signal: AbortSignal.timeout(10000),
    });
    if (family) {
      const { rename, readdir } = await import("node:fs/promises");
      const { inspectMigration, relocateImportSources } =
        await import("../../packages/cli/src/inspect-migration.js");
      const bindingDirectory = join(
        options.publisherRoot,
        (await readdir(options.publisherRoot))[0]!,
      );
      const inspected = await inspectMigration(bindingDirectory);
      const moved = join(exportsDirectory, "moved-child.json");
      await rename(childPath, moved);
      childPath = moved;
      await relocateImportSources(bindingDirectory, {
        nativeSource: sourcePath,
        familySources: [`ses_child=${moved}`],
        operationId: "relocate-before-resume",
        expectedManifestHash: inspected.imported!.manifestHash,
      });
    }
    const session = await server.store.get(imported.streamId);
    const before = [];
    for await (const event of session.history(0, session.boundary.sequence))
      before.push(event);
    const live = {
      ...options,
      includeChildren: family,
      nativeServerOrigin: native.url,
      nativeSessionId: "ses_test",
      nativePassword: "native-password",
    };
    await expect(
      publishOpenCodeRecording({ ...live, signal: AbortSignal.timeout(5000) }),
    ).rejects.toThrow("--resume-import");
    expect(session.info.lifecycle).toBe("ended");
    const originalExport = await readFile(sourcePath, "utf8");
    await writeFile(sourcePath, originalExport + " ");
    await expect(
      publishOpenCodeRecording({
        ...live,
        resumeImport: true,
        signal: AbortSignal.timeout(5000),
      }),
    ).rejects.toThrow("changed since import");
    expect(session.info.lifecycle).toBe("ended");
    await writeFile(sourcePath, originalExport);
    await expect(
      publishOpenCodeRecording({
        ...live,
        resumeImport: true,
        secrets: ["changed-filter"],
        signal: AbortSignal.timeout(5000),
      }),
    ).rejects.toThrow("filtering policy changed");
    expect(session.info.lifecycle).toBe("ended");
    if (family) {
      native.hideChild(true);
      await expect(
        publishOpenCodeRecording({
          ...live,
          resumeImport: true,
          signal: AbortSignal.timeout(5000),
        }),
      ).rejects.toThrow("missing or reparented");
      expect(session.info.lifecycle).toBe("ended");
      native.hideChild(false);
      native.reparentChild("unrelated");
      await expect(
        publishOpenCodeRecording({
          ...live,
          resumeImport: true,
          signal: AbortSignal.timeout(5000),
        }),
      ).rejects.toThrow("lineage changed");
      expect(session.info.lifecycle).toBe("ended");
      native.reparentChild("ses_test");
      const child = await readFile(childPath, "utf8");
      await writeFile(childPath, child + " ");
      await expect(
        publishOpenCodeRecording({
          ...live,
          resumeImport: true,
          signal: AbortSignal.timeout(5000),
        }),
      ).rejects.toThrow("child export changed");
      expect(session.info.lifecycle).toBe("ended");
      await rm(childPath);
      await expect(
        publishOpenCodeRecording({
          ...live,
          resumeImport: true,
          signal: AbortSignal.timeout(5000),
        }),
      ).rejects.toThrow();
      expect(session.info.lifecycle).toBe("ended");
      await writeFile(childPath, child);
      await expect(
        publishOpenCodeRecording({
          ...live,
          includeChildren: false,
          resumeImport: true,
          signal: AbortSignal.timeout(5000),
        }),
      ).rejects.toThrow("options differ");
      expect(session.info.lifecycle).toBe("ended");
    }
    let abort = new AbortController();
    let failure: unknown;
    let captured = 0;
    const begin = (resumeImport: boolean) =>
      publishOpenCodeRecording({
        ...live,
        resumeImport,
        signal: abort.signal,
        onReady: (recording) => {
          expect(recording.streamId).toBe(imported.streamId);
        },
        onCaptured: (boundary) => {
          captured = boundary.producerEvents;
        },
      }).catch((error) => {
        failure = error;
      });
    let running = begin(true);
    const waitFor = async (text: string) => {
      await expect
        .poll(
          async () => {
            if (failure) throw failure;
            if (!captured) return false;
            let state = initialState();
            for await (const event of session.history(
              0,
              session.boundary.sequence,
            ))
              state = apply(state, event);
            return (
              [...state.messages.values()]
                .filter((message) => message.text)
                .map((message) => message.text)
                .sort()
                .join("|") ===
                (family ? [text, "child " + text] : [text]).sort().join("|") &&
              session.info.lifecycle === "open"
            );
          },
          { timeout: 10000 },
        )
        .toBe(true);
    };
    try {
      await waitFor("retained");
      expect(session.boundary.sequence).toBe(before.length + 1);
      abort.abort();
      await running;
      native.update("continued after import");
      abort = new AbortController();
      captured = 0;
      running = begin(false);
      await waitFor("continued after import");
      const prefix = [];
      for await (const event of session.history(0, before.length))
        prefix.push(event);
      expect(prefix).toEqual(before);
    } finally {
      abort.abort();
      await running;
    }
  },
);

it.each([false, true])(
  "explicitly expands live OpenCode scope while preserving the main prefix (imported=%s)",
  async (imported) => {
    const { PublisherJournal } =
      await import("../../packages/publisher/src/index.js");
    const root = await mkdtemp(join(tmpdir(), "agentlive-opencode-expand-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const native = await nativeServer(true);
    const server = await startServer({
      directory: join(root, "server"),
      ownerSecret: "c".repeat(64),
      port: 0,
    });
    cleanup.push(() => server.close());
    const options = {
      publisherRoot: join(root, "publisher"),
      serverOrigin: server.url,
      ownerCredential: "c".repeat(64),
      nativeServerOrigin: native.url,
      nativeSessionId: "ses_test",
      nativePassword: "native-password",
      secrets: ["native-password"],
      ...(imported ? { sourcePath: join(root, "export.json") } : {}),
      title: "Expansion",
      visibility: "private" as const,
      signal: AbortSignal.timeout(15000),
    };
    const run = async (extra: object) => {
      let finish = false;
      await publishOpenCodeRecording({
        ...options,
        ...extra,
        onCaptured: () => {
          finish = true;
        },
        finishRequested: () => finish,
      });
    };
    const read = async () => {
      const journal = await PublisherJournal.open(options.publisherRoot, {
        agent: "opencode",
        nativeSessionId: "ses_test",
        serverOrigin: server.url,
      });
      try {
        const events = [];
        for await (const event of journal.pending(0)) events.push(event);
        return {
          id: journal.identity.streamId,
          directory: journal.directory,
          events,
        };
      } finally {
        await journal.close();
      }
    };
    await expect(
      run({ includeChildren: true, expandFamily: true }),
    ).rejects.toThrow("existing live OpenCode publication");
    if (imported) {
      const { importOpenCodeRecording } =
        await import("../../packages/adapters/src/index.js");
      const headers = {
        authorization: `Basic ${Buffer.from("opencode:native-password").toString("base64")}`,
      };
      const info = await (
        await fetch(native.url + "/session/ses_test", { headers })
      ).json();
      const messages = await (
        await fetch(native.url + "/session/ses_test/message", { headers })
      ).json();
      await writeFile(options.sourcePath!, JSON.stringify({ info, messages }));
      await importOpenCodeRecording({
        ...options,
        sourcePath: options.sourcePath!,
      });
      await expect(
        run({ includeChildren: true, expandFamily: true }),
      ).rejects.toThrow("Resume the original single-session import");
      await run({ resumeImport: true });
    } else await run({});
    const before = await read();
    await expect(run({ includeChildren: true })).rejects.toThrow(
      imported ? "options differ" : "options changed",
    );
    await expect(
      run({ includeChildren: true, expandFamily: true, title: "Changed" }),
    ).rejects.toThrow(imported ? "resume provenance" : "options changed");
    await run({ includeChildren: true, expandFamily: true });
    const after = await read();
    expect(after.id).toBe(before.id);
    expect(after.events.slice(0, before.events.length)).toEqual(before.events);
    expect(
      after.events.filter((event) => event.content.kind === "session.started"),
    ).toHaveLength(1);
    expect(JSON.stringify(after.events)).toContain("child retained");
    expect(
      after.events.filter(
        (event) => event.content.kind === "attachment.available",
      ),
    ).toHaveLength(1);
    if (imported) {
      const marker = JSON.parse(
        await readFile(
          join(after.directory, "import-family-expansion.json"),
          "utf8",
        ),
      );
      await writeFile(
        join(after.directory, "publish.json"),
        JSON.stringify(marker.previous),
      );
    }
    await run({ includeChildren: true });
    expect(await read()).toEqual(after);
    await expect(run({ expandFamily: true })).rejects.toThrow(
      imported ? "resume provenance" : "options changed",
    );
  },
);
