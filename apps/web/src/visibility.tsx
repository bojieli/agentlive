import { Removal } from "./removal.js";
import { useEffect, useRef, useState } from "react";
import { request } from "@agentlive/client/transport";
import { accountFetch } from "./account-transport.js";
type State = {
  revision: string;
  version: number;
  visibility: "public" | "unlisted" | "private";
};
export function Visibility({
  streamId,
  credential,
}: {
  streamId: string;
  credential: string;
}) {
  const [state, setState] = useState<State>();
  const [value, setValue] = useState("private");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | undefined>(undefined);
  const pending = useRef<object | undefined>(undefined);
  async function run(save: boolean) {
    if (active.current) return;
    const stop = new AbortController();
    active.current = stop;
    setBusy(true);
    setError("");
    try {
      if (save && !pending.current && state)
        pending.current = {
          revision: state.revision,
          expectedVersion: state.version,
          visibility: value,
          operationId: crypto.randomUUID(),
        };
      const response = await request(
        accountFetch,
        `/api/v1/streams/${encodeURIComponent(streamId)}/visibility`,
        {
          method: save ? "POST" : "GET",
          headers: {
            ...(credential ? { authorization: `Bearer ${credential}` } : {}),
            ...(save ? { "content-type": "application/json" } : {}),
          },
          ...(save ? { body: JSON.stringify(pending.current) } : {}),
        },
        AbortSignal.any([stop.signal, AbortSignal.timeout(15000)]),
        4096,
      );
      const result = JSON.parse(response.text);
      if (
        result.streamId !== streamId ||
        typeof result.revision !== "string" ||
        !Number.isSafeInteger(result.version) ||
        !["public", "private", "unlisted"].includes(result.visibility)
      )
        throw new Error("Invalid visibility response");
      if (stop.signal.aborted) return;
      pending.current = undefined;
      setState(result);
      setValue(result.visibility);
    } catch {
      if (!stop.signal.aborted)
        setError(
          "Visibility could not be updated. Recording owner access is required. Retry the same change or refresh before choosing another.",
        );
    } finally {
      if (active.current === stop) {
        active.current = undefined;
        if (!stop.signal.aborted) setBusy(false);
      }
    }
  }
  useEffect(() => {
    void run(false);
    return () => {
      active.current?.abort();
      active.current = undefined;
    };
  }, []);
  return (
    <section aria-label="Recording visibility">
      <p>
        Public recordings appear in discovery. Unlisted recordings can be viewed
        by anyone with the link. Private recordings require authorized access.
      </p>
      <label>
        Recording visibility{" "}
        <select
          disabled={busy || !state || !!pending.current}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        >
          <option value="private">Private</option>
          <option value="unlisted">Unlisted</option>
          <option value="public">Public</option>
        </select>
      </label>
      <button disabled={busy || !state} onClick={() => void run(true)}>
        {pending.current ? "Retry visibility change" : "Save visibility"}
      </button>
      <button disabled={busy} onClick={() => void run(false)}>
        Refresh visibility
      </button>
      {state && (
        <Removal
          key={streamId + state.revision}
          streamId={streamId}
          revision={state.revision}
          credential={credential}
        />
      )}
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">Updating visibility…</p>}
    </section>
  );
}
