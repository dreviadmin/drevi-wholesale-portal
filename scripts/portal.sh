#!/usr/bin/env bash
# Drevi Wholesale Portal — local process manager.
#
#   ./scripts/portal.sh start     start Next dev + Supabase keep-warm loop
#   ./scripts/portal.sh stop      stop both
#   ./scripts/portal.sh status    show what's running + Supabase status + port 3000
#   ./scripts/portal.sh logs      tail dev + keepalive logs
#   ./scripts/portal.sh restore   force-restore Supabase if paused
#
# start runs both processes detached (nohup + &), so you can close the
# Terminal window and the portal keeps serving. Use stop when done.
set -euo pipefail

PORTAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$PORTAL_DIR/.local"
DEV_LOG="$LOG_DIR/dev.log"
KEEP_LOG="$LOG_DIR/keepalive.log"
DEV_PID="$LOG_DIR/dev.pid"
KEEP_PID="$LOG_DIR/keepalive.pid"
KEEP_INTERVAL=300  # seconds between warm pings

mkdir -p "$LOG_DIR"

# Load Supabase config from .env.local (never checked in).
SUPABASE_URL=$(grep -E '^NEXT_PUBLIC_SUPABASE_URL=' "$PORTAL_DIR/.env.local" | cut -d= -f2-)
SUPABASE_TOKEN=$(grep -E '^SUPABASE_ACCESS_TOKEN=' "$PORTAL_DIR/.env.local" | cut -d= -f2- || echo "")
SUPABASE_ANON=$(grep -E '^NEXT_PUBLIC_SUPABASE_ANON_KEY=' "$PORTAL_DIR/.env.local" | cut -d= -f2-)
PROJECT_REF=$(echo "$SUPABASE_URL" | sed -n 's|https://\([a-z0-9]*\)\.supabase\.co.*|\1|p')

supabase_status() {
  curl -s --max-time 10 -H "Authorization: Bearer $SUPABASE_TOKEN" \
    "https://api.supabase.com/v1/projects/$PROJECT_REF" \
    | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4
}

restore_if_paused() {
  [ -z "$SUPABASE_TOKEN" ] && return 0
  local st; st=$(supabase_status)
  [ -z "$st" ] && return 0
  if [ "$st" = "INACTIVE" ]; then
    echo "$(date +%H:%M:%S) Supabase INACTIVE — restoring…"
    curl -s -X POST -H "Authorization: Bearer $SUPABASE_TOKEN" \
      "https://api.supabase.com/v1/projects/$PROJECT_REF/restore" >/dev/null
    for _ in $(seq 1 30); do
      st=$(supabase_status)
      if [ "$st" = "ACTIVE_HEALTHY" ]; then
        echo "$(date +%H:%M:%S) Supabase healthy"
        return 0
      fi
      sleep 10
    done
    echo "$(date +%H:%M:%S) restore didn't complete within 5 min"
  fi
}

warm_ping() {
  curl -s -o /dev/null --max-time 10 -H "apikey: $SUPABASE_ANON" \
    "$SUPABASE_URL/rest/v1/" || true
}

_keepalive_loop() {
  # Runs forever, restoring on pause + a warm ping on interval.
  while true; do
    restore_if_paused
    warm_ping
    sleep "$KEEP_INTERVAL"
  done
}

is_running() {
  local pidfile="$1"
  [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null
}

start_dev() {
  if is_running "$DEV_PID"; then
    echo "dev already running (pid $(cat "$DEV_PID"))"
    return
  fi
  cd "$PORTAL_DIR"
  # Wait until port 3000 is actually free (in case another dev instance is dying).
  for _ in $(seq 1 5); do lsof -ti :3000 >/dev/null 2>&1 || break; sleep 1; done
  nohup env NEXT_TELEMETRY_DISABLED=1 npm run dev > "$DEV_LOG" 2>&1 &
  echo $! > "$DEV_PID"
  echo "dev started (pid $!) → http://localhost:3000/login    log: $DEV_LOG"
}

start_keepalive() {
  if is_running "$KEEP_PID"; then
    echo "keepalive already running (pid $(cat "$KEEP_PID"))"
    return
  fi
  # Re-invoke this script in a background loop.
  nohup bash "$0" _keepalive > "$KEEP_LOG" 2>&1 &
  echo $! > "$KEEP_PID"
  echo "keepalive started (pid $!) — pinging every ${KEEP_INTERVAL}s    log: $KEEP_LOG"
}

stop_all() {
  if is_running "$KEEP_PID"; then
    kill "$(cat "$KEEP_PID")" 2>/dev/null || true
    rm -f "$KEEP_PID"
    echo "keepalive stopped"
  fi
  if is_running "$DEV_PID"; then
    kill "$(cat "$DEV_PID")" 2>/dev/null || true
    rm -f "$DEV_PID"
    echo "dev stopped"
  fi
  # Just in case a stray next-server survived
  pkill -f "next dev" 2>/dev/null || true
  pkill -f "next-server" 2>/dev/null || true
}

case "${1:-help}" in
  start)
    restore_if_paused
    start_dev
    start_keepalive
    ;;
  stop)
    stop_all
    ;;
  status)
    echo -n "dev:        "; is_running "$DEV_PID" && echo "running (pid $(cat "$DEV_PID"))" || echo "stopped"
    echo -n "keepalive:  "; is_running "$KEEP_PID" && echo "running (pid $(cat "$KEEP_PID"))" || echo "stopped"
    echo -n "supabase:   "; supabase_status
    echo -n "port 3000:  "; curl -s -o /dev/null -w "%{http_code}\n" --max-time 5 http://localhost:3000/login
    ;;
  logs)
    tail -f "$DEV_LOG" "$KEEP_LOG"
    ;;
  restore)
    restore_if_paused
    echo "status: $(supabase_status)"
    ;;
  _keepalive)
    _keepalive_loop
    ;;
  *)
    cat <<EOF
Usage: $0 {start|stop|status|logs|restore}

  start   Start the Next dev server + Supabase keep-warm loop (detached).
  stop    Stop both.
  status  Show what's running and the Supabase project status.
  logs    Tail both log files.
  restore Force a Supabase restore if it's paused.

Detached processes survive closing this Terminal window. Portal serves at
http://localhost:3000/login once dev is up. Logs and PIDs live in .local/.
EOF
    ;;
esac
