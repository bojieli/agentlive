import { PublisherJournal } from "../../packages/publisher/src/index.js";
import { expect, it } from "vitest";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  appendFile,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  importKimiRecording,
  publishKimiRecording,
} from "../../packages/adapters/src/index.js";
import { startServer } from "../../packages/server/src/http.js";
import { initialState, apply } from "../../packages/playback/src/index.js";
import { exportRecording } from "../../packages/cli/src/export.js";
import { importArchiveRecording } from "../../packages/cli/src/import-archive.js";

it.each([false, true])(
  "captures Kimi remote image and inline audio/video families through import, live continuation and archive (CLI=%s)",
  async (cli) => {
    const root = await mkdtemp(join(tmpdir(), "agentlive-kimi-remote-"));
    const owner = "a".repeat(64);
    const server = await startServer({
      directory: join(root, "server"),
      ownerSecret: owner,
      port: 0,
    });
    let requests = 0,
      expired = false;
    const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
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
      res.writeHead(200, {
        "content-type": req.url?.startsWith("/image")
          ? "image/png"
          : "text/plain",
      });
      res.end(
        req.url?.startsWith("/image") ? image : "document Bearer file-secret",
      );
    });
    await new Promise<void>((resolve) =>
      native.listen(0, "127.0.0.1", resolve),
    );
    const origin = `http://127.0.0.1:${(native.address() as { port: number }).port}`;
    const row = (id: string, child = false) =>
      JSON.stringify({
        type: "context.append_message",
        time: 1788220800001,
        message: {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: origin + "/image?" + id } },
          ],
        },
      }) + "\n";
    const abort = new AbortController();
    let running: Promise<void> | undefined;
    try {
      const sourcePath = join(
        root,
        "session_session",
        "agents",
        "main",
        "wire.jsonl",
      );
      const children = join(root, "session_session", "agents", "worker");
      await mkdir(join(sourcePath, ".."), { recursive: true });
      await mkdir(children, { recursive: true });
      const metadata =
        JSON.stringify({
          type: "metadata",
          protocol_version: "1.5",
          created_at: 1788220800000,
        }) + "\n";
      await writeFile(sourcePath, metadata + row("main"));
      await writeFile(
        join(children, "wire.jsonl"),
        metadata +
          row("child", true) +
          JSON.stringify({
            type: "context.append_loop_event",
            time: 1788220800002,
            event: {
              type: "content.part",
              uuid: "audio",
              part: {
                type: "audio_url",
                audio_url: { url: "data:audio/aac;base64,AQIDBA==" },
              },
            },
          }) +
          "\n" +
          JSON.stringify({
            type: "context.append_message",
            time: 1788220800003,
            message: {
              role: "user",
              content: [
                {
                  type: "video_url",
                  video_url: { url: "data:video/mp4;base64,BQYHCA==" },
                },
              ],
            },
          }) +
          "\n",
      );
      const options = {
        sourcePath,
        publisherRoot: join(root, "publisher"),
        serverOrigin: server.url,
        ownerCredential: owner,
        title: "Kimi remote",
        visibility: "private" as const,
        includeChildren: true,
        secrets: [owner, "Bearer file-secret"],
        remoteArtifacts: {
          origins: [{ origin, authorization: "Bearer file-secret" }],
        },
        signal: AbortSignal.timeout(20000),
      };
      const policyPath = join(root, "policy.json");
      await writeFile(
        policyPath,
        JSON.stringify({
          origins: [{ origin, authorizationEnv: "FILE_AUTH" }],
        }),
      );
      const runImport = async () => {
        if (!cli) return importKimiRecording(options);
        const result = await promisify(execFile)(
          process.execPath,
          [
            "packages/cli/dist/main.js",
            "import",
            "--agent",
            "kimi",
            "--source",
            sourcePath,
            "--include-children",
            "--state-dir",
            root,
            "--server",
            server.url,
            "--title",
            options.title,
            "--remote-artifact-policy",
            policyPath,
          ],
          {
            env: {
              PATH: process.env.PATH ?? "",
              AGENTLIVE_OWNER_SECRET: owner,
              FILE_AUTH: "Bearer file-secret",
            },
            timeout: 15000,
          },
        );
        return JSON.parse(result.stdout) as Awaited<
          ReturnType<typeof importKimiRecording>
        >;
      };
      const first = await runImport();
      expect(requests).toBe(2);
      const journal = await PublisherJournal.open(options.publisherRoot, {
        agent: "kimi",
        nativeSessionId: "session",
        serverOrigin: server.url,
      });
      const importPath = join(journal.directory, "import.json");
      await journal.close();
      const originalManifest = await readFile(importPath, "utf8");
      await writeFile(
        importPath,
        originalManifest.replace("kimi-history-4", "kimi-history-3"),
      );
      await expect(importKimiRecording(options)).rejects.toThrow(
        "options changed",
      );
      expect(requests).toBe(2);
      await writeFile(importPath, originalManifest);
      expired = true;
      const retry = await runImport();
      expect(retry.streamId).toBe(first.streamId);
      expect(retry.producerEvents).toBe(first.producerEvents);
      expect(requests).toBe(2);
      await expect(
        publishKimiRecording({
          ...options,
          resumeImport: true,
          remoteArtifacts: { ...options.remoteArtifacts, maxBytes: 1000 },
        }),
      ).rejects.toThrow();
      let caught = false,
        failure: unknown;
      running = publishKimiRecording({
        ...options,
        resumeImport: true,
        signal: abort.signal,
        onCaughtUp: async () => {
          caught = true;
        },
      }).catch((error) => {
        failure = error;
      });
      await expect
        .poll(
          () => {
            if (failure) throw failure;
            return caught;
          },
          { timeout: 10000 },
        )
        .toBe(true);
      expect(requests).toBe(2);
      expired = false;
      await appendFile(sourcePath, row("new-document"));
      await expect
        .poll(
          async () => {
            if (failure) throw failure;
            const session = await server.store.get(first.streamId);
            try {
              let state = initialState();
              for await (const event of session.history(
                0,
                session.info.serverSeq,
              ))
                state = apply(state, event);
              return [...state.artifacts.values()].flatMap((a) => [
                ...a.versions.values(),
              ]).length;
            } finally {
              server.store.release(session);
            }
          },
          { timeout: 10000 },
        )
        .toBe(5);
      abort.abort();
      await running;
      const archive = join(root, "remote.agentlive");
      await exportRecording({
        serverOrigin: server.url,
        streamId: first.streamId,
        credential: owner,
        output: archive,
        signal: options.signal,
      });
      const restored = await importArchiveRecording({
        serverOrigin: server.url,
        credential: owner,
        source: archive,
        signal: options.signal,
      });
      for (const streamId of [first.streamId, restored.streamId]) {
        const session = await server.store.get(streamId);
        try {
          let state = initialState();
          for await (const event of session.history(
            0,
            session.info.serverSeq,
          )) {
            expect(JSON.stringify(event)).not.toContain(origin);
            state = apply(state, event);
          }
          const versions = [...state.artifacts.values()].flatMap((a) => [
            ...a.versions.values(),
          ]);
          expect(versions).toHaveLength(5);
          for (const version of versions) {
            expect(version.provenance).toBe(
              version.mediaType === "image/png"
                ? "live-capture"
                : "historical-version",
            );
            const response = await fetch(
              `${server.url}/api/v1/streams/${streamId}/attachments/${version.hash}`,
              { headers: { authorization: `Bearer ${owner}` } },
            );
            expect(response.status).toBe(200);
            const bytes = Buffer.from(await response.arrayBuffer());
            if (version.mediaType === "image/png") expect(bytes).toEqual(image);
            else
              expect(bytes).toEqual(
                Buffer.from(
                  version.mediaType === "audio/aac"
                    ? [1, 2, 3, 4]
                    : [5, 6, 7, 8],
                ),
              );
          }
        } finally {
          server.store.release(session);
        }
      }
    } finally {
      abort.abort();
      await running;
      native.closeAllConnections();
      await new Promise<void>((resolve) => native.close(() => resolve()));
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
