import { opendir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { atomicJson } from "@agentlive/storage";
import { idSchema } from "@agentlive/protocol";
import {
  inspectClaudeHistory,
  createClaudeHistoryConsumer,
} from "./claude-history.js";
import { readJsonlSource, type SourceCursor } from "./jsonl.js";
import type { NativeFollowContext } from "./publish-native.js";

export function claudeFamilyFollower(
  sessionId: string,
  context: NativeFollowContext,
) {
  const directory = join(dirname(context.sourcePath), sessionId, "subagents");
  const logs = new Map<
    string,
    {
      cursor?: SourceCursor;
      committedOffset: number;
      consumer: Awaited<ReturnType<typeof createClaudeHistoryConsumer>>;
      dev: number;
      ino: number;
    }
  >();
  return async (finishing = false) => {
    let entries;
    try {
      entries = await opendir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && logs.size === 0)
        return;
      throw error;
    }
    const present = new Set<string>();
    let scanned = 0;
    for await (const entry of entries) {
      context.signal.throwIfAborted();
      if (++scanned > 10000)
        throw new Error("Claude subagent directory exceeds discovery limit");
      if (!entry.name.startsWith("agent-") || !entry.name.endsWith(".jsonl"))
        continue;
      if (!entry.isFile() || entry.isSymbolicLink())
        throw new Error("Claude subagent source must be a regular file");
      const agent = idSchema.parse(entry.name.slice(6, -6));
      present.add(agent);
      const path = join(directory, entry.name),
        info = await stat(path);
      const checkpoint = join(
        context.journal.directory,
        `claude-child-${createHash("sha256").update(agent).digest("hex")}.json`,
      );
      let retained = logs.get(agent);
      if (!retained) {
        if (logs.size >= 199)
          throw new Error("Claude family exceeds 199 subagent logs");
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
        const manifest = await inspectClaudeHistory(
          path,
          context.signal,
          "defer",
        );
        if (manifest.nativeSessionId !== sessionId)
          throw new Error("Claude subagent belongs to another session");
        retained = {
          committedOffset,
          dev: info.dev,
          ino: info.ino,
          consumer: await createClaudeHistoryConsumer(
            manifest,
            context.journal,
            context.secrets,
            context.artifacts.resolveInline,
            {
              childAgentId: agent,
              ...(context.artifacts.resolveRemote
                ? { resolveRemote: context.artifacts.resolveRemote }
                : {}),
            },
          ),
        };
        logs.set(agent, retained);
      }
      if (retained.dev !== info.dev || retained.ino !== info.ino)
        throw new Error("Claude subagent source was replaced");
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
          "Claude subagent has an incomplete final record; recovery required",
        );
    }
    for (const agent of logs.keys())
      if (!present.has(agent))
        throw new Error(
          "Captured Claude subagent log disappeared; recovery required",
        );
  };
}
