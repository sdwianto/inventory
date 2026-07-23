#!/bin/sh
# Entrypoint: pastikan media storage writable (uid nextjs), lalu jalankan CMD sebagai nextjs.
set -e

MEDIA_ROOT="${MEDIA_STORAGE_PATH:-/app/storage/media}"
mkdir -p "$MEDIA_ROOT"

if [ "$(id -u)" = "0" ]; then
  if ! chown -R nextjs:nodejs /app/storage 2>/dev/null; then
    if ! chown -R nextjs:nodejs "$MEDIA_ROOT"; then
      echo "ERROR: gagal chown media storage ($MEDIA_ROOT) — upload foto akan EACCES" >&2
      exit 1
    fi
  fi
  # Probe tulis sebagai nextjs sebelum start app
  if ! su-exec nextjs sh -c "touch \"$MEDIA_ROOT/.write-ok\" && rm -f \"$MEDIA_ROOT/.write-ok\""; then
    echo "ERROR: media storage tidak writable oleh nextjs: $MEDIA_ROOT" >&2
    exit 1
  fi
fi

start_bg_poller() {
  if [ "$(id -u)" = "0" ]; then
    su-exec nextjs node scripts/run-bg-worker.mjs &
  else
    node scripts/run-bg-worker.mjs &
  fi
}

# Legacy serverless: poll in-app saat EXECUTION_LEGACY_BG=1 dan bukan VPS.
if [ -n "$WORKER_SECRET" ] && [ "${DEPLOYMENT_MODE:-}" != "vps" ] && [ "${EXECUTION_LEGACY_BG:-0}" = "1" ]; then
  start_bg_poller
fi

# VPS safety-net: HTTP poll /api/bg-jobs/process (execution drain + recovery).
# Melengkapi inventory-worker — interval default 120s (lihat BG_WORKER_INTERVAL_MS).
if [ -n "$WORKER_SECRET" ] && [ "${DEPLOYMENT_MODE:-}" = "vps" ] && [ "${BG_JOBS_SAFETY_POLL:-1}" = "1" ]; then
  export WORKER_INTERNAL_URL="${WORKER_INTERNAL_URL:-http://127.0.0.1:3001}"
  export BG_WORKER_INTERVAL_MS="${BG_WORKER_INTERVAL_MS:-120000}"
  start_bg_poller
fi

if [ "$(id -u)" = "0" ]; then
  exec su-exec nextjs "$@"
fi
exec "$@"
