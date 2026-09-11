import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicJson } from "@agentlive/storage";
import { delay } from "@agentlive/client/transport";
import {
  discoverNativeSessions,
  inspectClaudeHistory,
  publishClaudeRecording,
  type NativePublishOptions,
} from "@agentlive/adapters";
import { managedFileResume } from "./managed-launch.js";

/** Allocate a native identity before launch; never infer it from cwd or recency. */
export async function launchNewClaude(
  options: Omit<NativePublishOptions, "sourcePath" | "resumeImport"> & {
    stateDir: string;
    includeChildren?: boolean;
    sourceRoot: string;
    cwd: string;
    onLaunch: (event: { nativeSessionId: string; status: string }) => void;
  },
): Promise<number> {
  const nativeSessionId = randomUUID();
  const directory = join(options.stateDir, "launches");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await atomicJson(join(directory, `${nativeSessionId}.json`), {
    version: 1,
    agent: "claude",
    nativeSessionId,
    cwd: options.cwd,
    sourceRoot: options.sourceRoot,
    serverOrigin: options.serverOrigin,
    createdAt: new Date().toISOString(),
  });
  let sourcePath: string | undefined;
  options.onLaunch({ nativeSessionId, status: "native-identity-saved" });
  return managedFileResume({
    agent: "claude",
    nativeSessionId,
    newSession: true,
    cooperativeDrain: true,
    sourcePath: () => sourcePath,
    cwd: options.cwd,
    signal: options.signal,
    onStatus: (status) => options.onLaunch({ nativeSessionId, status }),
    publish: async ({ nativeExited, ...hooks }) => {
      while (!sourcePath) {
        hooks.signal.throwIfAborted();
        const result = await discoverNativeSessions({
          agent: "claude",
          rootSessionOnly: true,
          root: options.sourceRoot,
          nativeSessionId,
          limit: 2,
          signal: hooks.signal,
        });
        if (result.truncated || result.sessions.length > 1)
          throw new Error(
            "Fresh Claude discovery is ambiguous or truncated; narrow --source-root and reattach using the saved native identity",
          );
        const candidate = result.sessions[0];
        if (candidate?.source) {
          try {
            const manifest = await inspectClaudeHistory(
              candidate.source,
              hooks.signal,
              "defer",
            );
            if (manifest.nativeSessionId !== nativeSessionId)
              throw new Error("Fresh Claude source identity changed");
            sourcePath = candidate.source;
          } catch (error) {
            if (
              !(error instanceof Error) ||
              error.message !==
                "Claude source lacks session identity or timestamp" ||
              nativeExited()
            )
              throw error;
          }
        }
        if (!sourcePath) {
          if (nativeExited())
            throw new Error(
              "Native Claude exited without a complete identified transcript; use the saved native identity to resume",
            );
          await delay(250, hooks.signal);
        }
      }
      options.onLaunch({
        nativeSessionId,
        status: "source-identified; capture=file-follow",
      });
      await publishClaudeRecording({ ...options, sourcePath, ...hooks });
    },
  });
}
