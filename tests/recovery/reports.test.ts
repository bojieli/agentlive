import { expect, it } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../packages/server/src/http.js";

it("accepts readable-recording reports, protects operator details and preserves idempotency after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-reports-"));
  const owner = "a".repeat(64),
    writer = "b".repeat(64);
  let server = await startServer({
    directory: root,
    ownerSecret: owner,
    port: 0,
  });
  try {
    const ids = [];
    for (const visibility of ["public", "private"] as const) {
      const session = await server.store.create({
        ownerId: "local",
        requestId: visibility,
        requestedAt: new Date().toISOString(),
        publisherId: "pub",
        producerEpoch: "epoch",
        writeSecret: writer,
        title: "Report fixture",
        visibility,
      });
      ids.push(session.info.id);
      server.store.release(session);
    }
    const input = {
      operationId: "report-one",
      category: "privacy",
      details: "Please review this recording",
    };
    const submit = (id: string, body: unknown, credential = "") =>
      fetch(`${server.url}/api/v1/streams/${id}/reports`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(credential ? { authorization: `Bearer ${credential}` } : {}),
        },
        body: JSON.stringify(body),
      });
    expect((await submit(ids[1]!, input)).status).toBe(403);
    const response = await submit(ids[0]!, input);
    expect(response.status).toBe(201);
    const receipt = await response.json();
    expect(Object.keys(receipt).sort()).toEqual(["receivedAt", "reportId"]);
    expect(await (await submit(ids[0]!, input)).json()).toEqual(receipt);
    expect(
      (await submit(ids[0]!, { ...input, details: "changed" })).status,
    ).toBe(409);
    expect(
      (
        await submit(
          ids[1]!,
          { ...input, operationId: "private-report" },
          writer,
        )
      ).status,
    ).toBe(201);
    expect((await fetch(server.url + "/api/v1/reports")).status).toBe(401);
    expect(
      (
        await fetch(server.url + "/api/v1/reports", {
          headers: { authorization: `Bearer ${writer}` },
        })
      ).status,
    ).toBe(401);
    const list = () =>
      fetch(server.url + "/api/v1/reports?limit=1", {
        headers: { authorization: `Bearer ${owner}` },
      });
    const first = await (await list()).json();
    expect(first.reports).toHaveLength(1);
    expect(first.nextAfter).toBe(first.reports[0].id);
    expect((await stat(join(root, "reports.json"))).mode & 0o077).toBe(0);
    expect(await readFile(join(root, "reports.json"), "utf8")).not.toContain(
      writer,
    );
    await server.close();
    server = await startServer({
      directory: root,
      ownerSecret: owner,
      port: 0,
    });
    expect(await (await list()).json()).toEqual(first);
    expect(await (await submit(ids[0]!, input)).json()).toEqual(receipt);
    expect(
      (
        await submit(ids[0]!, {
          ...input,
          operationId: "oversize",
          details: "x".repeat(1001),
        })
      ).status,
    ).toBe(400);
    for (let i = 0; i < 32; i++)
      expect(
        (await submit(ids[0]!, { ...input, operationId: `limit-${i}` })).status,
      ).toBe(201);
    expect(
      (await submit(ids[0]!, { ...input, operationId: "excess" })).status,
    ).toBe(503);
    expect(await (await submit(ids[0]!, input)).json()).toEqual(receipt);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("restricts report decisions to operators, preserves dismissal receipts and rejects conflicting decisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-report-decisions-"));
  const owner = "c".repeat(64),
    writer = "d".repeat(64);
  const server = await startServer({
    directory: root,
    ownerSecret: owner,
    port: 0,
  });
  try {
    const session = await server.store.create({
      ownerId: "local",
      requestId: "decide",
      requestedAt: new Date().toISOString(),
      publisherId: "pub",
      producerEpoch: "epoch",
      writeSecret: writer,
      title: "Review",
      visibility: "public",
    });
    const { id, revision } = session.info;
    server.store.release(session);
    const input = {
      operationId: "submit",
      category: "spam" as const,
      details: "Review fixture",
    };
    const receipt = await server.store.reports.submit(input, id, revision);
    const decision = {
      operationId: "review-one",
      action: "dismiss",
      revision,
      note: "Reviewed and dismissed",
    };
    const call = (body: unknown, credential = owner) =>
      fetch(`${server.url}/api/v1/reports/${receipt.reportId}/decision`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${credential}`,
        },
        body: JSON.stringify(body),
      });
    expect((await call(decision, writer)).status).toBe(401);
    expect((await call({ ...decision, revision: "wrong" })).status).toBe(409);
    const response = await call(decision);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.status).toBe("dismissed");
    expect(await (await call(decision)).json()).toEqual(result);
    expect((await call({ ...decision, action: "remove" })).status).toBe(409);
    expect(await server.store.reports.submit(input, id, revision)).toEqual(
      receipt,
    );
    expect((await fetch(`${server.url}/api/v1/streams/${id}`)).status).toBe(
      200,
    );
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const removedBeforeFailure of [false, true])
  it(`retries durable operator removal after interruption (recording already removed: ${removedBeforeFailure})`, async () => {
    const { vi } = await import("vitest");
    const root = await mkdtemp(join(tmpdir(), "agentlive-report-retry-"));
    const owner = "e".repeat(64);
    let server = await startServer({
      directory: root,
      ownerSecret: owner,
      port: 0,
    });
    try {
      const session = await server.store.create({
        ownerId: "local",
        requestId: "retry",
        requestedAt: new Date().toISOString(),
        publisherId: "pub",
        producerEpoch: "epoch",
        writeSecret: "f".repeat(64),
        title: "Removal review",
        visibility: "public",
      });
      const { id, revision } = session.info;
      server.store.release(session);
      const receipt = await server.store.reports.submit(
        { operationId: "report", category: "privacy", details: "Review" },
        id,
        revision,
      );
      const decision = {
        operationId: "remove-reviewed",
        action: "remove",
        revision,
        note: "Operator reviewed",
      };
      const call = () =>
        fetch(`${server.url}/api/v1/reports/${receipt.reportId}/decision`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${owner}`,
          },
          body: JSON.stringify(decision),
        });
      const original = server.store.remove.bind(server.store);
      const failure = vi
        .spyOn(server.store, "remove")
        .mockImplementationOnce(async (input) => {
          if (removedBeforeFailure) await original(input);
          throw new Error("interrupted removal");
        });
      expect((await call()).status).toBe(503);
      failure.mockRestore();
      expect((await server.store.reports.list()).reports[0]).toMatchObject({
        status: "removing",
        decision,
      });
      await server.close();
      server = await startServer({
        directory: root,
        ownerSecret: owner,
        port: 0,
      });
      expect((await server.store.reports.list()).reports[0].status).toBe(
        "removing",
      );
      const response = await call();
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.status).toBe("removed");
      expect(await (await call()).json()).toEqual(result);
      expect((await fetch(`${server.url}/api/v1/streams/${id}`)).status).toBe(
        404,
      );
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

