import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { atomicJson } from "@agentlive/storage";
import { discoverNativeSessions } from "./discovery.js";
import {
  inspectCodexHistory,
  createCodexHistoryConsumer,
} from "./codex-history.js";
import { CodexCapture } from "./codex.js";
import { readJsonlSource, type SourceCursor } from "./jsonl.js";
import type { NativeFollowContext } from "./publish-native.js";

/** Discover a bounded explicit family and validate every path to its root. */
export async function discoverCodexFamily(
  root: string,
  sessionId: string,
  sourcePath: string,
  signal: AbortSignal,
) {
  const result = await discoverNativeSessions({
    agent: "codex",
    root,
    nativeSessionId: sessionId,
    limit: 200,
    signal,
  });
  if (result.truncated || result.skipped)
    throw new Error(
      "Codex family discovery is incomplete; narrow the source root or repair skipped sources",
    );
  const threads = new Map<string, (typeof result.sessions)[number]>();
  for (const candidate of result.sessions) {
    if (!candidate.nativeThreadId || threads.has(candidate.nativeThreadId))
      throw new Error("Codex family has ambiguous thread histories");
    threads.set(candidate.nativeThreadId, candidate);
  }
  if (threads.get(sessionId)?.source !== resolve(sourcePath))
    throw new Error("Codex family root does not match the selected rollout");
  for (const [thread, candidate] of threads) {
    if (thread === sessionId) continue;
    const visited = new Set([thread]);
    let parent = candidate.parentNativeThreadId;
    while (parent !== sessionId) {
      if (!parent || visited.has(parent) || visited.size >= 8)
        throw new Error(
          "Codex family has missing, cyclic or excessively deep lineage",
        );
      visited.add(parent);
      parent = threads.get(parent)?.parentNativeThreadId;
    }
  }
  return threads;
}

/** Follow only explicitly related threads in the same logical Codex session. */
export function codexFamilyFollower(
  root: string,
  sessionId: string,
  context: NativeFollowContext,
  format: "structured" | "legacy",
) {
  const logs = new Map<
    string,
    {
      path: string;
      parent: string;
      dev: number;
      ino: number;
      cursor?: SourceCursor;
      committedOffset: number;
      consumer: Awaited<ReturnType<typeof createCodexHistoryConsumer>>;
    }
  >();
  return async (finishing = false) => {
    const threads = await discoverCodexFamily(
      root,
      sessionId,
      context.sourcePath,
      context.signal,
    );
    for (const [thread, candidate] of threads) {
      if (thread === sessionId) continue;
      const path = candidate.source!,
        parent = candidate.parentNativeThreadId!;
      const info = await stat(path);
      const checkpoint = join(
        context.journal.directory,
        `codex-child-${createHash("sha256").update(thread).digest("hex")}.json`,
      );
      let retained = logs.get(thread);
      if (!retained) {
        if (logs.size >= 199)
          throw new Error("Codex family exceeds 199 retained child rollouts");
        let committedOffset = 0;
        try {
          const saved = JSON.parse(
            await readFile(checkpoint, "utf8"),
          ) as SourceCursor;
          for await (const _ of readJsonlSource(path, {
            after: saved,
            through: saved.offset,
            signal: context.signal,
          })) {
          }
          committedOffset = saved.offset;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const manifest = await inspectCodexHistory(
          path,
          context.signal,
          "defer",
        );
        if (
          manifest.nativeSessionId !== sessionId ||
          manifest.nativeThreadIds[0] !== thread ||
          manifest.nativeThreadParents?.[thread] !== parent
        )
          throw new Error("Codex child rollout has conflicting identity");
        const ancestors = new Set<string>();
        let ancestor: string | undefined = parent;
        while (ancestor) {
          ancestors.add(ancestor);
          if (ancestor === sessionId) break;
          ancestor = threads.get(ancestor)?.parentNativeThreadId;
        }
        if (
          manifest.nativeThreadIds.some(
            (id) => id !== thread && !ancestors.has(id),
          )
        )
          throw new Error(
            "Codex child rollout contains unrelated thread metadata",
          );
        if (format === "legacy" && manifest.nativeThreadIds.length > 1)
          throw new Error(
            "Mixed-thread legacy Codex history requires explicit reconciliation",
          );
        if (format === "legacy" && manifest.structuredItems)
          throw new Error(
            "Structured Codex child conflicts with legacy capture",
          );
        if (format === "structured")
          manifest.structuredItems = Math.max(1, manifest.structuredItems);
        const capture = new CodexCapture(
          context.journal,
          context.secrets,
          manifest.createdAt,
          context.artifacts.resolveArtifact,
          thread,
          context.artifacts,
        );
        retained = {
          committedOffset,
          path,
          parent,
          dev: info.dev,
          ino: info.ino,
          consumer: await createCodexHistoryConsumer(manifest, capture, {
            childThreadId: thread,
          }),
        };
        logs.set(thread, retained);
      }
      if (
        retained.path !== path ||
        retained.parent !== parent ||
        retained.dev !== info.dev ||
        retained.ino !== info.ino
      )
        throw new Error("Codex child rollout was replaced or reparented");
      for await (const record of readJsonlSource(path, {
        ...(retained.cursor ? { after: retained.cursor } : {}),
        through: info.size,
        tail: "defer",
        signal: context.signal,
      })) {
        await retained.consumer.accept(record);
        if (record.cursor.offset > retained.committedOffset) {
          await atomicJson(checkpoint, record.cursor);
          retained.committedOffset = record.cursor.offset;
        }
        retained.cursor = { ...record.cursor };
      }
      if (finishing && retained.cursor?.offset !== info.size)
        throw new Error(
          "Codex child rollout has an incomplete final record; recovery required",
        );
    }
    for (const thread of logs.keys())
      if (!threads.has(thread))
        throw new Error(
          "Captured Codex child rollout disappeared; recovery required",
        );
  };
}

/** Validate proposed import pointers against the same discovery used by live capture. */
export async function verifyCodexFamilySources(options: {
  root: string;
  nativeSessionId: string;
  sourcePath: string;
  children: readonly { nativeAgent: string; sourcePath: string }[];
  signal: AbortSignal;
}) {
  const threads = await discoverCodexFamily(
    options.root,
    options.nativeSessionId,
    options.sourcePath,
    options.signal,
  );
  for (const child of options.children) {
    const candidate = threads.get(child.nativeAgent);
    if (
      child.nativeAgent === options.nativeSessionId ||
      !candidate?.source ||
      resolve(child.sourcePath) !== candidate.source
    )
      throw new Error(
        "Relocated Codex child does not match native family discovery",
      );
    const manifest = await inspectCodexHistory(
      child.sourcePath,
      options.signal,
      "defer",
    );
    if (
      manifest.nativeSessionId !== options.nativeSessionId ||
      manifest.nativeThreadIds[0] !== child.nativeAgent ||
      manifest.nativeThreadParents?.[child.nativeAgent] !==
        candidate.parentNativeThreadId
    )
      throw new Error("Relocated Codex child identity or lineage differs");
    const ancestors = new Set<string>();
    let parent = candidate.parentNativeThreadId;
    while (parent) {
      ancestors.add(parent);
      if (parent === options.nativeSessionId) break;
      parent = threads.get(parent)?.parentNativeThreadId;
    }
    if (
      manifest.nativeThreadIds.some(
        (id) => id !== child.nativeAgent && !ancestors.has(id),
      )
    )
      throw new Error(
        "Relocated Codex child contains unrelated thread metadata",
      );
  }
}
