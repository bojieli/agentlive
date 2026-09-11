import { expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectKimiHistory,
  captureKimiHistory,
} from "../../packages/adapters/src/index.js";
import type { EventContent } from "../../packages/protocol/src/index.js";

// Kimi 1.5 writes some tool results as a single content part object rather
// than an array; conversion must accept it like a one-element array.
it("converts Kimi tool results whose output is a single content part", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-kimi-tool-output-"));
  try {
    const directory = join(root, "session_single", "agents", "main");
    await mkdir(directory, { recursive: true });
    const path = join(directory, "wire.jsonl");
    const time = Date.parse("2026-09-01T00:00:00.000Z");
    const call = (id: string, at: number) => ({
      type: "context.append_loop_event",
      time: at,
      event: {
        type: "tool.call",
        uuid: `call-${id}`,
        toolCallId: id,
        name: "ReadMediaFile",
        args: { path: "shot.png" },
      },
    });
    const result = (id: string, at: number, output: unknown) => ({
      type: "context.append_loop_event",
      time: at,
      event: {
        type: "tool.result",
        parentUuid: `call-${id}`,
        toolCallId: id,
        result: { output },
      },
    });
    const image = {
      type: "image",
      url: "data:image/png;base64,iVBORw0KGgo=",
      mime: "image/png",
      filename: "shot.png",
    };
    await writeFile(
      path,
      [
        { type: "metadata", protocol_version: "1.5", created_at: time },
        call("single", time + 1),
        result("single", time + 2, image),
        call("text", time + 3),
        result("text", time + 4, { type: "text", text: "single text part" }),
        call("array", time + 5),
        result("array", time + 6, [image]),
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
    );
    const manifest = await inspectKimiHistory(path);
    const content: EventContent[] = [];
    const sink = {
      identity: {
        nativeAgent: "kimi" as const,
        nativeSessionId: manifest.nativeSessionId,
      },
      capturedThrough: 0,
      capture: async (input: { content: readonly EventContent[] }) => {
        content.push(...input.content);
        return [];
      },
    };
    await captureKimiHistory(path, manifest, sink as never);
    const completed = content.filter(
      (event) => event.kind === "tool.completed",
    ) as Extract<EventContent, { kind: "tool.completed" }>[];
    expect(completed).toHaveLength(3);
    expect(completed[1]!.payload.output).toBe("single text part");
    const gaps = content
      .filter((event) => event.kind === "capture.gap")
      .map(
        (event) =>
          (event as Extract<EventContent, { kind: "capture.gap" }>).payload
            .reason,
      );
    // The single-object image and the array image are reported identically.
    expect(
      gaps.filter((reason) => reason.includes("tool_result/image")),
    ).toHaveLength(2);
    expect(JSON.stringify(content)).not.toContain("iVBORw0KGgo");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
