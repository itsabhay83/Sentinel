# Running Sentinel in Docker

One command builds the images, starts Postgres and Redis, applies migrations,
seeds the demo data, and brings up the web app, the scheduler and all three
regional probes:

```bash
./start.sh
```

When it finishes it prints the dashboard URL and the demo credentials.

---

## What gets started

| Container            | Image                      | Host port | Role                                                                       |
| -------------------- | -------------------------- | --------- | -------------------------------------------------------------------------- |
| `sentinel-postgres`  | `postgres:16-alpine`       | 5432      | Monitors, checks, incidents. Checks live in monthly partitions.            |
| `sentinel-redis`     | `redis:7-alpine`           | 6379      | BullMQ queues (`checks-<region>`) and the scheduler leader lock.           |
| `sentinel-migrate`   | `sentinel-scheduler:local` | —         | Runs `drizzle` migrations, then exits 0.                                   |
| `sentinel-seed`      | `sentinel-scheduler:local` | —         | Demo org, 20 monitors, 90 days of history. Only runs on an empty database. |
| `sentinel-web`       | `sentinel-web:local`       | 3000      | Next.js dashboard and public status pages.                                 |
| `sentinel-scheduler` | `sentinel-scheduler:local` | 4000      | 1 s tick loop; enqueues due checks, runs consensus and alerting.           |
| `sentinel-probe-bom` | `sentinel-probe:local`     | 4101      | Executes checks for region `bom`.                                          |
| `sentinel-probe-fra` | `sentinel-probe:local`     | 4102      | Executes checks for region `fra`.                                          |
| `sentinel-probe-iad` | `sentinel-probe:local`     | 4103      | Executes checks for region `iad`.                                          |

Three probes are not decoration — a monitor is only declared down once a quorum
of regions agrees, so a single region cannot trigger a false alert.

Once it is up:

- **Dashboard** — <http://localhost:3000>, sign in with `demo@sentinel.dev` / `sentinel123`
- **Public status page** — <http://localhost:3000/status/acme>
- **Health endpoints** — scheduler on `:4000`, probes on `:4101`, `:4102`, `:4103`

---

## Prerequisites

Docker Desktop (or Docker Engine) with Compose v2. Nothing else — Node, pnpm and
the workspace dependencies all live inside the images.

```bash
docker --version           # 20.10+
docker compose version     # v2.x
```

`.env` is created automatically on the first run if it is missing, with a freshly
generated `ENCRYPTION_KEY` and `BETTER_AUTH_SECRET`.

---

## First run takes a while

The initial build installs the whole pnpm workspace and runs `next build`, which
takes **roughly 20–25 minutes** on a typical laptop. That cost is paid once —
the dependency layer is cached, so later runs start in seconds. `./start.sh` on
an already-built stack is effectively instant.

---

## Running alongside a local `pnpm dev`

The host dev stack already owns ports 3000, 4000 and 4101–4103. Rather than
failing halfway through startup on a port bind, `start.sh` checks all five ports
up front and refuses to start, telling you what holds them. To run both at once,
move the container ports:

```bash
WEB_PORT=3010 SCHEDULER_PORT=4010 \
PROBE_BOM_PORT=4111 PROBE_FRA_PORT=4112 PROBE_IAD_PORT=4113 \
./start.sh
```

`BETTER_AUTH_URL` and `NEXT_PUBLIC_APP_URL` follow `WEB_PORT` automatically. Both
are read server-side through `getServerEnv()` at request time rather than being
inlined into the client bundle, so changing the port needs **no image rebuild**.

---

## Commands

