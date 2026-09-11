import { expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Accounts } from "../../packages/server/src/accounts.js";
import { AccountSessions } from "../../packages/server/src/account-sessions.js";
import { DeviceLinks } from "../../packages/server/src/device-links.js";

it("requires browser approval, repeats lost poll results, persists scoped device credentials and revokes them", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-device-"));
  const accounts = await Accounts.open(join(root, "accounts"));
  const path = join(root, "sessions.json"),
    password = "p".repeat(64);
  let sessions = await AccountSessions.open(path, accounts, password);
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  try {
    const account = await accounts.resolveVerifiedIdentity({
      issuer: "https://id.example",
      subject: "device",
      displayName: "Device user",
    });
    const browser = await sessions.issue(account.id);
    const links = new DeviceLinks(sessions);
    const link = links.begin();
    expect(links.poll(link.deviceCode)).toMatchObject({ status: "slow_down" });
    now += 5000;
    expect(links.poll(link.deviceCode)).toEqual({ status: "pending" });
    await expect(links.decide(link.userCode, "invalid", true)).rejects.toThrow(
      "Sign in",
    );
    await links.decide(link.userCode, browser.cookie, true);
    await expect(
      links.decide(link.userCode, browser.cookie, true),
    ).rejects.toThrow("already decided");
    now += 5000;
    const approved = links.poll(link.deviceCode);
    expect(approved.status).toBe("approved");
    if (approved.status !== "approved")
      throw new Error("Device was not approved");
    expect(sessions.authenticateDevice(approved.token)?.account.id).toBe(
      account.id,
    );
    const listed = await sessions.listDevices(account.id);
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(approved.token);
    expect(JSON.stringify(listed)).not.toContain("hash");
    expect(
      await sessions.revokeAccountDevice(
        "00000000-0000-4000-8000-000000000000",
        listed[0]!.id,
      ),
    ).toBe(false);
    expect(await sessions.authenticate(approved.token)).toBeUndefined();
    expect(sessions.authenticateDevice(browser.cookie)).toBeUndefined();
    now += 5000;
    expect(links.poll(link.deviceCode)).toEqual(approved);
    expect(await readFile(path, "utf8")).not.toContain(approved.token);
    await sessions.close();
    const legacy = JSON.parse(await readFile(path, "utf8"));
    for (const record of legacy.sessions) {
      delete record.managementId;
      delete record.createdAt;
    }
    await writeFile(path, JSON.stringify(legacy));
    sessions = await AccountSessions.open(path, accounts, password);
    expect(sessions.authenticateDevice(approved.token)?.account.id).toBe(
      account.id,
    );
    expect(new DeviceLinks(sessions).poll(link.deviceCode)).toEqual({
      status: "expired",
    });
    const migrated = (await sessions.listDevices(account.id))[0]!;
    expect(migrated.createdAt).toBeNull();
    await sessions.close();
    sessions = await AccountSessions.open(path, accounts, password);
    expect((await sessions.listDevices(account.id))[0]!.id).toBe(migrated.id);
    expect(await sessions.revokeAccountDevice(account.id, migrated.id)).toBe(
      true,
    );
    expect(await sessions.revokeDevice(approved.token)).toBe(false);
    expect(sessions.authenticateDevice(approved.token)).toBeUndefined();
    const second = await sessions.issueDevice(account.id);
    const disabled = await accounts.setDisabled(
      account.id,
      account.version,
      true,
    );
    expect(sessions.authenticateDevice(second.token)).toBeUndefined();
    await accounts.setDisabled(account.id, disabled.version, false);
    expect(sessions.authenticateDevice(second.token)).toBeUndefined();
  } finally {
    clock.mockRestore();
    await sessions.close();
    await accounts.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("expires/denies requests, bounds anonymous starts, and cannot approve after logout", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-device-deny-"));
  const accounts = await Accounts.open(join(root, "accounts"));
  const sessions = await AccountSessions.open(
    join(root, "sessions.json"),
    accounts,
    "p".repeat(64),
  );
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  try {
    const account = await accounts.resolveVerifiedIdentity({
      issuer: "https://id.example",
      subject: "device",
      displayName: "Device",
    });
    const browser = await sessions.issue(account.id);
    const links = new DeviceLinks(sessions);
    const denied = links.begin();
    await links.decide(denied.userCode, browser.cookie, false);
    now += 5000;
    expect(links.poll(denied.deviceCode)).toEqual({ status: "denied" });
    const expired = links.begin();
    now += 600001;
    expect(links.poll(expired.deviceCode)).toEqual({ status: "expired" });
    await expect(
      links.decide(expired.userCode, browser.cookie, true),
    ).rejects.toThrow("expired");
    const pending = links.begin();
    await sessions.revoke(browser.cookie);
    await expect(
      links.decide(pending.userCode, browser.cookie, true),
    ).rejects.toThrow("Sign in");
    for (let i = 1; i < 32; i++) links.begin();
    expect(() => links.begin()).toThrow("capacity");
    now += 60000;
    expect(() => links.begin()).not.toThrow();
  } finally {
    clock.mockRestore();
    await sessions.close();
    await accounts.close();
    await rm(root, { recursive: true, force: true });
  }
});
