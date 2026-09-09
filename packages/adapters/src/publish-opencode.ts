import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  PublisherJournal,
  PublisherNetwork,
  type PublisherStatus,
} from "@agentlive/publisher";
import { canonicalJson, idSchema } from "@agentlive/protocol";
import { atomicJson } from "@agentlive/storage";
import {
  originOf,
  delay,
  request,
  retryable,
} from "@agentlive/client/transport";
import { localArtifactResolver } from "./local-artifacts.js";
import { OpenCodeCapture } from "./opencode-capture.js";
import { observeOpenCodeSession } from "./observe-opencode.js";
export interface OpenCodePublishOptions {
  artifactRoots?: readonly string[];
  publisherRoot: string;
  serverOrigin: string;
  ownerCredential: string;
  nativeServerOrigin: string;
  nativeSessionId: string;
  nativePassword?: string;
  nativeUsername?: string;
  title: string;
  visibility: "private" | "public" | "unlisted";
  secrets?: readonly string[];
  signal: AbortSignal;
  onReady?: (recording: { streamId: string; revision: string }) => void;
  onStatus?: (status: PublisherStatus) => void;
  onNativeStatus?: (
    status: "connecting" | "observing" | "reconnecting" | "stopped",
  ) => void;
  onCaptured?: (boundary: { producerEvents: number }) => void;
}
/** Attach to a supported native server; publisher and native connections recover independently. */
export async function publishOpenCodeRecording(
  options: OpenCodePublishOptions,
): Promise<void> {
  const nativeServerOrigin = originOf(options.nativeServerOrigin);
  const nativeSessionId = idSchema.parse(options.nativeSessionId);
  const journal = await PublisherJournal.open(options.publisherRoot, {
    serverOrigin: options.serverOrigin,
    agent: "opencode",
    nativeSessionId,
  });
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  let running: Promise<void> | undefined;
  let networkFailure: unknown;
  let capture: OpenCodeCapture | undefined;
  let artifacts: Awaited<ReturnType<typeof localArtifactResolver>> | undefined;
  try {
    if (!journal.identity.streamId) {
      const headers = options.nativePassword
        ? {
            authorization: `Basic ${Buffer.from(`${options.nativeUsername ?? "opencode"}:${options.nativePassword}`).toString("base64")}`,
          }
        : {};
      while (true) {
        try {
          const info = JSON.parse(
            (
              await request(
                fetch,
                `${nativeServerOrigin}/session/${nativeSessionId}`,
                { headers },
                signal,
                1024 * 1024,
              )
            ).text,
          );
          if (
            info.id !== nativeSessionId ||
            !Number.isSafeInteger(info.time?.created) ||
            info.time.created < 0
          )
            throw new Error(
              "OpenCode preflight returned invalid native session identity",
            );
          break;
        } catch (error) {
          if (signal.aborted || !retryable(error)) throw error;
          await delay(250, signal);
        }
      }
    }
    try {
      await readFile(join(journal.directory, "import.json"));
      throw new Error(
        "OpenCode historical imports require snapshot converter migration before live continuation",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const secrets = [
      ...(options.secrets ?? []),
      options.ownerCredential,
      journal.identity.writeSecret,
      ...(options.nativePassword ? [options.nativePassword] : []),
    ];
    const roots = (options.artifactRoots ?? [])
      .map((root) => resolve(root))
      .sort();
    const identity = {
      artifactRoots: roots,
      version: 1,
      converterVersion: "opencode-live-2",
      title: options.title,
      visibility: options.visibility,
      filterFingerprint: createHash("sha256")
        .update(canonicalJson([...new Set(secrets)].sort()))
        .digest("hex"),
    };
    const manifestPath = join(journal.directory, "publish.json");
    try {
      const previous = JSON.parse(await readFile(manifestPath, "utf8"));
      const { artifactRoots: _, ...legacyIdentity } = identity;
      if (
        previous.artifactRoots === undefined &&
        canonicalJson(previous) === canonicalJson(legacyIdentity)
      )
        await atomicJson(manifestPath, identity);
      else if (canonicalJson(previous) !== canonicalJson(identity))
        throw new Error(
          "OpenCode publishing conversion, filtering, artifact or sharing options changed",
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await atomicJson(manifestPath, identity);
    }
    if (!journal.identity.sharingEnabled)
      throw new Error("Publishing is paused");
    const network = new PublisherNetwork({
      journal,
      ownerCredential: options.ownerCredential,
      title: options.title,
      visibility: options.visibility,
      ...(options.onStatus ? { onStatus: options.onStatus } : {}),
    });
    running = network.run(signal).catch((error) => {
      networkFailure = error;
      controller.abort(error);
    });
    while (!journal.identity.streamId) await delay(25, signal);
    artifacts = await localArtifactResolver({
      directory: join(journal.directory, "artifacts"),
      roots,
      baseDirectory: "/",
      secrets,
      serverOrigin: journal.identity.serverOrigin,
      streamId: journal.identity.streamId!,
      writeSecret: journal.identity.writeSecret,
      signal,
    });
    capture = await OpenCodeCapture.open(journal, secrets, artifacts);
    options.onReady?.({
      streamId: journal.identity.streamId!,
      revision: journal.identity.revision!,
    });
    await observeOpenCodeSession({
      serverOrigin: nativeServerOrigin,
      nativeSessionId,
      signal,
      ...(options.nativePassword ? { password: options.nativePassword } : {}),
      ...(options.nativeUsername ? { username: options.nativeUsername } : {}),
      ...(options.onNativeStatus ? { onStatus: options.onNativeStatus } : {}),
      commit: async (snapshot) => {
        await capture!.accept(snapshot, signal);
        options.onCaptured?.({ producerEvents: journal.capturedThrough });
      },
    });
  } catch (error) {
    if (networkFailure) throw networkFailure;
    if (!options.signal.aborted) throw error;
  } finally {
    controller.abort();
    await running;
    try {
      await capture?.close();
    } finally {
      try {
        await artifacts?.close();
      } finally {
        await journal.close();
      }
    }
  }
}
