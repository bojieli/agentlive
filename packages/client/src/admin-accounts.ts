import { z } from "zod";
import { request, originOf } from "./http.js";

const accountSchema = z.object({
  id: z.uuid(),
  issuer: z.string(),
  displayName: z.string(),
  version: z.number().int().positive().safe(),
  disabled: z.boolean(),
  authVersion: z.number().int().nonnegative().safe(),
  createdAt: z.number().int().nonnegative().safe(),
  updatedAt: z.number().int().nonnegative().safe(),
});

/** Operator-only listing of hosted accounts; never includes identity subjects. */
export async function listAccounts(options: {
  serverOrigin: string;
  credential: string;
  signal: AbortSignal;
  after?: string;
  limit?: number;
  fetch?: typeof fetch;
}) {
  const url = new URL(
    `${originOf(options.serverOrigin)}/api/v1/admin/accounts`,
  );
  if (options.after !== undefined) url.searchParams.set("after", options.after);
  if (options.limit !== undefined)
    url.searchParams.set("limit", String(options.limit));
  const response = await request(
    options.fetch ?? fetch,
    url.toString(),
    { headers: { authorization: `Bearer ${options.credential}` } },
    options.signal,
    1024 * 1024,
  );
  return z
    .strictObject({
      accounts: z.array(accountSchema.strict()).max(100),
      nextAfter: z.uuid().nullable(),
    })
    .parse(JSON.parse(response.text));
}

/** Operator-only disable/enable; disabling ends the account's sessions and transfers. */
export async function setAccountDisabled(options: {
  serverOrigin: string;
  credential: string;
  accountId: string;
  expectedVersion: number;
  disabled: boolean;
  signal: AbortSignal;
  fetch?: typeof fetch;
}) {
  const response = await request(
    options.fetch ?? fetch,
    `${originOf(options.serverOrigin)}/api/v1/admin/accounts/${encodeURIComponent(z.uuid().parse(options.accountId))}/status`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        disabled: options.disabled,
        expectedVersion: options.expectedVersion,
      }),
    },
    options.signal,
    8192,
  );
  return accountSchema
    .omit({ issuer: true })
    .strict()
    .parse(JSON.parse(response.text));
}
