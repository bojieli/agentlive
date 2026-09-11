import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { z } from "zod";
import { FileLock, atomicJson, syncDirectory } from "@agentlive/storage";
import { dirname } from "node:path";
import { request, delay, retryable } from "@agentlive/client/transport";

export function accountOrigin(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value)
    throw new Error(
      "Account login requires an explicit HTTPS server origin without a path",
    );
  return url.origin;
}
const savedSchema = z.strictObject({
  version: z.literal(1),
  serverOrigin: z.string(),
  token: z.string().regex(/^ald1_[a-f0-9]{64}$/),
  expiresAt: z.number().int().nonnegative().safe(),
});
async function readAccount(path: string) {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0)
      throw new Error(
        "Account file must be a private regular file (chmod 600)",
      );
    const bytes = Buffer.alloc(4097);
    let length = 0;
    while (length < bytes.length) {
      const part = await file.read(bytes, length, bytes.length - length, null);
      if (!part.bytesRead) break;
      length += part.bytesRead;
    }
    if (length > 4096) throw new Error("Account file exceeds limit");
    try {
      return savedSchema.parse(
        JSON.parse(bytes.subarray(0, length).toString("utf8")),
      );
    } catch {
      throw new Error("Invalid account credential file");
    }
  } finally {
    await file.close();
  }
}
export async function accountCredential(path: string, serverOrigin: string) {
  const saved = await readAccount(path);
  if (saved.serverOrigin !== accountOrigin(serverOrigin))
    throw new Error("Account credential belongs to another server origin");
  if (saved.expiresAt <= Date.now())
    throw new Error("Account credential expired; log in again");
  return saved.token;
}
export async function loginAccount(options: {
  serverOrigin: string;
  output: string;
  signal: AbortSignal;
  prompt: (value: {
    userCode: string;
    verificationUri: string;
    expiresAt: number;
  }) => void;
  fetch?: typeof fetch;
}) {
  const origin = accountOrigin(options.serverOrigin);
  const lock = await FileLock.acquire(options.output + ".lock");
  try {
    try {
      const file = await open(
        options.output,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      await file.close();
      throw new Error(
        "Account file already exists; log out or choose a new file",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const call = async (suffix: string, body?: unknown) => {
      const response = await request(
        options.fetch ?? fetch,
        origin + "/auth/device/" + suffix,
        {
          method: "POST",
          ...(body
            ? {
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
              }
            : {}),
        },
        options.signal,
        8192,
      );
      return JSON.parse(response.text);
    };
    const started = z
      .strictObject({
        deviceCode: z.string().regex(/^[a-f0-9]{64}$/),
        userCode: z.string().regex(/^[A-F0-9]{10}$/),
        verificationUri: z.string(),
        expiresAt: z.number().int().safe(),
        intervalSeconds: z.number().int().min(1).max(60),
      })
      .parse(await call("start"));
    const uri = new URL(started.verificationUri);
    if (
      uri.origin !== origin ||
      uri.username ||
      uri.password ||
      uri.hash ||
      started.expiresAt <= Date.now() ||
      started.expiresAt > Date.now() + 600000
    )
      throw new Error("Invalid device verification destination or expiry");
    options.prompt({
      userCode: started.userCode,
      verificationUri: uri.href,
      expiresAt: started.expiresAt,
    });
    let interval = started.intervalSeconds;
    while (Date.now() < started.expiresAt) {
      await delay(
        Math.min(interval * 1000, started.expiresAt - Date.now()),
        options.signal,
      );
      options.signal.throwIfAborted();
      if (Date.now() >= started.expiresAt) break;
      let result;
      try {
        result = await call("poll", { deviceCode: started.deviceCode });
      } catch (error) {
        options.signal.throwIfAborted();
        if (retryable(error)) continue;
        throw error;
      }
      if (result.status === "approved") {
        const parsed = savedSchema.safeParse({
          version: 1,
          serverOrigin: origin,
          token: result.token,
          expiresAt: result.expiresAt,
        });
        if (!parsed.success)
          throw new Error("Invalid approved account credential response");
        const saved = parsed.data;
        if (
          saved.expiresAt <= Date.now() ||
          saved.expiresAt > Date.now() + 8 * 3600000
        )
          throw new Error("Invalid account credential expiry");
        await atomicJson(options.output, saved);
        return { serverOrigin: origin, expiresAt: saved.expiresAt };
      }
      if (result.status === "slow_down") {
        interval = z
          .number()
          .int()
          .min(1)
          .max(60)
          .parse(result.intervalSeconds);
        continue;
      }
      if (result.status === "denied" || result.status === "expired")
        throw new Error("Device login was denied or expired");
      if (result.status !== "pending")
        throw new Error("Invalid device login response");
    }
    throw new Error("Device login expired");
  } finally {
    await lock.release();
  }
}
export async function logoutAccount(options: {
  serverOrigin: string;
  path: string;
  signal: AbortSignal;
  fetch?: typeof fetch;
}) {
  const origin = accountOrigin(options.serverOrigin);
  const lock = await FileLock.acquire(options.path + ".lock");
  try {
    const saved = await readAccount(options.path);
    if (saved.serverOrigin !== origin)
      throw new Error("Account credential belongs to another server origin");
    const response = await (options.fetch ?? fetch)(
      origin + "/auth/device/revoke",
      {
        method: "POST",
        headers: { authorization: `Bearer ${saved.token}` },
        redirect: "error",
        credentials: "omit",
        signal: AbortSignal.any([options.signal, AbortSignal.timeout(30000)]),
      },
    );
    await response.body?.cancel();
    if (!response.ok && response.status !== 401)
      throw new Error("Account revocation failed; credential file retained");
    await unlink(options.path);
    await syncDirectory(dirname(options.path));
    return { serverOrigin: origin, loggedOut: true };
  } finally {
    await lock.release();
  }
}
