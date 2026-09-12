import { OperatorReports } from "./operator-reports.js";
import { ReportRecording } from "./report.js";
import { Sharing } from "./sharing.js";
import { AccountControls } from "./account.js";
import { accountFetch } from "./account-transport.js";
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
  const [signedIn, setSignedIn] = useState(false);
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
  const [publicListing, setPublicListing] = useState(false);
  const recoveryAttempted = useRef(false);
  // Keyboard focus must land on the new context after joining or leaving:
  // the control that was activated is unmounted by that same transition.
  const streamField = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const enterPlayback = useRef(false);
  const returnToForm = useRef(false);
  const [announcement, setAnnouncement] = useState("");
  const announced = useRef("");
  const request = useRef<AbortController | undefined>(undefined);
  const listing = useRef<AbortController | undefined>(undefined);
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
  useEffect(() => () => listing.current?.abort(), []);
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
  const recoveryView =
    session instanceof BrowserPagedSession
      ? session.recoveryPresentation
      : undefined;
  useEffect(() => {
    if (
      !session ||
      !recoveryView ||
      recoveryAttempted.current ||
      busy ||
      clearing
    )
      return;
    recoveryAttempted.current = true;
    void join(session.streamId, {
      view: recoveryView,
      credential: session.credential,
      cache: session.cacheStatus === "saved",
    });
  }, [session, session?.error, busy, clearing]);
  async function join(
    id = stream,
    recovery?: {
      view: NonNullable<BrowserPagedSession["recoveryPresentation"]>;
      credential: string;
      cache: boolean;
    },
  ) {
    if (clearing) return;
    if (!recovery) {
      recoveryAttempted.current = false;
      enterPlayback.current = true;
    }
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
        recovery?.credential ?? key,
        abort.signal,
        () => refresh((value) => value + 1),
        location.origin,
        {
          cache: recovery ? recovery.cache : cacheHistory,
          ...(recovery ? { resumeView: recovery.view } : {}),
        },
      );
      if (abort.signal.aborted) {
        await closeSession(joined);
        return;
      }
      setSession(joined);
      if (joined instanceof BrowserPagedSession)
        setAttachment(joined.selectedAttachment);
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
      setCacheNotice("Playback cache cleared from this device.");
    } catch {
      setError(
        "Unable to clear playback cache. Close other AgentLive tabs and try again.",
      );
    } finally {
      setClearing(false);
    }
  }
  async function browse(after?: string, publicOnly = false) {
    listing.current?.abort();
    const stop = new AbortController();
    listing.current = stop;
    setError("");
    try {
      const page = await listRecordings({
        fetch: accountFetch,
        serverOrigin: location.origin,
        credential: key,
        public: publicOnly,
        signal: AbortSignal.any([stop.signal, AbortSignal.timeout(30000)]),
        ...(after ? { after } : {}),
      });
      if (stop.signal.aborted) return;
      setRecordings(page.recordings);
      setPublicListing(publicOnly);
      setNext(page.nextAfter);
    } catch (error) {
      if (stop.signal.aborted) return;
      setError(
        error instanceof Error ? error.message : "Unable to list recordings",
      );
    }
  }
  useEffect(() => {
    if (session) {
      if (!enterPlayback.current) return;
      enterPlayback.current = false;
      heading.current?.focus();
      return;
    }
    if (!returnToForm.current) return;
    returnToForm.current = false;
    streamField.current?.focus();
  }, [session]);
  const playbackMode = !session
    ? ""
    : session.follow
      ? `Following live at ${speed}× speed`
      : playing
        ? `Playing at ${speed}× speed`
        : `Paused at ${speed}× speed, event ${session.state.appliedSeq} of ${session.received}`;
  useEffect(() => {
    if (playbackMode === announced.current) return;
    announced.current = playbackMode;
    setAnnouncement(playbackMode);
  }, [playbackMode]);
  const state = session?.state;
  const [checkedAttachment, setCheckedAttachment] = useState<{
    view: NonNullable<ViewerSession["view"]>;
    attachment: Attachment;
    resolved: Attachment;
  }>();
  const view = session?.view;
  function chooseAttachment(value: Attachment | undefined) {
    setAttachment(value);
    if (session instanceof BrowserPagedSession)
      session.setAttachmentChoice(value);
  }
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
      if (!available) chooseAttachment(undefined);
      return;
    }
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]);
    void view
      .attachment(attachment.artifactId, attachment.version, signal)
      .then((value) => {
        if (signal.aborted) return;
        if (value?.hash === attachment.hash)
          setCheckedAttachment({ view, attachment, resolved: value });
        else chooseAttachment(undefined);
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
          <span aria-hidden="true">◉</span> <span>AgentLive</span>
        </a>
        <span className="tag">Shared coding sessions</span>
      </header>
      <AccountControls
        changed={setSignedIn}
        leave={async () => {
          request.current?.abort();
          listing.current?.abort();
          setSession(undefined);
          setAttachment(undefined);
          setRecordings([]);
          setNext(null);
          setKey("");
          await closeSession(session);
        }}
      />
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
              ref={streamField}
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
            Cache playback on this device
          </label>
          <button className="primary" disabled={busy || clearing || !stream}>
            {busy ? "Joining…" : "Join recording"}
          </button>
        </form>
        <button
          className="secondary"
          onClick={() => void browse()}
          disabled={!key && !signedIn}
        >
          Browse my recordings
        </button>
        <button
          className="secondary"
          onClick={() => void browse(undefined, true)}
        >
          Browse public recordings
        </button>
        <button
          className="secondary"
          disabled={!cachePlatform || busy || clearing}
          onClick={() => void forgetHistory()}
        >
          {clearing ? "Clearing…" : "Clear playback cache"}
        </button>
        {cacheNotice && (
          <p className="muted" role="status">
            {cacheNotice}
          </p>
        )}
        <OperatorReports key={key} credential={key} />
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
            <button onClick={() => void browse(next, publicListing)}>
              More recordings
            </button>
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
            <span className="orb" aria-hidden="true">
              ◉
            </span>
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
                <h2 ref={heading} tabIndex={-1}>
                  {state!.title || session.title}
                </h2>
              </div>
              <button
                onClick={() => {
                  request.current?.abort();
                  closeSession(session);
                  setSession(undefined);
                  returnToForm.current = true;
                  setKey("");
                }}
              >
                Leave
              </button>
            </div>
            <section className="player" aria-label="Playback controls">
              <div className="controls">
                <span className="status" role="status">
                  <span aria-hidden="true">●</span> Connection: {session.status}
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
                <button
                  disabled={session.state.appliedSeq === 0}
                  onClick={() => {
                    void session.step(-1);
                  }}
                >
                  Previous event
                </button>
                <button
                  disabled={session.state.appliedSeq >= session.received}
                  onClick={() => {
                    void session.step(1);
                  }}
                >
                  Next event
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
                <label className="speed">
                  {/* The visible text is the accessible name: speech input
                      must be able to address the control it can read. */}
                  Idle gap cap
                  <select
                    aria-label="Idle gap cap"
                    value={session.idleCapMs ?? "off"}
                    onChange={(event) =>
                      session.setIdleCap(
                        event.target.value === "off"
                          ? undefined
                          : Number(event.target.value),
                      )
                    }
                  >
                    <option value="off">Original timing</option>
                    {[
                      ...new Set([
                        0,
                        1000,
                        5000,
                        ...(session.idleCapMs === undefined
                          ? []
                          : [session.idleCapMs]),
                      ]),
                    ]
                      .sort((a, b) => a - b)
                      .map((cap) => (
                        <option key={cap} value={cap}>
                          {cap === 0 ? "Skip gaps" : `At most ${cap / 1000}s`}
                        </option>
                      ))}
                  </select>
                </label>
              </div>
              <input
                aria-label="Timeline"
                aria-valuetext={`${seconds(session.time)} of ${seconds(
                  session.duration,
                )}, event ${state!.appliedSeq} of ${session.received}`}
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
              {/* One bounded announcement for playback mode. The elapsed
                  time is deliberately excluded: it changes on every tick
                  and would flood a screen reader during playback. */}
              <p className="visually-hidden" role="status">
                {announcement}
              </p>
            </section>
            <p className="muted" role="status">
              {session.cacheStatus === "saved"
                ? "Loaded playback data is cached on this device."
                : "Playback data is kept for this visit only."}
            </p>
            <ReportRecording
              key={session.streamId + session.credential}
              streamId={session.streamId}
              credential={session.credential}
            />
            <Sharing
              key={session.streamId}
              streamId={session.streamId}
              credential={session.credential}
            />
            {session.error && (
              <div className="error" role="alert">
                {session.error}
                {recoveryView && (
                  <button
                    onClick={() =>
                      void join(session.streamId, {
                        view: recoveryView,
                        credential: session.credential,
                        cache: session.cacheStatus === "saved",
                      })
                    }
                    disabled={busy || clearing}
                  >
                    Reopen playback
                  </button>
                )}
              </div>
            )}
            {attachment && available && (
              <AttachmentViewer
                key={`${session.streamId}/${attachment.hash}`}
                attachment={view ? checkedAttachment!.resolved : attachment}
                streamId={session.streamId}
                credential={session.credential}
                onClose={() => chooseAttachment(undefined)}
              />
            )}
            <ActivityFeed
              key={session.streamId}
              state={state!}
              {...(view ? { view } : {})}
              {...(session instanceof BrowserPagedSession
                ? {
                    textPages: session.textPages,
                    onTextPage: (
                      key: string,
                      page: import("./inspection-choices.js").TextPosition,
                    ) => session.setTextPage(key, page),
                    expandedDisclosures: session.expandedDisclosures,
                    onDisclosure: (key: string, expanded: boolean) =>
                      session.setDisclosure(key, expanded),
                  }
                : {})}
              following={session.follow}
              onPause={() => session.setPlaying(false)}
              order={(key) => session.order(key)}
              onAttachment={chooseAttachment}
            />
          </>
        )}
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
