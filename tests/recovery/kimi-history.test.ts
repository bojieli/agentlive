import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { mkdtemp, writeFile, rm, mkdir, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  importKimiRecording,
  publishKimiRecording,
} from "../../packages/adapters/src/index.js";
import { startServer } from "../../packages/server/src/http.js";
import { initialState, apply } from "../../packages/playback/src/index.js";
it("captures Kimi sibling logs, follows idle-main updates and deduplicates restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-kimi-family-"));
  const ownerCredential = "b".repeat(64);
  const server = await startServer({
    directory: join(root, "server"),
    ownerSecret: ownerCredential,
    port: 0,
  });
  const session = join(root, "session_family");
  const time = Date.parse("2026-09-01T00:00:00Z");
  const row = (text: string) =>
    JSON.stringify({
      type: "context.append_message",
      time,
      message: { role: "user", content: [{ type: "text", text }] },
    }) + "\n";
  const create = async (agent: string, text: string) => {
    const directory = join(session, "agents", agent);
    await mkdir(directory, { recursive: true });
    const path = join(directory, "wire.jsonl");
    await writeFile(
      path,
      JSON.stringify({
        type: "metadata",
        protocol_version: "1.5",
        created_at: time,
      }) +
        "\n" +
        row(text),
    );
    return path;
  };
  try {
    const sourcePath = await create("main", "main message");
    const child = await create("worker", "worker message");
    let streamId = "",
      baseline = 0;
    const settings = {
      sourcePath,
      publisherRoot: join(root, "publisher"),
      serverOrigin: server.url,
      ownerCredential,
      title: "Kimi family",
      visibility: "private" as const,
      includeChildren: true,
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const abort = new AbortController();
      let failure: unknown;
      const running = publishKimiRecording({
        ...settings,
        signal: abort.signal,
        onReady: (recording) => {
          if (streamId) expect(recording.streamId).toBe(streamId);
          streamId = recording.streamId;
        },
      }).catch((error) => {
        failure = error;
      });
      const until = async (expected: string[]) => {
        let state = initialState(),
          sequence = 0;
        await expect
          .poll(
            async () => {
              if (failure) throw failure;
              if (!streamId) return [];
              const recording = await server.store.get(streamId);
              state = initialState();
              let starts = 0;
              try {
                sequence = recording.boundary.sequence;
                for await (const event of recording.history(0, sequence)) {
                  state = apply(state, event);
                  if (event.content.kind === "session.started") starts++;
                }
              } finally {
                server.store.release(recording);
              }
              expect(starts).toBeLessThanOrEqual(1);
              return [...state.messages.values()]
                .map((message) => message.text)
                .sort();
            },
            { timeout: 10000 },
          )
          .toEqual([...expected].sort());
        return { state, sequence };
      };
      try {
        const expected = [
          "main message",
          "worker message",
          ...(attempt ? ["worker later", "new agent"] : []),
        ];
        const initial = await until(expected);
        if (attempt) expect(initial.sequence).toBe(baseline);
        else {
          await appendFile(child, row("worker later"));
          await create("later", "new agent");
          const result = await until([
            ...expected,
            "worker later",
            "new agent",
          ]);
          // Trailing events for the new agent may still be committing after the
          // texts appear; take the baseline only once the boundary is stable.
          let previous = -1;
          await expect
            .poll(
              async () => {
                const recording = await server.store.get(streamId);
                const current = recording.boundary.sequence;
                server.store.release(recording);
                const stable = current === previous;
                previous = current;
                return stable;
              },
              { timeout: 10000, interval: 300 },
            )
            .toBe(true);
          baseline = previous;
          expect(result.state.agents.size).toBe(3);
          expect(
            new Set(
              [...result.state.messages.values()].map(
                (message) => message.agentId,
              ),
            ).size,
          ).toBe(3);
        }
      } finally {
        abort.abort();
        await running;
      }
    }
    await expect(
      publishKimiRecording({
        ...settings,
        includeChildren: false,
        signal: AbortSignal.timeout(5000),
      }),
    ).rejects.toThrow("options changed");
    await writeFile(
      child,
      JSON.stringify({
        type: "metadata",
        protocol_version: "1.5",
        created_at: time,
      }) +
        "\n" +
        row("changed history"),
    );
    await expect(
      publishKimiRecording({ ...settings, signal: AbortSignal.timeout(5000) }),
    ).rejects.toThrow(/prefix changed|truncated/);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
it("imports Kimi wire text and failed tools with agent identity, filtering and stable retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-kimi-test-"));
  const ownerCredential = "b".repeat(64);
  const server = await startServer({
    directory: join(root, "server"),
    ownerSecret: ownerCredential,
    port: 0,
  });
  try {
    const sourcePath = join(root, "wire.jsonl"),
      time = Date.parse("2026-09-01T00:00:00.000Z");
    const planPath = join(root, "plan.md"),
      planText = "# Plan\nFinish private-key work";
    const planHash = createHash("sha256").update(planText).digest("hex");
    await writeFile(planPath, planText);
    const rows = [
      { type: "metadata", protocol_version: "1.5", created_at: time },
      {
        type: "context.append_message",
        time,
        message: {
          role: "user",
          content: [{ type: "text", text: "Question" }],
        },
      },
      {
        type: "context.append_loop_event",
        time: time + 1,
        event: {
          type: "content.part",
          uuid: "text1",
          part: { type: "text", text: "Reply private-key" },
        },
      },
      {
        type: "context.append_loop_event",
        time: time + 2,
        event: {
          type: "content.part",
          uuid: "think1",
          part: { type: "think", think: "unpublished reasoning" },
        },
      },
      {
        type: "context.append_loop_event",
        time: time + 3,
        event: {
          type: "tool.call",
          uuid: "call1",
          toolCallId: "tool1",
          name: "Shell",
          args: { command: "echo private-key" },
        },
      },
      {
        type: "context.append_loop_event",
        time: time + 4,
        event: {
          type: "tool.result",
          parentUuid: "call1",
          toolCallId: "tool1",
          result: {
            output: [
              { type: "text", text: "failed" },
              {
                type: "image_url",
                imageUrl: { url: "private-image-reference" },
              },
            ],
            isError: true,
            truncated: true,
          },
        },
      },
      {
        type: "goal.create",
        time: time + 5,
        goalId: "goal1",
        objective: "Complete private-key workload",
      },
      {
        type: "goal.update",
        time: time + 6,
        status: "paused",
        turnsUsed: 2,
        tokensUsed: 100,
        reason: "Wait for capacity",
      },
      { type: "goal.update", time: time + 7, status: "complete", turnsUsed: 3 },
      { type: "goal.clear", time: time + 8 },
      {
        type: "task.started",
        agentId: "worker",
        time: time + 9,
        info: {
          taskId: "task1",
          kind: "process",
          status: "running",
          description: "Background monitor",
          command: "echo private-key",
          detached: true,
        },
      },
      {
        type: "task.terminated",
        agentId: "worker",
        time: time + 10,
        info: {
          taskId: "task1",
          kind: "process",
          status: "killed",
          description: "Background monitor",
          detached: true,
        },
        outputTail: "partial monitor output",
      },
      {
        type: "interaction.request",
        time: time + 11,
        id: "approval1",
        kind: "approval",
        toolCallId: "tool1",
        request: {
          toolName: "Shell",
          action: "Run command",
          display: { command: "echo private-key" },
        },
      },
      {
        type: "interaction.resolved",
        time: time + 12,
        id: "approval1",
        response: { decision: "approved", scope: "session" },
      },
      {
        type: "permission.record_approval_result",
        time: time + 13,
        turnId: 1,
        toolCallId: "tool1",
        toolName: "Shell",
        action: "Run command",
        result: { decision: "approved", scope: "session" },
      },
      {
        type: "interaction.request",
        time: time + 14,
        id: "question1",
        kind: "question",
        request: {
          questions: [
            {
              question: "Continue?",
              header: "Choice",
              options: [{ label: "Yes", description: "Continue working" }],
            },
          ],
        },
      },
      {
        type: "interaction.resolved",
        time: time + 15,
        id: "question1",
        response: { answers: { Choice: "Yes" }, method: "user" },
      },
      { type: "plan_mode.enter", time: time + 16, id: "plan1" },
      {
        type: "plan.revision",
        time: time + 17,
        id: "plan1",
        version: 1,
        sha256: planHash,
        bytes: Buffer.byteLength(planText),
        path: "plan.md",
      },
      { type: "plan_mode.exit", time: time + 18 },
    ];
    await writeFile(
      sourcePath,
      rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    );
    const options = {
      sourcePath,
      nativeIdentity: { nativeSessionId: "kimi_session", agentId: "main" },
      publisherRoot: join(root, "publisher"),
      serverOrigin: server.url,
      ownerCredential,
      title: "Kimi import",
      visibility: "private" as const,
      secrets: ["private-key"],
      signal: AbortSignal.timeout(5000),
    };
    const result = await importKimiRecording(options);
    const session = await server.store.get(result.streamId);
    let state = initialState();
    const events = [];
    for await (const event of session.history(0, session.boundary.sequence)) {
      state = apply(state, event);
      events.push(event);
    }
    expect([...state.messages.values()].map((message) => message.text)).toEqual(
      ["Question", "Reply [REDACTED]"],
    );
    expect(state.agents.size).toBe(2);
    expect([...state.tasks.values()][0]!.agentId).toBe(
      [...state.agents.values()].find((agent) => agent.name === "worker")!
        .agentId,
    );
    expect([...state.tools.values()][0]!.status).toBe("failed");
    expect(JSON.stringify(events)).not.toContain("private-key");
    expect(JSON.stringify(events)).not.toContain("unpublished reasoning");
    expect([...state.goals.values()][0]).toMatchObject({
      objective: "Complete [REDACTED] workload",
      status: "cleared",
      turnsUsed: 3,
      tokensUsed: 100,
    });
    expect([...state.tasks.values()][0]).toMatchObject({
      taskType: "process",
      status: "interrupted",
      description: "Background monitor",
      detached: true,
    });
    expect(
      [...state.tools.values()].some(
        (tool) =>
          tool.output.endsWith("partial monitor output") &&
          tool.status === "interrupted",
      ),
    ).toBe(true);
    expect(state.interactions.size).toBe(2);
    expect(
      [...state.interactions.values()].find(
        (value) => value.interactionType === "approval",
      ),
    ).toMatchObject({
      status: "resolved",
      response: "approved",
      scope: "session",
      prompt: "Run command\necho [REDACTED]",
    });
    expect(
      [...state.interactions.values()].find(
        (value) => value.interactionType === "question",
      ),
    ).toMatchObject({
      status: "resolved",
      questions: [
        {
          question: "Continue?",
          header: "Choice",
          options: [{ label: "Yes", description: "Continue working" }],
        },
      ],
    });
    expect([...state.plans.values()][0]).toMatchObject({
      status: "inactive",
      version: 1,
      sourceHash: planHash,
      byteSize: Buffer.byteLength(planText),
    });
    expect(result.report.unsupported).toEqual({
      "tool_result/source_truncated": 1,
      "tool_result/image_url": 1,
    });
    const attachment = [...state.artifacts.values()].flatMap((artifact) => [
      ...artifact.versions.values(),
    ])[0]!;
    expect(attachment.provenance).toBe("historical-version");
    expect(attachment.sourceHash).toBe(planHash);
    expect([...state.plans.values()][0]!.attachment).toEqual({
      artifactId: attachment.artifactId,
      version: attachment.version,
    });
    const response = await fetch(
      `${server.url}/api/v1/streams/${result.streamId}/attachments/${attachment.hash}`,
      { headers: { authorization: `Bearer ${ownerCredential}` } },
    );
    expect(await response.text()).toBe("# Plan\nFinish [REDACTED] work");
    await rm(planPath);
    const before = session.boundary.sequence;
    await importKimiRecording(options);
    expect(session.boundary.sequence).toBe(before);
    expect(
      (await fetch(`${server.url}/api/v1/streams/${result.streamId}`)).status,
    ).toBe(403);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("preserves Kimi goal, task and approval state across live publisher restart", async () => {
  const { publishKimiRecording } =
    await import("../../packages/adapters/src/index.js");
  const { appendFile } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "agentlive-kimi-follow-"));
  const server = await startServer({
    directory: join(root, "server"),
    ownerSecret: "b".repeat(64),
    port: 0,
  });
  const sourcePath = join(root, "wire.jsonl");
  const time = Date.parse("2026-09-09T00:00:00Z");
  const rows = [
    { type: "metadata", protocol_version: "1.5", created_at: time },
    {
      type: "goal.create",
      time,
      goalId: "goal1",
      objective: "Finish workload",
    },
    {
      type: "task.started",
      time,
      info: {
        taskId: "task1",
        kind: "process",
        status: "running",
        description: "Monitor",
      },
    },
    {
      type: "interaction.request",
      time,
      id: "approval1",
      kind: "approval",
      request: { toolName: "Shell", action: "Run command" },
    },
  ];
  await writeFile(
    sourcePath,
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  const settings = {
    sourcePath,
    publisherRoot: join(root, "publisher"),
    serverOrigin: server.url,
    ownerCredential: "b".repeat(64),
    title: "Kimi live",
    visibility: "private" as const,
    nativeIdentity: { nativeSessionId: "kimi_live", agentId: "root" },
  };
  let streamId = "";
  async function attach(resolved: boolean) {
    const controller = new AbortController();
    let failure: unknown;
    let captured = 0;
    const running = publishKimiRecording({
      ...settings,
      signal: controller.signal,
      resumeImport: true,
      onReady: (recording) => {
        if (streamId) expect(recording.streamId).toBe(streamId);
        streamId = recording.streamId;
      },
      onCaughtUp: async (boundary) => {
        captured = boundary.producerEvents;
      },
    }).catch((error) => {
      failure = error;
    });
    try {
      await expect
        .poll(
          async () => {
            if (failure) throw failure;
            if (!captured || !streamId) return false;
            const session = await server.store.get(streamId);
            let state = initialState();
            let through = 0;
            for await (const event of session.history(
              0,
              session.boundary.sequence,
            )) {
              state = apply(state, event);
              if (event.origin.type === "publisher")
                through = event.origin.event.producerSeq;
            }
            return (
              through >= captured &&
              state.goals.size === 1 &&
              state.tasks.size === 1 &&
              state.interactions.size === 1 &&
              [...state.goals.values()][0]?.status ===
                (resolved ? "complete" : "active") &&
              [...state.tasks.values()][0]?.status ===
                (resolved ? "completed" : "running") &&
              [...state.interactions.values()][0]?.status ===
                (resolved ? "resolved" : "pending")
            );
          },
          { timeout: 10000 },
        )
        .toBe(true);
    } finally {
      controller.abort();
      await running;
    }
    if (failure) throw failure;
  }
  try {
    const imported = await importKimiRecording({
      ...settings,
      signal: AbortSignal.timeout(5000),
    });
    streamId = imported.streamId;
    await attach(false);
    await appendFile(
      sourcePath,
      [
        {
          type: "goal.update",
          time: time + 1,
          status: "complete",
          turnsUsed: 2,
        },
        {
          type: "task.terminated",
          time: time + 2,
          info: {
            taskId: "task1",
            kind: "process",
            status: "completed",
            description: "Monitor",
          },
          outputTail: "Finished",
        },
        {
          type: "interaction.resolved",
          time: time + 3,
          id: "approval1",
          response: { decision: "approved", scope: "once" },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
    );
    await attach(true);
    const before = (await server.store.get(streamId)).boundary.sequence;
    await attach(true);
    expect((await server.store.get(streamId)).boundary.sequence).toBe(before);
    await appendFile(
      sourcePath,
      JSON.stringify({
        type: "metadata",
        protocol_version: "1.5",
        created_at: time + 1,
      }) + "\n",
    );
    await expect(
      publishKimiRecording({ ...settings, signal: AbortSignal.timeout(5000) }),
    ).rejects.toThrow("conflicting metadata");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

it("imports a frozen Kimi family once and rejects changed child history or scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-kimi-family-import-"));
  const ownerCredential = "d".repeat(64);
  const server = await startServer({
    directory: join(root, "server"),
    ownerSecret: ownerCredential,
    port: 0,
  });
  const row = (text: string) =>
    JSON.stringify({
      type: "context.append_message",
      time: 2,
      message: { role: "user", content: [{ type: "text", text }] },
    }) + "\n";
  const paths = new Map<string, string>();
  try {
    for (const agent of ["main", "worker", "other"]) {
      const directory = join(root, "session_import_family", "agents", agent);
      await mkdir(directory, { recursive: true });
      const path = join(directory, "wire.jsonl");
      paths.set(agent, path);
      await writeFile(
        path,
        JSON.stringify({
          type: "metadata",
          protocol_version: "1.5",
          created_at: 1,
        }) +
          "\n" +
          row(agent),
      );
    }
    const options = {
      sourcePath: paths.get("main")!,
      publisherRoot: join(root, "publisher"),
      serverOrigin: server.url,
      ownerCredential,
      title: "Kimi family import",
      visibility: "private" as const,
      includeChildren: true,
      signal: AbortSignal.timeout(15000),
    };
    const first = await importKimiRecording(options);
    const second = await importKimiRecording(options);
    expect(second.streamId).toBe(first.streamId);
    expect(second.producerEvents).toBe(first.producerEvents);
    const recording = await server.store.get(first.streamId);
    try {
      let state = initialState(),
        starts = 0,
        ends = 0;
      for await (const event of recording.history(
        0,
        recording.boundary.sequence,
      )) {
        state = apply(state, event);
        if (event.content.kind === "session.started") starts++;
        if (event.content.kind === "recording.ended") ends++;
      }
      expect(starts).toBe(1);
      expect(ends).toBe(1);
      expect(
        [...state.messages.values()].map((message) => message.text).sort(),
      ).toEqual(["main", "other", "worker"]);
      expect(
        new Set([...state.messages.values()].map((message) => message.agentId))
          .size,
      ).toBe(3);
    } finally {
      server.store.release(recording);
    }
    await expect(
      importKimiRecording({ ...options, includeChildren: false }),
    ).rejects.toThrow("Import source or options changed");
    await appendFile(paths.get("worker")!, row("later child"));
    await expect(importKimiRecording(options)).rejects.toThrow(
      "Import source or options changed",
    );
    let finish = false;
    await publishKimiRecording({
      ...options,
      resumeImport: true,
      onCaughtUp: async () => {
        finish = true;
      },
      finishRequested: () => finish,
    });
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
