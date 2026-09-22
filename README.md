# Sentinel

Multi-region uptime and synthetic monitoring. Eight probe regions vote on whether your
service is actually down, so a flaky probe in São Paulo doesn't page you at 3am.

Sentinel runs HTTP, TCP, ICMP, DNS, heartbeat and multi-step API-flow checks from
independent regional workers, then applies a quorum rule across their verdicts before it
opens an incident. Every check records a full DNS → TCP → TLS → TTFB → transfer waterfall,
so "the site is slow" becomes "TLS negotiation costs 340ms from Sydney".

---

## Quick start

Requires **Node 20+**, **pnpm 10+**, and **Docker** (for Postgres and Redis).

```bash
pnpm install
cp .env.example .env
pnpm setup          # starts containers, runs migrations, seeds demo data
```

Then start the three processes, each in its own terminal:

```bash
pnpm dev:web        # Next.js on http://localhost:3000
pnpm dev:scheduler  # dispatcher + consensus evaluator + housekeeping
pnpm dev:probes     # three regional probes (bom, fra, iad) in one terminal
```

Open [http://localhost:3000](http://localhost:3000) and sign in:

|          |                     |
| -------- | ------------------- |
| Email    | `demo@sentinel.dev` |
| Password | `sentinel123`       |

The seeded organisation has 20 monitors with 90 days of history, 9 incidents, alert
channels, an escalation policy and a public status page at
[http://localhost:3000/status/acme](http://localhost:3000/status/acme).

Within about a minute the live probes start overwriting the seeded present: `API — checkout`
resolves to an intentionally unroutable host and goes **DOWN**, `API — search` breaches its
250ms latency budget and goes **DEGRADED**, and everything else settles **UP**. Those
verdicts come from the consensus engine reading real check rows, not from the seed.

`pnpm dev:probes bom sin syd fra` runs a different set of regions. Region codes are
`bom sin fra lhr iad sjc gru syd`.

---

## What's in the box

```
apps/
  web         Next.js 15 App Router — dashboard, monitor CRUD, incidents, status pages, REST API
  scheduler   Leader-locked dispatcher, consensus evaluator, incident lifecycle, rollups, alerting
  probe       BullMQ worker; one process per region, REGION_CODE from the environment
packages/
  shared      Failure taxonomy, region table, consensus algorithm, crypto, plan limits, env loader
  db          Drizzle schema (32 tables), migrations, monthly partitioning, seed script
  checker     The actual prober: HTTP/TCP/DNS/ping/flow, SSRF guard, assertion engine
```

### How a check happens

1. The **scheduler** claims monitors whose `next_run_at` has passed, using one statement that
   both claims and advances the schedule (`FOR UPDATE SKIP LOCKED`), so two schedulers can run
   concurrently without double-dispatching.
2. It fans one job out per enabled region onto `checks-<region>` in Redis, with monitor headers
   and bodies encrypted (AES-256-GCM) so credentials never sit in Redis' append-only file.
3. Each **probe** consumes only its own region's queue, runs the check, and writes a row to
   the partitioned `checks` table with the full timing breakdown.
4. Once every region has reported (or a 20s grace window lapses), the **evaluator** applies
   the quorum rule, damps the result through confirmation counters, and opens, escalates or
   resolves an incident.
5. **Alert deliveries** are queued inside that same transaction with `ON CONFLICT DO NOTHING`
   against a unique index — the guarantee of exactly one alert per incident per channel is
   enforced by the database, not by application logic.

### The consensus rule

With `N` regions reporting and `F` of them failing:

| Condition                    | Verdict                                               |
| ---------------------------- | ----------------------------------------------------- |
| `N < minRegionsRequired`     | `INCONCLUSIVE` — not enough evidence to accuse anyone |
| `F == 0`                     | `UP`                                                  |
| `F >= ceil(N × quorumRatio)` | `DOWN`                                                |
| otherwise                    | `PARTIAL_OUTAGE`                                      |

Defaults are `quorumRatio 0.6`, `minRegionsRequired 2`, and two consecutive confirming cycles
before a status flips. A region that fails far more than its peers gets **quarantined** and
drops out of the quorum entirely, because that is a probe fault, not a customer outage.

`DEGRADED` is layered on top of a healthy verdict: if the median latency across the _passing_
regions breaches the monitor's threshold, the monitor is up but unwell.

---

## Commands

|                                                 |                                                     |
| ----------------------------------------------- | --------------------------------------------------- |
| `pnpm setup`                                    | Containers up, migrate, seed — the whole cold start |
| `pnpm dev`                                      | Everything via Turborepo                            |
| `pnpm dev:web` / `dev:scheduler` / `dev:probes` | Individual processes                                |
| `pnpm build`                                    | Production build of every package                   |
| `pnpm typecheck`                                | `tsc --noEmit` across the workspace                 |
| `pnpm test`                                     | Vitest across the workspace (133 tests)             |
| `pnpm db:migrate` / `db:seed` / `db:studio`     | Database lifecycle                                  |
| `pnpm infra:up` / `infra:down` / `infra:reset`  | Docker containers (`reset` destroys volumes)        |

---

## Configuration

`.env.example` documents every variable. The ones that matter:

| Variable              | Purpose                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------- |
| `DATABASE_URL`        | Postgres connection string                                                              |
| `REDIS_URL`           | Redis connection string                                                                 |
| `ENCRYPTION_KEY`      | 64 hex chars. Encrypts monitor headers, bodies and webhook secrets at rest              |
| `BETTER_AUTH_SECRET`  | Session secret                                                                          |
| `NEXT_PUBLIC_APP_URL` | Used in alert bodies and status-page links                                              |
| `RESEND_API_KEY`      | Optional.**Empty means email alerts are logged to stdout**, which is what the demo does |
| `REGION_CODE`         | Which region a probe process claims to be                                               |
| `PROBE_CONCURRENCY`   | Simultaneous checks per probe                                                           |

Generate a real encryption key with `openssl rand -hex 32`.

The seeded Slack and webhook alert channels point at `.invalid` hostnames on purpose — no demo
can provision a real Slack endpoint. They fail once per incident and show up as `failed` in
Settings → Alerting, next to the email channel's `sent`. Replace their URLs with your own to
see them deliver.

---

## Security

The prober is a deliberate SSRF machine — it fetches URLs that users type in — so the guard is
the load-bearing part of `packages/checker`:

- Every resolved address is checked against 17 blocked CIDR ranges before a socket opens,
  including `169.254.0.0/16` (cloud metadata) and all RFC1918 space.
- IPv4-mapped IPv6 (`::ffff:169.254.169.254`) is unwrapped before matching, closing the obvious
  blocklist bypass.
- The validated IP is **pinned** into the connection, so a DNS record that changes between
  validation and connection (DNS rebinding) cannot redirect the probe.
- Every redirect hop is re-validated. A public URL that 302s to `127.0.0.1` is rejected at the
  hop, not after.
- ICMP shells out with an argv array and pings the resolved IP, never the user's hostname.

`pnpm --filter @sentinel/checker test` includes tests proving `169.254.169.254` and
`localhost:5432` are rejected **before any socket is opened** (`timing.tcpMs === null`).

Outbound webhooks are signed `HMAC-SHA256` over `${timestamp}.${body}` in the
`X-Sentinel-Signature` header, with a 300-second replay window.

---

## Notes on running it

- The `checks` table is **partitioned monthly by `checked_at`**. The scheduler creates future
  partitions and drops expired ones on a schedule; retention is per plan.
- Raw checks are rolled up into 5-minute and 1-hour buckets, so the 90-day charts stay fast
  after raw rows age out.
- `pnpm infra:reset` destroys the Docker volumes. `pnpm db:seed` truncates and rebuilds the
  demo org; it is idempotent and deterministic.
- Architectural choices and their reasoning are in [DECISIONS.md](./DECISIONS.md).
  The REST API is documented in [docs/api.md](./docs/api.md).
