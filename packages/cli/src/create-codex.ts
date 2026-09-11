import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { idSchema } from "@agentlive/protocol";
import { atomicJson } from "@agentlive/storage";
import { StdioRpc, inspectCodexHistory } from "@agentlive/adapters";

/** Create an identified durable native thread without submitting a model turn. */
export async function createCodexSession(options: {
  cwd: string;
  stateDir: string;
  serverOrigin: string;
  signal: AbortSignal;
  title?: string;
}) {
  options.signal.throwIfAborted();
  const rpc = new StdioRpc({
    command: "codex",
    args: ["app-server"],
    cwd: options.cwd,
    onNotification: async () => {},
  });
  const abort = () => {
    void rpc.close();
  };
  options.signal.addEventListener("abort", abort, { once: true });
  try {
    if (options.signal.aborted) abort();
    await rpc.call("initialize", {
      clientInfo: { name: "agentlive_managed_launch", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    rpc.notify("initialized");
    const response = (await rpc.call("thread/start", {
      cwd: options.cwd,
      ephemeral: false,
      // File capture requires the rollout history contract. Paginated threads
      // can return a path without materializing a resumable rollout here.
      historyMode: "legacy",
    })) as { thread?: { id?: unknown; sessionId?: unknown; path?: unknown } };
    const id = idSchema.parse(response.thread?.id);
    if (response.thread?.sessionId != null && response.thread.sessionId !== id)
      throw new Error(
        "New Codex thread returned a different logical session identity",
      );
    const directory = join(options.stateDir, "launches");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await atomicJson(join(directory, `${id}.json`), {
      version: 1,
      agent: "codex",
      nativeSessionId: id,
      cwd: options.cwd,
      serverOrigin: options.serverOrigin,
      createdAt: new Date().toISOString(),
    });
    if (typeof response.thread?.path !== "string" || !response.thread.path)
      throw new Error(
        "Codex did not return a durable rollout path; native identity was saved for recovery",
      );
    // Naming materializes an empty legacy thread without submitting inference.
    // Save identity first so failures can be diagnosed/recovered explicitly.
    await rpc.call("thread/name/set", {
      threadId: id,
      name: options.title ?? "AgentLive session",
    });
    await rpc.close();
    options.signal.throwIfAborted();
    const sourcePath = resolve(response.thread.path);
    const manifest = await inspectCodexHistory(
      sourcePath,
      options.signal,
      "defer",
    );
    if (
      manifest.nativeSessionId !== id ||
      !manifest.nativeThreadIds.includes(id)
    )
      throw new Error(
        "Created Codex rollout does not match its native identity",
      );
    return { nativeSessionId: id, sourcePath };
  } finally {
    options.signal.removeEventListener("abort", abort);
    await rpc.close();
  }
}
