import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicJson } from "@agentlive/storage";
import {
  publishOpenCodeRecording,
  type OpenCodePublishOptions,
} from "@agentlive/adapters";
import { startManagedOpenCodeServer } from "./opencode-server.js";
import { ownerCredential } from "./credentials.js";

export async function launchManagedOpenCode(
  options: Omit<
    OpenCodePublishOptions,
    | "nativeServerOrigin"
    | "nativeSessionId"
    | "nativePassword"
    | "nativeUsername"
  > & {
    nativeSessionId?: string;
    stateDir: string;
    cwd: string;
    onLaunch: (event: { status: string; nativeSessionId?: string }) => void;
  },
) {
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
  const password = await ownerCredential(
    join(options.stateDir, "managed-opencode-credential.json"),
    true,
  );
  const server = await startManagedOpenCodeServer({
    cwd: options.cwd,
    signal,
    password,
  });
  let child: ChildProcess | undefined;
  let childClosed: Promise<void> | undefined;
  let terminalEnded = false,
    closing = false;
  let failure: unknown;
  let code = 0;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  const stopChild = () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      forceTimer ??= setTimeout(() => child?.kill("SIGKILL"), 5000);
    }
  };
  options.signal.addEventListener("abort", stopChild, { once: true });
  void server.exited.then(() => {
    if (!closing && !signal.aborted) {
      failure = new Error(
        "Managed native server exited; reattach to recover retained history",
      );
      controller.abort();
      stopChild();
    }
  });
  try {
    const session = await server.session(options.nativeSessionId);
    const directory = join(options.stateDir, "launches");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await atomicJson(join(directory, `${session.nativeSessionId}.json`), {
      version: 1,
      agent: "opencode",
      nativeSessionId: session.nativeSessionId,
      cwd: options.cwd,
      serverOrigin: options.serverOrigin,
      createdAt: new Date().toISOString(),
    });
    options.onLaunch({
      status: "native-identity-saved",
      nativeSessionId: session.nativeSessionId,
    });
    await publishOpenCodeRecording({
      ...options,
      signal,
      nativeServerOrigin: server.origin,
      nativeSessionId: session.nativeSessionId,
      nativePassword: server.password,
      nativeUsername: server.username,
      finishRequested: () => terminalEnded,
      onCaptured: (boundary) => {
        options.onCaptured?.(boundary);
        if (child || signal.aborted) return;
        options.onLaunch({
          status: "native-attaching; capture=snapshot-reconciliation",
          nativeSessionId: session.nativeSessionId,
        });
        child = spawn(
          "opencode",
          [
            "attach",
            server.origin,
            "--session",
            session.nativeSessionId,
            "--dir",
            options.cwd,
          ],
          {
            cwd: options.cwd,
            stdio: "inherit",
            shell: false,
            env: {
              ...process.env,
              OPENCODE_SERVER_PASSWORD: server.password,
              OPENCODE_SERVER_USERNAME: server.username,
            },
          },
        );
        childClosed = new Promise((resolve) => child!.once("close", resolve));
        child.once("error", () => {
          failure = new Error("OpenCode terminal could not start");
          controller.abort();
        });
        child.once("close", (exitCode, nativeSignal) => {
          terminalEnded = true;
          code = exitCode ?? (nativeSignal ? 1 : 0);
          options.onLaunch({
            status: "native-terminal-exited; reconciling final snapshot",
            nativeSessionId: session.nativeSessionId,
          });
          if (!signal.aborted)
            drainTimer = setTimeout(() => {
              failure = new Error(
                "Final OpenCode reconciliation timed out; reattach to recover retained history",
              );
              controller.abort();
            }, 30_000);
        });
      },
    }).catch(async (error) => {
      failure ??= error;
      options.onLaunch({
        status:
          "capture-failed; native terminal remains available; reattach to recover",
        nativeSessionId: session.nativeSessionId,
      });
      await childClosed;
    });
    if (failure) throw failure;
    options.signal.throwIfAborted();
    return code;
  } finally {
    closing = true;
    if (drainTimer) clearTimeout(drainTimer);
    stopChild();
    await childClosed;
    if (forceTimer) clearTimeout(forceTimer);
    options.signal.removeEventListener("abort", stopChild);
    await server.close();
    controller.abort();
  }
}
