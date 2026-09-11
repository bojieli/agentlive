import { expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCodexSession } from "../packages/cli/src/create-codex.js";
it.each(["name-failure", "wrong-rollout", "missing-path"])(
  "fresh Codex rejects %s and retains native identity",
  async (failure) => {
    const root = await mkdtemp(join(tmpdir(), "agentlive-create-codex-"));
    await writeFile(
      join(root, "codex"),
      `#!/usr/bin/env node
const fs=require('node:fs');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const {id,method}=JSON.parse(line);if(id===undefined)return;
 let result={};
 if(method==='thread/start') result={thread:{id:'saved-id',...(${JSON.stringify(failure)}==='missing-path'?{}:{path:${JSON.stringify(join(root, "rollout.jsonl"))}})}};
 if(method==='thread/name/set') {
  if(${JSON.stringify(failure)}==='name-failure') {console.log(JSON.stringify({id,error:{code:-1,message:'Native naming failed'}}));return;}
  fs.writeFileSync(${JSON.stringify(join(root, "rollout.jsonl"))},JSON.stringify({type:'session_meta',timestamp:'2026-09-10T00:00:00Z',payload:{id:'foreign-id',timestamp:'2026-09-10T00:00:00Z',cli_version:'test'}})+'\\n');
 }
 console.log(JSON.stringify({id,result}));
});
`,
      { mode: 0o700 },
    );
    vi.stubEnv("PATH", `${root}:${process.env.PATH}`);
    try {
      await expect(
        createCodexSession({
          cwd: root,
          stateDir: root,
          serverOrigin: "http://127.0.0.1:7331",
          signal: AbortSignal.timeout(5000),
        }),
      ).rejects.toThrow(
        failure === "name-failure"
          ? "Native naming failed"
          : failure === "wrong-rollout"
            ? "does not match"
            : "durable rollout path",
      );
      expect(
        JSON.parse(
          await readFile(join(root, "launches", "saved-id.json"), "utf8"),
        ).nativeSessionId,
      ).toBe("saved-id");
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  },
);
