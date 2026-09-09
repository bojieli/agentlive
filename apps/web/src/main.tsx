import { BrowserContentStore } from "./content-store.js";
import { BrowserSnapshotCache } from "./snapshot-cache.js";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { listRecordings } from "@agentlive/client";
import { ForegroundClock, bindPageLifecycle } from "./lifecycle.js";
import { BrowserPagedSession } from "./paged-session.js";
type ViewerSession = Awaited<ReturnType<typeof BrowserPagedSession.open>>;
import { AttachmentViewer } from "./attachment-viewer.js";
import type { Attachment } from "./attachments.js";
import { ActivityFeed } from "./activity-feed.js";
import { browserCachePlatform, clearSavedHistories } from "./history-cache.js";
import "./style.css";
const seconds = (time: number) => `${(time / 1000).toFixed(1)}s`;
function App() {
  const [stream, setStream] = useState(
    new URLSearchParams(location.search).get("stream") ?? "",
  );
  const [key, setKey] = useState("");
  const [session, setSession] = useState<ViewerSession>();
  const [cachePlatform] = useState(browserCachePlatform);
  const [cacheHistory, setCacheHistory] = useState(!!cachePlatform);
  const [cacheNotice, setCacheNotice] = useState("");
  const [clearing, setClearing] = useState(false);
  const [attachment, setAttachment] = useState<Attachment>();
  const [, refresh] = useState(0);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const playing = session?.playing ?? false,
    speed = session?.speed ?? 1;
  const [recordings, setRecordings] = useState<
    Awaited<ReturnType<typeof listRecordings>>["recordings"]
  >([]);
  const [next, setNext] = useState<string | null>(null);
  const request = useRef<AbortController | undefined>(undefined);
  const closing = useRef<Promise<void>>(Promise.resolve());
  function closeSession(current: ViewerSession | undefined) {
    closing.current = Promise.all([closing.current, current?.close()]).then(
      () => {},
    );
    return closing.current;
  }
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
        session.advance(elapsed);
      } catch (error) {
        setError(error instanceof Error ? error.message : "Playback failed");
        session?.setPlaying(false);
      }
    }, 50);
    return () => clearInterval(interval);
  }, [session, playing, speed, clock]);
  async function join(id = stream) {
    if (clearing) return;
    request.current?.abort();
    closeSession(session);
    setSession(undefined);
    setAttachment(undefined);
    const abort = new AbortController();
    request.current = abort;
    setBusy(true);
    setError("");
    setCacheNotice("");
    try {
      await closing.current;
      abort.signal.throwIfAborted();
      const joined = await BrowserPagedSession.open(
        id,
        key,
        abort.signal,
        () => refresh((value) => value + 1),
        location.origin,
        { cache: cacheHistory },
      );
      if (abort.signal.aborted) {
        await closeSession(joined);
        return;
      }
      setSession(joined);
      setStream(id);
      const fragment =
        new URLSearchParams(location.search).get("stream") === id
          ? location.hash
          : "";
      history.replaceState(
        null,
        "",
        `/?stream=${encodeURIComponent(id)}${fragment}`,
      );
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
    setCacheHistory(false);
    setCacheNotice("");
    try {
      await closeSession(session);
      setSession(undefined);
      await clearSavedHistories(cachePlatform, AbortSignal.timeout(10000));
      await BrowserSnapshotCache.clear(
        cachePlatform.indexedDB,
        AbortSignal.timeout(10000),
      );
      await BrowserContentStore.clear(
        cachePlatform.indexedDB,
        AbortSignal.timeout(10000),
      );
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
  const [checkedAttachment, setCheckedAttachment] = useState<{
    view: NonNullable<ViewerSession["view"]>;
    attachment: Attachment;
  }>();
  const view = session?.view;
  const available =
    attachment &&
    (view
      ? checkedAttachment?.view === view &&
        checkedAttachment.attachment === attachment
      : state?.artifacts.get(attachment.artifactId)?.visible !== false &&
        state?.artifacts
          .get(attachment.artifactId)
          ?.versions.get(attachment.version)?.hash === attachment.hash);
  useEffect(() => {
    if (!attachment) return;
    if (!view) {
      if (!available) setAttachment(undefined);
      return;
    }
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]);
    void view
      .attachment(attachment.artifactId, attachment.version, signal)
      .then((value) => {
        if (signal.aborted) return;
        if (value?.hash === attachment.hash)
          setCheckedAttachment({ view, attachment });
        else setAttachment(undefined);
      })
      .catch((error) => {
        if (!abort.signal.aborted)
          setError(
            error instanceof Error ? error.message : "Attachment lookup failed",
          );
      });
    return () => abort.abort();
  }, [attachment, view, available]);
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
                  closeSession(session);
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
                    session.setPlaying(!(session.playing || session.follow));
                  }}
                >
                  {playing || session.follow ? "Pause" : "Play"}
                </button>
                <button
                  onClick={() => {
                    session?.setPlaying(false);
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
                    onChange={(event) =>
                      session.setSpeed(Number(event.target.value))
                    }
                  >
                    {[...new Set([speed, 0.25, 0.5, 1, 2, 4, 8])]
                      .sort((a, b) => a - b)
                      .map((value) => (
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
                  session?.setPlaying(false);
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
            <ActivityFeed
              key={session.streamId}
              state={state!}
              {...(view ? { view } : {})}
              following={session.follow}
              onPause={() => session.setPlaying(false)}
              order={(key) => session.order(key)}
              onAttachment={setAttachment}
            />
          </>
        )}
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
