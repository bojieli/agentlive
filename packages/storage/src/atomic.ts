import { open, rename, unlink } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalJson } from "@agentlive/protocol";

/** Local POSIX filesystems are the first supported durability target. */
export async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  const bytes = Buffer.from(canonicalJson(value) + "\n");
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } catch (error) {
    await file.close();
    await unlink(temporary).catch(() => {});
    throw error;
  }
  await file.close();
  try {
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
