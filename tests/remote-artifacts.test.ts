import { expect, it } from "vitest";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { fetchRemoteArtifact } from "../packages/adapters/src/remote-artifacts.js";
it("captures authenticated bytes only from allowed origins and verifies source hashes", async () => {
  const requests: { path: string; auth: string | undefined }[] = [];
  const server = createServer((req, res) => {
    requests.push({ path: req.url!, auth: req.headers.authorization });
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/private" });
      res.end();
      return;
    }
    if (req.url === "/stall") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("partial");
      return;
    }
    if (req.url === "/large") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("123456789");
      return;
    }
    if (req.headers.authorization !== "Bearer native-secret") {
      res.writeHead(401);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("private bytes");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const policy = {
    origins: [{ origin, authorization: "Bearer native-secret" }],
  };
  const signal = AbortSignal.timeout(5000);
  try {
    const hash = createHash("sha256").update("private bytes").digest("hex");
    const result = await fetchRemoteArtifact(
      { url: origin + "/private", expectedSourceHash: hash },
      policy,
      signal,
    );
    expect(result.bytes.toString()).toBe("private bytes");
    expect(result.historical).toBe(true);
    expect(
      (await fetchRemoteArtifact({ url: origin + "/private" }, policy, signal))
        .historical,
    ).toBe(false);
    await expect(
      fetchRemoteArtifact(
        { url: origin + "/private", expectedSourceHash: "a".repeat(64) },
        policy,
        signal,
      ),
    ).rejects.toThrow("hash changed");
    await expect(
      fetchRemoteArtifact(
        { url: origin + "/private?secret=query" },
        { origins: [] },
        signal,
      ),
    ).rejects.toThrow("not authorized");
    await expect(
      fetchRemoteArtifact(
        { url: origin + "/private" },
        { origins: [{ origin }] },
        signal,
      ),
    ).rejects.toThrow("HTTP 401");
    const before = requests.length;
    await expect(
      fetchRemoteArtifact({ url: origin + "/redirect" }, policy, signal),
    ).rejects.toThrow("HTTP 302");
    expect(requests.length).toBe(before + 1);
    await expect(
      fetchRemoteArtifact(
        { url: origin + "/large" },
        { ...policy, maxBytes: 4 },
        signal,
      ),
    ).rejects.toThrow("capture limit");
    await expect(
      fetchRemoteArtifact(
        { url: origin + "/stall" },
        { ...policy, timeoutMs: 30 },
        signal,
      ),
    ).rejects.toThrow();
    expect(
      requests
        .filter((request) => request.path !== "/private")
        .every((request) => request.auth === "Bearer native-secret"),
    ).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
it("rejects credential URLs, conflicting MIME and invalid text without exposing request details", async () => {
  const policy = {
    origins: [
      { origin: "https://artifacts.example", authorization: "Bearer private" },
    ],
  };
  const signal = new AbortController().signal;
  const input = { url: "https://artifacts.example/file?token=secret" };
  await expect(
    fetchRemoteArtifact(
      { url: "https://user:password@artifacts.example/file" },
      policy,
      signal,
    ),
  ).rejects.toThrow("not authorized");
  await expect(
    fetchRemoteArtifact(input, policy, signal, async () => {
      throw new Error(input.url);
    }),
  ).rejects.toThrow(/^Remote artifact request failed$/);
  await expect(
    fetchRemoteArtifact(
      { ...input, mediaType: "image/png" },
      policy,
      signal,
      async () =>
        new Response("text", { headers: { "content-type": "text/plain" } }),
    ),
  ).rejects.toThrow("media type");
  await expect(
    fetchRemoteArtifact(
      input,
      policy,
      signal,
      async () =>
        new Response(new Uint8Array([255]), {
          headers: { "content-type": "text/plain" },
        }),
    ),
  ).rejects.toThrow("UTF-8");
});

it("spools authenticated remote content and reuses it after the origin disappears", async () => {
  const { localArtifactResolver } =
    await import("../packages/adapters/src/local-artifacts.js");
  const { startServer } = await import("../packages/server/src/http.js");
  const { PublisherJournal, PublisherNetwork } =
    await import("../packages/publisher/src/index.js");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "agentlive-remote-spool-"));
  const owner = "a".repeat(64);
  const server = await startServer({
    directory: join(root, "server"),
    ownerSecret: owner,
    port: 0,
  });
  let requests = 0;
  const native = createServer((req, res) => {
    requests++;
    if (req.headers.authorization !== "Bearer native-secret") {
      res.writeHead(401);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("downloaded Bearer native-secret");
  });
  await new Promise<void>((resolve) => native.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(native.address() as { port: number }).port}`;
  const journal = await PublisherJournal.open(join(root, "publisher"), {
    agent: "opencode",
    nativeSessionId: "remote",
    serverOrigin: server.url,
  });
  let resolver: Awaited<ReturnType<typeof localArtifactResolver>> | undefined;
  try {
    const signal = AbortSignal.timeout(10000);
    await new PublisherNetwork({
      journal,
      ownerCredential: owner,
      title: "Remote",
      visibility: "private",
    }).ensureRemote(signal);
    const options = {
      directory: join(journal.directory, "artifacts"),
      roots: [root],
      baseDirectory: root,
      secrets: [],
      serverOrigin: server.url,
      streamId: journal.identity.streamId!,
      writeSecret: journal.identity.writeSecret,
      signal,
      remoteArtifacts: {
        origins: [{ origin, authorization: "Bearer native-secret" }],
      },
    };
    const request = {
      artifactId: "remote_file",
      sourceKey: "remote/version1",
      url: origin + "/file",
      filename: "file.txt",
      mediaType: "text/plain",
    };
    resolver = await localArtifactResolver(options);
    const first = await resolver.resolveRemote!(request);
    expect("attachment" in first).toBe(true);
    await resolver.close();
    native.closeAllConnections();
    await new Promise<void>((resolve) => native.close(() => resolve()));
    resolver = await localArtifactResolver(options);
    const second = await resolver.resolveRemote!(request);
    expect(second).toEqual(first);
    expect(requests).toBe(1);
    if (!("attachment" in second)) throw new Error("Missing remote attachment");
    const response = await fetch(
      `${server.url}/api/v1/streams/${journal.identity.streamId}/attachments/${second.attachment.hash}`,
      { headers: { authorization: `Bearer ${owner}` } },
    );
    // Upload alone must not expose bytes before attachment.available publication.
    expect(response.status).toBe(409);
    const status = await fetch(
      `${server.url}/api/v1/streams/${journal.identity.streamId}/attachments/${second.attachment.hash}/status?byteSize=${second.attachment.byteSize}`,
      { headers: { authorization: `Bearer ${journal.identity.writeSecret}` } },
    );
    expect(await status.json()).toEqual({ available: true });
    expect(second.attachment.hash).not.toBe(
      createHash("sha256")
        .update("downloaded Bearer native-secret")
        .digest("hex"),
    );
    await expect(
      resolver.resolveRemote!({ ...request, url: origin + "/different" }),
    ).rejects.toThrow("policy or identity changed");
  } finally {
    await resolver?.close();
    await journal.close();
    native.closeAllConnections();
    await new Promise<void>((resolve) => native.close(() => resolve()));
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
