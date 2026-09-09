import { open, mkdir } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import { ProtocolError } from "@agentlive/protocol";
const require = createRequire(import.meta.url);
const native = require("fs-native-extensions") as {
  tryLock(fd: number): boolean;
  unlock(fd: number): void;
};

/** Kernel-owned advisory lock. The lock inode is never unlinked or replaced. */
export class FileLock {
  private released = false;
  private constructor(private readonly file: FileHandle) {}
  static async acquire(path: string): Promise<FileLock> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const file = await open(
      path,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      if (!native.tryLock(file.fd))
        throw new ProtocolError(
          "publisher_busy",
          "Another process owns this data directory",
        );
      return new FileLock(file);
    } catch (error) {
      await file.close();
      throw error;
    }
  }
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    try {
      native.unlock(this.file.fd);
    } finally {
      await this.file.close();
    }
  }
}
