import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { FileLock, atomicJson } from "@agentlive/storage";
export function validateSecret(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value))
    throw new Error(
      "Owner credential must be 64 lowercase hexadecimal characters",
    );
  return value;
}

/** Read the private JSON returned by viewing-grant without treating it as owner state. */
export async function viewingCredential(
  path: string,
  streamId: string,
): Promise<string> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 4096)
      throw new Error("Invalid viewing credential file");
    if ((stat.mode & 0o077) !== 0)
      throw new Error(
        "Viewing credential file must only be accessible to its owner (chmod 600)",
      );
    const bytes = Buffer.alloc(4097);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(
        bytes,
        length,
        bytes.length - length,
        null,
      );
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > 4096) throw new Error("Invalid viewing credential file");
    let value;
    try {
      value = JSON.parse(bytes.subarray(0, length).toString("utf8"));
    } catch {
      // JSON parser errors may include the credential bytes.
      throw new Error("Invalid viewing credential JSON");
    }
    if (
      !value ||
      typeof value.token !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.token) ||
      typeof value.streamId !== "string" ||
      !Number.isSafeInteger(value.expiresAt)
    )
      throw new Error("Invalid viewing credential file");
    if (value.streamId !== streamId)
      throw new Error("Viewing credential belongs to another recording");
    if (value.expiresAt <= Date.now())
      throw new Error("Viewing credential has expired");
    return value.token;
  } finally {
    await file.close();
  }
}
/** Server startup may initialize a credential; imports never silently invent one. */
export async function ownerCredential(
  path: string,
  create: boolean,
): Promise<string> {
  const lock = await FileLock.acquire(path + ".lock");
  try {
    let file;
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!create)
        throw new Error(
          "Owner credential is missing; start the local server or specify --owner-file",
        );
      const secret = randomBytes(32).toString("hex");
      await atomicJson(path, { version: 1, secret });
      return secret;
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 4096)
        throw new Error("Invalid owner credential file");
      if ((stat.mode & 0o077) !== 0)
        throw new Error(
          "Owner credential file must only be accessible to its owner (chmod 600)",
        );
      const value = JSON.parse(await file.readFile("utf8")) as {
        version?: unknown;
        secret?: unknown;
      };
      if (value.version !== 1 || typeof value.secret !== "string")
        throw new Error("Invalid owner credential file");
      return validateSecret(value.secret);
    } finally {
      await file.close();
    }
  } finally {
    await lock.release();
  }
}
