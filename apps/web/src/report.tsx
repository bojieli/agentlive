import { useEffect, useRef, useState } from "react";
import { submitReport, type ReportSubmission } from "@agentlive/client";
import { accountFetch } from "./account-transport.js";

export function ReportRecording({
  streamId,
  credential,
}: {
  streamId: string;
  credential: string;
}) {
  const [category, setCategory] =
    useState<ReportSubmission["category"]>("privacy");
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<string>();
  const active = useRef<AbortController | undefined>(undefined);
  const pending = useRef<ReportSubmission | undefined>(undefined);
  useEffect(
    () => () => {
      active.current?.abort();
    },
    [],
  );
  async function send() {
    if (active.current || receipt || !details.trim()) return;
    const stop = new AbortController();
    active.current = stop;
    pending.current ??= {
      operationId: crypto.randomUUID(),
      category,
      details: details.trim(),
    };
    setBusy(true);
    setError("");
    try {
      const result = await submitReport({
        serverOrigin: location.origin,
        streamId,
        credential,
        input: pending.current,
        fetch: accountFetch,
        signal: AbortSignal.any([stop.signal, AbortSignal.timeout(15000)]),
      });
      if (!stop.signal.aborted) {
        setReceipt(result.reportId);
        setDetails("");
      }
    } catch {
      if (!stop.signal.aborted)
        setError(
          "Your report could not be confirmed. Retry the same report. Reporting requires current viewing access and available service capacity.",
        );
    } finally {
      if (active.current === stop) {
        active.current = undefined;
        if (!stop.signal.aborted) setBusy(false);
      }
    }
  }
  return (
    <details className="sharing">
      <summary>Report recording</summary>
      <p>
        Send a concern to the server operator for review. Your explanation and
        recording reference are saved. If signed in, your account is associated
        with the report. Do not include passwords or other credentials.
        Reporting does not automatically remove a recording.
      </p>
      {receipt ? (
        <p role="status">Report received. Reference: {receipt}</p>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <label>
            Report category{" "}
            <select
              value={category}
              disabled={busy || !!pending.current}
              onChange={(event) =>
                setCategory(event.target.value as ReportSubmission["category"])
              }
            >
              <option value="privacy">Privacy concern</option>
              <option value="harmful">Harmful content</option>
              <option value="spam">Spam</option>
              <option value="other">Other concern</option>
            </select>
          </label>
          <label>
            Report explanation{" "}
            <textarea
              required
              maxLength={1000}
              value={details}
              disabled={busy || !!pending.current}
              onChange={(event) => setDetails(event.target.value)}
            />
          </label>
          <button type="submit" disabled={busy || !details.trim()}>
            {pending.current ? "Retry report" : "Send report"}
          </button>
          {busy && <p role="status">Sending report…</p>}
          {error && <p role="alert">{error}</p>}
        </form>
      )}
    </details>
  );
}
