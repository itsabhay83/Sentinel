# Observability

Set `METRICS_ENABLED=true` (the default). Metrics are exposed on the same HTTP
server as the health endpoints:

| Process   | Metrics                             | Liveness    | Readiness    |
| --------- | ----------------------------------- | ----------- | ------------ |
| scheduler | `:${SCHEDULER_HEALTH_PORT}/metrics` | `/live`     | `/ready`     |
| probe     | `:${PROBE_HEALTH_PORT}/metrics`     | `/live`     | `/ready`     |
| web       | `/api/metrics`                      | `/api/live` | `/api/ready` |

† The Next app has no dedicated health route yet; `deploy/` probes hit `/`.

`/live` answers "is this process running" — it never touches Postgres or Redis,
so a database outage does not get the pods killed and restarted into the same
outage. `/ready` answers "can this process do useful work" and does check its
dependencies. Wire liveness to `/live` and readiness to `/ready`; swapping them
turns a dependency blip into a cluster-wide restart storm.

---

## Scraping

`deploy/k8s/probes.yaml` publishes a headless `sentinel-probe` Service, and the
scheduler and web have ClusterIP Services. With the Prometheus Operator:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: sentinel
  namespace: sentinel
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: sentinel
  podMetricsEndpoints:
    - port: health
      path: /metrics
      interval: 15s
  namespaceSelector:
    matchNames: [sentinel]
