import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, idSchema } from "@agentlive/protocol";
import { originOf, request } from "@agentlive/client/transport";
import { discoverNativeSessions } from "./discovery.js";
import {
  parseOpenCodeSnapshot,
  type OpenCodeSnapshot,
} from "./opencode-history.js";

const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

export interface FrozenOpenCodeBoundary {
  offset: number;
  prefixHash: string;
}
export interface FrozenOpenCodeSession {
  nativeSessionId: string;
  parentNativeSessionId?: string;
  sourcePath: string;
  boundary: FrozenOpenCodeBoundary;
  snapshot: OpenCodeSnapshot;
}
export interface FrozenOpenCodeSource {
  directory: string;
  root: FrozenOpenCodeSession;
  children: FrozenOpenCodeSession[];
}
export interface OpenCodeNativeAccess {
  origin: string;
  nativeSessionId: string;
  password?: string;
  username?: string;
  includeChildren: boolean;
  signal: AbortSignal;
}

/** Deterministic per-session file name inside one frozen-source directory. */
export const frozenOpenCodePath = (
  directory: string,
  nativeSessionId: string,
) => join(directory, `${sha256(nativeSessionId)}.json`);

const basicHeaders = (access: OpenCodeNativeAccess) =>
  access.password
    ? {
        authorization: `Basic ${Buffer.from(
          `${access.username ?? "opencode"}:${access.password}`,
        ).toString("base64")}`,
      }
    : {};

/** Read one native session exactly as `opencode export` would present it. */
async function fetchSnapshot(access: OpenCodeNativeAccess, id: string) {
  const headers = basicHeaders(access);
  const origin = originOf(access.origin);
  const read = async (path: string, limit: number) =>
    JSON.parse(
      (
        await request(
          fetch,
          `${origin}/session/${encodeURIComponent(id)}${path}`,
          { headers },
          access.signal,
          limit,
        )
      ).text,
    );
  const snapshot = parseOpenCodeSnapshot({
    info: await read("", 1024 * 1024),
    messages: await read("/message", 64 * 1024 * 1024),
  });
  if (snapshot.info.id !== id)
    throw new Error("OpenCode returned a different native session");
  return snapshot;
}

/** Every descendant of the bound session, with its declared native parent. */
async function discoverFamily(access: OpenCodeNativeAccess) {
  const queue = [{ id: access.nativeSessionId, depth: 0 }];
  const seen = new Set([access.nativeSessionId]);
  const family: { id: string; parent: string }[] = [];
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index]!;
    const found = await discoverNativeSessions({
      agent: "opencode",
      nativeServer: access.origin,
      parentNativeSessionId: current.id,
      limit: 200,
      signal: access.signal,
      ...(access.password ? { password: access.password } : {}),
      ...(access.username ? { username: access.username } : {}),
    });
    if (found.truncated || found.skipped)
      throw new Error(
        "OpenCode child discovery is incomplete; a frozen family source requires reconciliation",
      );
    for (const child of found.sessions) {
      if (seen.has(child.nativeSessionId))
        throw new Error(
          "OpenCode family contains duplicate or cyclic session identity",
        );
      if (current.depth >= 8 || seen.size >= 200)
        throw new Error(
          "OpenCode family exceeds 200 sessions or eight descendant levels",
        );
      seen.add(child.nativeSessionId);
      family.push({ id: child.nativeSessionId, parent: current.id });
      queue.push({ id: child.nativeSessionId, depth: current.depth + 1 });
    }
  }
  return family;
}

/** Write canonical snapshot bytes under their own name; the directory holds nothing else. */
async function writeFrozen(
  directory: string,
  snapshot: OpenCodeSnapshot,
): Promise<FrozenOpenCodeSession> {
  const bytes = Buffer.from(canonicalJson(snapshot));
  if (bytes.length > 64 * 1024 * 1024)
    throw new Error("Frozen OpenCode source exceeds the 64 MiB import limit");
  const sourcePath = frozenOpenCodePath(directory, snapshot.info.id);
  const temporary = `${sourcePath}.partial`;
  await unlink(temporary).catch(() => {});
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, sourcePath);
  return {
    nativeSessionId: snapshot.info.id,
    ...(snapshot.info.parentID
      ? { parentNativeSessionId: snapshot.info.parentID }
      : {}),
    sourcePath,
    boundary: { offset: bytes.length, prefixHash: sha256(bytes) },
    snapshot,
  };
}

/**
 * Freeze an OpenCode live source by exporting the native server's current state for
 * the bound session (and, for a family binding, every discoverable descendant) into
 * immutable files. The bytes are what the historical importer consumes, so a frozen
 * live source and a hand-made `opencode export` are the same kind of input.
 */
export async function freezeOpenCodeSource(
  access: OpenCodeNativeAccess,
  directory: string,
): Promise<FrozenOpenCodeSource> {
  idSchema.parse(access.nativeSessionId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = await writeFrozen(
    directory,
    await fetchSnapshot(access, access.nativeSessionId),
  );
  const children: FrozenOpenCodeSession[] = [];
  if (access.includeChildren)
    for (const child of await discoverFamily(access)) {
      const snapshot = await fetchSnapshot(access, child.id);
      if (snapshot.info.parentID !== child.parent)
        throw new Error(
          "OpenCode family source identity changed while freezing",
        );
      children.push(await writeFrozen(directory, snapshot));
    }
  children.sort((a, b) => a.nativeSessionId.localeCompare(b.nativeSessionId));
  return { directory, root, children };
}

/**
 * Re-read a frozen file and confirm it still holds exactly the pinned bytes. Retries
 * of a saved migration convert these bytes, never a fresh native read.
 */
export async function readFrozenOpenCodeSession(
  sourcePath: string,
  boundary: FrozenOpenCodeBoundary,
): Promise<OpenCodeSnapshot> {
  const info = await stat(sourcePath);
  if (!info.isFile() || info.size !== boundary.offset)
    throw new Error("Frozen OpenCode source changed since the migration began");
  const bytes = await readFile(sourcePath);
  if (bytes.length !== boundary.offset || sha256(bytes) !== boundary.prefixHash)
    throw new Error("Frozen OpenCode source changed since the migration began");
  return parseOpenCodeSnapshot(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
}

/**
 * Restore one missing frozen file from the native server. Only bytes identical to the
 * pinned boundary are accepted, so a session that moved on cannot change the target.
 */
export async function refreezeOpenCodeSession(
  access: OpenCodeNativeAccess,
  directory: string,
  nativeSessionId: string,
  boundary: FrozenOpenCodeBoundary,
) {
  const snapshot = await fetchSnapshot(
    { ...access, nativeSessionId },
    nativeSessionId,
  );
  const bytes = Buffer.from(canonicalJson(snapshot));
  if (bytes.length !== boundary.offset || sha256(bytes) !== boundary.prefixHash)
    throw new Error(
      "The OpenCode server no longer returns the frozen source this migration pinned",
    );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return writeFrozen(directory, snapshot);
}
