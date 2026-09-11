import { request } from "@agentlive/client/transport";
import { discoverNativeSessions } from "./discovery.js";
import { parseOpenCodeSnapshot } from "./opencode-history.js";
import { OpenCodeCapture } from "./opencode-capture.js";
import type { PublisherJournal } from "@agentlive/publisher";
import type { OpenCodeArtifactResolvers } from "./opencode-artifacts.js";

/** Serial family reconciliation shares one durable journal but isolates each native converter. */
export class OpenCodeFamilyCapture {
  private captures = new Map<
    string,
    { parent: string; capture: OpenCodeCapture }
  >();
  constructor(
    private readonly options: {
      journal: PublisherJournal;
      origin: string;
      root: string;
      secrets: readonly string[];
      password?: string;
      username?: string;
      artifacts?: OpenCodeArtifactResolvers;
    },
  ) {}
  async reconcile(signal: AbortSignal) {
    const options = this.options;
    const queue = [{ id: options.root, depth: 0 }];
    const seen = new Set([options.root]);
    const family: { id: string; parent: string }[] = [];
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index]!;
      const result = await discoverNativeSessions({
        agent: "opencode",
        nativeServer: options.origin,
        parentNativeSessionId: current.id,
        limit: 200,
        signal,
        ...(options.password ? { password: options.password } : {}),
        ...(options.username ? { username: options.username } : {}),
      });
      if (result.truncated || result.skipped)
        throw new Error(
          "OpenCode child discovery is incomplete; family capture requires reconciliation",
        );
      for (const child of result.sessions) {
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
    const headers = options.password
      ? {
          authorization: `Basic ${Buffer.from(`${options.username ?? "opencode"}:${options.password}`).toString("base64")}`,
        }
      : {};
    for (const child of family) {
      signal.throwIfAborted();
      const info = JSON.parse(
        (
          await request(
            fetch,
            `${options.origin}/session/${child.id}`,
            { headers },
            signal,
            1024 * 1024,
          )
        ).text,
      );
      const messages = JSON.parse(
        (
          await request(
            fetch,
            `${options.origin}/session/${child.id}/message`,
            { headers },
            signal,
            64 * 1024 * 1024,
          )
        ).text,
      );
      const snapshot = parseOpenCodeSnapshot({ info, messages });
      if (
        snapshot.info.id !== child.id ||
        snapshot.info.parentID !== child.parent
      )
        throw new Error(
          "OpenCode family source identity changed during reconciliation",
        );
      let retained = this.captures.get(child.id);
      if (retained && retained.parent !== child.parent)
        throw new Error("OpenCode child changed its parent");
      if (!retained) {
        if (this.captures.size >= 199)
          throw new Error("OpenCode retained family capture limit reached");
        retained = {
          parent: child.parent,
          capture: await OpenCodeCapture.open(
            options.journal,
            options.secrets,
            options.artifacts,
            { nativeSessionId: child.id, parentNativeSessionId: child.parent },
          ),
        };
        this.captures.set(child.id, retained);
      }
      await retained.capture.accept(snapshot, signal);
    }
  }
  async close() {
    const results = await Promise.allSettled(
      [...this.captures.values()].map(({ capture }) => capture.close()),
    );
    this.captures.clear();
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
}
