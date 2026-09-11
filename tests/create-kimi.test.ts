import { expect, it, vi } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKimiSession } from "../packages/cli/src/create-kimi.js";
it.each(["missing-source", "invalid-metadata", "unsupported-id"])(
  "fresh Kimi rejects %s before managed launch",
  async (failure) => {
    const root = await mkdtemp(join(tmpdir(), "agentlive-create-kimi-"));
    const id = failure === "unsupported-id" ? "foreign" : "session_saved-id";
    await writeFile(
      join(root, "kimi"),
      `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const {id,method}=JSON.parse(line);if(id===undefined)return;
 let result={protocolVersion:1};
 if(method==='session/new') {
  result={sessionId:${JSON.stringify(id)}};
  if(${JSON.stringify(failure)}==='invalid-metadata') {
   const dir=path.join(${JSON.stringify(root)},'session_saved-id','agents','main');
   fs.mkdirSync(dir,{recursive:true});
   fs.writeFileSync(path.join(dir,'wire.jsonl'),JSON.stringify({type:'metadata',protocol_version:'1.5',created_at:1})+'\\n'+JSON.stringify({type:'metadata',protocol_version:'1.5',created_at:2})+'\\n');
  }
 } else if(method!=='initialize')process.exit(4);
 console.log(JSON.stringify({id,result}));
});
`,
      { mode: 0o700 },
    );
    vi.stubEnv("PATH", `${root}:${process.env.PATH}`);
    try {
      await expect(
        createKimiSession({
          cwd: root,
          stateDir: root,
          sourceRoot: root,
          serverOrigin: "http://127.0.0.1:7331",
          signal: AbortSignal.timeout(5000),
        }),
      ).rejects.toThrow(
        failure === "unsupported-id"
          ? "unsupported session identity"
          : failure === "invalid-metadata"
            ? "conflicting metadata"
            : /Native session not found/,
      );
      if (failure !== "unsupported-id")
        expect(
          JSON.parse(
            await readFile(join(root, "launches", "saved-id.json"), "utf8"),
          ),
        ).toMatchObject({
          nativeSessionId: "saved-id",
          nativeProtocolId: "session_saved-id",
        });
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  },
);
