import { expect, it } from "vitest";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { startServer } from "../../packages/server/src/http.js";
import { initialState, apply } from "../../packages/playback/src/index.js";
import {
  ARTIFACT_BUNDLE_MEDIA_TYPE,
  decodeArtifactBundle,
} from "../../packages/protocol/src/index.js";
import { exportRecording } from "../../packages/cli/src/export.js";
import { importArchiveRecording } from "../../packages/cli/src/import-archive.js";

it.each(["file", "inline", "remote"] as const)(
  "publishes %s HTML bundles through CLI import, source loss, retry and portable recording",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "agentlive-publish-bundle-"));
    const owner = "a".repeat(64);
    const server = await startServer({
      directory: join(root, "server"),
      ownerSecret: owner,
      port: 0,
    });
    const html =
      '<base href="./"><link rel="stylesheet" href="style.css"><img src="image.png" srcset="image.png 1x, image2.png 2x"><script type="module" src="main.js"></script><p>Bearer file-secret</p>';
    const content = new Map([
      ["/index.html", { type: "text/html", bytes: Buffer.from(html) }],
      [
        "/style.css",
        {
          type: "text/css",
          bytes: Buffer.from('body { background: url("image.png") }'),
        },
      ],
      [
        "/image.png",
        { type: "image/png", bytes: Buffer.from([137, 80, 78, 71, 1]) },
      ],
    ]);
    content.set("/image2.png", {
      type: "image/png",
      bytes: Buffer.from([137, 80, 78, 71, 1]),
    });
    content.set("/main.js", {
      type: "application/javascript",
      bytes: Buffer.from(
        'import {value} from "./helper.js"; import("./helper.js"); export default value;',
      ),
    });
    content.set("/helper.js", {
      type: "application/javascript",
      bytes: Buffer.from('import value from "./main.js"; export {value};'),
    });
    let expired = false,
      requests = 0;
    const native = createServer((req, res) => {
      requests++;
      if (expired) {
        res.writeHead(410).end();
        return;
      }
      if (req.headers.authorization !== "Bearer file-secret") {
        res.writeHead(401).end();
        return;
      }
      const file = content.get(req.url ?? "");
      if (!file) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": file.type });
      res.end(file.bytes);
    });
    await new Promise<void>((resolve) =>
      native.listen(0, "127.0.0.1", resolve),
    );
    const origin = `http://127.0.0.1:${(native.address() as { port: number }).port}`;
    try {
      const assets = join(root, "assets");
      await mkdir(assets);
      for (const [path, value] of content)
        await writeFile(join(assets, path.slice(1)), value.bytes);
      const source = join(root, "export.json");
      await writeFile(
        source,
        JSON.stringify({
          info: { id: "bundle-session", time: { created: 1 } },
          messages: [
            {
              info: {
                id: "message",
                sessionID: "bundle-session",
                role: "assistant",
                time: { created: 1, completed: 2 },
              },
              parts: [
                {
                  id: "file",
                  type: "file",
                  sessionID: "bundle-session",
                  messageID: "message",
                  filename: "index.html",
                  mime: "text/html",
                  url:
                    kind === "file"
                      ? pathToFileURL(join(assets, "index.html")).href
                      : kind === "inline"
                        ? "data:text/html;base64," +
                          Buffer.from(html).toString("base64")
                        : origin + "/index.html",
                },
              ],
            },
          ],
        }),
      );
      const policy = join(root, "policy.json");
      await writeFile(
        policy,
        JSON.stringify({
          origins: [{ origin, authorizationEnv: "FILE_AUTH" }],
        }),
      );
      const args = [
        "packages/cli/dist/main.js",
        "import",
        "--agent",
        "opencode",
        "--source",
        source,
        "--state-dir",
        root,
        "--server",
        server.url,
        "--artifact-bundles",
        "--artifact-root",
        assets,
        "--artifact-base",
        assets,
        "--remote-artifact-policy",
        policy,
      ];
      const run = async (arguments_ = args) =>
        JSON.parse(
          (
            await promisify(execFile)(process.execPath, arguments_, {
              env: {
                PATH: process.env.PATH ?? "",
                AGENTLIVE_OWNER_SECRET: owner,
                FILE_AUTH: "Bearer file-secret",
              },
              timeout: 15000,
            })
          ).stdout,
        ) as { streamId: string; producerEvents: number };
      const first = await run();
      if (kind === "remote") expect(requests).toBe(6);
      expect(await readFile(join(assets, "index.html"), "utf8")).toBe(html);
      expired = true;
      // Keep the configured directory; its contents are no longer available.
      for (const path of content.keys()) await rm(join(assets, path.slice(1)));
      const retry = await run();
      expect(retry.streamId).toBe(first.streamId);
      expect(retry.producerEvents).toBe(first.producerEvents);
      if (kind === "remote") expect(requests).toBe(6);
      await expect(
        run(args.filter((argument) => argument !== "--artifact-bundles")),
      ).rejects.toThrow();
      const archive = join(root, "bundle.agentlive");
      await exportRecording({
        serverOrigin: server.url,
        streamId: first.streamId,
        credential: owner,
        output: archive,
        signal: AbortSignal.timeout(10000),
      });
      const restored = await importArchiveRecording({
        serverOrigin: server.url,
        credential: owner,
        source: archive,
        signal: AbortSignal.timeout(10000),
      });
      let firstBytes: Buffer | undefined;
      for (const streamId of [first.streamId, restored.streamId]) {
        const session = await server.store.get(streamId);
        let state = initialState();
        try {
          for await (const event of session.history(0, session.info.serverSeq))
            state = apply(state, event);
        } finally {
          server.store.release(session);
        }
        const versions = [...state.artifacts.values()].flatMap((artifact) => [
          ...artifact.versions.values(),
        ]);
        expect(versions).toHaveLength(1);
        const version = versions[0]!;
        expect(version.mediaType).toBe(ARTIFACT_BUNDLE_MEDIA_TYPE);
        expect(version.provenance).toBe("live-capture");
        const response = await fetch(
          `${server.url}/api/v1/streams/${streamId}/attachments/${version.hash}`,
          { headers: { authorization: `Bearer ${owner}` } },
        );
        expect(response.status).toBe(200);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (firstBytes) expect(bytes).toEqual(firstBytes);
        else firstBytes = bytes;
        const bundle = await decodeArtifactBundle(bytes);
        expect(bundle.manifest.files).toHaveLength(6);
        expect(bundle.manifest.unavailable).toEqual([]);
        expect(
          Buffer.from(bundle.files.get(bundle.manifest.entrypoint)!).toString(),
        ).not.toContain("file-secret");
        for (const file of bundle.manifest.files)
          if (file.mediaType === "image/png")
            expect(Buffer.from(bundle.files.get(file.path)!)).toEqual(
              content.get("/image.png")!.bytes,
            );
      }
    } finally {
      native.closeAllConnections();
      await new Promise<void>((resolve) => native.close(() => resolve()));
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
