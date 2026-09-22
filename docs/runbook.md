# Sentinel runbook

For the person holding the pager. Every command here is meant to be pasted.

Conventions: `$NS` is the Kubernetes namespace (`sentinel`), `$PGURL` is the
admin `DATABASE_URL`. Set them first.

```bash
export NS=sentinel
export PGURL='postgresql://sentinel:...@db.internal:5432/sentinel?sslmode=require'
```

---

## 0. First 60 seconds

```bash
kubectl -n $NS get pods -o wide
kubectl -n $NS get deploy
kubectl -n $NS logs -l app.kubernetes.io/component=scheduler --tail=200 --since=15m
redis-cli -u "$REDIS_URL" info clients | head
psql "$PGURL" -c "SELECT count(*) FROM pg_stat_activity WHERE state <> 'idle';"
```

Decide which of these you are in:

| Symptom                              | Section                                                   |
| ------------------------------------ | --------------------------------------------------------- |
| No new check rows                    | [4](#4-queue-backs-up), [5](#5-scheduler-lost-leadership) |
| Alerts firing for everything at once | [6](#6-a-region-is-quarantined)                           |
| Dashboard 5xx, probes healthy        | [3](#3-disaster-recovery)                                 |
| `checks` inserts failing             | [2](#2-restore) — missing partition                       |
| Suspected key compromise             | [7](#7-secret-rotation)                                   |

---

## 1. Backup

Postgres is the only stateful component that matters. Redis holds queue state
and the leader lock; losing it costs one dispatch cycle, not data.

### What is in the database

32 tables. One of them, `checks`, is **partitioned monthly by `checked_at`**
(`checks_YYYY_MM`), created and dropped by the scheduler's housekeeping loop.
Rollups (`check_rollups_5m`, `check_rollups_1h`) are regular tables derived from
`checks` — they can be recomputed, but doing so is slow.

Verify the partition set before trusting any backup:

```bash
psql "$PGURL" -Atc "
  SELECT c.relname, pg_size_pretty(pg_total_relation_size(c.oid))
  FROM pg_class c
  JOIN pg_inherits i ON i.inhrelid = c.oid
  JOIN pg_class p ON p.oid = i.inhparent
  WHERE p.relname = 'checks'
  ORDER BY c.relname;"
```

### Full logical dump

`pg_dump` follows partitions automatically — a plain dump of `checks` contains
every child. Use the directory format so restore can parallelise.

```bash
pg_dump "$PGURL" \
  --format=directory --jobs=4 --compress=9 --no-owner --no-acl \
  --file=/backup/sentinel-$(date -u +%Y%m%dT%H%M%SZ)
```

### Schema-only dump (keep one per release)

```bash
pg_dump "$PGURL" --schema-only --no-owner --no-acl \
  --file=/backup/schema-$(git rev-parse --short HEAD).sql
```

### Excluding raw checks

A full dump is dominated by `checks`. For a fast config-only backup — the one you
actually need to rebuild the service — skip the raw rows and keep the rollups:

```bash
pg_dump "$PGURL" --format=directory --jobs=4 \
  --exclude-table-data='public.checks_*' \
  --file=/backup/sentinel-config-$(date -u +%Y%m%dT%H%M%SZ)
```

Monitors, incidents, alert channels, status pages and 90 days of 1-hour rollups
survive. Only the raw sub-hour history is lost.

### Managed snapshots

RDS automated backups are configured for 14 days with PITR
(`deploy/terraform/modules/postgres`). Take a manual snapshot before any
migration that drops or rewrites a column:

```bash
aws rds create-db-snapshot \
  --db-instance-identifier sentinel-production-postgres \
  --db-snapshot-identifier sentinel-pre-$(git rev-parse --short HEAD)
```

---

## 2. Restore

### Stop the writers first

A restore into a live database races the scheduler and the probes.

```bash
kubectl -n $NS scale deploy --replicas=0 \
  -l app.kubernetes.io/component=probe
kubectl -n $NS scale deploy/sentinel-scheduler --replicas=0
kubectl -n $NS scale deploy/sentinel-web --replicas=0
```

### Restore

```bash
createdb "$PGADMIN_URL" sentinel_restore
pg_restore --dbname="$PGADMIN_URL/sentinel_restore" \
  --jobs=4 --no-owner --no-acl /backup/sentinel-20260917T031500Z
```

Then verify before cutting over:

```bash
psql "$PGADMIN_URL/sentinel_restore" -Atc "SELECT count(*) FROM monitors;"
psql "$PGADMIN_URL/sentinel_restore" -Atc "SELECT count(*) FROM incidents WHERE resolved_at IS NULL;"
psql "$PGADMIN_URL/sentinel_restore" -Atc "
  SELECT count(*) FROM pg_class c
  JOIN pg_inherits i ON i.inhrelid = c.oid
  JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname='checks';"
```

### Missing partition after a restore

The most common post-restore failure is an insert into `checks` for a month with
no partition, which surfaces as `no partition of relation "checks" found for row`.
The scheduler creates partitions on its housekeeping tick, so the fastest fix is
to start exactly one scheduler replica and wait ~60s. To force it immediately:

```bash
kubectl -n $NS run partition-fix --rm -i --restart=Never \
  --image=ghcr.io/<org>/sentinel/scheduler:<tag> \
  --env-from=secret/sentinel-secrets \
  --command -- node dist/migrate.js
```

`migrate.js` runs `ensurePartitions({ monthsBack: 4, monthsForward: 1 })` after
applying migrations, so it is safe and idempotent to re-run.

### Bring writers back in order

```bash
kubectl -n $NS scale deploy/sentinel-scheduler --replicas=2
kubectl -n $NS rollout status deploy/sentinel-scheduler
kubectl -n $NS scale deploy --replicas=2 -l app.kubernetes.io/component=probe
kubectl -n $NS scale deploy/sentinel-web --replicas=3
```

---

## 3. Disaster recovery

Targets: **RPO 5 minutes** (PITR), **RTO 60 minutes**.

Loss of the whole control-plane region:

1. **Restore Postgres by PITR** into the standby region.
   ```bash
   aws rds restore-db-instance-to-point-in-time \
     --source-db-instance-identifier sentinel-production-postgres \
     --target-db-instance-identifier sentinel-dr-postgres \
     --restore-time 2026-09-17T03:00:00Z
   ```
2. **Create a fresh Redis.** Do not restore it. Queue state is disposable and a
   stale leader lock from the dead region will stall the new scheduler for its
   full TTL.
3. **Update the secret** with the new `DATABASE_URL` and `REDIS_URL`, then
   `kubectl -n $NS rollout restart deploy`.
4. **Run migrate** — the PITR target may predate the current schema.
5. **Start scheduler, then probes, then web.**
6. **Repoint DNS** to the standby ingress.

Probes in the eight regions are stateless and independent of the control-plane
region; they reconnect to the new Redis on their own once the secret is rolled.

Expect a gap in `checks` for the outage window. Incidents that opened before the
failure remain open — the consensus engine re-evaluates them on the next cycle.

---

## 4. Queue backs up

Symptom: `checks-<region>` depth climbing, dispatcher logging backpressure.

```bash
redis-cli -u "$REDIS_URL" --scan --pattern 'bull:checks-*:wait' | while read -r k; do
  printf '%s %s\n' "$k" "$(redis-cli -u "$REDIS_URL" llen "$k")"
done
```

The dispatcher stops enqueueing above `QUEUE_MAX_DEPTH` (default 20000), so a
full queue means checks are being skipped, not that Redis is about to OOM.

Triage in this order:

1. **Are the probes for that region alive?**

   ```bash
   kubectl -n $NS get pods -l sentinel.io/region=fra
   kubectl -n $NS logs -l sentinel.io/region=fra --tail=100
   ```

   A crash-looping probe is almost always a bad env var — Zod fails at import,
   so the log line names the variable.

2. **Is one region's queue the outlier?** Then it is that region's probes, not
   the scheduler. Scale them:

   ```bash
   kubectl -n $NS scale deploy/sentinel-probe-fra --replicas=6
   ```

3. **Are all regions backed up equally?** Then the probes are fine and the
   scheduler is over-dispatching, or Postgres writes are the bottleneck:

   ```bash
   psql "$PGURL" -c "
     SELECT wait_event_type, wait_event, count(*)
     FROM pg_stat_activity WHERE state = 'active'
     GROUP BY 1,2 ORDER BY 3 DESC LIMIT 10;"
   ```

4. **Raise concurrency** rather than replica count when the probes are
   CPU-idle and network-bound:

   ```bash
   kubectl -n $NS set env deploy/sentinel-probe-fra PROBE_CONCURRENCY=50
   ```

5. **Shed load deliberately** if nothing else holds. Disabling the lowest-value
   monitors is better than a queue that silently drops every check:
   ```sql
   UPDATE monitors SET enabled = false
   WHERE organization_id = '<org>' AND interval_seconds < 60;
   ```

### Draining a stuck queue

Only when jobs are known-poisoned. This discards real work:

```bash
redis-cli -u "$REDIS_URL" del bull:checks-fra:wait bull:checks-fra:delayed
```

---

## 5. Scheduler lost leadership

Housekeeping — partition rotation, rollups, retention, incident escalation — sits
behind a Redis leader lock. Dispatch does not: every replica dispatches, using
`FOR UPDATE SKIP LOCKED`. So "no leader" means **housekeeping stopped**, while
checks keep running.

Symptom: no rollup rows for the last hour, partitions not being created,
escalations not firing.

```bash
redis-cli -u "$REDIS_URL" get sentinel:leader
redis-cli -u "$REDIS_URL" ttl sentinel:leader
kubectl -n $NS logs -l app.kubernetes.io/component=scheduler --tail=200 | grep -i leader
```

| Observation                      | Meaning                                     | Action               |
| -------------------------------- | ------------------------------------------- | -------------------- |
| Key exists, TTL counting down    | Healthy. A leader exists.                   | none                 |
| Key exists, TTL `-1`             | Lock leaked without expiry. Stuck forever.  | delete the key       |
| Key exists, holder pod is gone   | Dead replica still nominally holds it.      | delete the key       |
| Key absent, no replica claims it | All replicas unhealthy or Redis unreachable | check pods and Redis |

Forcing a re-election:

```bash
redis-cli -u "$REDIS_URL" del sentinel:leader
kubectl -n $NS logs -l app.kubernetes.io/component=scheduler --tail=50 -f | grep -i leader
```

A new leader should appear within one lock TTL. If leadership flaps between
replicas, Redis latency is the cause — check `redis-cli --latency` and whether
the replication group failed over.

**Never run two schedulers with the lock disabled.** Duplicate housekeeping
double-writes rollups and can resolve an incident twice.

---

## 6. A region is quarantined

A region that fails far more than its peers is dropped from the quorum
automatically — that is the system working, not an outage. It means Sentinel
decided the probe is broken, not the customer.

```bash
psql "$PGURL" -c "SELECT code, quarantined_at, enabled FROM regions ORDER BY code;"
kubectl -n $NS get pods -l sentinel.io/region=gru
kubectl -n $NS logs -l sentinel.io/region=gru --tail=200
```

Check whether the probe or the network is at fault:

```bash
kubectl -n $NS exec deploy/sentinel-probe-gru -- \
  node -e "fetch('https://example.com').then(r=>console.log(r.status)).catch(e=>console.log('FAIL',e.message))"
kubectl -n $NS exec deploy/sentinel-probe-gru -- ping -c 3 -W 2 1.1.1.1
```

If `ping` returns `Operation not permitted`, the container lost `NET_RAW` — check
the pod's `securityContext.capabilities.add` and any Pod Security admission
policy. HTTP checks will still be passing, which is what makes this failure mode
look like a partial outage.

Quorum impact: with `minRegionsRequired = 2`, quarantining regions until fewer
than two report makes every verdict `INCONCLUSIVE` and **no incidents open at
all**. Confirm how many regions are still voting before you quarantine another:

```sql
SELECT count(*) FROM regions WHERE enabled AND quarantined_at IS NULL;
```

Returning a region to service after the underlying fault is fixed:

```sql
UPDATE regions SET quarantined_at = NULL WHERE code = 'gru';
```

Then restart that region's probes so they re-register cleanly:

```bash
kubectl -n $NS rollout restart deploy/sentinel-probe-gru
```

---

## 7. Secret rotation

### `ENCRYPTION_KEY` — HAZARDOUS

AES-256-GCM key for monitor request headers, bodies, flow steps and webhook
secrets. **A naive swap makes every encrypted column undecryptable.** There is no
recovery other than restoring the old key.

Rotation requires re-encrypting the data, so it is a maintenance window, not a
rolling change:

1. Snapshot Postgres. Do not skip this.
   ```bash
   aws rds create-db-snapshot --db-instance-identifier sentinel-production-postgres \
     --db-snapshot-identifier sentinel-pre-key-rotation
   ```
2. Stop every writer (`scale --replicas=0` for scheduler, probes, web).
3. Re-encrypt with both keys available. There is no shipped CLI for this; run a
   one-shot job that reads with the old key and writes with the new one over
   `monitors.headers_encrypted`, `monitors.body_encrypted`,
   `monitors.flow_steps_encrypted` and `alert_channels.secret_encrypted`.
4. Update the secret, verify, then scale back up in the order in
   [deploy/README.md](../deploy/README.md).

Verification before scaling up — a monitor whose headers decrypt to a plausible
object:

```bash
kubectl -n $NS run key-check --rm -i --restart=Never \
  --image=ghcr.io/<org>/sentinel/scheduler:<tag> \
  --env-from=secret/sentinel-secrets \
  --command -- node -e "…decrypt one row and print its keys…"
```

### `BETTER_AUTH_SECRET`

Session signing key. Rotating it invalidates every session: all users are logged
out immediately. No data loss, no re-encryption.

```bash
NEW=$(openssl rand -base64 32)
kubectl -n $NS patch secret sentinel-secrets \
  -p "{\"stringData\":{\"BETTER_AUTH_SECRET\":\"$NEW\"}}"
kubectl -n $NS rollout restart deploy/sentinel-web deploy/sentinel-scheduler
```

Announce it. A silent mass logout reads as a breach to customers.

### `API_KEY_HMAC_SECRET` — BREAKS ALL API KEYS

This is the sharpest edge in the system. API keys are stored as HMACs, not as
ciphertext, so there is **no way to re-derive existing hashes under a new
secret**. Rotating it means **every API key every customer holds stops
authenticating, permanently**. Every CI pipeline, Terraform provider and script
using the Sentinel API breaks at once, and the only fix is for each customer to
issue a new key.

If it is unset it is derived from `BETTER_AUTH_SECRET`, domain-separated — so
rotating `BETTER_AUTH_SECRET` while `API_KEY_HMAC_SECRET` is empty **also
invalidates every API key**. Set it explicitly before you ever rotate sessions:

```bash
kubectl -n $NS get secret sentinel-secrets -o jsonpath='{.data.API_KEY_HMAC_SECRET}' | base64 -d
```

An empty result means you are one session rotation away from an API outage. Pin
it to its currently derived value first, then rotate sessions independently.

Only rotate it for an actual compromise. When you must:

1. Notify every organisation with active keys, with a deadline.
   ```sql
   SELECT o.name, count(*) AS keys, max(k.last_used_at) AS last_used
   FROM api_keys k JOIN organizations o ON o.id = k.organization_id
   WHERE k.revoked_at IS NULL GROUP BY o.name ORDER BY keys DESC;
   ```
2. Rotate the secret and restart web.
3. Revoke the dead rows so the UI stops showing keys that cannot work:
   ```sql
   UPDATE api_keys SET revoked_at = now() WHERE revoked_at IS NULL;
   ```
4. Expect a support spike. Customers see `401`, not a descriptive error.

### `RESEND_API_KEY`

Safe to rotate at any time. Empty means email alerts are logged to stdout rather
than sent — which is a silent alerting outage, so check it after rotating:

```bash
kubectl -n $NS logs -l app.kubernetes.io/component=scheduler --tail=200 | grep -i 'email'
```

---

## 8. Escalation

| Condition                                               | Escalate to                                               |
| ------------------------------------------------------- | --------------------------------------------------------- |
| Data loss suspected, or a restore is needed             | Engineering lead + CTO                                    |
| `ENCRYPTION_KEY` or `API_KEY_HMAC_SECRET` compromised   | Security on-call, immediately                             |
| Fewer than `minRegionsRequired` regions voting > 15 min | Engineering lead — the product is silently not monitoring |
| Postgres primary down > 10 min                          | Engineering lead + start the DR runbook                   |
