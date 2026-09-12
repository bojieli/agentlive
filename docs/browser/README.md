# Browser verification

A local headless Google Chrome 152.0.7977.83 run on macOS passed all 16 checks on 2026-09-10. The probe uses a fresh isolated browser context, an actual local HTTP/WebSocket server, a synthetic private recording, and real IndexedDB. No user recording or credential is retained in the report. Browser contexts and temporary server data are removed after the run.

Run after building the workspace, with Google Chrome installed:

```sh
node scripts/probe-browser.mjs
```

The probe verifies cached authenticated joining with verified server snapshot blob transfer; exact backward stepping through tied timestamps; receipt continuing while presentation stays paused; saved exact-position recovery after leaving and reloading; recovery of the committed selection and idle cap in a new tab after a confirmed CDP renderer crash; keyboard activation of Next event and Home/End focus in the one-row activity fixture; idle-cap selection, reload persistence and reset after cache clearing; return to live; document overflow at 1440×1000 and 390×844; paged activity search; clearing the playback cache; and joining/stepping with caching disabled. Page exceptions, console errors and rendered alerts fail the probe. Failure reports are also written under ignored `probe-results`.

Retained evidence: [report](chrome-smoke-2026-09-10.json), [desktop screenshot](desktop.png), [mobile viewport screenshot](mobile.png). Screenshot review caught a wrapping Leave button; the heading now preserves the button width while permitting the title to wrap. The page shell also serves a same-origin SVG favicon under the existing content security policy, eliminating its missing-resource request.

This is a small synthetic smoke check. A mobile viewport in desktop Chromium does not establish mobile hardware or Safari behavior. Keyboard coverage includes one player control and navigation in a one-row activity fixture; a 65-row Home/End/arrow navigation flow in both cache modes also passes; the complete keyboard task flow is covered separately by the accessibility run described at the end of this file. Screen readers, touch interactions, actual suspension, quota pressure/eviction, crashes during IndexedDB transactions or whole-browser termination, offline history, rich content, long-session scrolling and latency/memory acceptance still require verification. Reload recovery follows an explicit Leave action and is not a crash-durability claim.

The renderer-crash check waits for Playwright's actual page crash event, then opens a new tab in the same isolated context. It does not call Leave before the crash. It verifies previously committed cache state, requires the private access key to be entered again, and exercises stepping/live playback after recovery. It does not crash during an in-flight storage transaction or terminate Chrome's browser/storage process.

A CDP `Page.setWebLifecycleState` freeze/active experiment, also tried with another tab foregrounded, emitted no document freeze/resume events in this headless configuration. Those attempts failed the verification assertion and are not counted as suspension coverage. Real suspension remains open.

Automated accessibility scans use @axe-core/playwright 4.13.0 with WCAG 2 A/AA and WCAG 2.1 A/AA tags at both viewport sizes. Each scan passed 25 applicable rules and reported zero violations after darkening the small eyebrow labels, which previously measured 3.94:1 contrast. The retained report includes one incomplete color-contrast rule for a link containing only non-text characters, requiring manual review. These automated results do not establish full WCAG conformance or screen-reader usability, and cover only the synthetic rendered state.

The larger navigation fixture appends 64 synthetic messages in protocol-bounded batches, publishes a server snapshot and rejoins separately with caching enabled and disabled. It pauses playback, focuses the activity viewport and follows Home → End → ArrowUp → ArrowDown → Home. Each transition verifies the focused row's exact ordinal, the total row count (65) and intersection with the scroll viewport. Returning to the first row leaves 12 rows mounted in paged mode and 7 in memory mode, below the probe's bound of 30. [Cached navigation screenshot](navigation-cached.png) and [memory navigation screenshot](navigation-memory.png) retain the final rendered state. This covers a small message-only fixture at the mobile viewport; it does not prove long-session memory or all focus behavior during live updates, deletion, search and rich-content resizing.

Lease integration rerun: Chrome 152 passed all 16 existing rendered checks after production browser lease adoption and reopen recovery wiring, with no console errors and zero axe violations (25 passed rules at each viewport). Report: [lease integration](chrome-leases-2026-09-10.json). Exact stale-lease reconstruction is covered by the production HTTP/IndexedDB integration test; the rendered probe covers normal lease-backed import/reload, renderer crash and navigation, not lease expiry during an active tab.

