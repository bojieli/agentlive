import { expect, it, vi } from "vitest";
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  chmod,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Accounts } from "../../packages/server/src/accounts.js";

it("preserves exact issuer/subject identity across concurrent login, disable, profile changes and restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-accounts-"));
  let accounts = await Accounts.open(join(root, "accounts"));
  const identity = {
    issuer: "https://identity.example/tenant",
    subject: "same-subject",
    displayName: "Reviewer",
  };
  try {
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        accounts.resolveVerifiedIdentity(identity),
      ),
    );
    expect(new Set(results.map((account) => account.id)).size).toBe(1);
    const first = results[0]!;
    expect(first.version).toBe(1);
    expect(first).not.toHaveProperty("issuer");
    expect(first).not.toHaveProperty("subject");
    const different = await accounts.resolveVerifiedIdentity({
      ...identity,
      issuer: "https://other.example/tenant",
    });
    const slash = await accounts.resolveVerifiedIdentity({
      ...identity,
      issuer: identity.issuer + "/",
    });
    expect(new Set([first.id, different.id, slash.id]).size).toBe(3);
    await expect(Accounts.open(join(root, "accounts"))).rejects.toThrow();
    const renamed = await accounts.resolveVerifiedIdentity({
      ...identity,
      displayName: "New name",
    });
    expect(renamed).toMatchObject({ id: first.id, version: 2 });
    const disabled = await accounts.setDisabled(
      first.id,
      renamed.version,
      true,
    );
    expect(disabled).toMatchObject({ version: 3, disabled: true });
    await expect(
      accounts.resolveVerifiedIdentity({
        ...identity,
        displayName: "Reenabled?",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      accounts.setDisabled(first.id, 2, false),
    ).rejects.toMatchObject({ code: "precondition_failed" });
    expect(accounts.get(different.id)?.disabled).toBe(false);
    disabled.disabled = false;
    expect(accounts.get(first.id)?.disabled).toBe(true);
    await accounts.close();
    accounts = await Accounts.open(join(root, "accounts"));
    expect(accounts.get(first.id)).toMatchObject({
      disabled: true,
      displayName: "New name",
      version: 3,
    });
    await expect(
      accounts.resolveVerifiedIdentity(identity),
    ).rejects.toMatchObject({ code: "forbidden" });
    await accounts.setDisabled(first.id, 3, false);
    expect((await accounts.resolveVerifiedIdentity(identity)).id).toBe(
      first.id,
    );
  } finally {
    await accounts.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects malformed/ambiguous durable identities and unsafe account files", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-account-files-"));
  const directory = join(root, "accounts");
  const accounts = await Accounts.open(directory);
  const account = await accounts.resolveVerifiedIdentity({
    issuer: "https://identity.example",
    subject: "s",
    displayName: "Name",
  });
  await accounts.close();
  try {
    const path = join(directory, account.id + ".json");
    const saved = await readFile(path, "utf8");
    await chmod(path, 0o644);
    await expect(Accounts.open(directory)).rejects.toThrow(
      "Invalid account file",
    );
    await chmod(path, 0o600);
    const duplicate = randomUUID();
    const duplicatePath = join(directory, duplicate + ".json");
    await writeFile(
      duplicatePath,
      JSON.stringify({ ...JSON.parse(saved), id: duplicate }),
      { mode: 0o600 },
    );
    await expect(Accounts.open(directory)).rejects.toThrow(
      "Conflicting account identity",
    );
    await rm(duplicatePath);
    await symlink(path, duplicatePath);
    await expect(Accounts.open(directory)).rejects.toThrow(
      "Unexpected account directory entry",
    );
    await rm(duplicatePath);
    await writeFile(path, "private identity text that is not JSON");
    await expect(Accounts.open(directory)).rejects.toThrow(
      /^Invalid account record$/,
    );
    await writeFile(path, saved);
    const reopened = await Accounts.open(directory);
    await reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("does not publish failed account writes or silently exceed mutation admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-account-write-"));
  const accounts = await Accounts.open(join(root, "accounts"));
  const identity = {
    issuer: "https://identity.example",
    subject: "s",
    displayName: "Name",
  };
  try {
    const account = await accounts.resolveVerifiedIdentity(identity);
    const save = vi
      .spyOn(accounts as unknown as { save: () => Promise<void> }, "save")
      .mockRejectedValueOnce(new Error("disk full"));
    await expect(accounts.setDisabled(account.id, 1, true)).rejects.toThrow(
      "disk full",
    );
    save.mockRestore();
    expect(accounts.get(account.id)).toMatchObject({
      version: 1,
      disabled: false,
    });
    const outcomes = await Promise.allSettled(
      Array.from({ length: 33 }, () =>
        accounts.resolveVerifiedIdentity(identity),
      ),
    );
    expect(
      outcomes.filter((outcome) => outcome.status === "rejected"),
    ).toHaveLength(1);
    await accounts.close();
    await expect(accounts.resolveVerifiedIdentity(identity)).rejects.toThrow(
      "closing",
    );
  } finally {
    await accounts.close();
    await rm(root, { recursive: true, force: true });
  }
});
