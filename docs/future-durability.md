# Object-store durability for actors — notes, not a plan

**Status: not current work.** An actor's SQLite lives only on the device. This
records how [celld](https://github.com/denoland/celld) (Deno Land, Apache-2.0)
solves replication for the same actor contract, so the shape can be
reconstructed without re-reading their tree, and what it would cost here. It is
written down because the design is non-obvious and because the cheap versions of
it lose acknowledged writes.

## What celld does

**Ownership by compare-and-swap, fencing by epoch-in-key.** One record per cell,
`cells/<cell>/own.json` = `{node, epoch}`, acquired by conditional create or etag
CAS (`ownership_store.rs`). *Every* activation advances the epoch — takeover and
plain local wake alike — so an epoch never has two writers. The data path then
writes plain unconditional PUTs under `cells/<cell>/ltx/e<epoch>/`. The epoch in
the key *is* the fence: a node that lost ownership may keep writing, but into a
superseded prefix. Restore reads the newest epoch prefix containing a contiguous
chain from txn 0. `docs/fencing.md` in their repo carries the full argument.

The mechanism to copy is the fence, not the lease. Leases expire and are a
liveness hint; the epoch in the key is what makes a stale writer harmless.

**The output gate is what makes it RPO 0.** A gated write takes a ticket and
waits for the replicated position to pass it; concurrent writes to one cell
coalesce onto one upload, so a cell's throughput is not one round trip per write.
The step a naive implementation forgets: a bucket PUT succeeding is *not*
sufficient to acknowledge. celld re-reads the ownership record and acks only if
it still names this node at this epoch, because "durable in `e<epoch>/`" means
nothing if that prefix was orphaned — object storage cannot refuse a stale
writer.

**Self-fencing.** A node that cannot reach the store cannot replicate, so it
fences *itself* when its published lease expiry passes and writes nothing. Safety
never waits for a peer to notice.

**What the store must provide:** conditional create, conditional overwrite,
read-after-write. Their `celld diagnose` sends four writes and requires two to
fail. Several S3-compatible services accept the precondition headers and ignore
them — i.e. fail silently, which is the worst possible failure for a fence.

**Change capture is WAL reading.** They open WAL mode with
`wal_autocheckpoint(0)`, hold a long-running read transaction to take
checkpointing away from SQLite, and diff the WAL against the last replicated
position. Format lineage in their `crates/ltx/README.md`: rustyriver → Litestream
v0.5 → the [LTX format](https://github.com/superfly/ltx) v0.5.2.

## How it would map here

"The bucket is the source of truth, hosts are replaceable" survives the
translation *because the fence never trusts the host*. A Chrome tab is a far
worse owner than a VM — killed without warning, throttled timers, user-settable
clock, evictable OPFS — and none of that matters to a protocol fenced by an
epoch in a key. What it would buy: real backup (profile wipe, extension
reinstall, and OPFS eviction stop being data loss), device migration, and — the
strongest reason to adopt a real format rather than invent one — a tab↔server
handoff where a server node and a tab are peers in one ownership protocol over
one chain.

Multi-tab on one device is the same problem in miniature and we already have it.
Note the distinction: the OPFS SAH pool refuses concurrent openers, which is a
**lock**, not a fence, and `navigator.locks` is per-profile. Conflating the two
is the classic bug.

A browser cannot hold long-lived S3 credentials, so realistically "the bucket"
is our own endpoint speaking conditional-PUT semantics. That means we would
define the conditional-write contract instead of qualifying five stores.

**The gate hook already exists.** `ActorSqlite`'s third constructor argument is
`commitCallback`, documented at [actor-sqlite.ts](../src/io/actor-sqlite.ts) as
"invoked after committing a transaction. The output gate will block on the
returned promise. This can be used e.g. when the database needs to be replicated
to other machines before being considered durable." Today
[actor-container.ts](../src/server/actor-container.ts) passes `async () => {}`.
We already have the output gate; we lack a sink behind it. It fires *after*
`COMMIT`, so it knows a commit happened but carries no payload.

**What we cannot get free: there is no WAL to tail.** The OPFS SAH-pool VFS has
no shared memory, so WAL mode is unavailable; we run a rollback journal. Options
at our SQLite seam, cheapest first:

- **(a) Whole-DB snapshot — exists today.** `exportSnapshot`/`importSnapshot` in
  [src/util/sqlite.ts](../src/util/sqlite.ts). O(db) per backup, needs every
  handle closed. Fine for backup and device migration; useless for RPO 0.
- **(b) Statement-level logical log.** Every statement passes one choke point,
  `SqliteDatabase.#execStatement`. Tee SQL text plus bindings into a side table
  inside the same implicit transaction. Cheap and backend-neutral, but replays
  deterministically only if the statements are deterministic (`random()`,
  `CURRENT_TIMESTAMP`), and must also cover the runtime's own internal writes,
  which never pass the application regulator.
- **(c) Session extension / preupdate hook — the right primitive, likely
  unavailable.** `sqlite3session_changeset` is an LTX-shaped logical delta.
  Needs compile-time `SQLITE_ENABLE_SESSION`; **verify before planning anything
  on it** that the shipped `@sqlite.org/sqlite-wasm` exports `sqlite3session_*`.
  If absent this means a custom wasm build and browser/Node divergence.
- **(d) A VFS that tees `xWrite`.** Genuine page-level frames with no build
  flags, at the cost of owning a VFS.

A tab that sleeps will blow a 10s lease constantly, so any lease TTL here must be
far longer and the wake path must treat "owner is simply gone" as the normal
case.

## Verification ideas that transfer with no distribution at all

- **Sans-IO core plus seeded adversarial simulation.** celld's `crates/logic/` is
  pure — clock, randomness, and store are interfaces — and a simulator injects
  latency, CAS races, clock drift, and a crash at every await point. The payoff
  is not distribution; it is that the schedule can be hostile. Our gates,
  alarm scheduler, and facet deletion are timing-sensitive and tested against
  real promises.
- **Test the checkers.** They run deliberately broken protocol variants and
  *require* the property suite to go red: "a suite that stays green against a
  broken protocol is a broken suite." Directly applicable to the conformance
  suite right now, whose entire value is that it agrees with workerd. Cheapest
  idea here.
- **Pinned expected verdicts.** Every model configuration carries an expected
  verdict, most of them failure, each encoding a bug the protocol once had. "A
  configuration that stops failing has lost its tooth" — one had, and was
  repaired.
- **TLA+ only once an ownership protocol exists, and then before it is built.**
  Their spec found four bugs plus a split-brain that lost an acknowledged write,
  none of which review or testing had surfaced. Keep it deliberately out of CI
  with a written delta ledger, because a silently stale gate is worse than none.

## Cost and triggers

Their durability layer is a ~5k-line LTX crate plus replication and ownership,
resting on WAL reading we cannot do. A browser version is not a port; it is a
re-derivation around a different capture primitive. Budget quarters. The failure
mode is silent data loss, and every cheap version of this — last-writer-wins
sync, periodic snapshot upload marketed as durability — loses acknowledged writes
on exactly the schedule nobody notices until it matters. If we ship anything
here the RPO must be stated out loud and the gate must actually hold. Two-owner
risk, not availability, is what eats data.

Prerequisites worth preserving regardless, because they are cheap and not
commitments: keep the snapshot pair versioned and honest, keep the wasm `capi`
surface structurally typed so a future build can widen it, keep `commitCallback`
threaded through `ActorSqlite`, and do not let internal runtime writes bypass
whatever seam a future capture would attach to.

Revisit when: a user loses actor data and it matters (OPFS is evictable — the
likeliest first trigger); users want the same agent on two devices; a server
component appears for any other reason, at which point a conditional-write
record is marginal; a wasm build with the session extension becomes routine; or
an actor must continue on another host while its device is offline. That last
requirement needs coordinated ownership and replication rather than snapshot
backup. Local OPFS already survives ordinary tab closure. If it all stays
single-device and the only worry is loss, start with snapshot backup.
