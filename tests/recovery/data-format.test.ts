import { expect, it } from "vitest";
import {
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { RecordingStore } from "../../packages/server/src/store.js";
import { backupServer } from "../../packages/server/src/backup.js";
import { restoreServer } from "../../packages/server/src/restore.js";
import {
  SERVER_DATA_FORMAT,
  UnsupportedDataFormatError,
} from "../../packages/server/src/data-format.js";

const marker = (version: number) =>
  JSON.stringify({ format: "agentlive-server-data", version });

it("stamps, preserves and refuses server data formats", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-data-format-"));
  const directory = join(root, "server");
  try {
    await (await RecordingStore.open(directory)).close();
    expect(
      JSON.parse(await readFile(join(directory, "format.json"), "utf8")),
    ).toEqual({
      format: "agentlive-server-data",
      version: SERVER_DATA_FORMAT,
    });

    // Directories created before the marker existed are format 1 and get stamped.
    await unlink(join(directory, "format.json"));
    await (await RecordingStore.open(directory)).close();
    expect(
      JSON.parse(await readFile(join(directory, "format.json"), "utf8"))
        .version,
    ).toBe(1);

    // A newer format is refused before any other state is touched.
    await writeFile(
      join(directory, "format.json"),
      marker(SERVER_DATA_FORMAT + 1),
    );
    const sessionsBefore = await stat(join(directory, "sessions"));
    const refusal = RecordingStore.open(directory);
    await expect(refusal).rejects.toBeInstanceOf(UnsupportedDataFormatError);
    await expect(RecordingStore.open(directory)).rejects.toThrow(
      "newer AgentLive",
    );
    expect((await stat(join(directory, "sessions"))).mtimeMs).toBe(
      sessionsBefore.mtimeMs,
    );
    expect(
      JSON.parse(await readFile(join(directory, "format.json"), "utf8"))
        .version,
    ).toBe(SERVER_DATA_FORMAT + 1);

    for (const invalid of [
      "{",
      JSON.stringify({ format: "other", version: 1 }),
      marker(0),
    ]) {
      await writeFile(join(directory, "format.json"), invalid);
      await expect(RecordingStore.open(directory)).rejects.toThrow(
        "Invalid server data format marker",
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("backs up the marker and refuses to restore a newer-format backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-data-format-backup-"));
  const state = join(root, "state");
  const output = join(root, "backup");
  const signal = AbortSignal.timeout(20000);
  try {
    await (await RecordingStore.open(join(state, "server"))).close();
    const ownerFile = join(state, "owner.json");
    await writeFile(
      ownerFile,
      JSON.stringify({ version: 1, secret: "a".repeat(64) }),
      { mode: 0o600 },
    );
    await backupServer({
      directory: join(state, "server"),
      ownerFile,
      output,
      signal,
    });
    const manifestPath = join(output, "backup.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const entry = manifest.files.find(
      (file: { path: string }) => file.path === "server/format.json",
    );
    expect(entry).toBeTruthy();

    // A current-format backup restores normally.
    const restored = await restoreServer({
      source: output,
      output: join(root, "restored"),
      signal,
    });
    expect(restored.recordings).toBe(0);
    expect(
      JSON.parse(
        await readFile(join(root, "restored", "server", "format.json"), "utf8"),
      ).version,
    ).toBe(SERVER_DATA_FORMAT);

    // Simulate a backup taken by a newer release: consistent manifest, newer marker.
    const newer = Buffer.from(marker(SERVER_DATA_FORMAT + 1));
    await writeFile(join(output, "server", "format.json"), newer);
    entry.byteSize = newer.length;
    entry.hash = createHash("sha256").update(newer).digest("hex");
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(
      restoreServer({ source: output, output: join(root, "refused"), signal }),
    ).rejects.toBeInstanceOf(UnsupportedDataFormatError);
    await expect(stat(join(root, "refused"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
