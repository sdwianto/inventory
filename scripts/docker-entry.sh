#!/bin/sh
set -e
if [ -n "$WORKER_SECRET" ] && [ "${DEPLOYMENT_MODE:-}" != "vps" ] && [ "${EXECUTION_LEGACY_BG:-0}" = "1" ]; then
  node scripts/run-bg-worker.mjs &
fi
exec node server.js
