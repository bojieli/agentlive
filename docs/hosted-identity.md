# Hosted identity implementation

Hosted login routes are exposed when hosted mode is explicitly configured. Standalone remains the default. Cookie-authenticated accounts can create/import recordings, list their own recordings, read their private recordings and manage their viewing grants, publisher credentials, snapshots and visibility. Browser sign-in/out controls and same-origin cookie/CSRF transport are implemented; CLI device login/logout and explicit origin-bound account files are implemented. This implementation does not establish hosted-service readiness.

## Libraries and verified behavior

The server now pins `openid-client` **6.8.8** for OIDC and `iron-session` **9.0.1** for sealed login state. Their registry releases and Node compatibility were checked on 2026-09-10. Dependency/runtime locks and isolated-package verification include these versions. No password database or custom cryptographic implementation was added.

`OidcLogin` discovers a configured HTTPS issuer, requires an exact issuer match and uses authorization-code flow with S256 PKCE, random state and nonce. The callback URL is fixed by configuration. `openid-client` validates the response and ID-token claims, with signature validation explicitly enabled. Provider access/ID tokens are not persisted in the account store or returned by the adapter.

Login attempts are sealed through `iron-session`, expire after five minutes and require a matching in-memory entry. At most 1,024 attempts can be pending. Each accepted callback consumes its attempt before exchanging the code. Restart invalidates pending attempts; users must start login again. The adapter returns a durable account only after successful OIDC validation.

The `hostedAuth` route module provides `/auth/login`, `/auth/callback`, `/auth/session` and `/auth/logout` with Secure, HttpOnly, SameSite=Lax, host-only cookies, fixed callback/redirect destinations and no-store responses. Logout requires the configured Origin and a session CSRF token. The module is tested through Hono requests with the signed provider fixture and mounted by `startServer` in configured hosted mode. Actual HTTP tests cover login redirects, cookie attributes, missing sessions/callback state, origin checks, logout, startup failure cleanup and reopening state after shutdown.

## Configure hosted login

```json
{
  "version": 1,
  "publicOrigin": "https://recordings.example.com",
  "issuer": "https://identity.example.com",
  "clientId": "registered-client-id",
  "clientSecretEnv": "AGENTLIVE_OIDC_CLIENT_SECRET",
  "cookiePasswordEnv": "AGENTLIVE_SESSION_PASSWORD"
}
```

Register `https://recordings.example.com/auth/callback` with the OIDC provider. Supply the named environment variables through the deployment's secret configuration; the cookie password must contain at least 32 characters and should be randomly generated. Preserve it across normal restarts; changing it invalidates existing sealed cookies. Run `agentlive serve --hosted-config hosted.json` behind the HTTPS proxy serving the configured public origin. The local listener remains HTTP for proxy termination. The configuration loader rejects inline secrets, non-HTTPS URLs, URL credentials, invalid origins, symlinks and oversized files. Missing environment secrets fail startup.

Server startup owns the account and session ledgers, discovers the provider before listening, and releases acquired state on discovery failure. Shutdown drains requests before closing hosted state. `/api/v1/auth-config` reports `hosted` or `standalone` without provider secrets. The existing standalone owner credential remains an operator credential; its listing is scoped to local recordings. Hosted accounts cannot use it implicitly.