Recovery rerun and navigation correction: the latest browser recovery implementation passed all 16 checks in Chrome 152 after fixing unstable paged virtual-row keys. The original failure reproduced: ArrowUp focused row 64 while its top was 6,118 pixels and the viewport ended at 820 pixels. Loading/unloading row windows changed virtual keys and discarded measurements; keys now remain stable by view sequence and ordinal. The probe retains geometry when visibility fails. See [failure diagnostics](chrome-navigation-failure-2026-09-10.json) and [passing recovery/navigation report](chrome-recovery-2026-09-10.json). The final run mounted 12 cached rows and 7 memory-mode rows, with zero console errors and zero axe violations. Active lease expiry remains covered by integration tests, not this rendered probe.

Rendered follow-up qualification: the shared-retention build passed 15 Chrome checks but reproduced offscreen ArrowUp focus in cached 65-row navigation (row 64 top 1,621px versus viewport bottom 820px). Stable virtual keys alone did not establish reliable navigation despite the earlier passing sample. A subsequent animation-frame visibility attempt also failed and was removed. Retained diagnostics: docs/browser/chrome-shared-retention-navigation-failure-2026-09-10.json. Navigation acceptance remains open. Isolated install/reproducible package verification passed for shared retention; no full-suite claim is made for this latest change.

Keyboard navigation after asynchronous measurement: VirtualActivity now retains the explicit navigation target and checks its committed row geometry as virtual items change. If later card measurements move the focused target outside the viewport, it corrects the scroll offset. Wheel, touch, pointer interaction and leaving the region clear this navigation intent so manual scrolling is not overridden. This addresses the reproduced offscreen ArrowUp failure beyond the earlier stable-key change. Two successive Chrome runs passed all 16 checks; the second additionally verified that a 1,800px wheel scroll remains displaced after keyboard navigation in both cache modes. Twenty-one focused browser retention/state/session/step tests, TypeScript, browser/package builds and isolated install/reproducible rebuild passed. Evidence: docs/browser/chrome-navigation-geometry-2026-09-10.json. These synthetic 65-row checks do not establish physical-device, long-session or complete accessibility acceptance.

Startup-retry verification passed all 16 Chrome checks, including manual scroll preservation and navigation with 10 mounted cached rows and 7 memory-mode rows. Report: [startup retry](chrome-startup-retry-2026-09-10.json). The run had a long quiet interval during the final navigation fixture; a diagnostic heap showed it had not entered failure cleanup, and it subsequently completed with exit 0. Inspector attachment perturbed the run, so no performance claim is made. The probe now writes progress reports before and after every check, records each check duration, and writes its current cleanup phase before browser close, server close and fixture removal. A partial report's phase must be complete before treating it as a completed probe result.

Active browser generation recovery: stale_lease failures (including subscriber commit causes) capture a copied presentation descriptor before stopping playback. The UI permits one automatic reopen per explicit join, drains the old session, retains the session credential, and passes the exact displayed sequence/time, follow/playing mode, speed, gap anchor and idle cap into startup restoration. The replacement validates/persists that descriptor against rebuilt receipt before subscribing. A repeated failure remains visible instead of looping. The production test invalidates metadata through a second IndexedDB connection while paused, appends an event, and verifies exact view/time/preferences plus resumed receipt after reopen. The rendered probe separately invalidates the generation and triggers a preference save, verifies automatic reopen without Join, exact paused text/prefix and the changed cap. All 15 focused content/session tests and all 17 Chrome checks pass; TypeScript/browser/package builds, isolated install/reproducible rebuild and diff check pass. Report: docs/browser/chrome-active-recovery-2026-09-10.json. This does not complete arbitrary multi-tab races, device/suspend behavior, collection integration, or performance acceptance.

The expanded active-generation check now verifies the automatic-recovery limit and explicit Reopen playback action after a second invalidation. All 17 checks passed with completed cleanup, zero console errors and zero automated axe violations. Report: [repeated recovery](chrome-repeated-recovery-2026-09-10.json). Exact paused prefix/text and idle cap survived both reopen paths.

