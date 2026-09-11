import { open, opendir } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { idSchema } from "@agentlive/protocol";
import { originOf, request } from "@agentlive/client/transport";
export type DiscoveryAgent = "codex" | "claude" | "kimi" | "opencode";
export interface NativeSessionCandidate {
  agent: DiscoveryAgent;
  nativeSessionId: string;
  source?: string;
  nativeServer?: string;
  nativeAgent?: string;
  parentNativeSessionId?: string;
  nativeThreadId?: string;
  parentNativeThreadId?: string;
  modifiedAt: string;
  captureMode: "file-follow" | "snapshot-reconciliation";
}
const identity = (value: unknown) =>
  idSchema.safeParse(value).success ? (value as string) : undefined;
/** Metadata discovery only; normal import/publish still validates the complete source. */
export async function discoverNativeSessions(options: {
  agent: DiscoveryAgent;
  root?: string;
  nativeServer?: string;
  password?: string;
  username?: string;
  limit?: number;
  nativeSessionId?: string;
  rootSessionOnly?: boolean;
  parentNativeSessionId?: string;
  nativeAgent?: string;
  signal: AbortSignal;
  fetch?: typeof fetch;
}) {
  options.signal.throwIfAborted();
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    throw new RangeError("Discovery limit must be 1..200");
  if (options.nativeSessionId) idSchema.parse(options.nativeSessionId);
  if (options.parentNativeSessionId) {
    idSchema.parse(options.parentNativeSessionId);
    if (options.agent !== "opencode")
      throw new Error("Parent-session discovery applies only to OpenCode");
  }
  if (options.nativeAgent) {
    idSchema.parse(options.nativeAgent);
    if (options.agent !== "kimi")
      throw new Error("Native agent selection applies only to Kimi");
  }
  const sessions: NativeSessionCandidate[] = [];
  let scanned = 0,
    skipped = 0,
    truncated = false;
  const add = (candidate: NativeSessionCandidate) => {
    if (
      options.rootSessionOnly &&
      options.agent === "claude" &&
      candidate.nativeAgent
    )
      return;
    if (
      options.rootSessionOnly &&
      options.agent === "codex" &&
      candidate.nativeThreadId !== candidate.nativeSessionId
    )
      return;
    if (options.nativeAgent && candidate.nativeAgent !== options.nativeAgent)
      return;
    if (
      options.nativeSessionId &&
      candidate.nativeSessionId !== options.nativeSessionId
    )
      return;
    sessions.push(candidate);
    sessions.sort(
      (a, b) =>
        b.modifiedAt.localeCompare(a.modifiedAt) ||
        (a.source ?? a.nativeSessionId).localeCompare(
          b.source ?? b.nativeSessionId,
        ),
    );
    if (sessions.length > limit) {
      sessions.pop();
      truncated = true;
    }
  };
  if (options.agent === "opencode") {
    if (!options.nativeServer || options.root)
      throw new Error(
        "OpenCode discovery requires --native-server, without a source root",
      );
    const origin = originOf(options.nativeServer);
    const headers = options.password
      ? {
          authorization: `Basic ${Buffer.from(`${options.username ?? "opencode"}:${options.password}`).toString("base64")}`,
        }
      : {};
    const { text } = await request(
      options.fetch ?? fetch,
      options.parentNativeSessionId
        ? `${origin}/session/${encodeURIComponent(options.parentNativeSessionId)}/children`
        : `${origin}/session?limit=${limit + 1}`,
      { headers },
      options.signal,
      1024 * 1024,
    );
    const rows: unknown = JSON.parse(text);
    if (!Array.isArray(rows) || rows.length > 10000)
      throw new Error("Invalid OpenCode session listing");
    for (const row of rows) {
      options.signal.throwIfAborted();
      scanned++;
      const id = identity(row?.id);
      const parent = identity(row?.parentID);
      if (
        options.parentNativeSessionId &&
        (!id || parent !== options.parentNativeSessionId || id === parent)
      )
        throw new Error(
          "OpenCode children listing contains an invalid parent relationship",
        );
      const updated = row?.time?.updated ?? row?.time?.created;
      if (
        !id ||
        (row?.parentID !== undefined && (!parent || parent === id)) ||
        !Number.isSafeInteger(updated) ||
        updated < 0 ||
        !Number.isFinite(new Date(updated).getTime())
      ) {
        skipped++;
        continue;
      }
      add({
        agent: "opencode",
        nativeSessionId: id,
        ...(parent ? { parentNativeSessionId: parent } : {}),
        nativeServer: origin,
        modifiedAt: new Date(updated).toISOString(),
        captureMode: "snapshot-reconciliation",
      });
    }
    return { sessions, scanned, skipped, truncated, root: origin };
  }
  if (!options.root || options.nativeServer)
    throw new Error("File discovery requires a source root");
  const root = resolve(options.root);
  const visit = async (directory: string, depth: number): Promise<void> => {
    options.signal.throwIfAborted();
    let entries;
    try {
      entries = await opendir(directory);
    } catch (error) {
      if (
        directory === root &&
        (error as NodeJS.ErrnoException).code !== "ENOENT"
      )
        throw error;
      skipped++;
      return;
    }
    for await (const entry of entries) {
      options.signal.throwIfAborted();
      if (++scanned > 10000) {
        truncated = true;
        break;
      }
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        skipped++;
        continue;
      }
      if (entry.isDirectory()) {
        if (depth >= 8) {
          truncated = true;
          continue;
        }
        await visit(path, depth + 1);
        if (scanned > 10000) break;
        continue;
      }
      if (
        !entry.isFile() ||
        (options.agent === "kimi"
          ? entry.name !== "wire.jsonl"
          : !entry.name.endsWith(".jsonl"))
      )
        continue;
      const file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      ).catch(() => undefined);
      if (!file) {
        skipped++;
        continue;
      }
      try {
        const info = await file.stat();
        if (!info.isFile()) {
          skipped++;
          continue;
        }
        const prefix = Buffer.alloc(Math.min(info.size, 256 * 1024));
        let bytesRead = 0;
        while (bytesRead < prefix.length) {
          options.signal.throwIfAborted();
          const read = await file.read(
            prefix,
            bytesRead,
            prefix.length - bytesRead,
            bytesRead,
          );
          if (read.bytesRead === 0) break;
          bytesRead += read.bytesRead;
        }
        const lines = prefix
          .subarray(0, bytesRead)
          .toString("utf8")
          .split("\n");
        if (bytesRead < info.size) lines.pop();
        let id: string | undefined, nativeAgent: string | undefined;
        let nativeThreadId: string | undefined,
          parentNativeThreadId: string | undefined;
        for (const line of lines.slice(0, 128)) {
          let row: any;
          try {
            row = JSON.parse(line);
          } catch {
            continue;
          }
          if (options.agent === "codex" && row?.type === "session_meta") {
            id = identity(row.payload?.session_id ?? row.payload?.id);
            nativeThreadId = identity(row.payload?.id);
            parentNativeThreadId = identity(row.payload?.parent_thread_id);
            if (
              !nativeThreadId ||
              (row.payload?.parent_thread_id != null &&
                (!parentNativeThreadId ||
                  parentNativeThreadId === nativeThreadId))
            )
              id = undefined;
          }
          if (options.agent === "claude") {
            id = identity(row?.sessionId);
            if (row?.isSidechain === true) {
              nativeAgent = identity(row.agentId);
              if (!nativeAgent) id = undefined;
            }
          }
          if (options.agent === "kimi" && typeof row?.type === "string") {
            const component = path
              .split(/[\\/]/)
              .findLast((part) => /^session_[a-zA-Z0-9_-]+$/.test(part));
            id = identity(component?.slice(8));
            nativeAgent = identity(basename(dirname(path)));
          }
          if (id) break;
        }
        if (!id) {
          skipped++;
          continue;
        }
        add({
          agent: options.agent,
          nativeSessionId: id,
          source: path,
          ...(nativeAgent ? { nativeAgent } : {}),
          ...(nativeThreadId ? { nativeThreadId } : {}),
          ...(parentNativeThreadId ? { parentNativeThreadId } : {}),
          modifiedAt: info.mtime.toISOString(),
          captureMode: "file-follow",
        });
      } finally {
        await file.close();
      }
    }
  };
  await visit(root, 0);
  return { sessions, scanned, skipped, truncated, root };
}

/** Resolve an explicit identity only when the complete bounded scan is unambiguous. */
export async function selectNativeSession(
  options: Parameters<typeof discoverNativeSessions>[0] & {
    nativeSessionId: string;
  },
) {
  const result = await discoverNativeSessions({
    ...options,
    rootSessionOnly: options.agent === "claude" || options.agent === "codex",
    limit: 2,
  });
  if (result.truncated)
    throw new Error(
      "Native discovery was truncated; narrow --source-root or specify --source",
    );
  if (result.sessions.length === 0)
    throw new Error("Native session not found in the discovery root");
  if (result.sessions.length !== 1)
    throw new Error(
      "Native session has multiple histories; specify --source or narrow --source-root/--native-agent",
    );
  return result.sessions[0]!;
}
