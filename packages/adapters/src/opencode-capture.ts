import { visibleOpenCodeSnapshot } from "./opencode-history.js";
import {
  openCodeFileEvents,
  openCodeFileDescriptor,
  type OpenCodeArtifactResolvers,
} from "./opencode-artifacts.js";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  canonicalJson,
  idSchema,
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
import { openCodeLineage, openCodeAgentId } from "./opencode-lineage.js";
const hash = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
const entitySchema = z.strictObject({
  objectType: z.enum(["message", "tool", "attachment"]).optional(),
  generation: z.number().int().positive().safe(),
  availableVersions: z.array(z.number().int().positive()).default([]),
  identity: z.string(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  completed: z.boolean(),
  present: z.boolean(),
});
const stateSchema = z.strictObject({
  version: z.literal(1),
  lifecycleVersion: z.literal(1).optional(),
  presentationVersion: z.literal(1).optional(),
  attachmentEncodingVersion: z.literal(2).optional(),
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
/**
 * Every converter entity identity a visible snapshot produces, in one place so that
 * `convert` (which decides what disappeared) and live-binding migration (which checks
 * that a frozen source still covers everything a binding captured) cannot drift apart.
 * Malformed tool state yields no attachment identities; `convert` rejects it instead.
 */
export function openCodeEntityIds(
  snapshot: OpenCodeSnapshot,
  child?: { nativeSessionId: string },
): Set<string> {
  const entityId = (value: unknown) =>
    child ? hash({ child: child.nativeSessionId, entity: value }) : hash(value);
  const ids = new Set<string>([entityId("session")]);
  if (snapshot.info.parentID) ids.add(entityId("session-lineage"));
  for (const message of snapshot.messages) {
    ids.add(entityId(message.info.id));
    for (const part of message.parts) {
      if (
        ["text", "reasoning", "step-start", "step-finish"].includes(part.type)
      )
        continue;
      ids.add(entityId(part.id));
      if (part.type !== "tool") continue;
      const state = part.state;
      const attachments =
        state && typeof state === "object"
          ? (state as { attachments?: unknown }).attachments
          : undefined;
      if (!Array.isArray(attachments)) continue;
      for (const [index, value] of attachments.entries()) {
        const id =
          value && typeof value === "object"
            ? (value as { id?: unknown }).id
            : undefined;
        ids.add(
          entityId({
            tool: part.id,
            attachment: typeof id === "string" ? id : index,
          }),
        );
      }
    }
  }
  return ids;
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
    private readonly artifacts?: OpenCodeArtifactResolvers,
    private readonly child?: {
      nativeSessionId: string;
      parentNativeSessionId: string;
    },
  ) {}
  static async open(
    journal: PublisherJournal,
    secrets: readonly string[] = [],
    artifacts?: OpenCodeArtifactResolvers,
    child?: { nativeSessionId: string; parentNativeSessionId: string },
  ) {
    // The remote recording may not exist yet: capture is journaled with a
    // placeholder stream identity and bound when the server first answers.
    if (journal.identity.nativeAgent !== "opencode")
      throw new Error("OpenCode capture requires an OpenCode publisher");
    if (child) {
      idSchema.parse(child.nativeSessionId);
      idSchema.parse(child.parentNativeSessionId);
      if (
        child.nativeSessionId === journal.identity.nativeSessionId ||
        child.nativeSessionId === child.parentNativeSessionId
      )
        throw new Error("Invalid OpenCode child capture identity");
      child = { ...child };
    }
    const nativeSessionId =
      child?.nativeSessionId ?? journal.identity.nativeSessionId;
    const directory = child
      ? join(journal.directory, "opencode-children", hash(nativeSessionId))
      : join(journal.directory, "opencode-live");
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
        if (journal.capturedThrough > 0) {
          let captured = !child;
          if (child)
            for await (const event of journal.pending(0)) {
              if (
                event.clockSegmentId === `opencode_${hash(nativeSessionId)}`
              ) {
                captured = true;
                break;
              }
            }
          if (captured)
            throw new Error(
              "OpenCode capture state is missing for an existing publisher",
            );
        }
        state = {
          version: 1,
          lifecycleVersion: 1,
          presentationVersion: 1,
          attachmentEncodingVersion: 2,
          nativeSessionId,
          filterHash,
          elapsedMs: 0,
          entities: {},
        };
        await atomicJson(join(directory, "state.json"), state);
      }
      if (
        state.nativeSessionId !== nativeSessionId ||
        state.filterHash !== filterHash
      )
        throw new Error(
          "OpenCode capture identity or filtering policy changed",
        );
      const capture = new OpenCodeCapture(
        journal,
        directory,
        lock,
        state,
        [...secrets],
        artifacts,
        child,
      );
      await capture.recover();
      await capture.upgradeLifecycle();
      await capture.upgradeAttachmentEncoding();
      return capture;
    } catch (error) {
      await lock.release();
      throw error;
    }
  }
  private async upgradeAttachmentEncoding() {
    if (this.state.attachmentEncodingVersion === 2) return;
    const entities = { ...this.state.entities };
    for (const [id, entity] of Object.entries(entities)) {
      if (
        entity.objectType === "attachment" &&
        !entity.availableVersions.length
      )
        entities[id] = {
          ...entity,
          fingerprint: hash({
            previous: entity.fingerprint,
            attachmentEncodingVersion: 2,
          }),
        };
    }
    const next = {
      ...this.state,
      attachmentEncodingVersion: 2 as const,
      entities,
    };
    if (Buffer.byteLength(canonicalJson(next)) > 16 * 1024 * 1024)
      throw new Error("OpenCode capture state limit reached during migration");
    await atomicJson(join(this.directory, "state.json"), next);
    this.state = next;
  }
  private async upgradeLifecycle() {
    if (
      this.state.lifecycleVersion === 1 &&
      this.state.presentationVersion === 1
    )
      return;
    const entities = { ...this.state.entities };
    const seen = new Set<string>();
    for await (const event of this.journal.pending(0)) {
      const content = event.content;
      let id: string | undefined;
      let completed: boolean | undefined;
      let objectType: "message" | "tool" | "attachment" | undefined;
      let present: boolean | undefined;
      if (
        ["message.started", "message.completed", "message.reopened"].includes(
          content.kind,
        )
      ) {
        id = (content.payload as { messageId: string }).messageId;
        completed = content.kind === "message.completed";
        objectType = "message";
        if (content.kind === "message.started") present = true;
      } else if (
        ["tool.started", "tool.completed", "tool.reopened"].includes(
          content.kind,
        )
      ) {
        id = (content.payload as { toolId: string }).toolId;
        completed = content.kind === "tool.completed";
        objectType = "tool";
        if (content.kind === "tool.started") present = true;
      }
      if (
        content.kind === "attachment.pending" ||
        content.kind === "attachment.available"
      ) {
        id =
          content.kind === "attachment.pending"
            ? content.payload.artifactId
            : content.payload.attachment.artifactId;
        objectType = "attachment";
        if (!seen.has(id)) present = true;
      } else if (content.kind === "object.visibility") {
        id = content.payload.objectId;
        objectType = content.payload.objectType;
        present = content.payload.visible;
      }
      if (id && entities[id]) {
        entities[id] = {
          ...entities[id]!,
          ...(completed === undefined ? {} : { completed }),
          ...(present === undefined ? {} : { present }),
          ...(objectType ? { objectType } : {}),
        };
        seen.add(id);
      }
    }
    const next = {
      ...this.state,
      lifecycleVersion: 1 as const,
      presentationVersion: 1 as const,
      entities,
    };
    await atomicJson(join(this.directory, "state.json"), next);
    this.state = next;
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
    ) => EventContent[] | Promise<EventContent[]>,
    present = true,
    identity?: string,
  ) {
    const previous = this.state.entities[id];
    identity ??= previous?.identity ?? id;
    if (previous && previous.identity !== identity)
      throw new Error("OpenCode source object identity changed");
    const fingerprint = hash(desired);
    if (
      previous?.fingerprint === fingerprint &&
      previous.present === present &&
      previous.completed === complete
    )
      return;
    if (!previous && Object.keys(this.state.entities).length >= 50000)
      throw new Error("OpenCode capture entity limit reached");
    const raw = await content(previous);
    let objectType = previous?.objectType;
    if (!objectType)
      for (const event of raw) {
        if (event.kind === "message.started") objectType = "message";
        else if (event.kind === "tool.started") objectType = "tool";
        else if (event.kind === "attachment.pending") objectType = "attachment";
      }
    if (previous && !previous.present && present && objectType)
      raw.unshift({
        kind: "object.visibility",
        payload: { objectType, objectId: id, visible: true },
      });
    const repeated = new Set(
      raw
        .filter(
          (event) =>
            event.kind === "attachment.available" &&
            previous?.availableVersions.includes(
              event.payload.attachment.version,
            ),
        )
        .map(
          (event) =>
            (event as Extract<EventContent, { kind: "attachment.available" }>)
              .payload.attachment.artifactId,
        ),
    );
    const events = raw
      .filter(
        (event) =>
          !(
            event.kind === "attachment.available" &&
            repeated.has(event.payload.attachment.artifactId)
          ) &&
          !(
            event.kind === "attachment.pending" &&
            repeated.has(event.payload.artifactId)
          ),
      )
      .flatMap(chunkContent);
    const availableVersions = [
      ...new Set([
        ...(previous?.availableVersions ?? []),
        ...raw.flatMap((event) =>
          event.kind === "attachment.available"
            ? [event.payload.attachment.version]
            : [],
        ),
      ]),
    ];
    const intent = {
      entityId: id,
      next: {
        generation: (previous?.generation ?? 0) + 1,
        fingerprint,
        identity,
        ...(objectType ? { objectType } : {}),
        availableVersions,
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
  accept(input: OpenCodeSnapshot, signal?: AbortSignal): Promise<void> {
    const serialized = canonicalJson(input);
    if (Buffer.byteLength(serialized) > 64 * 1024 * 1024)
      return Promise.reject(
        new Error("OpenCode snapshot exceeds capture limit"),
      );
    const snapshot = visibleOpenCodeSnapshot(
      parseOpenCodeSnapshot(JSON.parse(serialized)),
    );
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
      await this.convert(snapshot, signal);
    });
    this.tail = work.catch(() => {
      this.failed = true;
    });
    return work;
  }
  private async convert(snapshot: OpenCodeSnapshot, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (
      this.child &&
      snapshot.info.parentID !== this.child.parentNativeSessionId
    )
      throw new Error("OpenCode child does not belong to the selected parent");
    const entityId = (value: unknown) =>
      this.child
        ? hash({ child: this.child.nativeSessionId, entity: value })
        : hash(value);
    const sessionId = entityId("session");
    // One traversal decides both what is revised and what disappeared.
    const seen = openCodeEntityIds(snapshot, this.child);
    const gap = (reason: string): EventContent => ({
      kind: "capture.gap",
      payload: { reason, recoveredState: false },
    });
    await this.revise(
      sessionId,
      "session",
      false,
      snapshot.info.time.created,
      () =>
        this.child
          ? []
          : [
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
    const lineageId = entityId("session-lineage");
    if (snapshot.info.parentID) {
      await this.revise(
        lineageId,
        snapshot.info.parentID,
        false,
        snapshot.info.time.created,
        async () => {
          const lineage = openCodeLineage(
            snapshot.info.id,
            snapshot.info.parentID!,
          );
          const parent = lineage[0]!;
          if (parent.kind !== "agent.updated")
            throw new Error("Invalid parent lineage event");
          // A placeholder must not replace a captured parent's richer lineage.
          // Consult the shared durable journal because child converters have
          // separate state and may be opened after their parent was captured.
          for await (const event of this.journal.pending(0)) {
            signal?.throwIfAborted();
            if (
              event.content.kind === "agent.updated" &&
              event.content.payload.agentId === parent.payload.agentId
            )
              return lineage.slice(1);
          }
          return lineage;
        },
        true,
        hash({
          nativeSessionId: snapshot.info.id,
          parentID: snapshot.info.parentID,
        }),
      );
    } else if (this.state.entities[lineageId]) {
      throw new Error("OpenCode session parent identity disappeared");
    }
    for (const message of snapshot.messages) {
      signal?.throwIfAborted();
      const id = entityId(message.info.id);
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
                  payload: {
                    messageId: id,
                    role: message.info.role,
                    ...(this.child
                      ? { agentId: openCodeAgentId(snapshot.info.id) }
                      : {}),
                  },
                } as EventContent,
              ]
            : []),
          ...(previous?.completed && !complete
            ? [
                {
                  kind: "message.reopened",
                  payload: { messageId: id },
                } as EventContent,
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
        signal?.throwIfAborted();
        if (
          ["text", "reasoning", "step-start", "step-finish"].includes(part.type)
        )
          continue;
        const partId = entityId(part.id);
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
                      payload: {
                        toolId: partId,
                        name,
                        input,
                        ...(this.child
                          ? { agentId: openCodeAgentId(snapshot.info.id) }
                          : {}),
                      },
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
                    {
                      kind: "tool.reopened",
                      payload: { toolId: partId },
                    } as EventContent,
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
            ],
            true,
            hash({ kind: "tool", owner: message.info.id, name: part.tool }),
          );
          if (Array.isArray(native.attachments)) {
            for (const [index, value] of native.attachments.entries()) {
              signal?.throwIfAborted();
              const attachment = z.record(z.string(), z.unknown()).parse(value);
              if (
                (attachment.sessionID !== undefined &&
                  attachment.sessionID !== snapshot.info.id) ||
                (attachment.messageID !== undefined &&
                  attachment.messageID !== message.info.id)
              )
                throw new Error(
                  "OpenCode tool attachment has conflicting ownership",
                );
              const attachmentId = entityId({
                tool: part.id,
                attachment:
                  typeof attachment.id === "string" ? attachment.id : index,
              });
              await this.revise(
                attachmentId,
                {
                  descriptor: openCodeFileDescriptor(attachment),
                  resolved: Boolean(this.artifacts),
                },
                false,
                time,
                () =>
                  openCodeFileEvents({
                    part: attachment,
                    artifactId: attachmentId,
                    messageId: id,
                    sourceScope: snapshot.info.id,
                    ...(this.artifacts ? { resolvers: this.artifacts } : {}),
                    filter: (text) => this.filter(text, true),
                  }),
                true,
                hash({ kind: "tool-attachment", owner: part.id }),
              );
            }
          }
        } else if (part.type === "file") {
          await this.revise(
            partId,
            {
              descriptor: openCodeFileDescriptor(part),
              resolved: Boolean(this.artifacts),
            },
            false,
            time,
            () =>
              openCodeFileEvents({
                part,
                artifactId: partId,
                messageId: id,
                sourceScope: snapshot.info.id,
                ...(this.artifacts ? { resolvers: this.artifacts } : {}),
                filter: (text) => this.filter(text, true),
              }),
            true,
            hash({ kind: part.type, owner: message.info.id }),
          );
        } else
          await this.revise(
            partId,
            { type: part.type, sourceHash: hash(part) },
            false,
            time,
            () => [
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
    for (const [id, previous] of Object.entries(this.state.entities)) {
      signal?.throwIfAborted();
      if (previous.present && !seen.has(id))
        await this.revise(
          id,
          { removed: true },
          previous.completed,
          snapshot.info.time.created,
          () =>
            previous.objectType
              ? [
                  {
                    kind: "object.visibility",
                    payload: {
                      objectType: previous.objectType,
                      objectId: id,
                      visible: false,
                    },
                  },
                ]
              : [
                  gap(
                    "OpenCode removed an unsupported source object; its historical events remain retained",
                  ),
                ],
          false,
        );
    }
  }
  async close() {
    await this.tail;
    this.closed = true;
    await this.lock.release();
  }
}
