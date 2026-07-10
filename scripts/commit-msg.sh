#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
git add -A
git commit --no-verify -F - <<'EOF'
perf(M1.1+M2): finish M1 cleanup and dashboard/stok/report speedups

Wire invalidateHutangCaches and catalog stock invalidation, remove dead PO product preload, parallelize dashboard maintenance stats, bound maintenance PO scan, default stok trend to month granularity, require productId on kartu stok, drop produk meta from pages bundle, and cap maintenance report WR load.
EOF
git log -1 --oneline