```

Every series carries `region` on probe processes and `service` everywhere
(`pino` sets the same fields on log lines, so logs and metrics join cleanly).

---

## What each metric means

### Check execution

| Metric                            | Type      | Labels                      |
| --------------------------------- | --------- | --------------------------- |
| `sentinel_checks_total`           | counter   | `region`, `type`, `outcome` |
| `sentinel_check_duration_seconds` | histogram | `region`, `type`, `phase`   |
| `sentinel_check_failures_total`   | counter   | `region`, `failure_code`    |

`phase` mirrors the stored waterfall: `dns`, `tcp`, `tls`, `ttfb`, `transfer`.
A latency regression isolated to one phase is the difference between "the site is
slow" and "TLS negotiation costs 340ms from Sydney".

### Queue and dispatch

| Metric                            | Type    | Labels   |
| --------------------------------- | ------- | -------- |
| `sentinel_queue_depth`            | gauge   | `region` |
| `sentinel_jobs_enqueued_total`    | counter | `region` |
| `sentinel_jobs_failed_total`      | counter | `region` |
| `sentinel_dispatch_lag_seconds`   | gauge   | —        |
| `sentinel_dispatch_skipped_total` | counter | `reason` |

`sentinel_dispatch_lag_seconds` is `now() - min(next_run_at)` over due monitors:
how far behind schedule dispatch is. It is the single best "are we actually
monitoring" signal, because it goes bad for every upstream cause — dead probes,
full queue, slow Postgres.

`sentinel_dispatch_skipped_total{reason="queue_full"}` increments when depth
exceeds `QUEUE_MAX_DEPTH`. Non-zero means checks are being dropped.

### Consensus and incidents

| Metric                               | Type      | Labels     |
| ------------------------------------ | --------- | ---------- |
| `sentinel_consensus_verdicts_total`  | counter   | `verdict`  |
| `sentinel_regions_reporting`         | gauge     | —          |
| `sentinel_regions_quarantined`       | gauge     | —          |
| `sentinel_incidents_open`            | gauge     | `severity` |
| `sentinel_incident_duration_seconds` | histogram | `severity` |

`verdict` is `UP`, `DOWN`, `PARTIAL_OUTAGE`, `DEGRADED`, `INCONCLUSIVE`. A rising
`INCONCLUSIVE` rate is the quiet failure mode: not enough regions are reporting,
so nothing can be declared down and **no alerts fire at all**.

### Scheduler internals

| Metric                               | Type                                 |
| ------------------------------------ | ------------------------------------ |
| `sentinel_leader`                    | gauge (1 on the leader, 0 elsewhere) |
| `sentinel_housekeeping_runs_total`   | counter, label `task`                |
| `sentinel_housekeeping_errors_total` | counter, label `task`                |
| `sentinel_partitions_present`        | gauge                                |

### Alert delivery

| Metric                                     | Type      | Labels              |
| ------------------------------------------ | --------- | ------------------- |
| `sentinel_alert_deliveries_total`          | counter   | `channel`, `status` |
| `sentinel_alert_delivery_duration_seconds` | histogram | `channel`           |
| `sentinel_alert_deliveries_dead`           | gauge     | `channel`           |

`status` is `sent`, `failed` or `dead`. `dead` means the delivery exhausted
`ALERT_MAX_DELIVERY_ATTEMPTS` and will never be retried — a customer was not told
about their outage.

### Database

| Metric                               | Type                         |
| ------------------------------------ | ---------------------------- |
| `sentinel_db_pool_in_use`            | gauge                        |
| `sentinel_db_pool_size`              | gauge                        |
| `sentinel_db_query_duration_seconds` | histogram, label `operation` |
| `sentinel_db_retries_total`          | counter, label `reason`      |

---

## What to alert on

Alert on the four symptoms a customer would notice, not on every metric.

1. **We stopped monitoring.** Dispatch lag, or too few regions reporting.
2. **We cannot tell customers.** Alert deliveries going dead.
3. **We are losing checks.** Queue full and skipping.
4. **We are about to fall over.** Partitions missing, pool saturated, Redis at
   its memory ceiling.

Everything else is a dashboard, not a page.

---

## Prometheus rules

```yaml
groups:
  - name: sentinel-monitoring-integrity
    interval: 30s
    rules:
      # The service exists to monitor. If dispatch falls behind, it is not.
      - alert: SentinelDispatchLagging
        expr: sentinel_dispatch_lag_seconds > 120
        for: 5m
        labels:
          severity: page
        annotations:
          summary: "Dispatch is {{ $value | humanizeDuration }} behind schedule"
          runbook: "docs/runbook.md#4-queue-backs-up"

      # Below minRegionsRequired every verdict is INCONCLUSIVE and no incident
      # can open. The product looks healthy while monitoring nothing.
      - alert: SentinelQuorumUnreachable
        expr: sentinel_regions_reporting < 2
        for: 10m
        labels:
          severity: page
        annotations:
          summary: "Only {{ $value }} region(s) reporting — no verdict can be reached"
          runbook: "docs/runbook.md#6-a-region-is-quarantined"

      - alert: SentinelInconclusiveVerdictsHigh
        expr: |
          sum(rate(sentinel_consensus_verdicts_total{verdict="INCONCLUSIVE"}[10m]))
            /
          sum(rate(sentinel_consensus_verdicts_total[10m])) > 0.25
        for: 15m
        labels:
          severity: ticket
        annotations:
          summary: "{{ $value | humanizePercentage }} of verdicts are INCONCLUSIVE"

      - alert: SentinelRegionQuarantined
        expr: sentinel_regions_quarantined > 0
        for: 15m
        labels:
          severity: ticket
        annotations:
          summary: "{{ $value }} region(s) quarantined — probe fault, not customer outage"
          runbook: "docs/runbook.md#6-a-region-is-quarantined"

  - name: sentinel-queues
    interval: 30s
    rules:
      - alert: SentinelQueueDropping
        expr: increase(sentinel_dispatch_skipped_total{reason="queue_full"}[10m]) > 0
        for: 10m
        labels:
          severity: page
        annotations:
          summary: "Checks are being dropped — queue at QUEUE_MAX_DEPTH"
          runbook: "docs/runbook.md#4-queue-backs-up"

      - alert: SentinelQueueDepthHigh
        expr: sentinel_queue_depth > 5000
        for: 10m
        labels:
          severity: ticket
        annotations:
          summary: "checks-{{ $labels.region }} depth is {{ $value }}"

      - alert: SentinelProbeRegionDown
        expr: |
          sum by (region) (up{app_kubernetes_io_component="probe"}) == 0
        for: 5m
        labels:
          severity: page
        annotations:
          summary: "No probe reachable in {{ $labels.region }}"

  - name: sentinel-alerting-path
    interval: 30s
    rules:
      # A customer had an outage and was never told. Strictly worse than a
      # false positive.
      - alert: SentinelAlertDeliveriesDead
        expr: increase(sentinel_alert_deliveries_total{status="dead"}[15m]) > 0
        labels:
          severity: page
        annotations:
          summary: "{{ $value }} alert(s) exhausted every retry on {{ $labels.channel }}"

      - alert: SentinelAlertFailureRateHigh
        expr: |
          sum by (channel) (rate(sentinel_alert_deliveries_total{status="failed"}[15m]))
            /
          sum by (channel) (rate(sentinel_alert_deliveries_total[15m])) > 0.2
        for: 15m
        labels:
          severity: ticket
        annotations:
          summary: "{{ $labels.channel }} delivery failure rate {{ $value | humanizePercentage }}"

  - name: sentinel-infrastructure
    interval: 30s
    rules:
      # An insert into a month with no partition fails outright.
      - alert: SentinelPartitionsMissing
        expr: sentinel_partitions_present < 2
        for: 5m
        labels:
          severity: page
        annotations:
          summary: "Only {{ $value }} checks partition(s) exist — inserts will start failing"
          runbook: "docs/runbook.md#missing-partition-after-a-restore"

      # Dispatch keeps working without a leader; housekeeping does not.
      - alert: SentinelNoSchedulerLeader
        expr: sum(sentinel_leader) < 1
        for: 10m
        labels:
          severity: ticket
        annotations:
          summary: "No scheduler holds the leader lock — housekeeping has stopped"
          runbook: "docs/runbook.md#5-scheduler-lost-leadership"

      - alert: SentinelLeaderFlapping
        expr: changes(sentinel_leader[15m]) > 4
        labels:
          severity: ticket
        annotations:
          summary: "Leadership changed {{ $value }} times in 15m — check Redis latency"

      - alert: SentinelDbPoolSaturated
        expr: sentinel_db_pool_in_use / sentinel_db_pool_size > 0.9
        for: 10m
        labels:
          severity: ticket
        annotations:
          summary: "Postgres pool {{ $value | humanizePercentage }} in use on {{ $labels.service }}"

      - alert: SentinelHousekeepingFailing
        expr: increase(sentinel_housekeeping_errors_total[30m]) > 3
        labels:
          severity: ticket
        annotations:
          summary: "Housekeeping task {{ $labels.task }} is failing repeatedly"
```

---

## Dashboards worth having

- **Monitoring integrity** — dispatch lag, regions reporting, verdict mix over
  time. This is the one to open first during any incident.
- **Per-region health** — queue depth, check rate, p50/p95 duration by phase,
  failure codes. Makes "is it us or is it them" answerable in one glance.
- **Alerting path** — deliveries by status and channel, time from incident open
  to first delivery.
- **Database** — pool use, query duration by operation, partition count, table
  sizes for `checks_*`.

## Logs

Everything is structured JSON via `pino`, with `service` and (on probes)
`region` on every line. Useful filters:

```bash
kubectl -n sentinel logs -l app.kubernetes.io/component=scheduler --tail=500 \
  | jq -c 'select(.level >= 50)'

kubectl -n sentinel logs -l sentinel.io/region=fra --tail=500 \
  | jq -c 'select(.msg | test("check job failed"))'
```

`LOG_LEVEL` is read at boot. Raising verbosity requires a restart — use
`kubectl set env deploy/... LOG_LEVEL=debug`, and set it back, because debug
logging on a probe at 50 concurrent checks is expensive.
