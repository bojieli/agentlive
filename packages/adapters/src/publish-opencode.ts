import { assertPublisherNotFinished } from "@agentlive/publisher";
import {
  validateRemoteArtifactPolicy,
  remoteArtifactSecrets,
  type RemoteArtifactPolicy,
} from "./remote-artifacts.js";
import { prepareImportedOpenCodeExpansion } from "./expand-import-family.js";
import { prepareOpenCodeFamilyResume } from "./resume-opencode-family.js";
import { resumeImportedRecording } from "./resume-import.js";
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
import { OpenCodeFamilyCapture } from "./opencode-family.js";
export interface OpenCodePublishOptions {
  artifactRoots?: readonly string[];
  artifactBundles?: boolean;
  remoteArtifacts?: RemoteArtifactPolicy;
  sourcePath?: string;
  resumeImport?: boolean;
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
  finishRequested?: () => boolean;
  includeChildren?: boolean;
  expandFamily?: boolean;
}
/** Attach to a supported native server; publisher and native connections recover independently. */
export async function publishOpenCodeRecording(
  options: OpenCodePublishOptions,
): Promise<void> {
  if (options.remoteArtifacts)
    options = {
      ...options,
      remoteArtifacts: validateRemoteArtifactPolicy(options.remoteArtifacts),
    };
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
  let family: OpenCodeFamilyCapture | undefined;
  let artifacts: Awaited<ReturnType<typeof localArtifactResolver>> | undefined;
  try {
    await assertPublisherNotFinished(journal.directory);
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
    let imported:
      { artifactBaseDirectory: string; artifactRoots: string[] } | undefined;
    try {
      imported = JSON.parse(
        await readFile(join(journal.directory, "import.json"), "utf8"),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!imported && options.resumeImport)
      throw new Error(
        "No import exists for this server and native session binding",
      );
    const secrets = [
      ...(options.secrets ?? []),
      ...remoteArtifactSecrets(options.remoteArtifacts),
      ...(options.artifactBundles
        ? ["agentlive-artifact-bundle-policy-v2"]
        : []),
      options.ownerCredential,
      journal.identity.writeSecret,
      ...(options.nativePassword ? [options.nativePassword] : []),
    ];
    const roots = (options.artifactRoots ?? imported?.artifactRoots ?? [])
      .map((root) => resolve(root))
      .sort();
    const identity = {
      artifactRoots: roots,
      version: 1,
      converterVersion: "opencode-live-2",
      ...(options.includeChildren ? { includeChildren: true } : {}),
      title: options.title,
      visibility: options.visibility,
      filterFingerprint: createHash("sha256")
        .update(canonicalJson([...new Set(secrets)].sort()))
        .digest("hex"),
    };
    let expansion: Awaited<ReturnType<typeof prepareImportedOpenCodeExpansion>>;
    if (imported) {
      if (!options.sourcePath)
        throw new Error(
          "OpenCode import continuation requires the original export --source",
        );
      // Verify the capture filter before remotely reopening an ended recording.
      const retained = await OpenCodeCapture.open(journal, secrets);
      await retained.close();
      const resumeIdentity = {
        version: 1,
        converterVersion: options.includeChildren
          ? "opencode-snapshot-4-family-import-1"
          : "opencode-snapshot-4",
        recordFormat: "snapshot",
        baseDirectory: imported.artifactBaseDirectory,
        roots,
        title: options.title,
        visibility: options.visibility,
        filterFingerprint: createHash("sha256")
          .update(
            canonicalJson(
              [
                ...new Set([
                  ...(options.secrets ?? []),
                  ...remoteArtifactSecrets(options.remoteArtifacts),
                  ...(options.artifactBundles
                    ? ["agentlive-artifact-bundle-policy-v2"]
                    : []),
                ]),
              ].sort(),
            ),
          )
          .digest("hex"),
      } as const;
      expansion = await prepareImportedOpenCodeExpansion(
        journal.directory,
        resumeIdentity,
        identity,
        options.expandFamily ?? false,
      );
      await resumeImportedRecording({
        journal,
        sourcePath: options.sourcePath,
        requested: options.resumeImport ?? false,
        ...(options.includeChildren
          ? {
              validateOpenCodeFamily: (sources: unknown) =>
                prepareOpenCodeFamilyResume({
                  journal,
                  sources,
                  sourcePath: options.sourcePath!,
                  origin: nativeServerOrigin,
                  ...(options.nativePassword
                    ? { password: options.nativePassword }
                    : {}),
                  ...(options.nativeUsername
                    ? { username: options.nativeUsername }
                    : {}),
                  secrets,
                  signal,
                }),
            }
          : {}),
        signal,
        identity: expansion?.original ?? resumeIdentity,
      });
    }
    await expansion?.commit();
    const manifestPath = join(journal.directory, "publish.json");
    try {
      const previous = JSON.parse(await readFile(manifestPath, "utf8"));
      // The v2 decoder only expands inline attachment decoding. Existing journal
      // entries remain immutable; capture state reconciles unavailable attachments.
      const compatible = { ...previous };
      if (compatible.converterVersion === "opencode-live-1")
        compatible.converterVersion = "opencode-live-2";
      if (compatible.artifactRoots === undefined) compatible.artifactRoots = [];
      if (
        (options.expandFamily || expansion) &&
        options.includeChildren &&
        compatible.includeChildren === undefined
      )
        compatible.includeChildren = true;
      if (canonicalJson(compatible) !== canonicalJson(identity))
        throw new Error(
          "OpenCode publishing conversion, filtering, artifact or sharing options changed",
        );
      if (canonicalJson(previous) !== canonicalJson(identity))
        await atomicJson(manifestPath, identity);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (options.expandFamily)
        throw new Error(
          "Family expansion requires an existing live OpenCode publication",
        );
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
      ...(options.artifactBundles ? { artifactBundles: true } : {}),
      directory: join(journal.directory, "artifacts"),
      ...(options.remoteArtifacts
        ? { remoteArtifacts: options.remoteArtifacts }
        : {}),
      roots,
      baseDirectory: imported?.artifactBaseDirectory ?? "/",
      secrets,
      serverOrigin: journal.identity.serverOrigin,
      streamId: journal.identity.streamId!,
      writeSecret: journal.identity.writeSecret,
      signal,
    });
    capture = await OpenCodeCapture.open(journal, secrets, artifacts);
    if (options.includeChildren)
      family = new OpenCodeFamilyCapture({
        journal,
        origin: nativeServerOrigin,
        root: nativeSessionId,
        secrets,
        artifacts,
        ...(options.nativePassword ? { password: options.nativePassword } : {}),
        ...(options.nativeUsername ? { username: options.nativeUsername } : {}),
      });
    options.onReady?.({
      streamId: journal.identity.streamId!,
      revision: journal.identity.revision!,
    });
    await observeOpenCodeSession({
      ...(options.finishRequested
        ? { finishRequested: options.finishRequested }
        : {}),
      serverOrigin: nativeServerOrigin,
      nativeSessionId,
      signal,
      ...(options.nativePassword ? { password: options.nativePassword } : {}),
      ...(options.nativeUsername ? { username: options.nativeUsername } : {}),
      ...(options.onNativeStatus ? { onStatus: options.onNativeStatus } : {}),
      commit: async (snapshot) => {
        await capture!.accept(snapshot, signal);
        await family?.reconcile(signal);
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
      try {
        await family?.close();
      } finally {
        await capture?.close();
      }
    } finally {
      try {
        await artifacts?.close();
      } finally {
        await journal.close();
      }
    }
  }
}
