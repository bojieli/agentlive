# Text pages from immutable content

The existing PagedText component accepts either a string or a TextSource. String rendering preserves the existing synchronous path. A source supplies immutable identity, UTF-16 length and an abortable range reader. BrowserPagedState creates sources bound to its recording namespace and complete content reference.

`readTextPage` reads one nominal 16,384-unit page plus at most two surrounding units. It adjusts boundaries exactly like string paging so a surrogate pair is not split between displayed pages. It validates returned range length and supports empty text. `sourcePageContaining` uses the same boundaries to navigate to a known offset.

Literal search reveal reads chunks of at most 16,384 plus query-length-minus-one units, retaining overlap for cross-chunk matches. Queries are limited to 256 units. The scan yields between groups of four reads so cancellation remains responsive even with an immediately resolving backend. Cancelling a read rejects promptly without awaiting an uncooperative source; late completion/rejection remains observed.

The stored-text component preserves first/previous/next and follow-latest controls. It displays loading/error state, cancels obsolete work and hides results whose source identity or selected page no longer matches. Each page/reveal request has a 10-second deadline. A source identity must change when its text changes. The component does not hydrate the complete text before showing a page.

Unit tests compare source and string paging at Unicode boundaries, literal search across chunks, invalid ranges and stalled/large-scan cancellation. Native probes compare first/latest pages from persisted browser state with reference text. These data-path tests do not establish React interaction, focus or accessibility behavior in an actual browser.

The active BrowserSession still supplies full reference state and strings to activity cards. Connecting its receipt, row lookup and viewport queries to BrowserPagedState remains required; the source-capable text renderer alone is not the completed viewer migration.
