import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importKimiRecording } from "../../packages/adapters/src/index.js";
import { startServer } from "../../packages/server/src/http.js";
import { initialState, apply } from "../../packages/playback/src/index.js";
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
