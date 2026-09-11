import { afterEach, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  symlink,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  discoverNativeSessions,
  selectNativeSession,
} from "../../packages/adapters/src/discovery.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agentlive-discovery-"));
  roots.push(root);
  return root;
}
async function put(root: string, path: string, text: string) {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text);
  return target;
}
const signal = () => new AbortController().signal;

it("selects explicit identities and rejects missing, ambiguous or truncated searches", async () => {
  const root = await fixture();
  const options = {
    agent: "claude" as const,
    root,
    nativeSessionId: "selected",
    signal: signal(),
  };
  await expect(selectNativeSession(options)).rejects.toThrow("not found");
  const source = await put(root, "one.jsonl", '{"sessionId":"selected"}\n');
  expect((await selectNativeSession(options)).source).toBe(source);
  await put(root, "two.jsonl", '{"sessionId":"selected"}\n');
  await expect(selectNativeSession(options)).rejects.toThrow(
    "multiple histories",
  );
  await put(root, "three.jsonl", '{"sessionId":"selected"}\n');
  await expect(selectNativeSession(options)).rejects.toThrow("truncated");
});

it("requires explicit disambiguation of Kimi agent logs", async () => {
  const root = await fixture();
  await put(
    root,
    "session_selected/agents/main/wire.jsonl",
    '{"type":"metadata"}\n',
  );
  await put(
    root,
    "session_selected/agents/child/wire.jsonl",
    '{"type":"metadata"}\n',
  );
  const options = {
    agent: "kimi" as const,
    root,
    nativeSessionId: "selected",
    signal: signal(),
  };
  await expect(selectNativeSession(options)).rejects.toThrow(
    "multiple histories",
  );
  expect(
    await selectNativeSession({ ...options, nativeAgent: "child" }),
  ).toMatchObject({ nativeAgent: "child", nativeSessionId: "selected" });
  await expect(
    selectNativeSession({ ...options, agent: "claude", nativeAgent: "main" }),
  ).rejects.toThrow("only to Kimi");
});

it("discovers native identities without exposing transcript metadata", async () => {
  const root = await fixture();
  const source = await put(
    root,
    "day/codex.jsonl",
    JSON.stringify({
      type: "session_meta",
      payload: { id: "codex_id", title: "private title" },
    }),
  );
  const codex = await discoverNativeSessions({
    agent: "codex",
    root,
    signal: signal(),
  });
  expect(codex.sessions).toEqual([
    {
      agent: "codex",
      nativeSessionId: "codex_id",
      nativeThreadId: "codex_id",
      source,
      modifiedAt: expect.any(String),
      captureMode: "file-follow",
    },
  ]);
  await put(
    root,
    "project/claude.jsonl",
    'invalid\n{"sessionId":"claude_id","message":"private text"}\n',
  );
  expect(
    (
      await discoverNativeSessions({ agent: "claude", root, signal: signal() })
    ).sessions.map((s) => s.nativeSessionId),
  ).toEqual(["claude_id"]);
  await put(
    root,
    "session_kimi_id/agents/main/wire.jsonl",
    '{"type":"metadata","protocol_version":"1.5","created_at":1}\n',
  );
  const kimi = await discoverNativeSessions({
    agent: "kimi",
    root,
    signal: signal(),
  });
  expect(kimi.sessions[0]).toMatchObject({
    nativeSessionId: "kimi_id",
    nativeAgent: "main",
  });
  expect(JSON.stringify([codex, kimi])).not.toContain("private");
});

it("distinguishes Claude sidechains from the selected main session", async () => {
  const root = await fixture();
  const source = await put(root, "main.jsonl", '{"sessionId":"shared"}\n');
  await put(
    root,
    "shared/subagents/agent-worker.jsonl",
    '{"sessionId":"shared","agentId":"worker","isSidechain":true}\n',
  );
  const result = await discoverNativeSessions({
    agent: "claude",
    root,
    signal: signal(),
  });
  expect(result.sessions).toHaveLength(2);
  expect(
    result.sessions.find((session) => session.nativeAgent === "worker"),
  ).toBeTruthy();
  expect(
    (
      await selectNativeSession({
        agent: "claude",
        root,
        nativeSessionId: "shared",
        signal: signal(),
      })
    ).source,
  ).toBe(source);
});

