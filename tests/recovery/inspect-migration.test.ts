import { expect, it } from "vitest";
import { mkdtemp, rm, readFile, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PublisherJournal } from "../../packages/publisher/src/index.js";
import { inspectMigration } from "../../packages/cli/src/inspect-migration.js";
it("inspects a frozen binding without changing metadata or exposing credentials, and excludes concurrent writers", async () => {
  const root = await mkdtemp(join(tmpdir(), "migration-inspect-"));
  const journal = await PublisherJournal.open(root, {
    serverOrigin: "https://example.com",
    agent: "opencode",
    nativeSessionId: "native",
  });
  const directory = journal.directory;
  try {
    await expect(inspectMigration(directory)).rejects.toThrow();
    await journal.bindRemote("stream", "revision");
    const secret = journal.identity.writeSecret;
    await journal.close();
    const manifest = {
      version: 1,
      converterVersion: "opencode-snapshot-4",
      filterFingerprint: "a".repeat(64),
      nativeSessionId: "native",
      sourceBytes: 12,
      sourcePrefix: "b".repeat(64),
      title: "Private title",
      extra: secret,
    };
    await writeFile(join(directory, "import.json"), JSON.stringify(manifest), {
      mode: 0o600,
    });
    const before = await readFile(join(directory, "binding.json"), "utf8");
    const result = await inspectMigration(directory);
    expect(result).toMatchObject({
      mode: "import",
      sourceBoundary: { bytes: 12, prefixHash: "b".repeat(64) },
      migrationImplemented: false,
      verification: "metadata-only",
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("Private title");
    expect(await readFile(join(directory, "binding.json"), "utf8")).toBe(
      before,
    );
    const cli = await promisify(execFile)(
      process.execPath,
      ["packages/cli/dist/main.js", "inspect-migration", "--source", directory],
      { timeout: 10000 },
    );
    expect(JSON.parse(cli.stdout)).toEqual(result);
    expect(cli.stderr).toBe("");
    await rm(join(directory, "import.json"));
    await symlink(
      join(directory, "binding.json"),
      join(directory, "import.json"),
    );
    await expect(inspectMigration(directory)).rejects.toThrow(
      "Cannot read migration metadata",
    );
    await rm(join(directory, "import.json"));
    await writeFile(
      join(directory, "import.json"),
      JSON.stringify({ ...manifest, nativeSessionId: secret }),
      { mode: 0o600 },
    );
    await expect(inspectMigration(directory)).rejects.toThrow(
      "Invalid publisher migration metadata schema",
    );
  } finally {
    await journal.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("verifies moved frozen prefixes, rejects changed/truncated sources and distinguishes appended suffixes", async () => {
  const { createHash } = await import("node:crypto");
  const root = await mkdtemp(join(tmpdir(), "migration-source-"));
  const journal = await PublisherJournal.open(root, {
    serverOrigin: "https://example.com",
    agent: "claude",
    nativeSessionId: "native",
  });
  const directory = journal.directory;
  await journal.close();
  try {
    const prefix = '{"sessionId":"native"}\n';
    await writeFile(
      join(directory, "import.json"),
      JSON.stringify({
        version: 1,
        converterVersion: "claude-history-4",
        filterFingerprint: "a".repeat(64),
        nativeSessionId: "native",
        sourceBytes: Buffer.byteLength(prefix),
        sourcePrefix: createHash("sha256").update(prefix).digest("hex"),
      }),
      { mode: 0o600 },
    );
    const source = join(root, "moved.jsonl");
    await writeFile(source, prefix + '{"new":"suffix"}\n');
    const inspected = await inspectMigration(directory, {
      nativeSource: source,
    });
    expect(inspected).toMatchObject({
      verification: "frozen-import-prefix",
      sourceVerification: {
        verifiedBytes: Buffer.byteLength(prefix),
        remainingBytes: 17,
        completeLineBoundary: true,
      },
    });
    const cli = await promisify(execFile)(
      process.execPath,
      [
        "packages/cli/dist/main.js",
        "inspect-migration",
        "--source",
        directory,
        "--native-source",
        source,
      ],
      { timeout: 10000 },
    );
    expect(JSON.parse(cli.stdout)).toEqual(inspected);
    await writeFile(source, prefix.replace("native", "change"));
    await expect(
      inspectMigration(directory, { nativeSource: source }),
    ).rejects.toThrow("prefix differs");
    await writeFile(source, "short");
    await expect(
      inspectMigration(directory, { nativeSource: source }),
    ).rejects.toThrow("truncated");
    const stop = new AbortController();
    stop.abort(new Error("cancelled"));
    await expect(
      inspectMigration(directory, {
        nativeSource: source,
        signal: stop.signal,
      }),
    ).rejects.toBe(stop.signal.reason);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("verifies every pinned child and refuses changed family bytes without exposing paths", async () => {
  const { createHash } = await import("node:crypto");
  const root = await mkdtemp(join(tmpdir(), "migration-family-"));
  const journal = await PublisherJournal.open(root, {
    serverOrigin: "https://example.com",
    agent: "opencode",
    nativeSessionId: "native",
  });
  const directory = journal.directory;
  await journal.close();
  try {
    const source = join(root, "root.json"),
      child = join(root, "private-child-path.json");
    const bytes = '{"fixture":true}';
    const digest = createHash("sha256").update(bytes).digest("hex");
    await writeFile(source, bytes);
    await writeFile(child, bytes);
    await writeFile(
      join(directory, "import.json"),
      JSON.stringify({
        version: 1,
        converterVersion: "opencode-snapshot-4-family-import-1",
        filterFingerprint: "a".repeat(64),
        nativeSessionId: "native",
        sourceBytes: bytes.length,
        sourcePrefix: digest,
        familySources: [
          {
            sourcePath: child,
            nativeAgent: "child",
            boundary: { offset: bytes.length, prefixHash: digest },
          },
        ],
      }),
      { mode: 0o600 },
    );
    const result = await inspectMigration(directory, {
      nativeSource: source,
      verifyFamily: true,
    });
    expect(result).toMatchObject({
      verification: "frozen-import-family-prefixes",
      familyVerification: {
        verifiedSources: 1,
        verifiedBytes: bytes.length,
        remainingBytes: 0,
      },
    });
    expect(JSON.stringify(result)).not.toContain(child);
    const cli = await promisify(execFile)(
      process.execPath,
      [
        "packages/cli/dist/main.js",
        "inspect-migration",
        "--source",
        directory,
        "--native-source",
        source,
        "--verify-family",
      ],
      { timeout: 10000 },
    );
    expect(JSON.parse(cli.stdout)).toEqual(result);
    const moved = join(root, "moved=child.json");
    await writeFile(moved, bytes);
    await rm(child);
    const beforeManifest = await readFile(
      join(directory, "import.json"),
      "utf8",
    );
    const mapping = `child=${moved}`;
    expect(
      await inspectMigration(directory, {
        nativeSource: source,
        verifyFamily: true,
        familySources: [mapping],
      }),
    ).toEqual(result);
    const movedCli = await promisify(execFile)(
      process.execPath,
      [
        "packages/cli/dist/main.js",
        "inspect-migration",
        "--source",
        directory,
        "--native-source",
        source,
        "--verify-family",
        "--family-source",
        mapping,
      ],
      { timeout: 10000 },
    );
    expect(JSON.parse(movedCli.stdout)).toEqual(result);
    expect(await readFile(join(directory, "import.json"), "utf8")).toBe(
      beforeManifest,
    );
    await expect(
      inspectMigration(directory, {
        nativeSource: source,
        verifyFamily: true,
        familySources: [`unknown=${moved}`],
      }),
    ).rejects.toThrow("does not belong");
    await expect(
      inspectMigration(directory, {
        nativeSource: source,
        verifyFamily: true,
        familySources: [mapping, mapping],
      }),
    ).rejects.toThrow("duplicate");
    await expect(
      inspectMigration(directory, {
        nativeSource: source,
        familySources: [mapping],
      }),
    ).rejects.toThrow("require --verify-family");
    await writeFile(moved, '{"fixture":null}');
    await expect(
      inspectMigration(directory, {
        nativeSource: source,
        verifyFamily: true,
        familySources: [mapping],
      }),
    ).rejects.toThrow("verification failed");
    await writeFile(child, '{"fixture":null}');
    await expect(
      inspectMigration(directory, { nativeSource: source, verifyFamily: true }),
    ).rejects.toThrow("Imported family source verification failed");
    expect(
      (await inspectMigration(directory, { nativeSource: source }))
        .verification,
    ).toBe("frozen-import-prefix");
    await expect(
      inspectMigration(directory, { verifyFamily: true }),
    ).rejects.toThrow("requires --native-source");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("commits verified child relocation and retries after a manifest commit with an unfinished intent", async () => {
  const { createHash } = await import("node:crypto");
  const { relocateImportSources } =
    await import("../../packages/cli/src/inspect-migration.js");
  const root = await mkdtemp(join(tmpdir(), "relocate-import-"));
  const journal = await PublisherJournal.open(root, {
    serverOrigin: "https://example.com",
    agent: "opencode",
    nativeSessionId: "native",
  });
  const directory = journal.directory;
  await journal.close();
  try {
    const bytes = '{"fixture":true}',
      digest = createHash("sha256").update(bytes).digest("hex");
    const source = join(root, "root.json"),
      child = join(root, "moved.json");
    await writeFile(source, bytes);
    await writeFile(child, bytes);
    const manifest = {
      version: 1,
      converterVersion: "opencode-snapshot-4-family-import-1",
      filterFingerprint: "a".repeat(64),
      nativeSessionId: "native",
      sourceBytes: bytes.length,
      sourcePrefix: digest,
      familySources: [
        {
          sourcePath: join(root, "old.json"),
          nativeAgent: "child",
          boundary: { offset: bytes.length, prefixHash: digest },
        },
      ],
    };
    await writeFile(join(directory, "import.json"), JSON.stringify(manifest), {
      mode: 0o600,
    });
    const inspected = await inspectMigration(directory);
    const options = {
      nativeSource: source,
      familySources: [`child=${child}`],
      operationId: "relocate-one",
      expectedManifestHash: inspected.imported!.manifestHash,
    };
    const bindingBefore = await readFile(
      join(directory, "binding.json"),
      "utf8",
    );
    await expect(
      relocateImportSources(directory, {
        ...options,
        expectedManifestHash: "0".repeat(64),
      }),
    ).rejects.toThrow("changed since inspection");
    const receipt = await relocateImportSources(directory, options);
    expect(receipt.completed).toBe(true);
    expect(
      JSON.parse(await readFile(join(directory, "import.json"), "utf8")),
    ).toEqual({
      ...manifest,
      familySources: [{ ...manifest.familySources[0], sourcePath: child }],
    });
    expect(await relocateImportSources(directory, options)).toEqual(receipt);
    const intentPath = join(directory, "relocate-import.json");
    const intent = JSON.parse(await readFile(intentPath, "utf8"));
    await writeFile(
      intentPath,
      JSON.stringify({ ...intent, completed: false }),
    );
    const cli = await promisify(execFile)(
      process.execPath,
      [
        "packages/cli/dist/main.js",
        "relocate-import-sources",
        "--source",
        directory,
        "--native-source",
        source,
        "--family-source",
        options.familySources[0]!,
        "--operation-id",
        options.operationId,
        "--expected-manifest-hash",
        options.expectedManifestHash,
      ],
      { timeout: 10000 },
    );
    expect(JSON.parse(cli.stdout)).toEqual(receipt);
    // Recover the other interruption boundary: intent saved, manifest still old.
    await writeFile(join(directory, "import.json"), JSON.stringify(manifest));
    await writeFile(
      intentPath,
      JSON.stringify({ ...intent, completed: false }),
    );
    expect(await relocateImportSources(directory, options)).toEqual(receipt);
    expect(await readFile(join(directory, "binding.json"), "utf8")).toBe(
      bindingBefore,
    );
    await writeFile(join(directory, "publish.json"), "{}", { mode: 0o600 });
    await expect(relocateImportSources(directory, options)).rejects.toThrow(
      "without publishing",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses a byte-identical Claude child mapping outside the native live layout", async () => {
  const { createHash } = await import("node:crypto");
  const { relocateImportSources } =
    await import("../../packages/cli/src/inspect-migration.js");
  const root = await mkdtemp(join(tmpdir(), "relocate-layout-"));
  const journal = await PublisherJournal.open(root, {
    serverOrigin: "https://example.com",
    agent: "claude",
    nativeSessionId: "native",
  });
  const directory = journal.directory;
  await journal.close();
  try {
    const source = join(root, "root.jsonl"),
      child = join(root, "wrong-layout.jsonl");
    const bytes = "{}\n",
      digest = createHash("sha256").update(bytes).digest("hex");
    await writeFile(source, bytes);
    await writeFile(child, bytes);
    const manifest = JSON.stringify({
      version: 1,
      converterVersion: "claude-history-4-family-import-1",
      filterFingerprint: "a".repeat(64),
      nativeSessionId: "native",
      sourceBytes: bytes.length,
      sourcePrefix: digest,
      familySources: [
        {
          sourcePath: "old",
          nativeAgent: "child",
          boundary: { offset: bytes.length, prefixHash: digest },
        },
      ],
    });
    await writeFile(join(directory, "import.json"), manifest, { mode: 0o600 });
    const inspected = await inspectMigration(directory);
    await expect(
      relocateImportSources(directory, {
        nativeSource: source,
        familySources: [`child=${child}`],
        operationId: "layout",
        expectedManifestHash: inspected.imported!.manifestHash,
      }),
    ).rejects.toThrow("live family layout");
    expect(await readFile(join(directory, "import.json"), "utf8")).toBe(
      manifest,
    );
    await expect(
      readFile(join(directory, "relocate-import.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
