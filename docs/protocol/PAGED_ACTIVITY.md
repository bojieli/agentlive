# Paged activity cards

BrowserPagedState creates PagedActivityView instances bound to immutable reducer roots. A view loads one requested ActivityRow plus the direct agent/tool/plan-attachment references its card renders. It does not enumerate unrelated objects or hydrate message/tool/edit text. The returned card projection contains only selected metadata and linked metadata, with TextSource references supplied separately. It must not be treated as a complete RecordingState for replay or search.

The activity feed accepts an optional paged view and uses PagedActivityCard for its mounted rows. The view sequence must match the supplied presentation sequence. Each card request is tied to the view, row and version-page offset; obsolete requests are cancelled and their results hidden. Loading and error states are explicit, with a retry action. Stored text failures can also be retried without changing playback position.

Messages, tools and changes use the existing asynchronous text component. Workflow cards retain their metadata and direct links. Plans load exactly their recorded attachment version. Artifact cards load at most 32 descriptors at once and provide previous/next version controls; descriptor identity and version are validated against their index keys. Capture notes are selected by their ordinal in the frozen gap collection.

Views remain fixed while live state advances or visibility changes. Existing immutable text references remain readable until the content owner closes or storage is cleared/evicted. Safe historical-root pinning and collection remain separate work.

Tests cover selected-card isolation from retained text, old-view stability after visibility changes, all rendered object families and workflow links, 35 artifact versions across pages, and corrupt descriptor rejection through both point/range access. Native verification compares each visible card projection with reference metadata and verifies its text-source lengths and pages. Actual browser interaction remains unverified because no browser is connected.

Production BrowserSession still supplies full reference state, and the feed's row enumeration/search still use that state. Replacing receipt, row indexing, seeking and search with paged sources is required before the viewer has bounded working memory. The optional paged-card path is the rendering integration point for that migration.
