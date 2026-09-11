import { spawn, type ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import { idSchema } from "@agentlive/protocol";
import type { NativePublishOptions } from "@agentlive/adapters";

export function nativeResumeCommand(
  agent: "codex" | "claude" | "kimi",
  id: string,
) {
  idSchema.parse(id);
  if (id.startsWith("-"))
    throw new Error(
      "Native resume identity cannot begin with an option prefix",
    );
  return {
    command: agent,
    args:
      agent === "codex"
        ? ["resume", id]
        : agent === "claude"
          ? ["--resume", id]
          : ["--session", id],
  };
}

/** Own a resumed terminal, keeping capture failure distinct from native process lifetime. */
export async function managedFileResume(options: {
  agent: "codex" | "claude" | "kimi";
  nativeSessionId: string;
  sourcePath: string | (() => string | undefined);
  /** Claude supports a caller-chosen UUID before its first transcript exists. */
  newSession?: boolean;
  /** Publisher resolves only after every source has been drained following native exit. */
  cooperativeDrain?: boolean;
  cwd: string;
  signal: AbortSignal;
  publish: (
    hooks: Pick<
      NativePublishOptions,
      "signal" | "onCaughtUp" | "onProgress" | "finishRequested"
    > & { nativeExited: () => boolean },
  ) => Promise<void>;
  onStatus: (status: string) => void;
  spawnNative?: typeof spawn;
  drainTimeoutMs?: number;
}): Promise<number> {
  const command = nativeResumeCommand(options.agent, options.nativeSessionId);
  if (options.newSession) {
    if (
      options.agent !== "claude" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        options.nativeSessionId,
      )
    )
      throw new Error("Fresh launch requires Claude and a generated UUID");
    command.args = ["--session-id", options.nativeSessionId];
  }
  options.signal.throwIfAborted();
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  let child: ChildProcess | undefined;
  let childClosed: Promise<void> | undefined;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  let capturedOffset = 0;
  let target: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let captureError: unknown;
  let exitCode = 0;
  let nativeExited = false;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const drained = () => {
    if (
      !options.cooperativeDrain &&
      target !== undefined &&
      capturedOffset >= target
    )
      finish();
  };
  const stop = () => {
    child?.kill("SIGTERM");
    if (child && child.exitCode === null && child.signalCode === null)
      forceTimer = setTimeout(() => child?.kill("SIGKILL"), 5000);
    finish();
  };
  options.signal.addEventListener("abort", stop, { once: true });
  const beginDrain = () => {
    const path =
      typeof options.sourcePath === "string"
        ? options.sourcePath
        : options.sourcePath();
    if (!nativeExited || !path || timer) return;
    options.onStatus("native-exited; draining retained source");
    timer = setTimeout(() => {
      captureError = new Error(
        "Native source drain timed out; reattach to recover retained history",
      );
      finish();
    }, options.drainTimeoutMs ?? 30_000);
    void stat(path).then(
      (info) => {
        target = info.size;
        drained();
      },
      (error) => {
        captureError = error;
        finish();
      },
    );
  };
  const startNative = () => {
    if (child || signal.aborted) return;
    options.onStatus(
      options.newSession
        ? "native-starting; awaiting identified source"
        : "native-resuming; capture=file-follow",
    );
    child = (options.spawnNative ?? spawn)(command.command, command.args, {
      cwd: options.cwd,
      stdio: "inherit",
      shell: false,
    });
    childClosed = new Promise((resolve) => {
      child!.once("close", resolve);
    });
    child.once("error", (error) => {
      captureError ??= error;
      finish();
    });
    child.once("close", (code, nativeSignal) => {
      nativeExited = true;
      exitCode = code ?? (nativeSignal ? 1 : 0);
      if (captureError || signal.aborted) {
        finish();
        return;
      }
      beginDrain();
    });
  };
  const publishing = Promise.resolve()
    .then(() => {
      if (options.newSession) startNative();
      return options.publish({
        signal,
        nativeExited: () => nativeExited,
        finishRequested: () =>
          Boolean(options.cooperativeDrain && nativeExited),
        onProgress: ({ sourceCursor }) => {
          capturedOffset = sourceCursor.offset;
          drained();
        },
        onCaughtUp: async () => {
          startNative();
          beginDrain();
        },
      });
    })
    .then(
      () => {
        if (options.cooperativeDrain && nativeExited) {
          finish();
          return;
        }
        if (!signal.aborted) {
          captureError ??= new Error(
            "Capture stopped before native session detached",
          );
          options.onStatus(
            "capture-stopped; native terminal remains available",
          );
        }
        if (!child || child.exitCode !== null || child.signalCode !== null)
          finish();
      },
      (error) => {
        captureError = error;
        options.onStatus(
          "capture-failed; native terminal remains available; reattach to recover",
        );
        if (!child || child.exitCode !== null || child.signalCode !== null)
          finish();
      },
    );
  try {
    await finished;
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
    options.signal.removeEventListener("abort", stop);
    await publishing;
    await childClosed;
    if (forceTimer) clearTimeout(forceTimer);
  }
  if (captureError) throw captureError;
  return exitCode;
}
