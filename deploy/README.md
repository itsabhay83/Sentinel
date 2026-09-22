# Deploying Sentinel

Three images come out of one `Dockerfile`, all running compiled JavaScript as the
unprivileged `node` user:

| Target      | Runs                                      | Port | Health                       |
| ----------- | ----------------------------------------- | ---- | ---------------------------- |
| `scheduler` | scheduler, plus `migrate` and `seed` CLIs | 4000 | `/live` `/ready`             |
| `probe`     | one regional worker, `REGION_CODE` scoped | 4100 | `/live` `/ready`             |
| `web`       | standalone Next.js server                 | 3000 | `/` (no dedicated route yet) |

```bash
docker build --target scheduler -t ghcr.io/<org>/sentinel/scheduler:<tag> .
docker build --target probe     -t ghcr.io/<org>/sentinel/probe:<tag> .
docker build --target web --build-arg NEXT_PUBLIC_APP_URL=https://sentinel.example.com \
                          -t ghcr.io/<org>/sentinel/web:<tag> .
```

`NEXT_PUBLIC_APP_URL` is inlined into the client bundle at build time. A web image
is therefore pinned to one public origin; a different origin needs a rebuild.
Everything else is read at runtime.

---

## Required secrets

Create these before the first deploy. None of them belong in git.

| Key                   | How to generate                 | Notes                                                             |
| --------------------- | ------------------------------- | ----------------------------------------------------------------- |
| `DATABASE_URL`        | from the Postgres module output | `sslmode=require` in production                                   |
| `REDIS_URL`           | from the Redis module output    | `rediss://` — transit encryption is on                            |
| `ENCRYPTION_KEY`      | `openssl rand -hex 32`          | 64 hex chars. Losing it makes every stored header/body unreadable |
| `BETTER_AUTH_SECRET`  | `openssl rand -base64 32`       | Rotating it logs everyone out                                     |
| `API_KEY_HMAC_SECRET` | `openssl rand -base64 32`       | **Rotating it invalidates every issued API key.** See the runbook |
| `RESEND_API_KEY`      | Resend dashboard                | May be empty — empty logs email to stdout instead of sending      |
| `SENTRY_DSN`          | Sentry project settings         | Optional, empty disables the exporter                             |

Everything else is non-secret and lives in the ConfigMap (`deploy/k8s/configmap.yaml`
or `values.yaml` `config:`). `packages/shared/src/env.ts` validates the whole
environment with Zod at import time, so a missing variable is a crash-loop at boot,
not a runtime surprise.

---

## Rollout order

Order is not advisory. The schema must lead, and the UI must trail.

1. **migrate** — `node dist/migrate.js` from the `scheduler` image, run to
   completion. It applies drizzle migrations and creates the monthly `checks`
   partitions. Abort the deploy if it exits non-zero.
2. **scheduler** — it owns consensus and incident lifecycle; it must understand
   the new schema before probes start writing against it.
3. **probes** — region by region. Watch quorum: taking more than
   `N - minRegionsRequired` regions down at once makes every verdict
   `INCONCLUSIVE`.
4. **web** — last, so the dashboard never renders a shape the API cannot serve.

Rollback runs in reverse, and stops at step 1: migrations are forward-only.
A bad migration is recovered by restore, not by rollback — see
[`docs/runbook.md`](../docs/runbook.md).

---

## Kubernetes (`deploy/k8s/`)

Plain manifests, useful for a single environment or for reading what the chart
generates.

```bash
kubectl apply -f deploy/k8s/namespace.yaml
kubectl -n sentinel create secret generic sentinel-secrets --from-env-file=./secrets.env
kubectl apply -f deploy/k8s/configmap.yaml
kubectl apply -f deploy/k8s/migrate-job.yaml
kubectl -n sentinel wait --for=condition=complete job/sentinel-migrate --timeout=10m
kubectl apply -f deploy/k8s/scheduler.yaml
kubectl apply -f deploy/k8s/probes.yaml
kubectl apply -f deploy/k8s/web.yaml
```

Probe pods are pinned with `nodeSelector: sentinel.io/region: <code>`. Label the
nodes in each region before applying, or every probe stays `Pending`:

```bash
kubectl label node <node> sentinel.io/region=fra
```

ICMP needs `NET_RAW`. The container drops `ALL` capabilities and adds only
`NET_RAW` back; `/bin/ping` in the image carries `cap_net_raw+ep`, so the
unprivileged `node` user can open a raw socket. If your cluster enforces the
`restricted` Pod Security Standard, probes need an exception — without `NET_RAW`,
every ICMP monitor fails with `EPERM` while HTTP/TCP/DNS keep working, which
looks like a partial outage in the product rather than an infrastructure fault.

## Helm (`deploy/helm/sentinel/`)

```bash
helm upgrade --install sentinel deploy/helm/sentinel \
  --namespace sentinel --create-namespace \
  --set image.repository=<org>/sentinel \
  --set image.tag=1.4.0 \
  --set secret.existingSecret=sentinel-secrets \
  --set config.NEXT_PUBLIC_APP_URL=https://sentinel.example.com \
  --set config.BETTER_AUTH_URL=https://sentinel.example.com
```

The chart renders one probe Deployment per entry in `probe.regions` and runs the
migration Job as a `pre-install,pre-upgrade` hook, so the rollout order above is
enforced by Helm rather than by the operator. The chart never creates a Secret —
`secret.existingSecret` must already exist.

Turning off a region:

```bash
helm upgrade sentinel deploy/helm/sentinel --reuse-values \
  --set probe.regions[6].enabled=false
```

Drain regions one at a time and confirm the remaining count still satisfies
`minRegionsRequired` (default 2) for every monitor.

## Terraform (`deploy/terraform/`)

Managed dependencies only — Postgres, Redis, the container registry, and probe
compute per region. It does not manage the Kubernetes cluster or the application.

```bash
terraform init -backend-config=backend.hcl
terraform plan -var environment=production
terraform apply -var environment=production
```

Module layout:

| Module         | Provides                                                                      |
| -------------- | ----------------------------------------------------------------------------- |
| `network`      | VPC, public/private subnets, routing for the control plane                    |
| `postgres`     | RDS Postgres 16, gp3, multi-AZ, encrypted, master password in Secrets Manager |
| `redis`        | ElastiCache Redis 7 with `maxmemory-policy=noeviction`                        |
| `registry`     | One immutable ECR repository per image target, scan-on-push                   |
| `probe-region` | ECS cluster, task definition and service for one region                       |

`noeviction` on Redis is load-bearing: BullMQ job state and the scheduler leader
lock are durable data. An eviction under memory pressure drops queued checks and
can hand leadership to a second scheduler.

**ICMP on Fargate does not work.** Fargate cannot grant `CAP_NET_RAW`. Regions
that must serve ICMP monitors need the EC2 launch type with
`linuxParameters.capabilities.add = ["NET_RAW"]`; the module keeps
`instance_type` for exactly that switch. HTTP, TCP, DNS, heartbeat and flow
checks are unaffected.

Provider aliases are written out per region rather than generated, because
Terraform requires provider aliases to be static. Adding a ninth region means
adding a `provider "aws"` block, a `module "probe_<code>"` block, and the region
code to the validation list in `variables.tf`.