Rendered disclosure persistence verified: the Chrome probe appends a completed tool with synthetic input/output, navigates to its card, expands it, leaves/reloads/rejoins and verifies both open state and output text. It then collapses the card and rejoins again to verify the closed preference. All 18 checks passed with complete cleanup and no console errors. The first fixture attempt used the wrong singular tool anchor; corrected to the established tools- prefix. Report: docs/browser/chrome-disclosures-2026-09-10.json. This covers a completed tool disclosure; text-page and attachment-selection persistence remain open, as do broader viewer/performance/release gates.

Persisted text-page choices: cached sessions now restore explicit numeric pages and Follow latest text from revision/origin-scoped IndexedDB metadata. Individual updates merge atomically, stale generations reject writes, root invalidation preserves choices, and the catalog retains at most 128 entries with bounded keys. Normal session shutdown explicitly waits for accepted disclosure/text-page writes before closing content storage; the immediate-close integration test caught and now covers cancellation of a queued second inspection write. Automatic follow defaults stay in component state so mounted fields do not fill the metadata queue or repeatedly replace bounded choices. All 17 focused content/session tests pass. The three-page completed-tool Chrome fixture verifies page 2 after Leave/reload/rejoin, explicit latest after another reopen, and disclosure collapse after reopening. All 18 Chrome checks pass with complete cleanup, no console errors and zero automated axe violations. Evidence: docs/browser/chrome-text-pages-2026-09-10.json. TypeScript, browser/package builds and isolated install/reproducible rebuild pass. Attachment-selection persistence and the broader lifecycle, device, performance and release gates remain open.

Attachment inspector selection persistence: cached sessions save one protocol-validated attachment descriptor in revision/origin-scoped metadata, with atomic generation-checked replace/clear and shutdown draining through the inspection-write tracker. Root invalidation preserves the descriptor; stale writers cannot replace or clear it. Reopen validates artifact ID/version/hash against the displayed immutable prefix before showing the inspector and uses that prefix's authoritative attachment metadata. Explicit close clears the saved choice; an unavailable version at the selected prefix clears it without showing a preview. The 18 focused content/session tests pass, including mutation isolation, invalid input, stale clear rejection, invalidation/reopen preservation, explicit clearing and immediate-close session restoration. Chrome passes all 19 checks: two distinct uploaded versions prove version 1 remains selected across reload despite version 2 being available, explicit close survives rejoin, and reopening before both versions existed discards the saved selection. Report: docs/browser/chrome-attachments-2026-09-10.json. TypeScript, browser/package builds, isolated install/reproducible rebuild, formatting and diff checks pass. The full suite's latest 441-test result predates this change; the focused tests and rendered probe validate this addition. Broader concurrent inspection lifecycle, attachment-list pagination preferences, device and performance acceptance remain open.

Automatic latest-text remount behavior is now implemented: TextPagesProvider retains up to 128 joined-viewer defaults in its in-memory position map, with persisted explicit choices taking precedence. Mounted text fields register their default on mount/follow transitions only; catalog eviction does not retrigger registration, and these automatic defaults do not write IndexedDB. Chrome confirms the last page of a three-page message remains selected after pausing, navigating Home until the message is detached, then navigating End to remount it. A subsequent manual page-2 selection survives the same remount in both cached and memory-only modes. All 20 Chrome checks pass with complete cleanup and no console errors; evidence is docs/browser/chrome-text-defaults-2026-09-10.json. TypeScript/browser/package builds, isolated installation/reproducible rebuild and diff checks pass. Defaults are bounded and visit-local; explicit choices retain the previously verified cached reopen behavior. Attachment-list pagination, broader concurrent inspection lifecycle, performance, devices and remaining M0–M7 gates stay open.

