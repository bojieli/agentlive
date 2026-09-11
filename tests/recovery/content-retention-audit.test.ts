import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TextStore } from "../../packages/storage/src/index.js";
import { auditContentReachability } from "../../scripts/audit-content-reachability.mjs";
it("diagnoses shared checkpoint content without counting orphan writes or changing storage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentlive-retention-audit-"));
  const content = await TextStore.open(directory);
  try {
    const text = await content.put("shared body");
    const first = await content.put(JSON.stringify({ version: 1, text }));
    const second = await content.put(JSON.stringify({ version: 2, text }));
    await content.put("unreferenced intermediate");
    const before = content.usage.storedBytes;
    const latest = await auditContentReachability(content, [second]);
    const both = await auditContentReachability(content, [
      first,
      second,
      second,
    ]);
    expect(latest.manifests).toBe(2);
    expect(latest.blobFiles).toBe(4);
    expect(both.manifests).toBe(3);
    expect(both.blobFiles).toBe(6);
    expect(latest.bytes).toBeLessThan(both.bytes);
    expect(both.bytes).toBeLessThan(before);
    expect(content.usage.storedBytes).toBe(before);
    expect(await content.read(text, 0, text.units)).toBe("shared body");
  } finally {
    await content.close();
    await rm(directory, { recursive: true, force: true });
  }
});
