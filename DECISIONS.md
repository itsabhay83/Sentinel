# Decisions

Choices that a reader would otherwise have to reverse-engineer, and the reasoning behind them.
Where the build departs from the original specification, that is stated explicitly.

---

## Server Actions and Route Handlers instead of tRPC

**Spec said:** tRPC for the control-plane API.

Next.js Server Actions already give end-to-end type safety inside the App Router: the mutation
is a typed function the client imports directly, and the argument types are checked at the call
site by the same compiler. tRPC would add a router, a client, a transport and a version
constraint to reproduce a guarantee React Server Components provide natively.

Mutations are Server Actions validated with Zod at the boundary. The public REST API is Route
Handlers, because it serves external callers who have no TypeScript to share.

---

## Hand-rolled scrypt sessions instead of Better Auth

**Spec said:** Better Auth (or Clerk, or similar).

`better-auth@^1.1` resolves to 1.7.x, which requires peer `zod@^4` and `drizzle-orm@^0.45`.
Adopting it meant migrating every Zod schema in `packages/shared` to v4 and regenerating a
migration that had already been applied and hand-patched for table partitioning — a large,
risky change to satisfy a dependency. Clerk needs externally provisioned API keys, which a
self-contained demo cannot assume.

The tables are still Better-Auth-shaped (`users`, `sessions`, `accounts`, `organizations`,
`members`, `invitations`), so swapping the implementation back in later is a migration-free
change. Auth itself is ~150 lines in `apps/web/src/lib/auth.ts`.

**Sessions are opaque random tokens stored server-side, not JWTs.** A JWT that can be revoked
needs a denylist, and a denylist is a session table wearing a hat. Every authenticated request
already touches Postgres to resolve the organisation, so the lookup is free.

Passwords are scrypt (`N=32768, r=8, p=1`) with the cost parameters stored inline in the hash
(`scrypt$N$r$p$salt$hash`), so they can be raised later without invalidating stored credentials.
Credentials live on `accounts` with `providerId = 'credential'`, not on `users`, so adding OAuth
does not require a schema change.

---

## The `checks` table is partitioned; the rollups are not

`checks` is `PARTITION BY RANGE (checked_at)` with one partition per month. Retention is then a
`DROP TABLE` of a whole partition rather than a `DELETE` that has to walk and vacuum hundreds of
millions of rows.

There is deliberately **no `DEFAULT` partition**. A catch-all silently absorbs rows with
out-of-range timestamps — which means a clock bug looks like success — and it blocks future
`ATTACH PARTITION` operations. Failing loudly on a missing partition is the better trade.

The primary key is `(id, checked_at)` because Postgres requires the partition key in every
unique constraint. `checks` has no foreign key to `monitors`, since foreign keys into a
partitioned parent constrain the partition lifecycle for no real benefit here.

Rollup tables are ordinary tables. They must outlive the raw rows they were computed from —
that is the entire point of a rollup — so partitioning them by the same retention clock would
defeat it. The 1-hour rollups are derived from the 5-minute rollups rather than from raw checks,
which means hourly percentiles are percentiles-of-percentiles. That is an accepted approximation:
exact hourly percentiles would require keeping raw rows for a year.

---

## Region quarantine measures peers, not the fleet

**Spec said:** quarantine a region when its failure rate is high _and_ the global failure rate is
below 10%.

Taken literally that guard can never fire. With eight equally-weighted regions, one region
failing every check puts the fleet-wide rate at 12.5% — above the ceiling — so the very
condition the rule exists to catch disqualifies itself.

`detectQuarantinedRegions` therefore measures the failure rate across the **other** regions,
excluding the one under judgement. One bad region among seven healthy ones is now correctly
identified as a probe fault; a genuine outage that takes down every region is correctly _not_
quarantined. A region with no peers is never quarantined, because there is nothing to compare it
against.

---

## Degradation is judged on the median of passing regions

`detectDegradation` in `packages/shared` is a **time-series** function: it wants consecutive
latency buckets ordered oldest to newest, and it requires three of them before it will act.

The cycle evaluator has a different shape of evidence — one cycle, several regions, no time
axis. Feeding regions into the time-series function (which the first implementation did) meant
monitors with fewer than three regions could never report `DEGRADED` at all, and eight-region
monitors were judged by whichever three regions SQL happened to return last.

