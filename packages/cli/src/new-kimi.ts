import {
  publishKimiRecording,
  type NativePublishOptions,
} from "@agentlive/adapters";
import { createKimiSession } from "./create-kimi.js";
import { managedFileResume } from "./managed-launch.js";
export async function launchNewKimi(
  options: Omit<NativePublishOptions, "sourcePath" | "resumeImport"> & {
    stateDir: string;
    cwd: string;
    sourceRoot: string;
    includeChildren?: boolean;
    onLaunch: (event: { nativeSessionId: string; status: string }) => void;
  },
): Promise<number> {
  const created = await createKimiSession(options);
  options.onLaunch({
    nativeSessionId: created.nativeSessionId,
    status: "native-identity-saved; source-identified",
  });
  return managedFileResume({
    agent: "kimi",
    nativeSessionId: created.nativeProtocolId,
    sourcePath: created.sourcePath,
    cwd: options.cwd,
    signal: options.signal,
    cooperativeDrain: true,
    onStatus: (status) =>
      options.onLaunch({ nativeSessionId: created.nativeSessionId, status }),
    publish: async ({ nativeExited: _nativeExited, ...hooks }) => {
      await publishKimiRecording({
        ...options,
        sourcePath: created.sourcePath,
        nativeIdentity: {
          nativeSessionId: created.nativeSessionId,
          agentId: "main",
        },
        ...hooks,
      });
    },
  });
}
