import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { listRecordings } from "@agentlive/client";
import { BrowserSession } from "./session.js";
import "./style.css";
const seconds = (time: number) => `${(time / 1000).toFixed(1)}s`;
function App() {
  const [stream, setStream] = useState(
    new URLSearchParams(location.search).get("stream") ?? "",
  );
  const [key, setKey] = useState("");
  const [session, setSession] = useState<BrowserSession>();
  const [, refresh] = useState(0);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [playing, setPlaying] = useState(false),
    [speed, setSpeed] = useState(1);
  const [recordings, setRecordings] = useState<
    Awaited<ReturnType<typeof listRecordings>>["recordings"]
  >([]);
  const [next, setNext] = useState<string | null>(null);
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (!session || !playing) return;
    let previous = performance.now();
    const interval = setInterval(() => {
      const now = performance.now();
      try {
        session.seek(session.time + (now - previous) * speed);
      } catch (error) {
        setError(error instanceof Error ? error.message : "Playback failed");
        setPlaying(false);
      }
      previous = now;
    }, 50);
    return () => clearInterval(interval);
  }, [session, playing, speed]);
  async function join(id = stream) {
    request.current?.abort();
    session?.close();
    setSession(undefined);
    setPlaying(false);
    const abort = new AbortController();
    request.current = abort;
    setBusy(true);
    setError("");
    try {
      const joined = await BrowserSession.open(id, key, abort.signal, () =>
        refresh((value) => value + 1),
      );
      if (abort.signal.aborted) {
        joined.close();
        return;
      }
      setSession(joined);
      setStream(id);
      history.replaceState(null, "", `/?stream=${encodeURIComponent(id)}`);
    } catch (error) {
      if (!abort.signal.aborted)
        setError(error instanceof Error ? error.message : "Unable to join");
    } finally {
      if (request.current === abort) setBusy(false);
    }
  }
  async function browse(after?: string) {
    setError("");
    try {
      const page = await listRecordings({
        serverOrigin: location.origin,
        credential: key,
        signal: AbortSignal.timeout(30000),
        ...(after ? { after } : {}),
      });
      setRecordings(page.recordings);
      setNext(page.nextAfter);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Unable to list recordings",
      );
    }
  }
  const state = session?.state;
  return (
    <div className="shell">
      <header>
        <a className="brand" href="/">
          ◉ <span>AgentLive</span>
        </a>
        <span className="tag">Shared coding sessions</span>
      </header>
      <aside>
        <p className="eyebrow">YOUR RECORDINGS</p>
        <h1>
          A front-row seat
          <br />
          to the work.
        </h1>
        <p className="muted">
          Join a session, follow its progress, or explore how it unfolded.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void join();
          }}
        >
          <label>
            Recording ID
            <input
              value={stream}
              onChange={(event) => setStream(event.target.value)}
              required
              autoComplete="off"
              placeholder="Paste a recording ID"
            />
          </label>
          <label>
            Access key <span className="muted">· if required</span>
            <input
              type="password"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              autoComplete="off"
            />
          </label>
          <button className="primary" disabled={busy || !stream}>
            {busy ? "Joining…" : "Join recording"}
          </button>
        </form>
        <button
          className="secondary"
          onClick={() => void browse()}
          disabled={!key}
        >
          Browse my recordings
        </button>
        <div className="recordings">
          {recordings.map((recording) => (
            <button key={recording.id} onClick={() => void join(recording.id)}>
              <strong>{recording.title || "Untitled recording"}</strong>
              <small>
                {recording.visibility} ·{" "}
                {new Date(recording.createdAt).toLocaleDateString()}
              </small>
            </button>
          ))}
          {next && (
            <button onClick={() => void browse(next)}>More recordings</button>
          )}
        </div>
      </aside>
      <main>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        {!session ? (
          <section className="empty">
            <span className="orb">◉</span>
            <h2>Every session tells a story.</h2>
            <p>Messages, tools, and artifacts—together in one timeline.</p>
            {busy && (
              <button
                onClick={() => {
                  request.current?.abort();
                  setBusy(false);
                }}
              >
                Cancel joining
              </button>
            )}
          </section>
        ) : (
          <>
            <div className="session-heading">
              <div>
                <p className="eyebrow">RECORDING</p>
                <h2>{state!.title || session.title}</h2>
              </div>
              <button
                onClick={() => {
                  request.current?.abort();
                  session.close();
                  setSession(undefined);
                  setKey("");
                }}
              >
                Leave
              </button>
            </div>
            <section className="player" aria-label="Playback controls">
              <div className="controls">
                <span className="status" aria-live="polite">
                  ● {session.status}
                </span>
                <button
                  onClick={() => {
                    const wasFollowing = session.follow;
                    if (wasFollowing) session.seek(session.time);
                    setPlaying(!playing && !wasFollowing);
                  }}
                >
                  {playing || session.follow ? "Pause" : "Play"}
                </button>
                <button
                  onClick={() => {
                    setPlaying(false);
                    session.seek(session.duration, true);
                  }}
                >
                  Follow live
                </button>
                <label className="speed">
                  Speed
                  <select
                    aria-label="Playback speed"
                    value={speed}
                    onChange={(event) => setSpeed(Number(event.target.value))}
                  >
                    {[0.25, 0.5, 1, 2, 4, 8].map((value) => (
                      <option key={value} value={value}>
                        {value}×
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <input
                aria-label="Timeline"
                type="range"
                min="0"
                max={Math.max(1, session.duration)}
                step="1"
                value={session.time}
                onChange={(event) => {
                  setPlaying(false);
                  session.seek(Number(event.target.value));
                }}
              />
              <div className="timeline-labels">
                <span>
                  {seconds(session.time)} / {seconds(session.duration)}
                </span>
                <span>
                  Viewing {state!.appliedSeq} · Received {session.received}
                </span>
              </div>
            </section>
            {session.error && (
              <div className="error" role="alert">
                {session.error}
              </div>
            )}
            <section className="feed" aria-label="Session activity">
              {[
                [...state!.messages.values()]
                  .filter((message) => message.visible !== false)
                  .map((message) => (
                    <article
                      className={`message ${message.role}`}
                      key={`messages/${message.id}`}
                    >
                      <div className="item-label">
                        {message.role}
                        <span>{message.completed ? "" : "in progress"}</span>
                      </div>
                      <pre>{message.text || "…"}</pre>
                    </article>
                  )),
                [...state!.tools.values()]
                  .filter((tool) => tool.visible !== false)
                  .map((tool) => (
                    <details className="card" key={`tools/${tool.id}`}>
                      <summary>
                        {tool.name} <span className="muted">{tool.status}</span>
                      </summary>
                      <h4>Input</h4>
                      <pre>{tool.input}</pre>
                      <h4>Output</h4>
                      <pre>{tool.output}</pre>
                    </details>
                  )),
                [...state!.changes.entries()].map(([id, change]) => (
                  <details className="card" key={`changes/${id}`}>
                    <summary>{change.path}</summary>
                    <pre>{change.patch}</pre>
                  </details>
                )),
                [...state!.artifacts.entries()]
                  .filter(([, artifact]) => artifact.visible !== false)
                  .map(([id, artifact]) => (
                    <section className="card" key={`artifacts/${id}`}>
                      <strong>{artifact.filename}</strong>
                      <p className="muted">
                        {artifact.reason ??
                          (artifact.pending
                            ? "Preparing attachment…"
                            : `${artifact.versions.size} saved version(s)`)}
                      </p>
                      {[...artifact.versions.values()].map((version) => (
                        <button
                          key={version.version}
                          onClick={() =>
                            void download(
                              version.hash,
                              version.filename,
                              session.credential,
                              session.streamId,
                            ).catch((error: unknown) =>
                              setError(
                                error instanceof Error
                                  ? error.message
                                  : "Download failed",
                              ),
                            )
                          }
                        >
                          Download version {version.version}
                        </button>
                      ))}
                    </section>
                  )),
                (
                  [
                    "agents",
                    "tasks",
                    "goals",
                    "interactions",
                    "plans",
                    "monitors",
                  ] as const
                ).map((kind) =>
                  [...state![kind].entries()].map(([id, value]) => (
                    <details className="card" key={`${kind}/${id}`}>
                      <summary>
                        {kind.slice(0, -1)} · {id.slice(0, 12)}
                      </summary>
                      <pre>{JSON.stringify(value, null, 2)}</pre>
                    </details>
                  )),
                ),
              ]
                .flat(2)
                .sort(
                  (a, b) =>
                    session.order(String(a.key)) - session.order(String(b.key)),
                )}
              {state!.gaps.map((gap, index) => (
                <div className="gap" key={index}>
                  Capture note: {gap.reason}
                </div>
              ))}
              {!session.received && (
                <p className="muted">Receiving session history…</p>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
async function download(
  hash: string,
  filename: string,
  credential: string,
  streamId: string,
) {
  const response = await fetch(
    `/api/v1/streams/${encodeURIComponent(streamId)}/attachments/${hash}`,
    {
      headers: credential ? { authorization: `Bearer ${credential}` } : {},
      signal: AbortSignal.timeout(30000),
      redirect: "error",
    },
  );
  if (!response.ok || !response.body)
    throw new Error("Attachment is unavailable or access was denied");
  const reader = response.body.getReader(),
    chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.length;
      if (size > 25 * 1024 * 1024)
        throw new Error("Attachment exceeds the browser download limit");
      chunks.push(new Uint8Array(item.value));
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const blob = new Blob(chunks, { type: "application/octet-stream" });
  const actual = [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (actual !== hash) throw new Error("Attachment integrity check failed");
  const url = URL.createObjectURL(blob),
    link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
createRoot(document.getElementById("root")!).render(<App />);
