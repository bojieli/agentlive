import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { idSchema } from "@agentlive/protocol";
import { request } from "@agentlive/client/transport";

/** Own one authenticated loopback native server; credentials never enter argv or diagnostics. */
export async function startManagedOpenCodeServer(options: {
  cwd: string;
  signal: AbortSignal;
  spawnServer?: typeof spawn;
  startupTimeoutMs?: number;
  password?: string;
}) {
  options.signal.throwIfAborted();
  const startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
  if (
    !Number.isSafeInteger(startupTimeoutMs) ||
    startupTimeoutMs < 1 ||
    startupTimeoutMs > 60_000
  )
    throw new RangeError("Invalid managed server startup deadline");
  const password = options.password ?? randomBytes(32).toString("hex");
  if (!/^[a-f0-9]{64}$/.test(password))
    throw new Error("Invalid managed OpenCode credential");
  const username = "opencode";
  const child = (options.spawnServer ?? spawn)(
    "opencode",
    ["serve", "--hostname", "127.0.0.1", "--port", "0"],
    {
      cwd: options.cwd,
      env: {
        ...process.env,
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_SERVER_USERNAME: username,
      },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    },
  );
  let ended = false;
  let rejectReady!: (error: Error) => void;
  let resolveReady!: (origin: string) => void;
  const ready = new Promise<string>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let exitResolve!: () => void;
  const exited = new Promise<void>((resolve) => {
    exitResolve = resolve;
  });
  child.once("error", () =>
    rejectReady(new Error("Managed OpenCode server could not start")),
  );
  child.once("close", () => {
    ended = true;
    rejectReady(new Error("Managed OpenCode server exited before readiness"));
    exitResolve();
  });
  // Consume bounded startup lines only. Do not retain or relay native diagnostics.
  let buffer = "",
    bytes = 0;
  const data = (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 64 * 1024) {
      rejectReady(
        new Error("Managed OpenCode startup output exceeded its limit"),
      );
      return;
    }
    buffer += chunk.toString("utf8");
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      const match =
        /^opencode server listening on (http:\/\/127\.0\.0\.1:(\d+))$/.exec(
          line,
        );
      if (match && Number(match[2]) > 0 && Number(match[2]) <= 65535)
        resolveReady(match[1]!);
    }
  };
  child.stdout!.on("data", data);
  child.stderr!.resume();
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      options.signal.removeEventListener("abort", abort);
      if (!ended) child.kill("SIGTERM");
      const force = setTimeout(() => {
        if (!ended) child.kill("SIGKILL");
      }, 5000);
      try {
        await exited;
      } finally {
        clearTimeout(force);
      }
    })());
  const abort = () => {
    rejectReady(new Error("Managed OpenCode startup cancelled"));
    void close();
  };
  options.signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(
    () => rejectReady(new Error("Managed OpenCode startup timed out")),
    startupTimeoutMs,
  );
  try {
    if (options.signal.aborted) abort();
    const origin = await ready;
    options.signal.throwIfAborted();
    child.stdout!.off("data", data);
    child.stdout!.resume();
    const headers = {
      authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
    };
    // A log line alone is insufficient readiness evidence.
    const health = JSON.parse(
      (
        await request(
          fetch,
          `${origin}/global/health`,
          { headers },
          options.signal,
          64 * 1024,
        )
      ).text,
    );
    if (health.healthy !== true)
      throw new Error("Managed OpenCode health check failed");
    return {
      origin,
      password,
      username,
      exited,
      close,
      session: async (nativeSessionId?: string) => {
        if (ended) throw new Error("Managed OpenCode server is stopped");
        if (nativeSessionId) idSchema.parse(nativeSessionId);
        const value = JSON.parse(
          (
            await request(
              fetch,
              nativeSessionId
                ? `${origin}/session/${encodeURIComponent(nativeSessionId)}`
                : `${origin}/session`,
              nativeSessionId
                ? { headers }
                : {
                    method: "POST",
                    headers: { ...headers, "content-type": "application/json" },
                    body: "{}",
                  },
              options.signal,
              1024 * 1024,
            )
          ).text,
        );
        const id = idSchema.parse(value.id);
        if (
          (nativeSessionId && id !== nativeSessionId) ||
          !Number.isSafeInteger(value.time?.created) ||
          value.time.created < 0
        )
          throw new Error("Managed OpenCode returned invalid session identity");
        return { nativeSessionId: id, createdAt: value.time.created as number };
      },
    };
  } catch (error) {
    await close();
    throw error;
  } finally {
    clearTimeout(timeout);
    child.stdout!.off("data", data);
  }
}