Attachment-list page persistence: artifact version offsets now share the existing bounded inspection-page catalog under each artifact's /versions key. Cached sessions atomically persist explicit offsets using the existing generation fencing and shutdown-drain path; memory-only sessions retain them in the joined viewer. The shared catalog retains at most 128 explicit text/list choices. Both modes render at most 32 attachment-version buttons per card; memory mode iterates only to the selected window rather than materializing the entire version list into the DOM. Presentation clamps the stored offset to the selected history without overwriting the retained choice. Chrome's 65-version fixture verifies page 3 across actual virtual detach/remount in both modes, cached Leave/reload/rejoin, clamping to page 2 after stepping back to 64 versions, cached reopen while clamped, and restoration of page 3 when stepping forward to 65 versions. All 21 Chrome checks pass with complete cleanup and no console errors. Evidence: docs/browser/chrome-version-pages-2026-09-10.json. All 34 focused browser-content/paged-state/session tests, TypeScript/browser/package builds, isolated installation/reproducible rebuild, formatting and diff checks pass. The full suite's latest 442-test result predates this addition. Memory-only source state remains unbounded, and broader inspection concurrency, performance, fidelity, deployment and release gates remain open.

Production presentation retirement: BrowserPagedSession now closes replaced views on restored selection, live presentation, seek and step. View replacement is synchronous with presentation-state updates; pending close tasks drain during shutdown before content storage closes. A selection that completes after cancellation is closed rather than installed, and a mismatched step result is closed before failing. The production session test verifies that a superseded view rejects subsequent reads. All 10 focused session/step/idle/memory-pin tests pass. Chrome passes all 21 checks with no console errors and complete cleanup, including live paused-prefix receipt, view recovery, virtualized navigation/text and attachment paging; report: docs/browser/chrome-view-retirement-2026-09-10.json. TypeScript/browser/package builds, isolated installation/reproducible rebuild, formatting and diff checks pass. This prepares view ownership for memory pins; the session still constructs cached receipt views synchronously and the uncached BrowserSession fallback has not switched backends. Asynchronous retained receipt acquisition, memory collection scheduling/backpressure, memory lease wiring and recovery remain open.

Asynchronous retained receipt presentation: BrowserPagedSession startup now receives an acquired initial view, and live presentation uses BrowserPagedState.retainedView through the serialized selection chain. Follow-live seeks return that acquisition task; subscriber commit waits for the followed presentation acquisition, providing backpressure instead of admitting unlimited live views. The acquired view's own timeline determines presentation time. Cancellation prevents installation and retires the acquired view. retainedView accepts authoritative history for the same stale-content reconstruction behavior as prior synchronous cached views and closes temporary recovery views. A gated production test completes acquisition, supersedes it with a paused seek, then releases it; the paused time/mode remain exact and the discarded view rejects reads. All 10 focused session/idle/step/memory-pin tests and all 21 Chrome checks pass, with complete cleanup/no console errors. Evidence: docs/browser/chrome-async-live-view-2026-09-10.json. TypeScript/browser/package builds, isolated installation/reproducible rebuild, formatting and diff checks pass. Memory store/lease backend selection, collection scheduling/backpressure and uncached stale recovery still need session integration before replacing BrowserSession's reference-reducer path. The remaining performance, fidelity, deployment and release gates remain open.

Production uncached paged backend switch: BrowserPagedSession now opens MemoryPagedStore through openContent and MemorySnapshotRetention when cache is disabled or IndexedDB is unavailable. Both modes use the same paged receipt, retained presentation, seek/step and inspection UI. Persistent legacy migration runs only for cached sessions. The session reports memory versus saved status; automatic/manual stale recovery carries the original cache mode, avoiding unintended persistent storage for an uncached visit. The legacy BrowserSession implementation remains for reference tests but is no longer selected by production BrowserPagedSession.open. A new memory variant of the real-server stepping test makes every IndexedDB open throw, verifies exact tied prefix stepping, independent receipt while paused, fresh-visit reset on reopen, return to live, and clean shutdown. All 10 focused step/session/memory-retention tests and all 21 Chrome checks pass, with complete cleanup and no console errors. The uncached virtual fixture mounts 8 of 65 rows. Evidence: docs/browser/chrome-memory-paged-2026-09-10.json. TypeScript/browser/package builds, isolated installation/reproducible rebuild and diff checks pass. Automatic content collection scheduling is not yet wired: the new memory backend enforces byte/entry quotas and stops at capacity rather than automatically reclaiming intermediate versions. Memory stale-lease recovery, collection/backpressure under sustained receipt and 500k/8h heap/latency acceptance remain open; this functional switch does not close scalable playback acceptance.