it("distinguishes Codex native threads sharing one logical session", async () => {
  const root = await fixture();
  const main = await put(
    root,
    "main.jsonl",
    JSON.stringify({
      type: "session_meta",
      payload: { session_id: "root", id: "root" },
    }) + "\n",
  );
  await put(
    root,
    "child.jsonl",
    JSON.stringify({
      type: "session_meta",
      payload: { session_id: "root", id: "child", parent_thread_id: "root" },
    }) + "\n",
  );
  await put(
    root,
    "grandchild.jsonl",
    JSON.stringify({
      type: "session_meta",
      payload: {
        session_id: "root",
        id: "grandchild",
        parent_thread_id: "child",
      },
    }) + "\n",
  );
  const result = await discoverNativeSessions({
    agent: "codex",
    root,
    signal: signal(),
  });
  expect(result.sessions).toHaveLength(3);
  expect(
    result.sessions.find(
      (candidate) => candidate.nativeThreadId === "grandchild",
    ),
  ).toMatchObject({ nativeSessionId: "root", parentNativeThreadId: "child" });
  expect(
    (
      await selectNativeSession({
        agent: "codex",
        root,
        nativeSessionId: "root",
        signal: signal(),
      })
    ).source,
  ).toBe(main);
  await put(
    root,
    "self.jsonl",
    JSON.stringify({
      type: "session_meta",
      payload: { id: "self", parent_thread_id: "self" },
    }) + "\n",
  );
  expect(
    (await discoverNativeSessions({ agent: "codex", root, signal: signal() }))
      .skipped,
  ).toBe(1);
});

it("returns the newest bounded candidates and preserves duplicate session histories", async () => {
  const root = await fixture();
  for (let i = 1; i <= 3; i++) {
    const source = await put(root, `${i}.jsonl`, '{"sessionId":"shared"}\n');
    await utimes(source, i, i);
  }
  const result = await discoverNativeSessions({
    agent: "claude",
    root,
    limit: 2,
    signal: signal(),
  });
  expect(result.truncated).toBe(true);
  expect(result.sessions.map((s) => s.source)).toEqual([
    join(root, "3.jsonl"),
    join(root, "2.jsonl"),
  ]);
  expect(
    (
      await discoverNativeSessions({
        agent: "claude",
        root,
        nativeSessionId: "absent",
        signal: signal(),
      })
    ).sessions,
  ).toEqual([]);
});

it("skips symlinks, invalid identities and metadata outside the bounded prefix", async () => {
  const root = await fixture();
  const outside = await fixture();
  const source = await put(
    outside,
    "valid.jsonl",
    '{"sessionId":"external"}\n',
  );
  await symlink(source, join(root, "linked.jsonl"));
  await symlink(outside, join(root, "linked-dir"));
  await put(root, "invalid.jsonl", '{"sessionId":"bad/id"}\n');
  await put(
    root,
    "large.jsonl",
    JSON.stringify({ padding: "x".repeat(256 * 1024), sessionId: "hidden" }) +
      "\n",
  );
  await put(root, "late.jsonl", "{}\n".repeat(128) + '{"sessionId":"late"}\n');
  const result = await discoverNativeSessions({
    agent: "claude",
    root,
    signal: signal(),
  });
  expect(result.sessions).toEqual([]);
  expect(result.skipped).toBe(5);
});

