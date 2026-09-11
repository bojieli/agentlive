import { randomBytes, createHash } from "node:crypto";
import { AccountSessions } from "./account-sessions.js";

type Link = {
  userCode: string;
  expiresAt: number;
  nextPoll: number;
  state: "pending" | "issuing" | "approved" | "denied";
  credential?: { token: string; expiresAt: number };
};
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export class DeviceLinks {
  private links = new Map<string, Link>();
  private codes = new Map<string, string>();
  private starts: number[] = [];
  private approvals: number[] = [];
  constructor(private sessions: AccountSessions) {}
  private prune() {
    const now = Date.now();
    for (const [key, link] of this.links)
      if (link.expiresAt <= now && link.state !== "issuing") {
        this.links.delete(key);
        this.codes.delete(link.userCode);
      }
    this.starts = this.starts.filter((time) => now - time < 60000);
    this.approvals = this.approvals.filter((time) => now - time < 60000);
  }
  begin() {
    this.prune();
    if (this.links.size >= 1024 || this.starts.length >= 32)
      throw new Error("Device login capacity is busy");
    this.starts.push(Date.now());
    const deviceCode = randomBytes(32).toString("hex");
    let userCode: string;
    do {
      userCode = randomBytes(5).toString("hex").toUpperCase();
    } while (this.codes.has(userCode));
    const key = hash(deviceCode);
    const expiresAt = Date.now() + 600000;
    this.links.set(key, {
      userCode,
      expiresAt,
      nextPoll: Date.now() + 5000,
      state: "pending",
    });
    this.codes.set(userCode, key);
    return { deviceCode, userCode, expiresAt, intervalSeconds: 5 };
  }
  poll(deviceCode: string) {
    this.prune();
    const link = /^[a-f0-9]{64}$/.test(deviceCode)
      ? this.links.get(hash(deviceCode))
      : undefined;
    if (!link || link.expiresAt <= Date.now())
      return { status: "expired" as const };
    if (Date.now() < link.nextPoll)
      return { status: "slow_down" as const, intervalSeconds: 5 };
    link.nextPoll = Date.now() + 5000;
    if (link.state === "approved") {
      if (!this.sessions.authenticateDevice(link.credential!.token))
        return { status: "denied" as const };
      // Keep the same result until link expiry so a lost polling response is retryable.
      return { status: "approved" as const, ...link.credential! };
    }
    return {
      status:
        link.state === "denied" ? ("denied" as const) : ("pending" as const),
    };
  }
  async decide(userCode: string, cookie: string, approve: boolean) {
    this.prune();
    if (this.approvals.length >= 64)
      throw new Error("Too many device decisions; retry later");
    this.approvals.push(Date.now());
    const principal = await this.sessions.authenticate(cookie);
    if (!principal) throw new Error("Sign in before linking a device");
    const normalized = userCode.toUpperCase().replaceAll("-", "");
    const key = /^[A-F0-9]{10}$/.test(normalized)
      ? this.codes.get(normalized)
      : undefined;
    const link = key ? this.links.get(key) : undefined;
    if (!link || link.expiresAt <= Date.now() || link.state !== "pending")
      throw new Error("Device code is expired or already decided");
    if (!approve) {
      link.state = "denied";
      return;
    }
    link.state = "issuing";
    try {
      const credential = await this.sessions.issueDevice(principal.account.id);
      if (!principal.isActive() || link.expiresAt <= Date.now()) {
        await this.sessions.revokeDevice(credential.token);
        link.state = "denied";
        throw new Error("Device authorization expired during approval");
      }
      link.credential = credential;
      link.state = "approved";
    } catch (error) {
      if (link.state === "issuing") link.state = "denied";
      throw error;
    }
  }
}
