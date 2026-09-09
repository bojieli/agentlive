import { createHash } from "node:crypto";
import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  canonicalJson,
  contentSchema,
  type EventContent,
} from "@agentlive/protocol";
import { PublisherJournal, StreamingRedactor } from "@agentlive/publisher";
import { atomicJson, FileLock, syncDirectory } from "@agentlive/storage";
import {
  parseOpenCodeSnapshot,
  type OpenCodeSnapshot,
} from "./opencode-history.js";
import { chunkContent } from "./chunks.js";
const hash = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
const entitySchema = z.strictObject({
  generation: z.number().int().positive().safe(),
  identity: z.string(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  completed: z.boolean(),
  present: z.boolean(),
});
const stateSchema = z.strictObject({
  version: z.literal(1),
  nativeSessionId: z.string(),
  filterHash: z.string(),
  createdAt: z.number().int().nonnegative().optional(),
  elapsedMs: z.number().nonnegative(),
  entities: z.record(z.string(), entitySchema),
});
const intentSchema = z.strictObject({
  entityId: z.string().regex(/^[a-f0-9]{64}$/),
  next: entitySchema,
  time: z.number().int().nonnegative(),
  elapsedMs: z.number().nonnegative(),
  events: z.array(contentSchema),
});
async function readBounded(path: string, limit: number) {
  const info = await stat(path);
  if (!info.isFile() || info.size > limit)
    throw new Error("OpenCode capture checkpoint exceeds its limit");
  return JSON.parse(await readFile(path, "utf8"));
}
/** Converts mutable native snapshots into durably numbered per-entity revisions. No raw snapshots are persisted. */
export class OpenCodeCapture {
  private tail: Promise<unknown> = Promise.resolve();
  private failed = false;
  private closed = false;
  private constructor(
    private readonly journal: PublisherJournal,
    private readonly directory: string,
    private readonly lock: FileLock,
    private state: z.infer<typeof stateSchema>,
    private readonly secrets: readonly string[],
  ) {}
  static async open(
    journal: PublisherJournal,
    secrets: readonly string[] = [],
  ) {
    if (
      journal.identity.nativeAgent !== "opencode" ||
      !journal.identity.streamId
    )
      throw new Error("OpenCode capture requires a bound OpenCode publisher");
    const directory = join(journal.directory, "opencode-live");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lock = await FileLock.acquire(join(directory, "capture.lock"));
    try {
      const filterHash = hash([...new Set(secrets)].sort());
      let state: z.infer<typeof stateSchema>;
      try {
        state = stateSchema.parse(
          await readBounded(join(directory, "state.json"), 16 * 1024 * 1024),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (journal.capturedThrough > 0)
          throw new Error(
            "OpenCode capture state is missing for an existing publisher",
          );
        state = {
          version: 1,
          nativeSessionId: journal.identity.nativeSessionId,
          filterHash,
          elapsedMs: 0,
          entities: {},
        };
        await atomicJson(join(directory, "state.json"), state);
      }
      if (
        state.nativeSessionId !== journal.identity.nativeSessionId ||
        state.filterHash !== filterHash
      )
        throw new Error(
          "OpenCode capture identity or filtering policy changed",
        );
      const capture = new OpenCodeCapture(journal, directory, lock, state, [
        ...secrets,
      ]);
      await capture.recover();
      return capture;
    } catch (error) {
      await lock.release();
      throw error;
    }
  }
  private filter(text: string, complete: boolean) {
    const filter = new StreamingRedactor(this.secrets);
    const visible = filter.push(text);
    return complete ? visible + filter.finish() : visible;
  }
  private async recover() {
    let intent: z.infer<typeof intentSchema>;
    const path = join(this.directory, "pending.json");
    try {
      intent = intentSchema.parse(await readBounded(path, 64 * 1024 * 1024));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const previous = this.state.entities[intent.entityId];
    if (previous?.generation === intent.next.generation) {
      if (canonicalJson(previous) !== canonicalJson(intent.next))
        throw new Error("Conflicting OpenCode capture completion");
    } else {
      if ((previous?.generation ?? 0) + 1 !== intent.next.generation)
        throw new Error("OpenCode capture generation gap");
      for (const [index, content] of intent.events.entries())
        await this.journal.capture({
          sourceKey: `opencode-live/${intent.entityId}/${intent.next.generation}/${index}`,
          content: [content],
          observedAt: new Date(intent.time).toISOString(),
          clockSegmentId: `opencode_${hash(this.state.nativeSessionId)}`,
          elapsedMs: intent.elapsedMs,
          fidelity: "reconstructed",
          adapterState: { version: 1, agent: "opencode-live" },
        });
      const next = {
        ...this.state,
        elapsedMs: Math.max(this.state.elapsedMs, intent.elapsedMs),
        entities: { ...this.state.entities, [intent.entityId]: intent.next },
      };
      if (Buffer.byteLength(canonicalJson(next)) > 16 * 1024 * 1024)
        throw new Error("OpenCode capture state limit reached");
      await atomicJson(join(this.directory, "state.json"), next);
      this.state = next;
    }
    await unlink(path);
    await syncDirectory(this.directory);
  }
  private async revise(
    id: string,
    desired: unknown,
    complete: boolean,
    time: number,
    content: (
      previous: z.infer<typeof entitySchema> | undefined,
    ) => EventContent[],
    present = true,
    identity?: string,
  ) {
    const previous = this.state.entities[id];
    identity ??= previous?.identity ?? id;
    if (previous && previous.identity !== identity)
      throw new Error("OpenCode source object identity changed");
    const fingerprint = hash(desired);
    if (previous?.fingerprint === fingerprint && previous.present === present)
      return;
    if (!previous && Object.keys(this.state.entities).length >= 50000)
      throw new Error("OpenCode capture entity limit reached");
    const events = content(previous).flatMap(chunkContent);
    const intent = {
      entityId: id,
      next: {
        generation: (previous?.generation ?? 0) + 1,
        fingerprint,
        identity,
        completed: complete,
        present,
      },
      time,
      elapsedMs: Math.max(
        this.state.elapsedMs,
        time - (this.state.createdAt ?? time),
      ),
      events,
    };
    if (Buffer.byteLength(canonicalJson(intent)) > 64 * 1024 * 1024)
      throw new Error("OpenCode capture revision exceeds limit");
    await atomicJson(join(this.directory, "pending.json"), intent);
    await this.recover();
  }
  accept(input: OpenCodeSnapshot): Promise<void> {
    const serialized = canonicalJson(input);
    if (Buffer.byteLength(serialized) > 64 * 1024 * 1024)
      return Promise.reject(
        new Error("OpenCode snapshot exceeds capture limit"),
      );
    const snapshot = parseOpenCodeSnapshot(JSON.parse(serialized));
    const work = this.tail.then(async () => {
      if (this.failed || this.closed)
        throw new Error("OpenCode capture requires reopening");
      if (snapshot.info.id !== this.state.nativeSessionId)
        throw new Error("OpenCode snapshot belongs to another session");
      if (this.state.createdAt === undefined) {
        this.state = { ...this.state, createdAt: snapshot.info.time.created };
        await atomicJson(join(this.directory, "state.json"), this.state);
      } else if (this.state.createdAt !== snapshot.info.time.created)
        throw new Error("OpenCode native creation time changed");
      await this.convert(snapshot);
    });
    this.tail = work.catch(() => {
      this.failed = true;
    });
    return work;
  }
  private async convert(snapshot: OpenCodeSnapshot) {
    const sessionId = hash("session");
    const seen = new Set([sessionId]);
    const gap = (reason: string): EventContent => ({
      kind: "capture.gap",
      payload: { reason, recoveredState: false },
    });
    await this.revise(
      sessionId,
      "session",
      false,
      snapshot.info.time.created,
      () => [
        {
          kind: "session.started",
          payload: {
            agent: "opencode",
            nativeSessionId: snapshot.info.id,
            title: "OpenCode session",
          },
        },
      ],
    );
    for (const message of snapshot.messages) {
      const id = hash(message.info.id);
      seen.add(id);
      const complete =
        message.info.role === "user" ||
        message.info.time.completed !== undefined;
      const time = message.info.time.completed ?? message.info.time.created;
      const texts = message.parts
        .filter((part) => part.type === "text")
        .map((part) => z.string().parse(part.text));
      if (message.info.error) {
        const error = z
          .record(z.string(), z.unknown())
          .parse(message.info.error);
        const data =
          error.data && typeof error.data === "object"
            ? (error.data as Record<string, unknown>)
            : {};
        texts.push(
          typeof data.message === "string"
            ? data.message
            : typeof error.message === "string"
              ? error.message
              : "OpenCode source error (details unavailable)",
        );
      }
      const text = this.filter(texts.join("\n"), complete);
      await this.revise(
        id,
        { role: message.info.role, text, complete },
        complete,
        time,
        (previous) => [
          ...(!previous
            ? [
                {
                  kind: "message.started",
                  payload: { messageId: id, role: message.info.role },
                } as EventContent,
              ]
            : []),
          ...(previous?.completed && !complete
            ? [
                gap(
                  "OpenCode reopened a completed message; retained completion state requires reconciliation",
                ),
              ]
            : []),
          { kind: "message.reconciled", payload: { messageId: id, text } },
          ...(complete && !previous?.completed
            ? [
                {
                  kind: "message.completed",
                  payload: { messageId: id },
                } as EventContent,
              ]
            : []),
        ],
        true,
        hash({ kind: "message", role: message.info.role }),
      );
      for (const part of message.parts) {
        if (
          ["text", "reasoning", "step-start", "step-finish"].includes(part.type)
        )
          continue;
        const partId = hash(part.id);
        seen.add(partId);
        if (part.type === "tool") {
          const native = z.record(z.string(), z.unknown()).parse(part.state);
          const status = z
            .enum(["pending", "running", "completed", "error"])
            .parse(native.status);
          const finished = status === "completed" || status === "error";
          const name = this.filter(z.string().max(200).parse(part.tool), true);
          const input =
            status === "pending"
              ? ""
              : this.filter(canonicalJson(native.input ?? null), true);
          const output = finished
            ? this.filter(
                z
                  .string()
                  .parse(status === "error" ? native.error : native.output),
                true,
              )
            : "";
          await this.revise(
            partId,
            {
              name,
              input,
              output,
              status,
              attachments: hash(native.attachments ?? []),
            },
            finished,
            time,
            (previous) => [
              ...(!previous
                ? [
                    {
                      kind: "tool.started",
                      payload: { toolId: partId, name, input },
                    } as EventContent,
                  ]
                : [
                    {
                      kind: "tool.arguments.ready",
                      payload: { toolId: partId, input },
                    } as EventContent,
                  ]),
              ...(previous?.completed && !finished
                ? [
                    gap(
                      "OpenCode restarted a completed tool; retained terminal state requires reconciliation",
                    ),
                  ]
                : []),
              ...(finished
                ? [
                    {
                      kind: "tool.completed",
                      payload: {
                        toolId: partId,
                        status: status === "error" ? "failed" : "completed",
                        output,
                      },
                    } as EventContent,
                  ]
                : []),
              ...(Array.isArray(native.attachments) && native.attachments.length
                ? [gap("OpenCode tool attachments require artifact conversion")]
                : []),
            ],
            true,
            hash({ kind: "tool", owner: message.info.id, name: part.tool }),
          );
        } else
          await this.revise(
            partId,
            { type: part.type, sourceHash: hash(part) },
            false,
            time,
            () =>
              part.type === "file"
                ? [
                    {
                      kind: "attachment.pending",
                      payload: { artifactId: partId, filename: "attachment" },
                    },
                    {
                      kind: "attachment.unavailable",
                      payload: {
                        artifactId: partId,
                        reason:
                          "OpenCode file reference requires artifact conversion",
                      },
                    },
                  ]
                : [
                    gap(
                      this.filter(
                        `Unsupported OpenCode source object: ${part.type}`,
                        true,
                      ),
                    ),
                  ],
            true,
            hash({ kind: part.type, owner: message.info.id }),
          );
      }
    }
    for (const [id, previous] of Object.entries(this.state.entities))
      if (previous.present && !seen.has(id))
        await this.revise(
          id,
          { removed: true },
          previous.completed,
          snapshot.info.time.created,
          () => [
            gap(
              "OpenCode removed a previously captured object; its historical events remain retained",
            ),
          ],
          false,
        );
  }
  async close() {
    await this.tail;
    this.closed = true;
    await this.lock.release();
  }
}
