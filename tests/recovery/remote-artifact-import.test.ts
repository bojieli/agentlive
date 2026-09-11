import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  importOpenCodeRecording,
  publishOpenCodeRecording,
} from "../../packages/adapters/src/index.js";
import { startServer } from "../../packages/server/src/http.js";
import { initialState, apply } from "../../packages/playback/src/index.js";

it.each([false, true])(
  "imports authenticated family artifacts and continues live without refetching expired URLs (CLI=%s)",
  async (cli) => {
    const root = await mkdtemp(join(tmpdir(), "agentlive-remote-import-"));
    const owner = "e".repeat(64);
    const server = await startServer({
      directory: join(root, "server"),
      ownerSecret: owner,
      port: 0,
    });
    let artifactRequests = 0,
      expired = false;
    const clients = new Set<ServerResponse>();
    const snapshots = new Map<string, ReturnType<typeof snapshot>>();
    const native = createServer((req, res) => {
      if (req.url?.startsWith("/files/")) {
        artifactRequests++;
        if (expired) {
          res.writeHead(410).end();
          return;
        }
        if (req.headers.authorization !== "Bearer artifact-secret") {
          res.writeHead(401).end();
          return;
        }
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("captured " + req.url.slice(7) + " Bearer artifact-secret");
        return;
      }
      if (req.url === "/event") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"type":"server.connected"}\n\n');
        clients.add(res);
        res.on("close", () => clients.delete(res));
        return;
      }
      const match = /^\/session\/(root|child)(?:\/(message|children))?$/.exec(
        req.url ?? "",
      );
      if (!match) {
        res.writeHead(404).end();
        return;
      }
      const value = snapshots.get(match[1]!)!;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(
          match[2] === "message"
            ? value.messages
            : match[2] === "children"
              ? match[1] === "root"
                ? [snapshots.get("child")!.info]
                : []
              : value.info,
        ),
      );
    });
    await new Promise<void>((resolve) =>
      native.listen(0, "127.0.0.1", resolve),
    );
    const origin = `http://127.0.0.1:${(native.address() as { port: number }).port}`;
    function snapshot(id: string) {
      return {
        info: {
          id,
          ...(id === "child" ? { parentID: "root" } : {}),
          time: { created: 1 },
        },
        messages: [
          {
            info: {
              id: "msg",
              sessionID: id,
              role: "assistant",
              time: { created: 1, completed: 2 },
            },
            parts: [
              {
                id: "text",
                type: "text",
                sessionID: id,
                messageID: "msg",
                text: "retained " + id,
              },
              {
                id: "file",
                type: "file",
                sessionID: id,
                messageID: "msg",
                mime: "text/plain",
                filename: id + ".txt",
                url: origin + "/files/" + id,
              },
            ],
          },
        ],
      };
    }
    const abort = new AbortController();
    let running: Promise<void> | undefined;
    try {
      const familyRoot = join(root, "exports");
      await mkdir(familyRoot);
      for (const id of ["root", "child"]) {
        snapshots.set(id, snapshot(id));
        await writeFile(
          join(familyRoot, id + ".json"),
          JSON.stringify(snapshots.get(id)),
        );
      }
      const options = {
        sourcePath: join(familyRoot, "root.json"),
        familyRoot,
        publisherRoot: join(root, "publisher"),
        serverOrigin: server.url,
        secrets: [owner, "Bearer artifact-secret"],
        ownerCredential: owner,
        title: "Remote import",
        visibility: "private" as const,
        remoteArtifacts: {
          origins: [{ origin, authorization: "Bearer artifact-secret" }],
        },
        signal: AbortSignal.timeout(15000),
      };
      const policyPath = join(root, "policy.json");
      await writeFile(
        policyPath,
        JSON.stringify({
          origins: [{ origin, authorizationEnv: "FILE_AUTH" }],
        }),
      );
      const runImport = async () => {
        if (!cli) return importOpenCodeRecording(options);
        const { stdout } = await promisify(execFile)(
          process.execPath,
          [
            "packages/cli/dist/main.js",
            "import",
            "--agent",
            "opencode",
            "--source",
            options.sourcePath,
            "--source-root",
            familyRoot,
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
              FILE_AUTH: "Bearer artifact-secret",
            },
            timeout: 15000,
          },
        );
        return JSON.parse(stdout) as Awaited<
          ReturnType<typeof importOpenCodeRecording>
        >;
      };
      const imported = await runImport();
      expect(imported.report.availableAttachments).toBe(2);
      expect(artifactRequests).toBe(2);
      expired = true;
      const retry = await runImport();
      expect(retry.streamId).toBe(imported.streamId);
      expect(retry.producerEvents).toBe(imported.producerEvents);
      expect(artifactRequests).toBe(2);
      const session = await server.store.get(imported.streamId);
      try {
        expect(session.info.lifecycle).toBe("ended");
        let state = initialState();
        for await (const event of session.history(0, session.info.serverSeq))
          state = apply(state, event);
        const versions = [...state.artifacts.values()].flatMap((a) => [
          ...a.versions.values(),
        ]);
        expect(versions).toHaveLength(2);
        for (const version of versions) {
          expect(version.provenance).toBe("live-capture");
          const response = await fetch(
            `${server.url}/api/v1/streams/${imported.streamId}/attachments/${version.hash}`,
            { headers: { authorization: `Bearer ${owner}` } },
          );
          expect(response.status).toBe(200);
          const text = await response.text();
          expect(text).toContain("captured ");
          expect(text).not.toContain("artifact-secret");
        }
      } finally {
        server.store.release(session);
      }
      await expect(
        importOpenCodeRecording({
          ...options,
          remoteArtifacts: { ...options.remoteArtifacts, maxBytes: 1000 },
        }),
      ).rejects.toThrow("options changed");
      const publish = {
        ...options,
        nativeServerOrigin: origin,
        nativeSessionId: "root",
        includeChildren: true,
        resumeImport: true,
      };
      await expect(
        publishOpenCodeRecording({
          ...publish,
          remoteArtifacts: { ...options.remoteArtifacts, maxBytes: 1000 },
        }),
      ).rejects.toThrow();
      const unchanged = await server.store.get(imported.streamId);
      expect(unchanged.info.lifecycle).toBe("ended");
      server.store.release(unchanged);
      let captured = false,
        failure: unknown;
      running = publishOpenCodeRecording({
        ...publish,
        signal: abort.signal,
        onCaptured: () => {
          captured = true;
        },
      }).catch((error) => {
        failure = error;
      });
      await expect
        .poll(
          () => {
            if (failure) throw failure;
            return captured;
          },
          { timeout: 10000 },
        )
        .toBe(true);
      expect(artifactRequests).toBe(2);
      const reopened = await server.store.get(imported.streamId);
      expect(reopened.info.lifecycle).toBe("open");
      server.store.release(reopened);
    } finally {
      abort.abort();
      await running;
      for (const client of clients) client.destroy();
      native.closeAllConnections();
      await new Promise<void>((resolve) => native.close(() => resolve()));
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
