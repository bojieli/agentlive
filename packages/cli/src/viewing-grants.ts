import { z } from "zod";
import { idSchema } from "@agentlive/protocol";
import { originOf, request } from "@agentlive/client/transport";
const metadata = z.object({
  id: idSchema,
  streamId: idSchema,
  revision: idSchema,
  label: z.string().max(200),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
});
export async function manageViewingGrants(options: {
  action: "issue" | "list" | "revoke";
  serverOrigin: string;
  streamId: string;
  credential: string;
  signal: AbortSignal;
  label?: string;
  expiresAt?: number;
  grantId?: string;
}) {
  const origin = originOf(options.serverOrigin);
  const stream = idSchema.parse(options.streamId);
  const base = `${origin}/api/v1/streams/${stream}/viewing-grants`;
  let path = base,
    method = "GET",
    body: string | undefined;
  if (options.action === "issue") {
    const input = z
      .strictObject({
        label: z.string().max(200),
        expiresAt: z.number().int().nonnegative().safe(),
      })
      .parse({ label: options.label ?? "", expiresAt: options.expiresAt });
    if (
      input.expiresAt <= Date.now() ||
      input.expiresAt - Date.now() > 366 * 86400000
    )
      throw new Error("Expiry must be within the next 366 days");
    method = "POST";
    body = JSON.stringify(input);
  } else if (options.action === "revoke") {
    path += "/" + idSchema.parse(options.grantId);
    method = "DELETE";
  }
  // Issuance is not retried: a lost response may have created a grant whose
  // token is unavailable. List/revoke that grant before issuing another.
  const response = await request(
    fetch,
    path,
    {
      method,
      headers: {
        authorization: `Bearer ${options.credential}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body } : {}),
    },
    options.signal,
    1024 * 1024,
  );
  const value = JSON.parse(response.text);
  if (options.action === "issue") {
    const issued = metadata
      .extend({ token: z.string().regex(/^[a-f0-9]{64}$/) })
      .parse(value);
    if (issued.streamId !== stream)
      throw new Error("Viewing credential scope differs");
    return issued;
  }
  if (options.action === "list") {
    const list = z.object({ grants: z.array(metadata).max(128) }).parse(value);
    if (list.grants.some((grant) => grant.streamId !== stream))
      throw new Error("Viewing credential scope differs");
    return list;
  }
  return z.object({ revoked: z.boolean() }).parse(value);
}
