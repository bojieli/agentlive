import { useEffect, useRef, useState } from "react";
import {
  listReports,
  decideReport,
  type OperatorReport,
  type ReportDecision,
} from "@agentlive/client";

export function OperatorReports({ credential }: { credential: string }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="sharing">
      <button
        disabled={!credential}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Review reports (operator)
      </button>
      {open && <ReportPage credential={credential} />}
    </section>
  );
}
function ReportPage({ credential }: { credential: string }) {
  const [reports, setReports] = useState<OperatorReport[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const active = useRef<AbortController | undefined>(undefined);
  async function load(after?: string) {
    if (active.current) return;
    const stop = new AbortController();
    active.current = stop;
    setBusy(true);
    setError("");
    try {
      const page = await listReports({
        serverOrigin: location.origin,
        credential,
        signal: AbortSignal.any([stop.signal, AbortSignal.timeout(15000)]),
        ...(after ? { after } : {}),
      });
      if (!stop.signal.aborted) {
        setReports(page.reports);
        setNext(page.nextAfter);
        setLoaded(true);
      }
    } catch {
      if (!stop.signal.aborted)
        setError(
          "Reports could not be loaded. Enter the server operator key in Access key and retry.",
        );
    } finally {
      if (active.current === stop) {
        active.current = undefined;
        if (!stop.signal.aborted) setBusy(false);
      }
    }
  }
  useEffect(() => {
    void load();
    return () => {
      active.current?.abort();
    };
  }, []);
  return (
    <div role="region" aria-label="Operator reports">
      <p>
        Reports are unverified submissions. Review the recording and explanation
        before deciding. Removal ends service access and starts data cleanup;
        existing backups and downloaded copies remain.
      </p>
      <button disabled={busy} onClick={() => void load()}>
        Refresh reports
      </button>
      {next && (
        <button disabled={busy} onClick={() => void load(next)}>
          Next report page
        </button>
      )}
      {busy && <p role="status">Loading reports…</p>}
      {error && <p role="alert">{error}</p>}
      {loaded && !reports.length && <p>No reports.</p>}
      {reports.map((report) => (
        <Review
          key={report.id + (report.reviewRevision ?? report.revision)}
          report={report}
          credential={credential}
          onChange={(updated) =>
            setReports((rows) =>
              rows.map((row) => (row.id === updated.id ? updated : row)),
            )
          }
        />
      ))}
    </div>
  );
}
function Review({
  report,
  credential,
  onChange,
}: {
  report: OperatorReport;
  credential: string;
  onChange: (report: OperatorReport) => void;
}) {
  const [action, setAction] = useState<ReportDecision["action"]>(
    report.decision?.action ?? "dismiss",
  );
  const [note, setNote] = useState(report.decision?.note ?? "");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<ReportDecision | undefined>(report.decision);
  const active = useRef<AbortController | undefined>(undefined);
  const final = report.status === "removed" || report.status === "dismissed";
  const chosen = pending.current ?? report.decision;
  const effectiveAction = chosen?.action ?? action;
  const effectiveNote = chosen?.note ?? note;
  useEffect(
    () => () => {
      active.current?.abort();
    },
    [],
  );
  async function submit() {
    if (
      active.current ||
      final ||
      !effectiveNote.trim() ||
      (effectiveAction === "remove" && !confirmed)
    )
      return;
    const stop = new AbortController();
    active.current = stop;
    pending.current ??= report.decision ?? {
      operationId: crypto.randomUUID(),
      revision: report.reviewRevision ?? report.revision,
      action,
      note: note.trim(),
    };
    setBusy(true);
    setError("");
    try {
      const result = await decideReport({
        serverOrigin: location.origin,
        credential,
        reportId: report.id,
        decision: pending.current,
        signal: AbortSignal.any([stop.signal, AbortSignal.timeout(15000)]),
      });
      if (!stop.signal.aborted) onChange(result);
    } catch {
      if (!stop.signal.aborted)
        setError(
          "Decision could not be confirmed. Retry the same decision or refresh to inspect saved progress. A changed recording revision requires further review.",
        );
    } finally {
      if (active.current === stop) {
        active.current = undefined;
        if (!stop.signal.aborted) setBusy(false);
      }
    }
  }
  return (
    <article aria-label={`Report ${report.id}`}>
      <p>
        Report {report.id} · {report.category} · {report.status}
      </p>
      <p>
        Recording: {report.streamId} · Revision: {report.revision}
      </p>
      {report.reviewRevision && (
        <p>
          This recording was restored. Review revision: {report.reviewRevision}.
          A new decision is required.
        </p>
      )}
      {report.reconciliations?.map((entry) => (
        <p key={entry.revision}>
          Restored from {entry.previousRevision} to {entry.revision}.
          {entry.previousDecision
            ? ` Prior decision: ${entry.previousDecision.action} — ${entry.previousDecision.note}`
            : " No prior decision."}
        </p>
      ))}
      <p>{report.details}</p>
      {report.reporterId && <p>Reporter account: {report.reporterId}</p>}
      {final ? (
        <p role="status">
          Decision: {report.status}. {report.decision?.note}
        </p>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label>
            Review action{" "}
            <select
              value={effectiveAction}
              disabled={busy || !!chosen}
              onChange={(event) =>
                setAction(event.target.value as ReportDecision["action"])
              }
            >
              <option value="dismiss">Dismiss report</option>
              <option value="remove">Remove recording</option>
            </select>
          </label>
          <label>
            Review note{" "}
            <textarea
              maxLength={500}
              required
              value={effectiveNote}
              disabled={busy || !!chosen}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          {effectiveAction === "remove" && (
            <label>
              <input
                type="checkbox"
                checked={confirmed}
                disabled={busy}
                onChange={(event) => setConfirmed(event.target.checked)}
              />{" "}
              I confirm permanent removal from the service.
            </label>
          )}
          <button
            disabled={
              busy ||
              !effectiveNote.trim() ||
              (effectiveAction === "remove" && !confirmed)
            }
          >
            {chosen ? "Retry report decision" : "Save report decision"}
          </button>
          {error && <p role="alert">{error}</p>}
        </form>
      )}
    </article>
  );
}