Automatic memory collection scheduling: guarded paged-state operations now call optional backend maintenance after releasing their construction guard. MemoryPagedStore triggers collection after 4 MiB of growth since the last successful pass or 256 completed operations; a configurable lower byte interval supports deterministic tests. A running peer postpones collection. New root work waits for active maintenance, and receipt/root snapshots are captured after guard acquisition so waiting cannot retain an unpinned superseded root. Retryable collection invalidation (including lazy content imports during tracing) defers to the next completed operation; no sweep occurs for that pass. The low-threshold integration fixture performs ten successive receipt appends, verifies an orphan is automatically reclaimed and confirms pinned paused and current text remain exact. All 18 focused memory/step/session tests and all 21 Chrome checks pass, with complete cleanup/no console errors; report: docs/browser/chrome-memory-collection-2026-09-10.json. TypeScript/browser/package builds, isolated install/reproducible rebuild, formatting and diff checks pass. Collection is now invoked automatically in uncached paged playback, but full pinned-root union capacity, quota failure within a single large batch, repeated lazy-import deferral, long-session throughput/heap and memory stale recovery still require acceptance work. The Chrome fixture is functional evidence, not a 500k/8h performance measurement.

## Keyboard and accessibility-tree verification (2026-09-12)

Chrome 152.0.7977.83 passed all 35 checks, including 14 new ones, with zero
console errors, complete cleanup and zero axe violations at four viewport
sizes. Report: [accessibility run](chrome-accessibility-2026-09-12.json).
Screenshots: [320px reflow](reflow-320.png), [200% zoom](zoom-200.png).

The 14 added checks are: a keyboard-only join of a private recording (Tab to
the Recording ID field, type the id and access key, Tab to the cache choice
and to Join, Enter) that asserts focus then lands on the recording heading;
Tab reachability and an accessible name for every visible control, comparing
the Tab walk against every focusable element in the DOM and against Chrome's
accessibility tree; the player control Tab order with playback-state
announcements, keyboard speed selection and timeline seeking; landmarks,
heading levels, image alternatives and the absence of decorative glyphs from
accessible names; polite, atomic, coalesced activity announcements that are
not applied to the feed; focus survival across virtualized row remounting
during live receipt; focus retention for a row scrolled out of view by
PageDown and its recovery with the arrow keys; keyboard search and opening a
result; keyboard operation of a tool disclosure and of long-text paging;
the attachment dialog's modal semantics, label, focus trapping and focus
restoration on Escape; keyboard Leave returning focus to the join form;
reduced motion; and reflow at 320 CSS pixels and at 200% zoom (640×512).
Each reflow viewport also runs an axe scan: 28 applicable rules passed with
zero violations, alongside 27 at 1440×1000 and at 390×844.

The run recorded: 5 Tab stops from the document to a submitted join form; 20
Tab stops covering all 21 visible controls with 22 named accessibility-tree
controls and none unnamed; `aria-valuetext` reading "0.0s of 0.0s, event 1 of
268" on the timeline; a focused row keeping position 72 of the list across
live appends; the opened search result landing on position 8; one coalesced
announcement ("3 new activity items; 72 in view.") for a three-event burst;
8 Tab stops confined to the attachment dialog; zero animated properties and
zero running animations across 173 elements under emulated
`prefers-reduced-motion: reduce`; and no horizontal overflow at 320 and 640
CSS pixels, with every button, link and select at least 24 CSS pixels on both
axes (the timeline slider, 18 pixels tall, is recorded and excluded).

Defects this found, all fixed in `apps/web/src`:

- Live receipt destroyed keyboard focus. In cached playback every arriving
  event replaces the presentation view, and virtual row keys are derived from
  that view's sequence, so React unmounted and remounted every row. A viewer
  reading a row while following live lost focus to the document body on the
  next event and had to navigate from the top again. The first run of the new
  check reproduced it ("Focus was dropped on the document body"). Focus is
  now restored to the same row, or to the region, whenever focus was inside
  the region and the document holds it instead.
- Every mounted virtual row was a Tab stop, so the feed inserted a dozen
  empty stops into the page's Tab order, and those stops changed as rows
  scrolled. Rows now use a roving tab stop: the region is the entry point and
  the arrow keys move between items.
