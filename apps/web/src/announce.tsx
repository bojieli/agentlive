/**
 * A polite status that carries text only after the viewer changes something.
 *
 * Virtualized rows mount and unmount continuously while playback follows
 * live, so a region that already holds text when it mounts makes a screen
 * reader read every remounted row. Rendering the region empty at mount and
 * filling it on an explicit change keeps the region present before the
 * change — which is what assistive technology needs in order to announce
 * it — without announcing anything the viewer did not ask for.
 */
export function ChangeStatus({
  text,
  changed,
}: {
  text: string;
  changed: boolean;
}) {
  return (
    <span className="visually-hidden" role="status" aria-atomic="true">
      {changed ? text : ""}
    </span>
  );
}
