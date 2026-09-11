import { expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Accounts } from "../../packages/server/src/accounts.js";
import { AccountSessions } from "../../packages/server/src/account-sessions.js";

it("persists sealed sessions and revocation, checks CSRF, and never resurrects sessions after account re-enable", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-account-sessions-"));
  const accounts = await Accounts.open(join(root, "accounts"));
  const path = join(root, "sessions.json"),
    password = "p".repeat(64);
  let sessions = await AccountSessions.open(path, accounts, password);
  try {
    const account = await accounts.resolveVerifiedIdentity({
      issuer: "https://id.example",
      subject: "one",
      displayName: "One",
    });
    const other = await accounts.resolveVerifiedIdentity({
      issuer: "https://id.example",
      subject: "two",
      displayName: "Two",
    });
    const first = await sessions.issue(account.id),
      second = await sessions.issue(other.id);
    expect((await sessions.authenticate(first.cookie))?.account.id).toBe(
      account.id,
    );
    expect((await sessions.authenticate(second.cookie))?.account.id).toBe(
      other.id,
    );
    expect(AccountSessions.validCsrf(first.csrf, first.csrf)).toBe(true);
    expect(AccountSessions.validCsrf(first.csrf, second.csrf)).toBe(false);
    expect(AccountSessions.validCsrf(first.csrf, undefined)).toBe(false);
    expect(
      await sessions.authenticate("tampered" + first.cookie),
    ).toBeUndefined();
    const disk = await readFile(path, "utf8");
    expect(disk).not.toContain(first.cookie);
    expect(disk).not.toContain(first.csrf);
    await expect(
      AccountSessions.open(path, accounts, password),
    ).rejects.toThrow();
    await sessions.close();
    sessions = await AccountSessions.open(path, accounts, password);
    expect((await sessions.authenticate(first.cookie))?.account.id).toBe(
      account.id,
    );
    expect(await sessions.revoke(first.cookie)).toBe(true);
    expect(await sessions.revoke(first.cookie)).toBe(false);
    expect(await sessions.authenticate(first.cookie)).toBeUndefined();
    await sessions.close();
    sessions = await AccountSessions.open(path, accounts, password);
    expect(await sessions.authenticate(first.cookie)).toBeUndefined();
    expect((await sessions.authenticate(second.cookie))?.account.id).toBe(
      other.id,
    );
    const disabled = await accounts.setDisabled(other.id, other.version, true);
    expect(await sessions.authenticate(second.cookie)).toBeUndefined();
    await accounts.setDisabled(other.id, disabled.version, false);
    expect(await sessions.authenticate(second.cookie)).toBeUndefined();
    const renewed = await sessions.issue(other.id);
    expect((await sessions.authenticate(renewed.cookie))?.account.id).toBe(
      other.id,
    );
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.now() + 9 * 3600000);
    try {
      expect(await sessions.authenticate(renewed.cookie)).toBeUndefined();
    } finally {
      clock.mockRestore();
    }
  } finally {
    await sessions.close();
    await accounts.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps sessions valid after failed revocation persistence and invalidates them when the sealing key changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-session-failure-"));
  const accounts = await Accounts.open(join(root, "accounts"));
  const path = join(root, "sessions.json");
  let sessions = await AccountSessions.open(path, accounts, "a".repeat(64));
  try {
    const account = await accounts.resolveVerifiedIdentity({
      issuer: "https://id.example",
      subject: "one",
      displayName: "One",
    });
    const issued = await sessions.issue(account.id);
    const save = vi
      .spyOn(sessions as unknown as { save: () => Promise<void> }, "save")
      .mockRejectedValueOnce(new Error("disk full"));
    await expect(sessions.revoke(issued.cookie)).rejects.toThrow("disk full");
    save.mockRestore();
    expect((await sessions.authenticate(issued.cookie))?.account.id).toBe(
      account.id,
    );
    await sessions.close();
    sessions = await AccountSessions.open(path, accounts, "b".repeat(64));
    expect(await sessions.authenticate(issued.cookie)).toBeUndefined();
    expect(await sessions.revoke("bad-cookie")).toBe(false);
  } finally {
    await sessions.close();
    await accounts.close();
    await rm(root, { recursive: true, force: true });
  }
});