| Command                 | Effect                                                                |
| ----------------------- | --------------------------------------------------------------------- |
| `./start.sh`            | Build → infra → migrate → seed-if-empty → start everything.           |
| `./start.sh down`       | Stop all containers. Volumes, and therefore data, are kept.           |
| `./start.sh reset`      | Stop everything and destroy the volumes. Asks for typed confirmation. |
| `./start.sh restart`    | Recreate the application containers without touching the database.    |
| `./start.sh build`      | Rebuild images without starting anything.                             |
| `./start.sh seed`       | Force the demo seed to re-run against a live stack.                   |
| `./start.sh logs [svc]` | Follow logs, all services or one (`./start.sh logs scheduler`).       |
| `./start.sh ps`         | Container status.                                                     |
| `./start.sh --help`     | The usage block.                                                      |

Flags for the default command: `--rebuild` (build with `--no-cache`), `--seed`
(seed even if the database has data), `--no-seed` (never seed).

---

## What the script does, stage by stage

1. **Preflight** — Docker installed, Compose v2 present, daemon running, and all
   five host ports free. Ports already published by this stack's own containers
   are ignored, since those are the ones about to be replaced.
2. **Environment** — `.env` is created from `.env.example` if absent, with real
   generated secrets. The `ENCRYPTION_KEY` is then read back and validated as 64
   hex characters, so a bad value fails here instead of crash-looping six
   containers on a Zod error at boot.
3. **Build** — three images. `sentinel-scheduler:local` (scheduler + the
   migrate/seed CLIs), `sentinel-probe:local` (regional workers) and
   `sentinel-web:local` (standalone Next.js server). All three run compiled
   JavaScript as the unprivileged `node` user.
4. **Infrastructure** — Postgres and Redis, waited on via their healthchecks.
5. **Migrations** — run as a one-shot container. The script uses `docker wait` to
   read the real exit code, dumps the container logs and aborts if it is
   non-zero, rather than starting an application against a half-migrated schema.
6. **Seed** — only when `organizations` is empty, so re-running never duplicates
   demo data.
7. **Application** — web, scheduler and the three probes, waited on via their
   healthchecks, then an HTTP poll against the dashboard before reporting ready.

Every stage is idempotent; running `./start.sh` twice is safe.

---

## Supporting files

| File                     | Purpose                                                                                                                           |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `start.sh`               | The entrypoint below. Everything else is invoked through it.                                                                      |
| `Dockerfile`             | `base` → `deps`/`prod-deps` → `source` → `node-build` (tsup) and `web-build` (`next build`), then `scheduler`, `probe` and `web`. |
| `docker-compose.app.yml` | Overlay adding migrate, seed, web, scheduler and the three probes on top of the existing infra compose file.                      |
| `docker-compose.yml`     | Postgres and Redis. Credentials are `${POSTGRES_USER}`/`${POSTGRES_PASSWORD}` with `sentinel` defaults.                           |
| `.dockerignore`          | Keeps `node_modules`, `.next` and `.env` out of the build context so host-native binaries never leak into the image.              |

Two details in the Dockerfile matter more than they look:

- **`iputils` is installed** in the probe image. The ping checker shells out to
  `ping` with an explicit argv array; Alpine's default busybox `ping` rejects
  that form, so ICMP monitors would fail without the real binary. `ping` carries
  the `cap_net_raw+ep` file capability so the unprivileged `node` user can open a
  raw socket; the probe service therefore declares `cap_add: [NET_RAW]`.
- **Node is invoked directly** (`node dist/index.js`) rather than through `pnpm
run`, so `SIGTERM` reaches Node itself and the probes can drain their in-flight
  checks instead of being killed mid-request.
- **Every service logs through a rotated json-file driver** (10 MB × 3). Before
  that was set, `.run/scheduler.log` grew to 171 MB unattended.

---

## Configuration

Compose reads `.env`, with two deliberate overrides per container:

| Variable       | Value in containers                                     | Why                                                                                              |
| -------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `DATABASE_URL` | `postgresql://sentinel:sentinel@postgres:5432/sentinel` | `.env` points at `localhost`, which is correct on the host and wrong inside a network namespace. |
| `REDIS_URL`    | `redis://redis:6379`                                    | Same reason.                                                                                     |

