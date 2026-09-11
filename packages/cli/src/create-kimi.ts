import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { idSchema } from "@agentlive/protocol";
import { atomicJson } from "@agentlive/storage";
import {
  StdioRpc,
  selectNativeSession,
  inspectKimiHistory,
} from "@agentlive/adapters";

/** Create via ACP, preserving both its wire ID and the existing file-adapter ID. */
export async function createKimiSession(options: {
  cwd: string;
  stateDir: string;
  sourceRoot: string;
  serverOrigin: string;
  signal: AbortSignal;
}) {
  options.signal.throwIfAborted();
  const rpc = new StdioRpc({
    command: "kimi",
    args: ["acp"],
    cwd: options.cwd,
    onNotification: async () => {},
  });
  const abort = () => {
    void rpc.close();
  };
  options.signal.addEventListener("abort", abort, { once: true });
  try {
    if (options.signal.aborted) abort();
    const initialized = (await rpc.call("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "agentlive_managed_launch", version: "0.1.0" },
    })) as { protocolVersion?: unknown };
    if (initialized.protocolVersion !== 1)
      throw new Error("Unsupported Kimi ACP protocol version");
    const created = (await rpc.call("session/new", {
      cwd: options.cwd,
      mcpServers: [],
    })) as { sessionId?: unknown };
    const nativeProtocolId = idSchema.parse(created.sessionId);
    if (!/^session_[a-zA-Z0-9_-]+$/.test(nativeProtocolId))
      throw new Error("Kimi ACP returned an unsupported session identity");
    const nativeSessionId = idSchema.parse(nativeProtocolId.slice(8));
    const directory = join(options.stateDir, "launches");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await atomicJson(join(directory, `${nativeSessionId}.json`), {
      version: 1,
      agent: "kimi",
      nativeSessionId,
      nativeProtocolId,
      cwd: options.cwd,
      sourceRoot: options.sourceRoot,
      serverOrigin: options.serverOrigin,
      createdAt: new Date().toISOString(),
    });
    await rpc.close();
    options.signal.throwIfAborted();
    const candidate = await selectNativeSession({
      agent: "kimi",
      root: options.sourceRoot,
      nativeSessionId,
      nativeAgent: "main",
      signal: options.signal,
    });
    if (!candidate.source)
      throw new Error(
        "Created Kimi session has no main wire source; native identity was saved for recovery",
      );
    const manifest = await inspectKimiHistory(
      candidate.source,
      options.signal,
      undefined,
      "defer",
    );
    if (
      manifest.nativeSessionId !== nativeSessionId ||
      manifest.agentId !== "main"
    )
      throw new Error("Created Kimi source does not match its native identity");
    return { nativeSessionId, nativeProtocolId, sourcePath: candidate.source };
  } finally {
    options.signal.removeEventListener("abort", abort);
    await rpc.close();
  }
}
