import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { publisherStatus } from "./publication.js";

export interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

const run = (command: string, args: string[], signal: AbortSignal) =>
  new Promise<string>((resolve, reject) => {
    execFile(
      command,
      args,
      {
        signal,
        timeout: 5_000,
        maxBuffer: 64 * 1024,
        env: { PATH: process.env.PATH ?? "", HOME: homedir() },
      },
      (error, stdout, stderr) =>
        error ? reject(error) : resolve(String(stdout || stderr)),
    );
  });

async function exists(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

const privateMode = (mode: number) => (mode & 0o077) === 0;

/** Content-free local diagnostics; never prints credentials or transcript text. */
export async function doctor(options: {
  stateDir: string;
  ownerFile: string;
  serverOrigin: string;
  signal: AbortSignal;
}): Promise<{ ok: boolean; checks: DoctorCheck[] }> {
  const checks: DoctorCheck[] = [];
  const add = (name: string, status: DoctorCheck["status"], detail: string) =>
    checks.push({ name, status, detail });
  const [major = 0, minor = 0, patch = 0] = process.versions.node
    .split(".")
    .map(Number);
  add(
    "node",
    major === 26 && (minor > 8 || (minor === 8 && patch >= 1)) ? "ok" : "fail",
    `Node ${process.versions.node} (requires >=26.8.1 <27) on ${process.platform}/${process.arch}`,
  );
  const state = await exists(options.stateDir);
  if (!state)
    add(
      "state-directory",
      "warn",
      `${options.stateDir} does not exist yet; serve/publish create it`,
    );
  else if (!state.isDirectory())
    add("state-directory", "fail", `${options.stateDir} is not a directory`);
  else
    add(
      "state-directory",
      privateMode(state.mode) ? "ok" : "warn",
      privateMode(state.mode)
        ? options.stateDir
        : `${options.stateDir} is accessible to other users; chmod 700 is recommended`,
    );
  const owner = await exists(options.ownerFile);
  if (process.env.AGENTLIVE_OWNER_SECRET)
    add(
      "owner-credential",
      "ok",
      "Supplied by AGENTLIVE_OWNER_SECRET (not persisted)",
    );
  else if (!owner)
    add(
      "owner-credential",
      "warn",
      `${options.ownerFile} is missing; the first local serve creates it`,
    );
  else
    add(
      "owner-credential",
      owner.isFile() && privateMode(owner.mode) ? "ok" : "fail",
      owner.isFile() && privateMode(owner.mode)
        ? options.ownerFile
        : `${options.ownerFile} must be a regular file readable only by its owner (chmod 600)`,
    );
  const probe = async (path: string) => {
    const response = await fetch(new URL(path, options.serverOrigin), {
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(3_000)]),
      redirect: "error",
    });
    await response.body?.cancel();
    return response.status;
  };
  try {
    const health = await probe("/healthz");
    const ready = health === 200 ? await probe("/readyz") : 0;
    add(
      "server",
      health === 200 && ready === 200 ? "ok" : "fail",
      health !== 200
        ? `${options.serverOrigin} /healthz returned ${health}`
        : ready === 200
          ? `${options.serverOrigin} is live and ready`
          : `${options.serverOrigin} is live but /readyz returned ${ready} (storage unavailable)`,
    );
  } catch (error) {
    options.signal.throwIfAborted();
    add(
      "server",
      "warn",
      `${options.serverOrigin} is unreachable (${error instanceof Error ? error.name : "error"}); start it with agentlive serve or pass --server`,
    );
  }
  try {
    const bindings = await publisherStatus({
      publisherRoot: join(options.stateDir, "publisher"),
      signal: options.signal,
    });
    const paused = bindings.filter((entry) => entry.sharing === "paused");
    const pending = bindings.reduce(
      (total, entry) => total + (entry.pendingEvents ?? 0),
      0,
    );
    const blocked = bindings.filter((entry) =>
      entry.notes.some((note) => note.startsWith("Local journal failed")),
    );
    add(
      "publishers",
      blocked.length ? "fail" : paused.length || pending ? "warn" : "ok",
      `${bindings.length} binding(s); ${paused.length} paused; ${pending} undelivered event(s)` +
        (blocked.length
          ? `; ${blocked.length} need recovery (see agentlive status)`
          : ""),
    );
  } catch (error) {
    options.signal.throwIfAborted();
    add(
      "publishers",
      "fail",
      `Unable to inspect publisher bindings: ${error instanceof Error ? error.message : "error"}`,
    );
  }
  const agents = [
    {
      name: "codex",
      root: join(
        process.env.CODEX_HOME ?? join(homedir(), ".codex"),
        "sessions",
      ),
    },
    {
      name: "claude",
      root: join(
        process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
        "projects",
      ),
    },
    { name: "kimi", root: join(homedir(), ".kimi-code", "sessions") },
    { name: "opencode", root: undefined },
  ];
  for (const agent of agents) {
    let version: string | undefined;
    try {
      version = (await run(agent.name, ["--version"], options.signal))
        .trim()
        .split("\n")[0]!
        .slice(0, 120);
    } catch (error) {
      options.signal.throwIfAborted();
    }
    const history = agent.root ? await exists(agent.root) : undefined;
    add(
      `agent:${agent.name}`,
      version ? "ok" : "warn",
      (version
        ? `${agent.name} ${version}`
        : `${agent.name} not found on PATH`) +
        (agent.root
          ? history?.isDirectory()
            ? `; history at ${agent.root}`
            : `; no history at ${agent.root}`
          : "; history is read through its native server"),
    );
  }
  return { ok: checks.every((check) => check.status !== "fail"), checks };
}
