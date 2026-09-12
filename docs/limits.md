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

| Limit                                                   | Value                                                                                                 | Where                                       |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Resident session cache                                  | 128 (`serve --max-cached-sessions`); a full cache returns a retryable capacity error                  | `packages/server/src/store.ts`              |
| WebSocket connections                                   | 256 (`maxConnections`)                                                                                | `packages/server/src/http.ts`               |
| Concurrent archive imports / exports                    | 2 each                                                                                                | `packages/server/src/http.ts`               |
| Total stored bytes                                      | unlimited by default; `serve --max-stored-bytes`                                                      | `packages/server/src/quotas.ts`             |
| Filesystem free-space floor                             | none by default; `serve --min-free-bytes`                                                             | `packages/server/src/free-space.ts`         |
| Per-account recordings / open recordings / stored bytes | unlimited by default; hosted `quotas` config                                                          | `packages/server/src/quotas.ts`             |
| Hosted accounts                                         | 10,000; 16 KiB per account record; 32 queued mutations                                                | `packages/server/src/accounts.ts`           |
| Account sessions                                        | 10,000; 8-hour cookies                                                                                | `packages/server/src/account-sessions.ts`   |
| Snapshot leases per recording                           | 128 retained descriptors, 15-minute expiry                                                            | `packages/server/src/snapshot-leases.ts`    |
| Automatic snapshot scheduling                           | 1,000 pending events, 30 seconds, or recording end; 30-second build deadline; 30-second retry backoff | `packages/server/src/snapshot-scheduler.ts` |
| Shutdown drain                                          | 30 seconds (`serve --shutdown-timeout-ms`)                                                            | `packages/server/src/http.ts`               |
| Operational backup                                      | 100 GiB, 100,000 entries, directory depth 32                                                          | `packages/server/src/backup.ts`             |
| Online backup write barrier                             | 30 seconds (`backup --barrier-timeout-ms`, 1–600 s)                                                   | `packages/server/src/backup.ts`             |

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

## Measured corpus conversion

Read-only conversion, reduction and terminal rendering of every local native history on 2026-09-11 (`scripts/validate-native-replay.mjs`, aggregate counts only): Codex 575/575 files and 314,037 events; Claude 1,649/1,684 files (35 rejected for missing standalone session identity or timestamps) and 444,720 events; Kimi 500/500 files and 103,244 events. See [native history corpus](adapters/NATIVE_HISTORY_CORPUS.md).

## What is not measured

- Latency and throughput under concurrent publishers and viewers, and any p95 figure.
- The IndexedDB and server-snapshot playback paths at 100,000+ events; the table above is the in-memory backend.
- Realistic mixed payloads (tools, attachments, file changes, text replacements) at scale; the fixture is message-only.
- Browser heap limits on real devices, mobile hardware, screen readers, storage-quota eviction and suspension.
- Server behaviour at its documented ceilings (200-session families, 8 GiB archives, 100 GiB backups) — these are enforced limits, not throughput results.
- Any deployed multi-host or hosted-provider result.

Open release gates are tracked in [implementation status](../IMPLEMENTATION_STATUS.md).