The shared threshold rule was extracted into `degradationThreshold()` so both callers agree on
_what counts as slow_, while each keeps its own evidence shape. The evaluator takes the **median**
of the passing regions: one slow region is a regional problem, which `PARTIAL_OUTAGE` already
describes, so it should not be able to declare the whole monitor degraded.

---

## Everything runs on every scheduler; only housekeeping is leader-locked

Dispatch is safe to run concurrently because claiming and rescheduling happen in a single
statement guarded by `FOR UPDATE SKIP LOCKED` — a second scheduler simply finds nothing to claim.
Consensus evaluation is likewise guarded per monitor by `pg_try_advisory_xact_lock`.

Only genuinely global work — rollups, partition maintenance, retention, quarantine, certificate
expiry, heartbeat misses — sits behind a Postgres advisory lock, and the lock is re-attempted
every tick so a replacement takes over within a second of the leader dying.

The advisory lock uses a **dedicated connection** (`createDedicatedClient()`), because advisory
locks are session-scoped and a pooled connection would silently drop the lock when recycled.

---

## Alert de-duplication is a database constraint

`alert_deliveries` has a unique index on `(incident_id, channel_id, kind, step_index)` and
alerts are queued with `INSERT … ON CONFLICT DO NOTHING` inside the transaction that opens the
incident. Two schedulers racing to alert on the same incident resolve the race in Postgres.

Delivery workers claim rows with `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)
RETURNING`, moving them to `sending` so no peer re-claims them. "Exactly one alert per incident
open and one on resolve" is therefore a schema property, not a code convention.

---

## Secrets are encrypted before they reach Redis

Monitor headers and bodies frequently contain bearer tokens. They are AES-256-GCM encrypted at
rest in Postgres, and the dispatcher re-encrypts them into a single envelope on the job payload,
so plaintext credentials never appear in Redis' append-only file or in `MONITOR` output. The
probe performs exactly one unwrap.

`packages/shared` is split into an isomorphic barrel and a Node-only `/server` subpath. Anything
touching `node:crypto` lives behind `@sentinel/shared/server`, so a client component that imports
it fails at build time rather than shipping key-handling code to the browser. The boundary is
enforced by module resolution rather than by discipline.

---

## The map is hand-drawn SVG, not maplibre-gl

The region map never pans, zooms or shows detail below country level. `maplibre-gl` would add
~800 kB and a runtime dependency on a tile server, which means the dashboard breaks when that
server is unreachable. An equirectangular projection of eight fixed coordinates is about eighty
lines of SVG, renders offline, and animates a ping on failing regions.

---

## Notes for anyone modifying this code

Three non-obvious runtime behaviours cost real debugging time. Each is commented at the site, but
they are collected here because they recur:

**postgres.js does not always return `Date` objects.** It parses timestamps by column OID, and
there are three situations where no OID is available: scalar subqueries inside a `RETURNING`
clause, queries with a dynamically interpolated relation name (which fall back to the simple
query protocol, where _every_ column arrives as text), and values that pass through `json_agg`.
Next.js ISR adds a fourth, since cached payloads rehydrate through JSON. Anywhere a date crosses
one of those boundaries, wrap it: `new Date(value)`.

**BullMQ forbids colons in queue names and custom job IDs**, because it composes its own Redis
keys with them. `checks-bom`, not `checks:bom`; `<cycleId>_<region>`, not `<cycleId>:<region>`.

**A custom `lookup` function must honour Node's `all: true` option.** With Happy Eyeballs enabled
(the default since Node 20), `net.connect` calls `lookup` with `{all: true}` and expects an array
of `{address, family}`. Answering with the legacy 3-argument single-address form makes Node read
`addresses[0].address` as `undefined` and throw `ERR_INVALID_IP_ADDRESS`, which manifests as
intermittent, unexplained check failures.

---

## Deliberately not built

- **Stripe billing.** The seam exists — `PLAN_LIMITS` in `packages/shared/src/limits.ts` and the
  `organizations.plan` column, enforced on monitor creation, region count, interval floor and
  retention. Only the payment provider is absent.
- **Write endpoints on the public REST API.** Reads are exposed; writes need idempotency keys and
  per-key rate limiting before they are safe to publish, and shipping them without those is worse
  than not shipping them.
- **Real Slack and PagerDuty delivery.** The transports are implemented and signed; the seeded
  channels point at `.invalid` hosts because no demo can provision real endpoints.