it("reconciles unresolved reports on restore while retaining old evidence and fencing stale decisions", async () => {
  const { writeFile } = await import("node:fs/promises");
  const { RecordingStore } = await import("../../packages/server/src/store.js");
  const { backupServer } = await import("../../packages/server/src/backup.js");
  const { restoreServer } =
    await import("../../packages/server/src/restore.js");
  const { decideReport, listReports } =
    await import("../../packages/client/src/reports.js");
  const root = await mkdtemp(join(tmpdir(), "agentlive-report-restore-"));
  const directory = join(root, "server"),
    owner = "a".repeat(64);
  const ownerFile = join(root, "owner.json");
  let store = await RecordingStore.open(directory);
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    await writeFile(ownerFile, JSON.stringify({ version: 1, secret: owner }), {
      mode: 0o600,
    });
    const session = await store.create({
      ownerId: "local",
      requestId: "restore-review",
      requestedAt: new Date().toISOString(),
      publisherId: "pub",
      producerEpoch: "epoch",
      writeSecret: "b".repeat(64),
      title: "Restored review",
      visibility: "public",
    });
    const { id, revision } = session.info;
    store.release(session);
    const input = {
      operationId: "original-report",
      category: "privacy" as const,
      details: "Original report evidence",
    };
    const receipt = await store.reports.submit(input, id, revision);
    const oldDecision = {
      operationId: "original-decision",
      revision,
      action: "remove" as const,
      note: "Original operator review",
    };
    await expect(
      store.reports.decide(receipt.reportId, oldDecision, async () => {
        throw new Error("interrupted");
      }),
    ).rejects.toThrow("interrupted");
    await store.close();
    const signal = AbortSignal.timeout(20000);
    await backupServer({
      directory,
      ownerFile,
      output: join(root, "backup"),
      signal,
    });
    const restored = await restoreServer({
      source: join(root, "backup"),
      output: join(root, "restored"),
      signal,
    });
    const nextRevision = restored.revisions[0]!.revision;
    expect(nextRevision).not.toBe(revision);
    server = await startServer({
      directory: join(root, "restored", "server"),
      ownerSecret: owner,
      port: 0,
    });
    const options = { serverOrigin: server.url, credential: owner, signal };
    const report = (await listReports(options)).reports[0]!;
    expect(report).toMatchObject({
      id: receipt.reportId,
      revision,
      reviewRevision: nextRevision,
      status: "open",
      details: input.details,
    });
    expect(report.decision).toBeUndefined();
    expect(report.reconciliations).toEqual([
      {
        previousRevision: revision,
        revision: nextRevision,
        restoredAt: expect.any(Number),
        previousDecision: oldDecision,
      },
    ]);
    await expect(
      decideReport({
        ...options,
        reportId: receipt.reportId,
        decision: oldDecision,
      }),
    ).rejects.toThrow();
    await expect(
      decideReport({
        ...options,
        reportId: receipt.reportId,
        decision: { ...oldDecision, revision: nextRevision },
      }),
    ).rejects.toThrow();
    expect((await fetch(`${server.url}/api/v1/streams/${id}`)).status).toBe(
      200,
    );
    const result = await decideReport({
      ...options,
      reportId: receipt.reportId,
      decision: {
        ...oldDecision,
        revision: nextRevision,
        operationId: "fresh-reviewed-decision",
        note: "Reviewed restored recording",
      },
    });
    expect(result.status).toBe("removed");
    expect(result.revision).toBe(revision);
    expect(result.reconciliations).toEqual(report.reconciliations);
    expect((await fetch(`${server.url}/api/v1/streams/${id}`)).status).toBe(
      404,
    );
  } finally {
    await server?.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
