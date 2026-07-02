#!/bin/sh
set -e
if [ -n "$WORKER_SECRET" ]; then
  node scripts/run-bg-worker.mjs &
fi
exec node server.js
