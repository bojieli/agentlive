# Limits and measured performance

Every number here is either a limit the code enforces (with the file that defines it) or a value measured on a named workload. Anything not listed has not been measured; see [what is not measured](#what-is-not-measured).

## Protocol and transport

| Limit                            | Value                                                 | Where                                   |
| -------------------------------- | ----------------------------------------------------- | --------------------------------------- |
| Normalized event, canonical JSON | 250 KiB (publisher rejects larger)                    | `packages/publisher/src/network.ts`     |
| Publish batch                    | 100 events or 256 KiB                                 | `packages/publisher/src/network.ts`     |
| HTTP JSON request body           | 300 KiB                                               | `packages/server/src/http.ts`           |
| WebSocket frame                  | 300 KiB                                               | `packages/server/src/http.ts`           |
| Per-socket outbound buffer       | 2 MiB, then the socket is closed with a resume cursor | `packages/server/src/http.ts`           |
| Pending subscriber messages      | 8, then the socket is closed                          | `packages/server/src/http.ts`           |
| Immutable text page              | 16,384 UTF-16 units                                   | `packages/protocol/src/text-content.ts` |

## Server

| Limit                                                   | Value                                                                                                                                                  | Where                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| Resident session cache                                  | 128 (`serve --max-cached-sessions`); a full cache returns a retryable capacity error                                                                   | `packages/server/src/store.ts`              |
| WebSocket connections                                   | 256 (`maxConnections`)                                                                                                                                 | `packages/server/src/http.ts`               |
| Concurrent archive imports / exports                    | 2 each                                                                                                                                                 | `packages/server/src/http.ts`               |
| Total stored bytes                                      | unlimited by default; `serve --max-stored-bytes`                                                                                                       | `packages/server/src/quotas.ts`             |
| Filesystem free-space floor                             | none by default; `serve --min-free-bytes`                                                                                                              | `packages/server/src/free-space.ts`         |
| Per-account recordings / open recordings / stored bytes | unlimited by default; hosted `quotas` config                                                                                                           | `packages/server/src/quotas.ts`             |
| Hosted accounts                                         | 10,000; 16 KiB per account record; 32 queued mutations                                                                                                 | `packages/server/src/accounts.ts`           |
| Account sessions                                        | 10,000; 8-hour cookies                                                                                                                                 | `packages/server/src/account-sessions.ts`   |
| Snapshot leases per recording                           | 128 retained descriptors, 15-minute expiry                                                                                                             | `packages/server/src/snapshot-leases.ts`    |
| Automatic snapshot collection                           | after 64 MiB of snapshot growth and 30 seconds since that recording's last pass; 30-second pass deadline; `serve --no-snapshot-collection` disables it | `packages/server/src/snapshot-scheduler.ts` |
| Automatic snapshot scheduling                           | 1,000 pending events, 30 seconds, or recording end; 30-second build deadline; 30-second retry backoff                                                  | `packages/server/src/snapshot-scheduler.ts` |
| Shutdown drain                                          | 30 seconds (`serve --shutdown-timeout-ms`)                                                                                                             | `packages/server/src/http.ts`               |
| Operational backup                                      | 100 GiB, 100,000 entries, directory depth 32                                                                                                           | `packages/server/src/backup.ts`             |
| Online backup write barrier                             | 30 seconds (`backup --barrier-timeout-ms`, 1–600 s)                                                                                                    | `packages/server/src/backup.ts`             |

## Attachments, artifacts and archives

| Limit                                  | Value                                                                                                         | Where                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Browser attachment inspection          | 25 MiB announced size, SHA-256 verified                                                                       | `apps/web/src/attachments.ts`              |
| Browser text preview                   | 1 MiB UTF-8                                                                                                   | `apps/web/src/attachments.ts`              |
| Browser raster preview (PNG/JPEG/WebP) | 8 MiB encoded, bounded dimensions                                                                             | `apps/web/src/attachments.ts`              |
| Artifact bundle                        | 24 MiB total, 16 MiB per file, 256 files                                                                      | `packages/protocol/src/artifact-bundle.ts` |
| Portable `.agentlive` archive          | 8 GiB expanded, 16 MiB manifest, 100,000 files, 1 MiB per event line, 64 MiB per attachment                   | `packages/storage/src/archive.ts`          |
| Native discovery scan                  | 50 results by default (1–200), 10,000 entries, 8 directory levels, 128 lines within a 256 KiB prefix per file | `packages/adapters/src/discovery.ts`       |
| Family capture                         | 200 sessions, 8 descendant levels, 199 retained child converters                                              | `packages/adapters/src/opencode-family.ts` |

## Viewers

| Limit                              | Value                                                                         | Where                                      |
| ---------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------ |
| Browser cached (IndexedDB) content | 512 MiB encoded blobs                                                         | `apps/web/src/content-store.ts`            |
| Browser uncached (memory) content  | 64 MiB and 262,144 encoded blobs per visit                                    | `apps/web/src/memory-content.ts`           |
| Terminal watch                     | 512 MiB event cache and 512 MiB derived content, separately                   | `packages/storage/src/subscriber-cache.ts` |
| Terminal replay                    | 512 MiB derived content in a private temporary directory                      | `packages/storage/src/text-store.ts`       |
| Persisted inspection choices       | 128 entries per recording (disclosures, text pages, attachment version pages) | `apps/web/src/inspection-choices.ts`       |
| Activity search results            | 50 matching objects per page                                                  | `apps/web/src/activity-search.ts`          |

## Measured playback performance

Uncached (memory-backed) paged playback, `node scripts/measure-memory-playback.mjs <events> <report> --audit-head`, on Node 26.8.1, macOS arm64 (Apple M2 Max), under the production defaults. Synthetic message-only fixture: one message per 32 events, 256-event receipt batches, a retained early presentation, one current view per batch, three exact-prefix seeks with boundary-text checks. Single local runs, not p95.

|                    Events |  Receipt |    Total | Seeks (mid / first / end) | Peak heap / RSS  | Head blobs / bytes |
| ------------------------: | -------: | -------: | ------------------------- | ---------------- | ------------------ |
|                    10,000 |  0.757 s |  0.930 s | 51 / 1 / 2 ms             | 79.6 / 172.1 MB  | 2,658 / 0.65 MB    |
|                   100,000 | 10.339 s | 11.555 s | 67 / 1 / 2 ms             | 194.4 / 321.4 MB | 26,518 / 6.64 MB   |
| 500,000 (8-hour timeline) | 87.528 s | 93.914 s | 739 / 1 / 4 ms            | 464.0 / 635.8 MB | 132,620 / 33.7 MB  |

The latest head costs 0.265 codec blobs per event, exactly linear. Replay from a landmark ran at roughly 8,100 events/s. At 500,000 events the retained landmark catalog left a largest gap of 106,496 events, so a seek landing at the end of that gap is estimated at about 13 seconds; the 739 ms measurement replayed 7,312 events from a nearby landmark and is one sample, not a guarantee. Reports and the full method are in [docs/performance](performance/README.md).

## Measured concurrent load

`node scripts/measure-load.mjs <report>` on Node 26.8.1, macOS arm64 (Apple M2 Max, 12 logical CPUs, 96 GiB), 2026-09-12. Single local runs on loopback: one driver process, a server child (production `startServer` on `127.0.0.1` under production defaults) and six load-generator children, all on one machine with no network latency and no 50 ms RTT profile. Publishers are real `PublisherJournal` + `PublisherNetwork`; viewers are real `SubscriberClient`. Events are message-only text appends averaging 1,013 bytes canonical; each carries a wall-clock stamp that the viewer's commit callback subtracts, so latency is **publisher capture through viewer commit**, excluding any browser reduction or rendering. Each shape is a 15-second steady window after a 4-second ramp; percentiles come from a bounded histogram (1 ms buckets below 1 s) and are bucket upper bounds. Not repeated runs, not a guarantee.

Shape is `publishers × viewers-per-recording @ captures/s/publisher`.

| Shape                           | Offered / captured / delivered ev/s | Latency p50 / p95 / p99  | Server CPU mean | Server RSS peak |
| ------------------------------- | ----------------------------------- | ------------------------ | --------------- | --------------- |
| 1×1@20                          | 20 / 20.0 / 19.9                    | 42 / 68 / 73 ms          | 11.5%           | 151 MB          |
| 10×10@20 (100 viewers)          | 200 / 144.8 / 1,446                 | 209 / 348 / 382 ms       | 17.8%           | 159 MB          |
| 10×24@100 (240 viewers)         | 1,000 / 138.8 / 3,335               | 224 / 376 / 413 ms       | 19.2%           | 205 MB          |
| 10×10@10, 32 events per capture | 3,200 / 3,210 / 31,905 (61 MB/s)    | 245 / 331 / 379 ms       | 82.9%           | 273 MB          |
| 10×16@10, 32 events per capture | 3,200 / 3,202 / 51,163 (98 MB/s)    | 279 / 383 / 436 ms       | 102.1%          | 277 MB          |
| 10×20@10, 32 events per capture | 3,200 / 3,198 / 60,247 (116 MB/s)   | 1,160 / 1,660 / 1,910 ms | 104.8%          | 335 MB          |
| 10×24@15, 32 events per capture | 4,800 / 4,799 / 63,384 (122 MB/s)   | 5,510 / 8,550 / 8,930 ms | 103.4%          | 348 MB          |

- **Durable capture, not the server, caps the one-event-per-capture rows.** Ten publishers sharing one local volume saturate at 140–147 `PublisherJournal.capture` calls per second in total (6 ms median for one publisher, 31–35 ms for ten), so only 72%, 28% and 14% of the offered 200, 500 and 1,000 events/s were captured. The server stayed below 20% of one CPU. Publishers on separate machines do not share this fsync path.
- **The server's fan-out knee is between about 51,000 and 60,000 event deliveries per second** (98–116 MB/s), with the server process at roughly one saturated core. Past it the server queues rather than sheds: at 240 viewers and 4,800 events/s offered, 55% of expected deliveries happened inside the window and p50 latency reached 5.5 s. No `retry_later`, socket close or viewer reconnect occurred at any shape.
- A `StoredEvent` embeds the publisher's original event beside the normalized content, so delivered bytes are about 1.9× captured bytes and fan-out cost follows the larger number.
- **History**: a 26,445-event, 50.9 MB recording downloads through 500-event pages at 32,520 events/s (62.6 MB/s); four concurrent downloads reach 37,998 events/s (73.2 MB/s). Random-offset page reads under live load are p95 17–41 ms below the knee and p95 1,620 ms at it.
- **Attachments**: 16 MiB uploads at 15.5 MB/s (staging, SHA-256 verification, install, fsync); downloads at 1.17 GB/s single and 1.64 GB/s across four readers, from page cache over loopback.
- **Slow viewer**: a viewer that stops reading is closed with code **1013 "Resume from last contiguous cursor"** after about 2 MiB of server buffering (3.28 MB drained including kernel buffers) while 16.8 MB was published; server RSS peaked at 262 MB during the stall versus 259 MB before it, and a healthy viewer on the same recording missed nothing.
- **Enforced ceilings confirmed**: the 257th WebSocket upgrade was refused with 503 after exactly 256 accepted; creating a 129th recording while 128 sessions were pinned returned 503 `retry_later` "All cached sessions are in use".
- Against [the plan's performance targets](../IMPLEMENTATION_PLAN.md): the ≤300 ms p95 target is met only for a single publisher (68 ms, at zero RTT and without browser rendering) and is missed by every ten-publisher shape (348–436 ms) before any network delay is added; the ≤50 ms idle batching delay is consistent with the 42 ms single-publisher median; the 100 events/s/publisher burst target was not reached by any ten-publisher shape at one event per durable capture (about 14 events/s each), while one publisher sustained 320 events/s with 32 events per capture — a single publisher at one event per capture was only measured at 20 events/s, so its ceiling is inferred from the 6 ms median capture, not measured; the 10-publisher/100-viewer workload was run on this laptop, not on the specified 2 vCPU / 4 GB VM.

Method, per-shape detail and every caveat are in [docs/performance](performance/README.md#concurrent-publishers-and-viewers-2026-09-12); raw reports are [load-sweep.json](performance/load-sweep.json), [load-batched.json](performance/load-batched.json) and [load-history.json](performance/load-history.json).

## Measured corpus conversion

Read-only conversion, reduction and terminal rendering of every local native history on 2026-09-11 (`scripts/validate-native-replay.mjs`, aggregate counts only): Codex 575/575 files and 314,037 events; Claude 1,649/1,684 files (35 rejected for missing standalone session identity or timestamps) and 444,720 events; Kimi 500/500 files and 103,244 events. See [native history corpus](adapters/NATIVE_HISTORY_CORPUS.md).

## What is not measured

- Any result over a real network: every latency and throughput figure above is loopback on one machine, with no RTT profile, packet loss or bandwidth limit, and with the load generator competing for the same CPUs.
- Repeated or statistical results: every figure is a single run, so the percentiles describe one window, not run-to-run variation.
- Latency to a browser or terminal viewer: the measured viewers commit and discard events, so reduction, rendering, IndexedDB and device cost are excluded from the concurrent-load figures.
- Concurrent load on the 2 vCPU / 4 GB VM named in the plan, with private recordings and viewing grants, or with publishers on separate machines (the measured per-publisher capture ceiling is a shared local filesystem effect).
- The IndexedDB and server-snapshot playback paths at 100,000+ events; the table above is the in-memory backend.
- Realistic mixed payloads (tools, attachments, file changes, text replacements) at scale; both the playback and load fixtures are message-only.
- Browser heap limits on real devices, mobile hardware, screen readers, storage-quota eviction and suspension.
- Server behaviour at its documented ceilings (200-session families, 8 GiB archives, 100 GiB backups) — these are enforced limits, not throughput results.
- Any deployed multi-host or hosted-provider result.

Open release gates are tracked in [implementation status](../IMPLEMENTATION_STATUS.md).
