import { useEffect, useRef, useState } from "react";
import { accountFetch } from "./account-transport.js";
import { Visibility } from "./visibility.js";
import { request } from "@agentlive/client/transport";
type Grant = { id: string; label: string; expiresAt: number; revision: string };
export function Sharing({
  streamId,
  credential,
}: {
  streamId: string;
  credential: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="sharing">
      <button onClick={() => setOpen(!open)} aria-expanded={open}>
        Manage viewing access
      </button>
      {open && (
        <SharingPanel
          key={streamId + credential}
          streamId={streamId}
          credential={credential}
        />
      )}
    </section>
  );
}
function SharingPanel({
  streamId,
  credential,
}: {
  streamId: string;
  credential: string;
}) {
  const [grants, setGrants] = useState<Grant[]>([]);
  const [label, setLabel] = useState("");
  const [days, setDays] = useState("7");
  const [issued, setIssued] = useState<{ id: string; token: string }>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const active = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);
  const endpoint = `/api/v1/streams/${encodeURIComponent(streamId)}/viewing-grants`;
  async function call(
    method: string,
    signal: AbortSignal,
    suffix = "",
    body?: unknown,
  ) {
    const result = await request(
      accountFetch,
      endpoint + suffix,
      {
        method,
        headers: {
          ...(credential ? { authorization: `Bearer ${credential}` } : {}),
          ...(body ? { "content-type": "application/json" } : {}),
        },
        credentials: "omit",
        referrerPolicy: "no-referrer",
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      signal,
      1024 * 1024,
    );
    return JSON.parse(result.text);
  }
  async function load(signal: AbortSignal) {
    const result = await call("GET", signal);
    if (
      !Array.isArray(result.grants) ||
      result.grants.length > 128 ||
      result.grants.some(
        (grant: Grant) =>
          typeof grant.id !== "string" ||
          typeof grant.label !== "string" ||
          !Number.isSafeInteger(grant.expiresAt),
      )
    )
      throw new Error("Invalid viewing access response");
    if (!signal.aborted) setGrants(result.grants);
  }
  async function run(operation: (signal: AbortSignal) => Promise<void>) {
    if (active.current) return;
    const stop = new AbortController();
    active.current = stop;
    setBusy(true);
    setError("");
    setNotice("");
    const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(30000)]);
    try {
      await operation(signal);
    } catch {
      if (mounted.current && !stop.signal.aborted)
        setError(
          "Viewing access could not be updated. Owner or publisher access is required. Refresh the list before retrying an uncertain request.",
        );
    } finally {
      if (active.current === stop) {
        active.current = undefined;
        if (mounted.current) setBusy(false);
      }
    }
  }
  useEffect(() => {
    mounted.current = true;
    void run(load);
    return () => {
      mounted.current = false;
      active.current?.abort();
      active.current = undefined;
    };
  }, []);
  const url = new URL(location.pathname, location.origin);
  url.searchParams.set("stream", streamId);
  return (
    <div role="region" aria-label="Viewing access">
      <Visibility streamId={streamId} credential={credential} />
      <p>
        Create read-only access to this recording. Public recordings remain
        readable without a credential.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run(async (signal) => {
            const count = Number(days);
            if (!Number.isInteger(count) || count < 1 || count > 366)
              throw new Error("Invalid expiry");
            const result = await call("POST", signal, "", {
              label,
              expiresAt: Date.now() + count * 86400000,
            });
            if (
              typeof result.id !== "string" ||
              typeof result.token !== "string" ||
              !/^[a-f0-9]{64}$/.test(result.token)
            )
              throw new Error("Invalid credential response");
            if (signal.aborted) return;
            setIssued({ id: result.id, token: result.token });
            await load(signal);
          });
        }}
      >
        <label>
          Access label{" "}
          <input
            value={label}
            maxLength={200}
            onChange={(event) => setLabel(event.target.value)}
            disabled={busy}
          />
        </label>
        <label>
          Expires in days{" "}
          <input
            type="number"
            min="1"
            max="366"
            required
            value={days}
            onChange={(event) => setDays(event.target.value)}
            disabled={busy}
          />
        </label>
        <button disabled={busy}>Create viewing credential</button>
      </form>
      <button disabled={busy} onClick={() => void run(load)}>
        Refresh viewing access
      </button>
      {busy && <p role="status">Updating viewing access…</p>}
      {error && <p role="alert">{error}</p>}
      {issued && (
        <div>
          <p>
            This credential is shown only here. Send it privately with the
            recording link. It is cleared when you close this panel.
          </p>
          <label>
            Recording link <input readOnly value={url.href} />
          </label>
          <label>
            Viewing credential{" "}
            <input
              readOnly
              type="password"
              value={issued.token}
              autoComplete="off"
            />
          </label>
          <button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(issued.token);
                if (mounted.current) setNotice("Viewing credential copied.");
              } catch {
                if (mounted.current)
                  setNotice(
                    "Copy unavailable. Select and copy the credential field.",
                  );
              }
            }}
          >
            Copy viewing credential
          </button>
          <button onClick={() => setIssued(undefined)}>Hide credential</button>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      <ul>
        {grants.map((grant) => (
          <li key={grant.id}>
            <span>
              {grant.label || "Unnamed access"} · Expires{" "}
              {new Date(grant.expiresAt).toLocaleString()}
            </span>{" "}
            <button
              disabled={busy}
              aria-label={`Revoke ${grant.label || "unnamed access"}`}
              onClick={() =>
                void run(async (signal) => {
                  await call(
                    "DELETE",
                    signal,
                    "/" + encodeURIComponent(grant.id),
                  );
                  if (issued?.id === grant.id) setIssued(undefined);
                  await load(signal);
                })
              }
            >
              Revoke
            </button>
          </li>
        ))}
      </ul>
      {!busy && !error && grants.length === 0 && (
        <p>No active viewing credentials.</p>
      )}
    </div>
  );
}
