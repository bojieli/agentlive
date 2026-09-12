import { expect, it } from "vitest";
import { mkdtemp, chmod, rm, readdir, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordingStore } from "../../packages/server/src/store.js";
import { prepareOnlineBackup } from "../../packages/server/src/backup.js";

// A cleanup failure must not keep the plaintext owner secret on disk, and must
// not wedge every later backup behind "already running".
it("reopens backup admission and drops the owner secret when cleanup fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-backup-release-"));
  const store = await RecordingStore.open(join(root, "server"));
  const parent = join(root, "locked");
  await mkdir(parent);
  try {
    const first = await prepareOnlineBackup({
      server: store,
      ownerSecret: "a".repeat(64),
      output: join(parent, "out"),
    });
    await chmod(parent, 0o500);
    await expect(
      first.run({
        signal: AbortSignal.timeout(20000),
        // Force the run itself to fail after the owner file exists.
        barrierTimeoutMs: -1 as unknown as number,
      }),
    ).rejects.toBeTruthy();
    await chmod(parent, 0o700);
    expect(await readdir(join(parent, "out")).catch(() => [])).not.toContain(
      "owner.json",
    );
    // Admission is free again: a second backup prepares rather than reporting busy.
    const second = await prepareOnlineBackup({
      server: store,
      ownerSecret: "a".repeat(64),
      output: join(root, "second"),
    });
    await second.abandon();
  } finally {
    await chmod(parent, 0o700).catch(() => {});
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
