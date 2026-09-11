import { expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRemoteArtifactPolicy } from "../packages/cli/src/remote-artifact-policy.js";
import { fetchRemoteArtifact } from "../packages/adapters/src/remote-artifacts.js";

it("loads bounded origin configuration with explicit environment credentials and sanitized errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlive-artifact-policy-"));
  const path = join(root, "policy.json");
  const config = {
    origins: [
      { origin: "https://files.example", authorizationEnv: "FILES_AUTH" },
    ],
    maxBytes: 1024,
  };
  try {
    await writeFile(path, JSON.stringify(config));
    expect(
      await loadRemoteArtifactPolicy(path, { FILES_AUTH: "Bearer private" }),
    ).toEqual({
      origins: [
        { origin: "https://files.example", authorization: "Bearer private" },
      ],
      maxBytes: 1024,
    });
    await expect(loadRemoteArtifactPolicy(path, {})).rejects.toThrow(
      "missing or empty",
    );
    await expect(
      loadRemoteArtifactPolicy(path, { FILES_AUTH: "Bearer private\r\nx: y" }),
    ).rejects.toThrow("Invalid remote artifact authorization");
    for (const invalid of [
      {
        origins: [
          { origin: "https://files.example", authorization: "private" },
        ],
      },
      { origins: [{ origin: "https://private@files.example" }] },
      { origins: [{ origin: "https://files.example/path" }] },
      {
        origins: [
          { origin: "https://files.example" },
          { origin: "https://files.example" },
        ],
      },
      {
        origins: Array.from({ length: 65 }, () => ({
          origin: "https://files.example",
        })),
      },
      { origins: [], maxBytes: 25 * 1024 * 1024 },
      { origins: [], timeoutMs: 60001 },
      { origins: [], unexpected: true },
    ]) {
      await writeFile(path, JSON.stringify(invalid));
      await expect(loadRemoteArtifactPolicy(path)).rejects.toThrow();
    }
    await writeFile(path, '{"private-secret');
    await expect(loadRemoteArtifactPolicy(path)).rejects.toThrow(
      "Invalid artifact policy JSON",
    );
    await writeFile(path, " ".repeat(65537));
    await expect(loadRemoteArtifactPolicy(path)).rejects.toThrow(
      "exceeds 64 KiB",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("requires UTF-8 text and recognizes structured text media types for redaction", async () => {
  const input = { url: "https://files.example/file" };
  const policy = { origins: [{ origin: "https://files.example" }] };
  const signal = AbortSignal.timeout(5000);
  await expect(
    fetchRemoteArtifact(
      input,
      policy,
      signal,
      async () =>
        new Response("ascii", {
          headers: { "content-type": "text/plain; charset=iso-8859-1" },
        }),
    ),
  ).rejects.toThrow("UTF-8 charset");
  const result = await fetchRemoteArtifact(
    input,
    policy,
    signal,
    async () =>
      new Response('{"secret":"value"}', {
        headers: {
          "content-type": 'application/problem+json; charset="UTF-8"',
        },
      }),
  );
  expect(result.text).toBe(true);
  expect(result.mediaType).toBe("application/problem+json");
});