- Each virtualized row rendered its loading placeholder as `role="status"`.
  Scrolling, or following live, therefore announced "Loading activity…" once
  per row mount. The placeholder is now plain text.
- Nothing announced arriving activity, or playback state, at all. One polite
  atomic region beside the feed now coalesces arrivals over two seconds, and
  one in the player reports follow/play/pause and speed. The first settled
  batch after joining is silent, and seeking backward never announces.
- The content store's bounded 16-operation queue surfaced `retry_later`
  backpressure as a `role="alert"` card inside the scrolling feed, one per
  affected row, with a manual retry button; ordinary fast scrolling triggered
  assertive announcements. Cards now retry backpressure automatically with a
  bounded backoff, and only a persisting failure raises the alert.
- Leaving a recording unmounted the focused Leave button, dropping focus on
  the document body; joining left focus in the sidebar form, eight Tab stops
  from the playback controls that had just appeared. Joining now moves focus
  to the recording heading and leaving returns it to the Recording ID field.
- The attachment dialog relied on the browser restoring focus to its opener,
  which is a virtualized row button that can be unmounted while the dialog is
  open. Closing then dropped focus on the body. The dialog restores focus
  explicitly, falling back to the activity region, and its label now names the
  file and version instead of reading "Attachment inspector" for every file.
- Decorative glyphs were exposed as text: the brand link was named "◉
  AgentLive", the connection status read "● live", and the empty-state orb
  was announced. They are now `aria-hidden`, and the status reads
  "Connection: live".
- The idle-gap control's visible label was "Idle gaps" while its accessible
  name was "Idle gap cap", so speech input could not address the control by
  the words next to it (WCAG 2.5.3). The visible label is now the name.
- The timeline slider announced raw milliseconds; it now carries
  `aria-valuetext` with elapsed time and event position.
- Tool cards jumped from the recording's level 2 heading to level 4 headings
  for Input and Output; they are level 3.
- Turning a text page or an attachment version page changed only static text,
  so a screen reader reported nothing. Those controls now have a status region
  that is rendered empty at mount and filled only after the viewer's own
  change: a region that already holds text when it mounts would be read out on
  every virtual remount.
- The cache checkbox's target was 20 CSS pixels tall, and at 320 pixels the
  sidebar form still used two columns. The label is now at least 24 pixels
  tall and the form collapses to one column below 380 pixels.
- PageUp and PageDown scroll the activity region natively, but the correction
  that keeps an explicitly navigated row visible only released on wheel, touch
  and pointer input, so it pulled the scroll back. Paging keys now release it,
  matching the existing wheel behaviour.

Component coverage: `tests/recovery/browser-activity.test.ts` and
`tests/recovery/browser-text-page.test.ts` assert the card heading levels, the
empty-at-mount paging status regions, and that the scrollable feed carries no
live region while one empty polite announcement sits beside it.

What these checks cannot establish. No screen reader was run: every assertion
is on Chrome's accessibility tree and the DOM, which is what assistive
technology consumes, not how it speaks. Announcement timing, verbosity,
interruption, and virtual-cursor (browse mode) behaviour with VoiceOver, NVDA,
JAWS, Orca or TalkBack remain unverified, as does whether the two-second
coalescing window reads well in practice. No physical device and no other
engine was used: the 320-pixel and 640×512 runs are desktop Chrome at a small
viewport, not a phone and not browser zoom, which also scales text and images.
Forced-colors/high-contrast mode, 200% text-only zoom and the WCAG 1.4.12 text
spacing criterion are not checked, and axe evaluates only automatically
detectable WCAG 2.0/2.1 A and AA rules — WCAG 2.2 criteria are outside that
rule set, apart from the 24-pixel target measurement the probe makes itself.
The journey covers one synthetic recording: workflow and agent cards, bundle
and HTML attachment previews, terminal output, account, sharing, reporting and
error paths are not exercised by keyboard. Focus recovery is verified for
appends while following live and for one Escape path, not for deletions,
visibility changes, multiple tabs, suspension or eviction, so the M4
device/screen-reader/suspension/eviction matrix stays open; this run closes
only its keyboard and structural-semantics slice. One axe result remains
incomplete at every viewport: a link whose only content is a non-text
character, now hidden from assistive technology, which axe cannot evaluate for
contrast.
