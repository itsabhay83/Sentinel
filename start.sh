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
  count="$(compose exec -T postgres psql -U "${POSTGRES_USER:-sentinel}" -d "${POSTGRES_DB:-sentinel}" -tAc \
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
