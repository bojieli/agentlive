import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { startManagedOpenCodeServer } from "../packages/cli/src/opencode-server.js";

it("starts an authenticated owned server and creates/verifies native identities", async () => {
  let child: ReturnType<typeof spawn> | undefined;
  const server = await startManagedOpenCodeServer({
    cwd: process.cwd(),
    signal: new AbortController().signal,
    spawnServer: ((command, args, options) => {
      expect(command).toBe("opencode");
      expect(args).toEqual(["serve", "--hostname", "127.0.0.1", "--port", "0"]);
      expect(options?.shell).toBe(false);
      const env = options?.env!;
      expect(env.OPENCODE_SERVER_PASSWORD).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(args)).not.toContain(env.OPENCODE_SERVER_PASSWORD);
      child = spawn(
        process.execPath,
        [
          "-e",
          `
        const http = require('node:http');
        const auth = 'Basic ' + Buffer.from(process.env.OPENCODE_SERVER_USERNAME + ':' + process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
        const server = http.createServer((req,res) => {
          if (req.headers.authorization !== auth) {res.writeHead(401);res.end();return;}
          res.setHeader('content-type','application/json');
          if(req.url === '/global/health') res.end(JSON.stringify({healthy:true}));
          else res.end(JSON.stringify({id:'ses_owned',time:{created:1}}));
        });
        server.listen(0,'127.0.0.1',() => console.log('opencode server listening on http://127.0.0.1:' + server.address().port));
      `,
        ],
        { ...options, stdio: ["ignore", "pipe", "pipe"] },
      );
      return child;
    }) as typeof spawn,
  });
  try {
    expect(await server.session()).toEqual({
      nativeSessionId: "ses_owned",
      createdAt: 1,
    });
    expect(await server.session("ses_owned")).toEqual({
      nativeSessionId: "ses_owned",
      createdAt: 1,
    });
    await expect(server.session("different")).rejects.toThrow(
      "invalid session identity",
    );
    expect((await fetch(server.origin + "/global/health")).status).toBe(401);
  } finally {
    await server.close();
  }
  expect(child?.signalCode).toBe("SIGTERM");
  await server.close();
  await expect(server.session()).rejects.toThrow("stopped");
});

it("reaps a server that never becomes ready", async () => {
  let child: ReturnType<typeof spawn> | undefined;
  await expect(
    startManagedOpenCodeServer({
      cwd: process.cwd(),
      signal: new AbortController().signal,
      startupTimeoutMs: 50,
      spawnServer: (() =>
        (child = spawn(
          process.execPath,
          ["-e", "setInterval(() => {}, 1000)"],
          { stdio: ["ignore", "pipe", "pipe"] },
        ))) as typeof spawn,
    }),
  ).rejects.toThrow("timed out");
  expect(child?.signalCode).toBe("SIGTERM");
});

it("rejects premature exit without echoing native diagnostics", async () => {
  await expect(
    startManagedOpenCodeServer({
      cwd: process.cwd(),
      signal: new AbortController().signal,
      spawnServer: (() =>
        spawn(
          process.execPath,
          ["-e", "console.error('private native diagnostic');process.exit(2)"],
          { stdio: ["ignore", "pipe", "pipe"] },
        )) as typeof spawn,
    }),
  ).rejects.toThrow("exited before readiness");
});

it("cancellation reaps a starting server and rejects invalid deadlines before spawn", async () => {
  const abort = new AbortController();
  let child: ReturnType<typeof spawn> | undefined;
  const pending = startManagedOpenCodeServer({
    cwd: process.cwd(),
    signal: abort.signal,
    spawnServer: (() => {
      child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      setTimeout(() => abort.abort(), 30);
      return child;
    }) as typeof spawn,
  });
  await expect(pending).rejects.toThrow("cancelled");
  expect(child?.signalCode).toBe("SIGTERM");
  await expect(
    startManagedOpenCodeServer({
      cwd: process.cwd(),
      signal: new AbortController().signal,
      startupTimeoutMs: -1,
    }),
  ).rejects.toThrow("deadline");
});
