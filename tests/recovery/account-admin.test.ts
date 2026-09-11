import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { startServer } from "../../packages/server/src/http.js";
import { Accounts } from "../../packages/server/src/accounts.js";
import { AccountSessions } from "../../packages/server/src/account-sessions.js";

const { WebSocket } = createRequire(
  new URL("../../packages/server/package.json", import.meta.url),
)("ws") as typeof import("ws");
const exec = promisify(execFile);
const cli = resolve("packages/cli/dist/main.js");
const ownerSecret = "a".repeat(64);
const password = "p".repeat(64),
  issuer = "https://id.example",
  origin = "https://app.example";

async function hostedServer(root: string) {
  const accounts = await Accounts.open(join(root, "accounts"));
  const sessions = await AccountSessions.open(
    join(root, "account-sessions.json"),
    accounts,
    password,
  );
  const target = await accounts.resolveVerifiedIdentity({
    issuer,
    subject: "target-subject",
    displayName: "Target",
  });
  const other = await accounts.resolveVerifiedIdentity({
    issuer,
    subject: "other-subject",
    displayName: "Other",
  });
  const device = await sessions.issueDevice(target.id);
  const otherDevice = await sessions.issueDevice(other.id);
  await sessions.close();
  await accounts.close();
  const server = await startServer({
    directory: root,
    ownerSecret,
    port: 0,
    publicOrigin: origin,
    hosted: {
      issuer,
      clientId: "client",
      clientSecret: "secret",
      cookiePassword: password,
      fetch: async () =>
        Response.json({
          issuer,
          authorization_endpoint: issuer + "/authorize",
          token_endpoint: issuer + "/token",
          jwks_uri: issuer + "/jwks",
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
        }),
    },
  });
  return { server, target, other, device, otherDevice };
}

it("lets only the operator list, disable and re-enable hosted accounts, ending sessions and sockets immediately", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-account-admin-"));
  const { server, target, other, device, otherDevice } =
    await hostedServer(root);
  const operator = { authorization: `Bearer ${ownerSecret}` };
  const sockets: import("ws").WebSocket[] = [];
  try {
    const recording = await (
      await fetch(server.url + "/api/v1/streams", {
        method: "POST",
        headers: {
          authorization: `Bearer ${device.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          requestId: "admin-owned",
          requestedAt: new Date().toISOString(),
          publisherId: "pub",
          producerEpoch: "epoch",
          writeSecret: "b".repeat(64),
          title: "Owned",
          visibility: "private",
        }),
      })
    ).json();
    const metadata = `${server.url}/api/v1/streams/${recording.streamId}`;
    const asDevice = (token: string) => ({ authorization: `Bearer ${token}` });
    expect(
      (await fetch(metadata, { headers: asDevice(device.token) })).status,
    ).toBe(200);

    // Listing is operator-only and never exposes identity subjects.
    for (const headers of [
      {},
      asDevice(device.token),
      { authorization: "Bearer " + "c".repeat(64) },
    ])
      expect(
        (await fetch(server.url + "/api/v1/admin/accounts", { headers }))
          .status,
      ).toBe(401);
    const listed = await (
      await fetch(server.url + "/api/v1/admin/accounts?limit=1", {
        headers: operator,
      })
    ).json();
    expect(listed.accounts).toHaveLength(1);
    expect(listed.nextAfter).toBe(listed.accounts[0].id);
    const second = await (
      await fetch(
        `${server.url}/api/v1/admin/accounts?after=${listed.nextAfter}`,
        { headers: operator },
      )
    ).json();
    const all = [...listed.accounts, ...second.accounts];
    expect(all.map((account: { id: string }) => account.id).sort()).toEqual(
      [target.id, other.id].sort(),
    );
    expect(JSON.stringify(all)).not.toContain("subject");
    expect(all.find((account) => account.id === target.id)).toMatchObject({
      issuer,
      displayName: "Target",
      disabled: false,
    });

    const socket = new WebSocket(
      server.url.replace("http:", "ws:") + "/api/v1/watch",
      {
        headers: asDevice(device.token),
      },
    );
    sockets.push(socket);
    const messages: { type: string }[] = [];
    socket.on("message", (bytes: Buffer) =>
      messages.push(JSON.parse(bytes.toString())),
    );
    const closed = new Promise<number>((resolve) =>
      socket.once("close", resolve),
    );
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(
      JSON.stringify({
        type: "subscribe",
        protocolVersion: 1,
        requestId: "sub",
        streamId: recording.streamId,
        revision: recording.revision,
        afterServerSeq: 0,
      }),
    );
    await expect
      .poll(() => messages.some((message) => message.type === "subscribed"))
      .toBe(true);

    const status = (
      body: unknown,
      headers: Record<string, string> = operator,
    ) =>
      fetch(`${server.url}/api/v1/admin/accounts/${target.id}/status`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect(
      (
        await status(
          { disabled: true, expectedVersion: target.version },
          asDevice(device.token),
        )
      ).status,
    ).toBe(401);
    expect(
      (await status({ disabled: true, expectedVersion: target.version + 5 }))
        .status,
    ).toBe(409);
    expect(
      (await status({ disabled: "yes", expectedVersion: target.version }))
        .status,
    ).toBe(400);
    const disabled = await (
      await status({ disabled: true, expectedVersion: target.version })
    ).json();
    expect(disabled).toMatchObject({
      id: target.id,
      disabled: true,
      version: target.version + 1,
    });
    expect(
      await Promise.race([
        closed,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("socket stayed open")), 3000),
        ),
      ]),
    ).toBe(1008);
    expect(
      (await fetch(metadata, { headers: asDevice(device.token) })).status,
    ).not.toBe(200);
    // Other accounts are unaffected.
    expect(
      (
        await fetch(server.url + "/api/v1/streams?limit=1", {
          headers: asDevice(otherDevice.token),
        })
      ).status,
    ).toBe(200);

    // Re-enabling keeps credentials issued before the disable invalid.
    const enabled = await (
      await status({ disabled: false, expectedVersion: disabled.version })
    ).json();
    expect(enabled).toMatchObject({
      disabled: false,
      version: disabled.version + 1,
    });
    expect(
      (await fetch(metadata, { headers: asDevice(device.token) })).status,
    ).not.toBe(200);

    // The CLI uses the same operator routes.
    const env = {
      PATH: process.env.PATH ?? "",
      AGENTLIVE_OWNER_SECRET: ownerSecret,
    };
    const page = JSON.parse(
      (
        await exec(
          process.execPath,
          [cli, "accounts", "--server", server.url, "--state-dir", root],
          { env },
        )
      ).stdout,
    );
    expect(page.accounts).toHaveLength(2);
    const cliDisabled = JSON.parse(
      (
        await exec(
          process.execPath,
          [
            cli,
            "account-status",
            "--server",
            server.url,
            "--state-dir",
            root,
            "--account-id",
            target.id,
            "--action",
            "disable",
            "--expected-version",
            String(enabled.version),
          ],
          { env },
        )
      ).stdout,
    );
    expect(cliDisabled).toMatchObject({
      disabled: true,
      version: enabled.version + 1,
    });
  } finally {
    for (const socket of sockets) socket.terminate();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

it("reports hosted account administration as unavailable on a standalone server", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-account-admin-local-"));
  const server = await startServer({ directory: root, ownerSecret, port: 0 });
  try {
    expect(
      (
        await fetch(server.url + "/api/v1/admin/accounts", {
          headers: { authorization: `Bearer ${ownerSecret}` },
        })
      ).status,
    ).toBe(404);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
