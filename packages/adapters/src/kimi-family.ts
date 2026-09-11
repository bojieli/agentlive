import { basename, dirname, join, resolve } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { atomicJson } from "@agentlive/storage";
import { discoverNativeSessions } from "./discovery.js";
import {
  createKimiHistoryConsumer,
  inspectKimiHistory,
} from "./kimi-history.js";
import { readJsonlSource, type SourceCursor } from "./jsonl.js";
import type { NativeFollowContext } from "./publish-native.js";

export function kimiFamilyRoot(source: string, sessionId: string) {
  const path = resolve(source);
  const agents = dirname(dirname(path));
  const root = dirname(agents);
  if (
    basename(path) !== "wire.jsonl" ||
    basename(dirname(path)) !== "main" ||
    basename(agents) !== "agents" ||
    basename(root) !== `session_${sessionId}`
  )
    throw new Error(
      "Kimi family capture requires session_<id>/agents/main/wire.jsonl",
    );
  return root;
}

/** Reconstruct each converter on restart; verify its durable source prefix before replay. */
export function kimiFamilyFollower(
  root: string,
  sessionId: string,
  context: NativeFollowContext,
) {
  const logs = new Map<
    string,
    {
      consumer: Awaited<ReturnType<typeof createKimiHistoryConsumer>>;
      cursor?: SourceCursor;
      committedOffset: number;
      dev: number;
      ino: number;
      path: string;
    }
  >();
  return async (finishing = false) => {
    const found = await discoverNativeSessions({
      agent: "kimi",
      root,
      nativeSessionId: sessionId,
      limit: 200,
      signal: context.signal,
    });
    if (found.truncated || found.skipped)
      throw new Error(
        "Kimi family discovery is incomplete; resolve skipped logs before capture",
      );
    const present = new Set<string>();
    for (const candidate of found.sessions) {
      const path = candidate.source!,
        agent = candidate.nativeAgent;
      if (!agent || path !== join(root, "agents", agent, "wire.jsonl"))
        throw new Error("Kimi family contains an unexpected agent log layout");
      if (present.has(agent))
        throw new Error("Kimi family contains duplicate agent identity");
      present.add(agent);
      if (agent === "main") continue;
      const info = await stat(path);
      const checkpoint = join(
        context.journal.directory,
        `kimi-child-${createHash("sha256").update(agent).digest("hex")}.json`,
      );
      let retained = logs.get(agent);
      if (!retained) {
        if (logs.size >= 199)
          throw new Error("Kimi family exceeds 199 child logs");
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
            /* Verify before emitting any reconstructed effects. */
          }
          committedOffset = saved.offset;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const manifest = await inspectKimiHistory(
          path,
          context.signal,
          undefined,
          "defer",
        );
        if (
          manifest.nativeSessionId !== sessionId ||
          manifest.agentId !== agent
        )
          throw new Error("Kimi child source identity changed");
        retained = {
          committedOffset,
          consumer: await createKimiHistoryConsumer(
            manifest,
            context.journal,
            context.secrets,
            context.artifacts.resolveArtifact,
            { childLog: true, mediaResolvers: context.artifacts },
          ),
          dev: info.dev,
          ino: info.ino,
          path,
        };
        logs.set(agent, retained);
      }
      if (
        retained.dev !== info.dev ||
        retained.ino !== info.ino ||
        retained.path !== path
      )
        throw new Error("Kimi child log was replaced");
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
          "Kimi child log has an incomplete final record; recovery required",
        );
    }
    if (!present.has("main"))
      throw new Error("Kimi family main log disappeared");
    for (const agent of logs.keys())
      if (!present.has(agent))
        throw new Error(
          "Kimi captured child log disappeared; recovery required",
        );
  };
}
