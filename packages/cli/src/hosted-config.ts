import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { z } from "zod";

/** Configuration names environment variables; provider/cookie secrets never appear in argv or JSON errors. */
export async function loadHostedConfig(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let raw: unknown;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 16384)
      throw new Error("Invalid hosted configuration file");
    const bytes = Buffer.alloc(16385);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > 16384) throw new Error("Hosted configuration exceeds limit");
    try {
      raw = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(0, length),
        ),
      );
    } catch {
      throw new Error("Invalid hosted configuration JSON");
    }
  } finally {
    await file.close();
  }
  const variable = z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/);
  const parsed = z
    .strictObject({
      version: z.literal(1),
      publicOrigin: z.string().max(2048),
      issuer: z.string().max(2048),
      clientId: z.string().min(1).max(1024),
      clientSecretEnv: variable,
      cookiePasswordEnv: variable,
    })
    .safeParse(raw);
  if (!parsed.success) throw new Error("Invalid hosted configuration");
  const value = parsed.data;
  for (const urlText of [value.publicOrigin, value.issuer]) {
    let url;
    try {
      url = new URL(urlText);
    } catch {
      throw new Error("Invalid hosted HTTPS URL");
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        "Hosted URLs require HTTPS without credentials, query or fragment",
      );
  }
  if (new URL(value.publicOrigin).origin !== value.publicOrigin)
    throw new Error("Hosted publicOrigin must be an origin without path");
  const clientSecret = env[value.clientSecretEnv],
    cookiePassword = env[value.cookiePasswordEnv];
  if (
    !clientSecret ||
    clientSecret.length > 4096 ||
    !cookiePassword ||
    cookiePassword.length < 32 ||
    cookiePassword.length > 4096
  )
    throw new Error(
      "Hosted authentication environment secrets are missing or invalid",
    );
  return {
    publicOrigin: value.publicOrigin,
    hosted: {
      issuer: value.issuer,
      clientId: value.clientId,
      clientSecret,
      cookiePassword,
    },
  };
}
