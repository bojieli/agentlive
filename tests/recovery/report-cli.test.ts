import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../packages/server/src/http.js";
const run = promisify(execFile);
it("lists reports and performs confirmed operator removal through the actual CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-report-cli-"));
  const owner = "a".repeat(64),
    writer = "b".repeat(64);
  const server = await startServer({
    directory: root,
    ownerSecret: owner,
    port: 0,
  });
  try {
    const session = await server.store.create({
      ownerId: "local",
      requestId: "report-cli",
      requestedAt: new Date().toISOString(),
      publisherId: "pub",
      producerEpoch: "epoch",
      writeSecret: writer,
      title: "CLI report",
      visibility: "public",
    });
    const { id, revision } = session.info;
    server.store.release(session);
    const receipt = await server.store.reports.submit(
      { operationId: "report", category: "privacy", details: "Review fixture" },
      id,
      revision,
    );
    const command = (name: string, args: string[] = [], credential = owner) =>
      run(
        process.execPath,
        ["packages/cli/dist/main.js", name, "--server", server.url, ...args],
        {
          env: { ...process.env, AGENTLIVE_OWNER_SECRET: credential },
          timeout: 10000,
        },
      );
    expect(JSON.parse((await command("reports")).stdout).reports[0].id).toBe(
      receipt.reportId,
    );
    await expect(command("reports", [], writer)).rejects.toThrow();
    await expect(
      command("reports", ["--account-file", "unused"]),
    ).rejects.toThrow();
    const args = [
      "--report-id",
      receipt.reportId,
      "--revision",
      revision,
      "--operation-id",
      "review",
      "--action",
      "remove",
      "--note",
      "Operator review completed",
    ];
    await expect(command("review-report", args)).rejects.toMatchObject({
      stderr: expect.stringContaining("--confirm-removal"),
    });
    expect((await server.store.reports.list()).reports[0].status).toBe("open");
    const result = await command("review-report", [
      ...args,
      "--confirm-removal",
    ]);
    expect(JSON.parse(result.stdout).status).toBe("removed");
    expect(
      (await command("review-report", [...args, "--confirm-removal"])).stdout,
    ).toBe(result.stdout);
    expect((await fetch(`${server.url}/api/v1/streams/${id}`)).status).toBe(
      404,
    );
    expect(result.stdout + result.stderr).not.toContain(owner);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
