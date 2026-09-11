import {
  publishCodexRecording,
  type CodexPublishOptions,
} from "@agentlive/adapters";
import { createCodexSession } from "./create-codex.js";
import { managedFileResume } from "./managed-launch.js";

export async function launchNewCodex(
  options: Omit<CodexPublishOptions, "sourcePath" | "resumeImport"> & {
    stateDir: string;
    cwd: string;
    sourceRoot: string;
    includeChildren?: boolean;
    onLaunch: (event: { nativeSessionId: string; status: string }) => void;
  },
): Promise<number> {
  const created = await createCodexSession(options);
  options.onLaunch({
    ...created,
    status: "native-identity-saved; source-identified",
  });
  return managedFileResume({
    agent: "codex",
    ...created,
    cooperativeDrain: true,
    cwd: options.cwd,
    signal: options.signal,
    onStatus: (status) =>
      options.onLaunch({ nativeSessionId: created.nativeSessionId, status }),
    publish: async ({ nativeExited: _nativeExited, ...hooks }) => {
      await publishCodexRecording({
        ...options,
        sourcePath: created.sourcePath,
        ...(options.includeChildren ? { familyRoot: options.sourceRoot } : {}),
        ...hooks,
      });
    },
  });
}