Everything else — `ENCRYPTION_KEY`, `BETTER_AUTH_SECRET`, `LOG_LEVEL`,
`RESEND_API_KEY`, `ALERT_EMAIL_FROM` — is passed through from `.env` unchanged.
Container environment always wins: the env loader never overwrites a variable
that is already set.

---

## Troubleshooting

**Ports are already in use.** Expected if `pnpm dev` is running. Stop it, or use
the `WEB_PORT=…` override shown above.

**`web did not respond within 180s`.** The script prints the last 40 lines of the
web log before exiting. Almost always a bad `.env` value.

**Migrations failed.** The migrate container's logs are dumped automatically. If
the schema is wedged, `./start.sh reset` destroys the volumes and starts clean.

**Checks are not appearing.** Give the probes about a minute, then
`./start.sh logs scheduler`. The scheduler only ticks when it holds the Redis
leader lock — `curl localhost:4000` should report `"leader":true`.

---

## Verified behaviour

A full boot was run end to end against this stack. Migrations applied and created
the `checks_2026_05` … `checks_2026_11` partitions; all five application
containers reached a healthy state; `/`, `/login` and `/status/acme` all returned
200; the scheduler reported `{"service":"scheduler","leader":true,"running":true}`
and each probe reported `{"service":"probe","region":"…","running":true}`.

Check rows written in the first three minutes, straight from Postgres:

| Type   | Rows | OK  | Avg latency |
| ------ | ---- | --- | ----------- |
| `http` | 99   | 73  | 464.2 ms    |
| `tcp`  | 18   | 18  | 85.6 ms     |
| `ping` | 9    | 9   | 129.9 ms    |

Evenly split across `bom`, `fra` and `iad` at 42 checks per region, which
confirms the scheduler is fanning work out to every probe rather than one. The 26
HTTP failures are the intentionally broken demo monitors that drive the sample
incidents.

---

## The script

`start.sh`, in full:

