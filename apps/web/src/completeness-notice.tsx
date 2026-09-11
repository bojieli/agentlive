import {
  completenessText,
  type CompletenessSummary,
} from "@agentlive/playback";
/** Persistent incompleteness notice; counts only, never recorded content. */
export function CompletenessNotice({
  summary,
}: {
  summary: CompletenessSummary | undefined;
}) {
  if (!summary) return null;
  const { title, details } = completenessText(summary);
  return (
    <section
      className="completeness-notice"
      role="status"
      aria-label="Recording completeness"
      data-source={summary.source}
    >
      <strong>{title}</strong>
      <ul>
        {details.map((detail) => (
          <li key={detail}>{detail}</li>
        ))}
      </ul>
    </section>
  );
}
