import { useEffect, useRef, useState } from "react";
import { removeRecording } from "@agentlive/client";
import { accountFetch } from "./account-transport.js";

export function Removal({
  streamId,
  revision,
  credential,
}: {
  streamId: string;
  revision: string;
  credential: string;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<string | undefined>(undefined);
  const active = useRef<AbortController | undefined>(undefined);
  useEffect(
    () => () => {
      active.current?.abort();
    },
    [],
  );
  async function remove() {
    if (!confirmed || active.current || removed) return;
    const stop = new AbortController();
    active.current = stop;
    pending.current ??= crypto.randomUUID();
    setBusy(true);
    setError("");
    try {
      await removeRecording({
        serverOrigin: location.origin,
        streamId,
        revision,
        operationId: pending.current,
        credential,
        fetch: accountFetch,
        signal: AbortSignal.any([stop.signal, AbortSignal.timeout(15000)]),
      });
      if (!stop.signal.aborted) setRemoved(true);
    } catch {
      if (!stop.signal.aborted)
        setError(
          "Removal could not be confirmed. Retry to check or complete the same removal. Recording owner access is required.",
        );
    } finally {
      if (active.current === stop) {
        active.current = undefined;
        if (!stop.signal.aborted) setBusy(false);
      }
    }
  }
  return (
    <section aria-label="Remove recording">
      <p>
        Removal ends publishing and viewing access and removes this recording
        from listings. It cannot be undone. Recording data is cleaned up after
        active operations finish. A removal record is retained; existing
        backups, downloads and cached copies remain.
      </p>
      {removed ? (
        <p role="status">
          Recording removed from the service. You can leave this recording.
        </p>
      ) : (
        <>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy || !!pending.current}
              onChange={(event) => setConfirmed(event.target.checked)}
            />{" "}
            I want to permanently remove this recording from the service.
          </label>
          <button disabled={!confirmed || busy} onClick={() => void remove()}>
            {pending.current ? "Retry recording removal" : "Remove recording"}
          </button>
          {busy && <p role="status">Removing recording…</p>}
          {error && <p role="alert">{error}</p>}
        </>
      )}
    </section>
  );
}