```bash
#!/usr/bin/env bash
# =============================================================================
# Sentinel — one-command Docker startup.
#
#   ./start.sh              boot the whole stack (build → infra → migrate →
#                           seed-if-empty → web + scheduler + 3 probes)
#   ./start.sh down         stop everything, keep the data
#   ./start.sh reset        stop everything and destroy the volumes
#   ./start.sh restart      recreate the application containers
#   ./start.sh build        rebuild the images without starting anything
#   ./start.sh seed         re-run the demo seed against a running stack
#   ./start.sh logs [svc]   follow logs (all services, or one)
#   ./start.sh ps           show container status
#
# The script is idempotent: running it twice does not duplicate data, and it
# only seeds a database that has no organisations in it.
#
# Host ports can be moved when something else already owns them — useful when a
# local `pnpm dev` stack is running at the same time:
#
#   WEB_PORT=3010 SCHEDULER_PORT=4010 \
#   PROBE_BOM_PORT=4111 PROBE_FRA_PORT=4112 PROBE_IAD_PORT=4113 ./start.sh
# =============================================================================
set -euo pipefail

cd "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

COMPOSE_FILES=(-f docker-compose.yml -f docker-compose.app.yml)
APP_SERVICES=(web scheduler probe-bom probe-fra probe-iad)
INFRA_SERVICES=(postgres redis)

: "${WEB_PORT:=3000}"
: "${SCHEDULER_PORT:=4000}"
: "${PROBE_BOM_PORT:=4101}"
: "${PROBE_FRA_PORT:=4102}"
: "${PROBE_IAD_PORT:=4103}"
export WEB_PORT SCHEDULER_PORT PROBE_BOM_PORT PROBE_FRA_PORT PROBE_IAD_PORT

# Not exported on purpose: compose reads APP_URL for the web build arg too, and
# exporting a derived value here would invalidate the cached `next build` layer
# every time someone picked a different port.
APP_URL="${APP_URL:-http://localhost:${WEB_PORT}}"
WEB_READY_TIMEOUT=180

# --- output ------------------------------------------------------------------
if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; CYAN=$'\033[36m'; RESET=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; CYAN=""; RESET=""
fi

step() { printf '%s==>%s %s%s%s\n' "$CYAN" "$RESET" "$BOLD" "$1" "$RESET"; }
info() { printf '    %s\n' "$1"; }
warn() { printf '%s !!%s %s\n' "$YELLOW" "$RESET" "$1"; }
ok()   { printf '%s  ✓%s %s\n' "$GREEN" "$RESET" "$1"; }
die()  { printf '%s  ✗%s %s\n' "$RED" "$RESET" "$1" >&2; exit 1; }

compose() { docker compose "${COMPOSE_FILES[@]}" "$@"; }

# --- preflight ---------------------------------------------------------------
preflight() {
  command -v docker >/dev/null 2>&1 || die "docker is not installed — https://docs.docker.com/get-docker/"
  docker compose version >/dev/null 2>&1 || die "'docker compose' (v2) is unavailable. Update Docker Desktop or install the compose plugin."
  docker info >/dev/null 2>&1 || die "the Docker daemon is not running — start Docker Desktop and try again."
  check_ports
}

# Ports already published by our own containers are fine — those are the ones we
# are about to replace. Anything else listening is a foreign process (typically a
# host `pnpm dev` session) and would fail the bind halfway through startup, after
# the migration has already run.
ports_owned_by_this_stack() {
  local ids
  ids="$(compose ps -aq 2>/dev/null)" || return 0
  [ -n "$ids" ] || return 0
  # shellcheck disable=SC2086
  docker inspect --format \
    '{{range $p, $conf := .NetworkSettings.Ports}}{{range $conf}}{{.HostPort}} {{end}}{{end}}' \
    $ids 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+$' || true
}

port_is_free() {
  ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

check_ports() {
  local owned conflicts=() entry port label holder
  owned="$(ports_owned_by_this_stack)"

  for entry in "web:$WEB_PORT" "scheduler:$SCHEDULER_PORT" \
               "probe-bom:$PROBE_BOM_PORT" "probe-fra:$PROBE_FRA_PORT" \
               "probe-iad:$PROBE_IAD_PORT"; do
    label="${entry%%:*}"
    port="${entry##*:}"
    port_is_free "$port" && continue
    grep -qx "$port" <<<"$owned" && continue

    holder="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -Fc 2>/dev/null | sed -n 's/^c//p' | head -1)"
    conflicts+=("$port ($label)${holder:+ — held by $holder}")
  done

  [ ${#conflicts[@]} -eq 0 ] && return 0

  warn "these host ports are already in use:"
  for entry in "${conflicts[@]}"; do info "$entry"; done
  printf '\n'
  info "Stop whatever owns them (a local 'pnpm dev' is the usual culprit), or"
  info "pick different host ports:"
  info ""
  info "  WEB_PORT=3010 SCHEDULER_PORT=4010 \\"
  info "  PROBE_BOM_PORT=4111 PROBE_FRA_PORT=4112 PROBE_IAD_PORT=4113 \\"
  info "  ./start.sh"
  printf '\n'
  die "refusing to start with conflicting ports"
}

# --- environment -------------------------------------------------------------
# .env is the single source of configuration for both the host dev workflow and
# these containers. Compose reads it for interpolation; DATABASE_URL/REDIS_URL
# are overridden per-container in docker-compose.app.yml because the values in
# .env point at localhost, which is correct on the host and wrong in a network
# namespace that has its own loopback.
ensure_env() {
  if [ -f .env ]; then
    ok ".env present"
  else
    [ -f .env.example ] || die ".env.example is missing; cannot generate .env"
    step "Creating .env with freshly generated secrets"
    cp .env.example .env

    local enc auth
    enc="$(openssl rand -hex 32)"
    auth="$(openssl rand -base64 32 | tr -d '=+/' | cut -c1-43)"
    # BSD sed (macOS) and GNU sed disagree about -i, so write through a temp file.
    awk -v enc="$enc" -v auth="$auth" '
      /^ENCRYPTION_KEY=/     { print "ENCRYPTION_KEY=\"" enc "\"";      next }
      /^BETTER_AUTH_SECRET=/ { print "BETTER_AUTH_SECRET=\"" auth "\""; next }
      { print }
    ' .env > .env.tmp && mv .env.tmp .env
    ok "generated ENCRYPTION_KEY and BETTER_AUTH_SECRET"
  fi

  # Read it back the way the services will see it, and fail early rather than
  # letting six containers crash-loop on a Zod error.
  local key
  key="$(sed -n 's/^ENCRYPTION_KEY=["'"'"']\{0,1\}\([^"'"'"']*\).*/\1/p' .env | head -1)"
  [ ${#key} -eq 64 ] || die "ENCRYPTION_KEY in .env must be exactly 64 hex characters (got ${#key}). Generate one with: openssl rand -hex 32"

  if [ "$key" = "0000000000000000000000000000000000000000000000000000000000000000" ]; then
    warn "ENCRYPTION_KEY is still the all-zero example value — fine for a demo, never for real data."
  fi
}

# --- build -------------------------------------------------------------------
build_images() {
  step "Building images (first run pulls Node and installs the workspace; expect a few minutes)"
  compose build "$@"
  ok "images built"
}

# --- infrastructure ----------------------------------------------------------
start_infra() {
  step "Starting Postgres and Redis"
  compose up -d --wait "${INFRA_SERVICES[@]}"
  ok "postgres and redis are healthy"
}

# --- migrations --------------------------------------------------------------
# Run as its own container rather than a compose dependency so the exit code is
# observable: `docker wait` blocks until it stops and prints its status.
run_migrations() {
  step "Applying database migrations"
  compose rm -fs migrate >/dev/null 2>&1 || true
  compose up -d --no-deps migrate >/dev/null

  local code
  code="$(docker wait sentinel-migrate)"
  if [ "$code" != "0" ]; then
    compose logs --no-log-prefix migrate || true
    die "migrations failed (exit $code)"
  fi
  compose logs --no-log-prefix migrate | sed 's/^/    /'
  ok "schema is up to date"
}

# --- seed --------------------------------------------------------------------
database_is_empty() {
  local count
  count="$(compose exec -T postgres psql -U sentinel -d sentinel -tAc \
    'SELECT count(*) FROM organizations' 2>/dev/null | tr -d '[:space:]')" || return 0
  [ -z "$count" ] || [ "$count" = "0" ]
}

run_seed() {
  step "Seeding demo data (20 monitors, 90 days of history, 9 incidents)"
  compose rm -fs seed >/dev/null 2>&1 || true
  compose --profile seed up -d --no-deps seed >/dev/null

  local code
  code="$(docker wait sentinel-seed)"
  if [ "$code" != "0" ]; then
    compose logs --no-log-prefix seed || true
    die "seed failed (exit $code)"
  fi
  ok "demo organisation ready"
}

# --- application -------------------------------------------------------------
start_app() {
  step "Starting web, scheduler and probes (bom, fra, iad)"
  compose up -d --wait "${APP_SERVICES[@]}"
  ok "application containers are healthy"
}

wait_for_web() {
  step "Waiting for $APP_URL"
  local deadline=$((SECONDS + WEB_READY_TIMEOUT))
  while [ $SECONDS -lt $deadline ]; do
    if curl -fsS -o /dev/null -w '' --max-time 5 "$APP_URL" 2>/dev/null; then
      ok "web is serving"
      return 0
    fi
    sleep 2
  done
  compose logs --tail 40 web || true
  die "web did not respond within ${WEB_READY_TIMEOUT}s"
}

summary() {
  cat <<EOF

${GREEN}${BOLD}Sentinel is running.${RESET}

  ${BOLD}Dashboard${RESET}      ${APP_URL}
  ${BOLD}Status page${RESET}    ${APP_URL}/status/acme
  ${BOLD}Sign in${RESET}        demo@sentinel.dev / sentinel123

  ${DIM}scheduler health   http://localhost:${SCHEDULER_PORT}
  probe health       http://localhost:${PROBE_BOM_PORT} (bom) · ${PROBE_FRA_PORT} (fra) · ${PROBE_IAD_PORT} (iad)
  postgres           localhost:5432  (sentinel / sentinel)
  redis              localhost:6379${RESET}

  ${DIM}Give the probes about a minute: live check rows replace the seeded
  present, "API — checkout" goes DOWN and "API — search" goes DEGRADED once
  the consensus engine has enough regional verdicts to rule.${RESET}

  ${BOLD}Logs${RESET}   ./start.sh logs           ${DIM}(or: ./start.sh logs scheduler)${RESET}
  ${BOLD}Stop${RESET}   ./start.sh down
  ${BOLD}Wipe${RESET}   ./start.sh reset          ${DIM}(destroys the volumes)${RESET}

EOF
}

# --- commands ----------------------------------------------------------------
cmd_up() {
  local do_seed="auto" rebuild=0
  for arg in "$@"; do
    case "$arg" in
      --seed)      do_seed="always" ;;
      --no-seed)   do_seed="never" ;;
      --rebuild)   rebuild=1 ;;
      *) die "unknown option: $arg" ;;
    esac
  done

  preflight
  ensure_env
  if [ "$rebuild" -eq 1 ]; then build_images --no-cache; else build_images; fi
  start_infra
  run_migrations

  case "$do_seed" in
    always) run_seed ;;
    never)  info "skipping seed (--no-seed)" ;;
    auto)
      if database_is_empty; then
        run_seed
      else
        ok "database already has data — skipping seed (force it with ./start.sh seed)"
      fi
      ;;
  esac

  start_app
  wait_for_web
  summary
}

cmd_down() {
  preflight
  step "Stopping all containers (data volumes are kept)"
  compose --profile seed down --remove-orphans
  ok "stopped"
}

cmd_reset() {
  preflight
  warn "This destroys the Postgres and Redis volumes. All monitors, checks and incidents are lost."
  read -r -p "    Type 'reset' to confirm: " reply
  [ "$reply" = "reset" ] || die "aborted"
  compose --profile seed down -v --remove-orphans
  ok "volumes destroyed — run ./start.sh to rebuild from scratch"
}

cmd_restart() {
  preflight
  step "Recreating application containers"
  compose up -d --force-recreate --wait "${APP_SERVICES[@]}"
  wait_for_web
  ok "restarted"
}

cmd_seed() {
  preflight
  ensure_env
  start_infra
  run_migrations
  run_seed
}

cmd_logs() {
  preflight
  if [ $# -gt 0 ]; then compose logs -f --tail 100 "$@"; else compose logs -f --tail 50; fi
}

cmd_ps() {
  preflight
  compose ps
}

usage() {
  sed -n '2,/^# =\{10,\}$/p' "$0" | sed 's/^# \{0,1\}//'
}

main() {
  local cmd="${1:-up}"
  [ $# -gt 0 ] && shift || true
  case "$cmd" in
    up|start|"")   cmd_up "$@" ;;
    down|stop)     cmd_down ;;
    reset)         cmd_reset ;;
    restart)       cmd_restart ;;
    build)         preflight; ensure_env; build_images "$@" ;;
    seed)          cmd_seed ;;
    logs)          cmd_logs "$@" ;;
    ps|status)     cmd_ps ;;
    -h|--help|help) usage ;;
    --*)           cmd_up "$cmd" "$@" ;;
    *)             die "unknown command: $cmd (try ./start.sh --help)" ;;
  esac
}

main "$@"
```
