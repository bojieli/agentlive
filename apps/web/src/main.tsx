import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { listRecordings } from "@agentlive/client";
import { ForegroundClock, bindPageLifecycle } from "./lifecycle.js";
import { BrowserSession } from "./session.js";
import { AttachmentViewer } from "./attachment-viewer.js";
import type { Attachment } from "./attachments.js";
import {
  WorkflowCard,
  workflowKinds,
  AgentReference,
  objectAnchor,
} from "./workflow-card.js";
import { browserCachePlatform, clearSavedHistories } from "./history-cache.js";
import "./style.css";
const seconds = (time: number) => `${(time / 1000).toFixed(1)}s`;
function App() {
  const [stream, setStream] = useState(
    new URLSearchParams(location.search).get("stream") ?? "",
  );
  const [key, setKey] = useState("");
  const [session, setSession] = useState<BrowserSession>();
  const [cachePlatform] = useState(browserCachePlatform);
  const [cacheHistory, setCacheHistory] = useState(!!cachePlatform);
  const [cacheNotice, setCacheNotice] = useState("");
  const [clearing, setClearing] = useState(false);
  const [attachment, setAttachment] = useState<Attachment>();
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
  const [clock] = useState(() => new ForegroundClock());
  useEffect(() => {
    if (session) return bindPageLifecycle(session, document, window, clock);
  }, [session, clock]);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (!session || !playing) return;
    clock.reset();
    const interval = setInterval(() => {
      try {
        const elapsed = clock.elapsed();
        if (clock.interrupted) session.reconnect();
        session.seek(session.time + elapsed * speed);
      } catch (error) {
        setError(error instanceof Error ? error.message : "Playback failed");
        setPlaying(false);
      }
    }, 50);
    return () => clearInterval(interval);
  }, [session, playing, speed, clock]);
  async function join(id = stream) {
    if (clearing) return;
    request.current?.abort();
    session?.close();
    setSession(undefined);
    setAttachment(undefined);
    setPlaying(false);
    const abort = new AbortController();
    request.current = abort;
    setBusy(true);
    setError("");
    setCacheNotice("");
    try {
      const joined = await BrowserSession.open(
        id,
        key,
        abort.signal,
        () => refresh((value) => value + 1),
        location.origin,
        { cache: cacheHistory },
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
  async function forgetHistory() {
    if (!cachePlatform || clearing) return;
    setClearing(true);
    setError("");
    session?.disableCache();
    setCacheHistory(false);
    setCacheNotice("");
    try {
      await clearSavedHistories(cachePlatform, AbortSignal.timeout(10000));
      setCacheNotice("Saved histories cleared from this device.");
    } catch {
      setError(
        "Unable to clear saved history. Close other AgentLive tabs and try again.",
      );
    } finally {
      setClearing(false);
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
  const available =
    attachment &&
    state?.artifacts.get(attachment.artifactId)?.visible !== false &&
    state?.artifacts
      .get(attachment.artifactId)
      ?.versions.get(attachment.version)?.hash === attachment.hash;
  useEffect(() => {
    if (attachment && !available) setAttachment(undefined);
  }, [attachment, available]);
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
          <label className="cache-choice">
            <input
              type="checkbox"
              checked={cacheHistory}
              disabled={!cachePlatform || busy || clearing || !!session}
              onChange={(event) => {
                setCacheHistory(event.target.checked);
                if (!event.target.checked) session?.disableCache();
              }}
            />
            Save history on this device
          </label>
          <button className="primary" disabled={busy || clearing || !stream}>
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
        <button
          className="secondary"
          disabled={!cachePlatform || busy || clearing}
          onClick={() => void forgetHistory()}
        >
          {clearing ? "Clearing…" : "Clear saved histories"}
        </button>
        {cacheNotice && (
          <p className="muted" role="status">
            {cacheNotice}
          </p>
        )}
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
            <p className="muted" role="status">
              {session.cacheStatus === "saved"
                ? "History is being saved on this device."
                : "History is kept for this visit only."}
            </p>
            {session.error && (
              <div className="error" role="alert">
                {session.error}
              </div>
            )}
            {attachment && available && (
              <AttachmentViewer
                key={`${session.streamId}/${attachment.hash}`}
                attachment={attachment}
                streamId={session.streamId}
                credential={session.credential}
                onClose={() => setAttachment(undefined)}
              />
            )}
            <section className="feed" aria-label="Session activity">
              {[
                [...state!.messages.values()]
                  .filter((message) => message.visible !== false)
                  .map((message) => (
                    <article
                      className={`message ${message.role}`}
                      key={`messages/${message.id}`}
                      id={objectAnchor("messages", message.id)}
                    >
                      <div className="item-label">
                        {message.role}
                        <span>{message.completed ? "" : "in progress"}</span>
                      </div>
                      <AgentReference
                        {...(message.agentId ? { id: message.agentId } : {})}
                        state={state!}
                      />
                      <pre>{message.text || "…"}</pre>
                    </article>
                  )),
                [...state!.tools.values()]
                  .filter((tool) => tool.visible !== false)
                  .map((tool) => (
                    <details
                      className="card"
                      key={`tools/${tool.id}`}
                      id={objectAnchor("tools", tool.id)}
                    >
                      <summary>
                        {tool.name} <span className="muted">{tool.status}</span>
                      </summary>
                      <AgentReference
                        {...(tool.agentId ? { id: tool.agentId } : {})}
                        state={state!}
                      />
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
                          onClick={() => setAttachment(version)}
                        >
                          Open version {version.version}
                        </button>
                      ))}
                    </section>
                  )),
                workflowKinds.map((kind) =>
                  [...state![kind].keys()].map((id) => (
                    <WorkflowCard
                      key={`${kind}/${id}`}
                      kind={kind}
                      id={id}
                      state={state!}
                      onAttachment={setAttachment}
                    />
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
createRoot(document.getElementById("root")!).render(<App />);