it("reports missing roots and bounded depth, and respects cancellation", async () => {
  const root = await fixture();
  expect(
    await discoverNativeSessions({
      agent: "codex",
      root: join(root, "absent"),
      signal: signal(),
    }),
  ).toMatchObject({ sessions: [], skipped: 1 });
  await put(root, "a/b/c/d/e/f/g/h/i/late.jsonl", '{"sessionId":"deep"}\n');
  expect(
    await discoverNativeSessions({ agent: "claude", root, signal: signal() }),
  ).toMatchObject({ sessions: [], truncated: true });
  const abort = new AbortController();
  abort.abort(new Error("cancel discovery"));
  await expect(
    discoverNativeSessions({ agent: "claude", root, signal: abort.signal }),
  ).rejects.toThrow("cancel discovery");
  await expect(
    discoverNativeSessions({
      agent: "claude",
      root,
      limit: 201,
      signal: signal(),
    }),
  ).rejects.toThrow("1..200");
});

it("lists authenticated OpenCode sessions with bounded results and validated timestamps", async () => {
  const fetcher = (async (input, init) => {
    expect(String(input)).toBe("http://localhost:9999/session?limit=2");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Basic ${Buffer.from("custom:secret").toString("base64")}`,
    );
    return Response.json([
      { id: "older", time: { created: 1 } },
      { id: "newer", time: { updated: 2 } },
      { id: "bad", time: { updated: -1 } },
      null,
    ]);
  }) as typeof fetch;
  const result = await discoverNativeSessions({
    agent: "opencode",
    nativeServer: "http://localhost:9999",
    username: "custom",
    password: "secret",
    limit: 1,
    signal: signal(),
    fetch: fetcher,
  });
  expect(result).toMatchObject({
    scanned: 4,
    skipped: 2,
    truncated: true,
    sessions: [
      { nativeSessionId: "newer", captureMode: "snapshot-reconciliation" },
    ],
  });
  expect(JSON.stringify(result)).not.toContain("secret");
});

it("discovers only explicitly owned OpenCode children and reports bounded results", async () => {
  const options = {
    agent: "opencode" as const,
    nativeServer: "http://localhost:9999",
    parentNativeSessionId: "ses_parent",
    signal: signal(),
    limit: 1,
  };
  const result = await discoverNativeSessions({
    ...options,
    fetch: (async (input) => {
      expect(String(input)).toBe(
        "http://localhost:9999/session/ses_parent/children",
      );
      return Response.json([
        { id: "ses_child1", parentID: "ses_parent", time: { created: 1 } },
        { id: "ses_child2", parentID: "ses_parent", time: { created: 2 } },
      ]);
    }) as typeof fetch,
  });
  expect(result.truncated).toBe(true);
  expect(result.sessions).toMatchObject([
    { nativeSessionId: "ses_child2", parentNativeSessionId: "ses_parent" },
  ]);
  for (const row of [
    { id: "unrelated", parentID: "other" },
    { id: "unrelated" },
    { id: "ses_parent", parentID: "ses_parent" },
  ]) {
    await expect(
      discoverNativeSessions({
        ...options,
        fetch: (async () =>
          Response.json([{ ...row, time: { created: 1 } }])) as typeof fetch,
      }),
    ).rejects.toThrow("invalid parent relationship");
  }
  await expect(
    discoverNativeSessions({
      agent: "claude",
      root: "/unused",
      parentNativeSessionId: "parent",
      signal: signal(),
    }),
  ).rejects.toThrow("only to OpenCode");
});

it("rejects malformed OpenCode listings and incompatible source options", async () => {
  await expect(
    discoverNativeSessions({
      agent: "opencode",
      nativeServer: "http://localhost:9999",
      signal: signal(),
      fetch: (async () => Response.json({ sessions: [] })) as typeof fetch,
    }),
  ).rejects.toThrow("Invalid OpenCode session listing");
  await expect(
    discoverNativeSessions({
      agent: "opencode",
      root: "/tmp",
      nativeServer: "http://localhost:9999",
      signal: signal(),
    }),
  ).rejects.toThrow("without a source root");
});
