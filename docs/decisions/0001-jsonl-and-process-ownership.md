# JSONL persistence and process ownership

Accepted implementation direction, 2026-09-09.

Persist ordered recording events as checksummed JSONL. Return durable acknowledgments only after file synchronization. Use atomic JSON replacement for metadata/checkpoints and sparse derived indexes for history reads. The publisher retains a second copy until the server acknowledges it. No database or external broker is required by this data flow.

A suspended process must retain its local writer ownership. A process that dies must release ownership without waiting for a stale-file timeout. Use kernel advisory file locks through `fs-native-extensions` (latest verified version 1.5.1), whose npm package supplies prebuilt bindings. This adds a small native binding but avoids implementing a PID/timer lock that can admit two writers after sleep. Verify prebuilt installation on every advertised Node 26 platform; do not patch Node or an agent binary.

Never unlink or atomically replace the lock inode. The data directory is owned by one cooperating server process; each publisher binding likewise has one local owner. Remote publisher connections still need server lease generations and connection-attempt fencing—filesystem locks do not solve network-session ownership.

Evidence: local tests acquire a lock in a separate process, suspend it with SIGSTOP, verify another opener is rejected, kill it with SIGKILL, then acquire the released lock. JSONL tests also kill an actual process after durable append and after an incomplete trailing write and verify prefix recovery.

[Upstream locking API](https://github.com/holepunchto/fs-native-extensions)