`AccountSessions` stores only session-ID hashes, account IDs, authentication versions and expiries in a protected, exclusively locked ledger. Sealed cookies last eight hours and require a live ledger entry and enabled account on every authentication. Logout persists deletion before reporting success. Disable/enable advances an account authentication version, so old sessions remain invalid after re-enabling. Admission is bounded to 10,000 sessions and 32 queued mutations. Session restart/revocation, tampering, expiry, key changes, failed persistence and disable/re-enable tests pass. Committed revocations and disable/enable changes notify the server so active HTTP transfers are rechecked (see [in-flight HTTP transfer revocation](#in-flight-http-transfer-revocation)). The same notifications recheck open viewing sockets, which close with code 1008 immediately. Whole-process crash acceptance remains open.

Synthetic signed-provider tests verify PKCE, state, nonce, issuer, audience, expiry, signature validation, tampered/expired attempt rejection, callback-origin binding, one-time consumption, stable account mapping and disabled-account denial. These use a controlled provider transport and real library validation. Actual provider interoperability and rendered browser login acceptance remain required.

## Durable accounts

`Accounts` stores one protected `accounts/<account-id>.json` file per identity and rebuilds its identity index from those files. It identifies a user by the exact OIDC issuer and subject pair. Email addresses and display names are not identity keys, and identities from different issuers are never automatically merged. A profile-name update preserves the account ID. A successful login cannot reactivate a disabled account.

The directory has an exclusive process lock, serialized mutations, atomic replacement and bounded admission: 10,000 accounts, 16 KiB per file and 32 pending writes. Reads reject invalid schemas, unsafe permissions, symlinks and duplicate identity mappings. Profile results exclude issuer/subject fields. Account disable/enable uses a version precondition and is exposed only through the operator routes below.

Tests cover concurrent identity resolution, exact issuer separation, profile changes, version conflicts, disabled-account persistence across restart, returned-value isolation, duplicate/corrupt/unsafe files, failed writes and bounded admission. Broader process-death, operational administration and hosted request-authorization acceptance remain open.

## Operator account administration

With hosted mode enabled, the server operator (the owner credential) can list and disable accounts:

```sh
agentlive accounts --server https://recordings.example.com [--limit 50] [--after <account-id>]
agentlive account-status --server https://recordings.example.com --account-id <id> --action disable --expected-version <version>
```

The routes are `GET /api/v1/admin/accounts` (pages of at most 100 ordered by account ID, with `nextAfter`) and `POST /api/v1/admin/accounts/:id/status` with `{ "disabled": true|false, "expectedVersion": n }`. Both require the owner bearer credential; account sessions, devices and grants receive 401, and a standalone server without hosted mode returns 404. Listings include the issuer and display name but never the OIDC subject. A stale `expectedVersion` returns 409.

Disabling commits the new status, then immediately rechecks active HTTP transfers and open viewing sockets, which are aborted or closed with code 1008. Browser sessions and device credentials stop authenticating. Re-enabling restores login but does not revive credentials issued before the disable, because the account's authentication version advanced. Recordings are not removed; use the removal workflow for content. Tests: `tests/recovery/account-admin.test.ts`.

## Next integration work

1. Complete the actual-provider browser redirect journey and broader session-expiry/relogin/multiple-tab acceptance.
2. Complete account authorization acceptance across attachments/import/export and concurrent logout/disable races beyond the in-flight transfer checks below.
3. Add short-lived CLI device linking and origin-bound credential persistence.
4. Per-account quotas and actual deployed-provider acceptance.

The full production gate remains open. Performance benchmarks remain paused while missing product features are completed.

## Account request authorization

Cookie authentication applies to API requests without an Authorization header. An explicit invalid bearer credential never falls back to a browser session. Cookie-authenticated mutations require the exact configured Origin and session CSRF token. Creation and archive import assign the authenticated account ID; client-supplied ownership is rejected by the existing strict request schema. Listing uses that account ID. Private read and management checks compare the recording owner against the authenticated account.

Account watch tickets retain the browser-session requirement. Subscription rechecks that session and recording ownership, so logout invalidates unused tickets. An established account socket checks session validity before each outgoing message and closes with code 1008 instead of delivering further data. Logout, account session revocation, device revocation, account disable and visibility changes also recheck every open viewing socket at the moment the change commits, so idle sockets close immediately rather than at the next heartbeat. Active HTTP transfers are cancelled as described below. Complete queued-operation race coverage remains open.

A real HTTP/WebSocket test seeds two durable accounts and verifies separate creation/listing, idempotent creation within account scope, private metadata/events/export/snapshot and management denial across accounts, CSRF enforcement, bearer precedence, authorized management, live subscription and post-logout socket/ticket denial. The separate signed OIDC route fixture covers session issuance; the account-isolation test does not claim a full real-provider browser journey.

## In-flight HTTP transfer revocation

Every recording API request holds an authorization lifetime for its entire response, including the streamed body, and the response source is cancelled when that lifetime ends. The lifetime depends on how the request was authorized:

- A viewing-grant bearer token uses the grant's own lifetime, which ends on revocation or expiry.
- An anonymous read uses a public-read lifetime, which ends when the recording becomes private.
- A read authorized by an account browser session, device credential, publisher key or operator credential is recorded in a bounded server registry (4,096 active transfers). It is rechecked with the route's normal read rule after browser logout, device self-revocation, browser device revocation, account disable/enable, publisher-credential rotation/revocation and visibility changes made through the API. Each check happens after the change is durably committed and before the mutating request returns. A coarse five-second sweep also covers session expiry and any change that does not go through the HTTP API. A transfer is aborted only if the request would no longer be authorized, so an owner's or publisher's download continues after a public recording becomes private. It also continues after the credential is revoked while the recording is still public.
- Every lifetime also ends when the recording is removed or its session closes.

Aborting cancels the underlying file stream and destroys the connection before the response completes. The client therefore sees a failed transfer: fetch body reads reject, and Content-Length responses are visibly truncated. A revoked transfer is never reported as complete. Response bodies are emitted in chunks of at most 64 KiB, so a revocation also interrupts large in-memory bodies such as history pages. History preparation, export archive assembly and snapshot reads observe the same signal before the response starts, and return an authorization error if it ends. Archive imports are registered with the importing browser session, device or operator credential. Revoking that session or device aborts the upload before the import commits. Attachment uploads abort staging when their publisher credential is rotated or revoked, and installation independently rechecks that credential. Registrations are removed when the response completes, is cancelled or fails.

Bytes already written to the socket, the kernel buffers or the client cannot be withdrawn. An import or upload that commits before the revocation is processed stays committed. The static operator credential is not revocable at runtime. Open viewing WebSockets are rechecked at the same revocation points and close with code 1008; their send-time and heartbeat checks remain as a backstop for expiry and out-of-band changes.

`tests/recovery/transfer-revocation.test.ts` covers this over real HTTP with 24 MiB attachments and paused readers. It cuts off transfers after viewing-grant revocation, publisher-credential revocation, browser logout (attachment and export), device self-revocation, browser device revocation, public-to-private changes for anonymous readers and recording removal. Concurrent unaffected transfers (another grant, the operator, other browser/device sessions and credentialed readers of a restricted recording) complete byte-exactly, with no registrations left afterward. The same test aborts an in-flight import on device revocation without creating a recording. A direct test checks that account disable aborts matching registrations and that the registry bound is enforced. The account-disable case is not tested over HTTP because no disable route is exposed.

## Browser account controls

In hosted mode the browser loads `/auth/session`, shows **Sign in** or the signed-in display name and **Sign out**, and enables **Browse my recordings** without an access key. Leaving the access-key field empty uses the account session for same-origin metadata/history, snapshots, watch tickets, attachments, listing and viewing-grant management. Mutating requests attach the current CSRF token. Explicit bearer requests and other origins do not receive this account transport behavior. Session and configuration reads are bounded and cancellable; credentials and CSRF tokens are not written to local storage.

Sign out revokes the server session, aborts pending joins/listings, closes the open viewer and clears its recording list and input key. It does not delete already saved recording bytes; use **Clear playback cache** for local cached data. Expired sessions currently require reload/sign-in to refresh the UI.

`node scripts/probe-hosted-browser.mjs` runs the production app in Chrome through a disposable HTTPS proxy with a securely scoped preissued synthetic session. Five checks verify cookie-only private listing/join, CSRF-protected grant issuance/revocation, sign-out clearing viewer/access and signed-out reload. The probe removes its temporary certificate, private state and session data; its report contains only aggregate results. The signed-provider fixture separately verifies OIDC redirects/claims; the Chrome probe does not claim a real-provider sign-in journey.

## Device linking server and approval UI

The hosted server now exposes `POST /auth/device/start`, `/auth/device/poll`, `/auth/device/decide` and `/auth/device/revoke`. Start returns a private random device code, a separate displayed user code, verification URI, ten-minute expiry and five-second polling interval. Poll sends `{deviceCode}` and returns pending/slow_down/denied/expired or the approved credential. Codes never authorize recording access themselves. Start is bounded to 32 requests per minute and 1,024 pending links; decisions are bounded to 64 per minute. These are global pilot admission limits, not complete hosted abuse prevention.

A signed-in user enters the displayed code in **Device code** and explicitly chooses **Approve device** or **Deny device**. Approval requires the browser session and same-origin CSRF authorization; the form explains that approval grants recording access and creation/publishing capability. Approval cannot be repeated or reassigned. Logout before approval prevents issuance. Poll retries after a lost response return the same credential until link expiry.

Device credentials have an `ald1_` prefix, are persisted only as hashes with a separate device kind in the session ledger, and last eight hours. They authenticate account API operations without browser CSRF requirements and remain separate from browser cookies, recording publisher keys and read-only viewing grants. They inherit account disable/authentication-version checks. `/auth/device/revoke` accepts the device bearer credential and durably invalidates it. Browser sign-out does not revoke already approved device credentials.

Pending links and approved polling results are memory-only. Restart expires the linking attempt; already issued device credentials remain in the durable ledger until expiry/revocation. If restart loses an approved result before the CLI receives it, the client must start a new link; the unreachable credential expires normally. Browser device listing/revocation is now implemented; broader device administration and crash acceptance remain open.

Device/session tests cover approval, denial, polling cadence, repeated results, restart, expiry, credential-kind separation, revocation, account disable/re-enable and admission limits. The real HTTP account test covers device endpoints, CSRF/unauthenticated approval rejection and cross-account access denial. The Chrome HTTPS probe now includes the approval form and polls/uses/revokes its resulting synthetic credential. CLI login/logout, polling cancellation and origin-bound credential files are now implemented as described below.

## CLI account login

```sh
agentlive login --server https://recordings.example.com --account-file /private/account.json
agentlive list --server https://recordings.example.com --account-file /private/account.json
agentlive replay --server https://recordings.example.com --stream RECORDING_ID --account-file /private/account.json
agentlive logout --server https://recordings.example.com --account-file /private/account.json
```

Login prints the verification URL and user code to stderr. Sign in in your browser, enter that code and approve it; the CLI polls until approval, denial, cancellation or expiry. Network failures during polling retry within the original deadline. The device secret and approved bearer token are not printed. An exclusive lock prevents simultaneous updates; login refuses an existing account file. Its parent directory must already exist.

The resulting owner-only JSON file contains the exact HTTPS server origin, device credential and expiry. `--account-file` supports list/import/publish/watch/replay/export and viewing/publisher-credential management commands. Explicit account files override ambient owner credentials, fail on wrong origin/expiry/unsafe permissions/symlinks, and never fall back to another credential. They cannot combine with owner/viewer files, anonymous access or offline replay. Publisher rotation of a local binding currently still uses its separate owner-credential path.

Logout revokes remotely before deleting and directory-syncing the file. Network/service errors retain it for retry; an already invalid credential (401) permits local removal. If login is cancelled after server approval but before a credential is saved, that credential may remain until expiry; the browser device list can revoke such credentials even without their local file. There is no automatic renewal: log out and log in again after the eight-hour credential expires.

The HTTPS Chrome probe now runs the actual CLI login, reads only the displayed user code, approves it through the production browser, lists/replays a private recording with the saved file, then runs CLI logout and checks file deletion and server denial. It trusts only its temporary self-signed certificate through NODE_EXTRA_CA_CERTS for the CLI and removes the fixture afterward. Focused tests cover polling retry/cancellation, foreign approval URLs, exact origin binding, private permissions, symlinks, existing-file protection, expired credentials and failed-logout retention. This does not establish full native publish, physical-device or real-provider acceptance.

## Manage approved CLI devices

Signed-in users see **Approved CLI devices**, with a separate management identifier, approval time and expiry for each active device credential. **Refresh devices** reloads the list; **Revoke device** durably deletes only the selected account-owned credential. No device token or token hash is returned to the browser. Device creation and browser approval refresh the panel automatically. A cancelled login's already-approved credential can therefore be removed without recovering its local file.

`GET /auth/devices` requires a browser account session. `POST /auth/devices/revoke` takes `{id}` and requires that session, the exact Origin and CSRF token. A different account cannot list or revoke another account's device, and device bearer credentials do not authorize these browser administration routes. Revocation is idempotent. Device-backed API requests and socket output fail their normal session checks afterward, and active HTTP transfers authorized by that device are aborted (see [in-flight HTTP transfer revocation](#in-flight-http-transfer-revocation)).

Older session records without management metadata receive a random durable management ID when listed. Their original tokens stay valid until revoked or expired, and an unknown approval time is shown explicitly. The Chrome HTTPS probe verifies browser revocation followed by denied CLI private access and local CLI logout cleanup. Device ledger tests verify legacy migration/restart, and HTTP tests verify account and CSRF isolation.

## Hosted publishing and portability probe

The HTTPS Chrome probe also runs the real CLI against synthetic Claude-format JSONL: native import creates an account-owned recording, live publish creates another, and appending a second native row delivers that text to account-authenticated replay. It verifies ownership directly through the server store. The publishing subprocess receives SIGTERM and is drained before fixture removal.

Account-authenticated CLI export followed by portable archive import creates a new private recording owned by the same account; its replay matches the source recording exactly. This covers the origin-bound account file through native import, live creation/delivery and archive HTTP transport. It does not establish compatibility with an actual running Claude release, all four native agents, attachment-rich hosted archives or real-provider browser authentication. Those acceptance items remain open.

## Public recording discovery

**Browse public recordings** works without sign-in in standalone and hosted mode. It calls `GET /api/v1/public-recordings?limit=50&after=CURSOR`, which returns public metadata across owners ordered by recording ID. Page size is 1–100. **More recordings** preserves public versus owned-list mode. Private and unlisted recordings are excluded; possessing an unlisted link still permits direct viewing under the existing visibility rules.

Public responses contain only recording ID, revision, title, visibility and creation time, with no owner identity or credentials. The store checks authoritative metadata during each scan, bounds retained selection to one page plus one item, and supports cancellation. This first implementation scans metadata and shares store serialization; large-service latency/abuse admission and indexed discovery are still capacity work. It does not add visibility editing, removal or an abuse-reporting workflow.

Tests verify pagination across owners, exclusion of private/unlisted titles, restart, limits and cancellation. The ten-check hosted HTTPS Chrome probe now signs out, browses public recordings, confirms the private recording is absent and joins public playback.

## Recording visibility management

Recording owners can open **Manage viewing access**, choose **Recording visibility** and save Private, Unlisted or Public for either a live or ended recording. Publisher/viewer credentials alone cannot edit visibility. Public appears in anonymous discovery; Unlisted allows direct anonymous reads without discovery; Private requires authorized access. Changing visibility does not erase downloaded or locally cached bytes.

Owner-only `GET /api/v1/streams/:id/visibility` returns revision, version and current visibility. `POST` accepts `{revision, expectedVersion, operationId, visibility}`. Metadata is durably replaced before success or subscriber invalidation. Exact last-operation retries return the saved result, conflicting operation reuse fails, and stale versions cannot undo newer changes. The UI retains its operation for an uncertain retry; Refresh reloads authoritative state before a different edit. The legacy one-way import-share operation refuses changes after a versioned visibility edit.

All current subscribers are invalidated after a visibility edit and must reconnect. Tickets retain their authorization requirement and recheck current visibility, so an unused anonymous public ticket cannot enter a recording that has become private. Socket output also checks current viewing authority to cover subscription/visibility races. Public GET responses now acquire a bounded authorization lifetime before route processing. Making the recording private aborts those lifetimes after durable metadata replacement, cancels wrapped response sources and prevents further output. Requests still preparing a response cancel its body and return an authorization error when preparation finishes. Already transferred bytes cannot be withdrawn. Owner, device and publisher-key reads of a formerly public recording continue while their credential remains valid; see [in-flight HTTP transfer revocation](#in-flight-http-transfer-revocation). Expensive pre-response work is not comprehensively interrupted; broader crash acceptance remains open.

Public response lifetimes retain their recording session until response completion/cancellation. A full session cache can therefore reject new-session admission while an undrained public download is active; admission resumes after drain. Tests assert both capacity refusal and successful later admission, plus exact downloaded bytes. The lifetime limit is 4,096 concurrent public reads per recording. Visibility restriction conservatively cancels all public-mode GET lifetimes, including an owner read made while public; clients can retry with private authorization.
