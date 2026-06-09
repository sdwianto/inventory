#!/bin/bash
# Terapkan palet BGN — ganti orange → brand colors
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

find app components -type f \( -name '*.js' -o -name '*.jsx' \) | while read -r f; do
  sed -i \
    -e 's/bg-orange-500 hover:bg-orange-600/btn-bgn/g' \
    -e 's/bg-orange-500\/90 text-white font-medium/nav-active-bgn/g' \
    -e 's/bg-orange-500 text-white font-medium/nav-active-bgn/g' \
    -e 's/ring-orange-500\/40/ring-bgn-gold\/50/g' \
    -e 's/bg-orange-100 text-orange-700/bg-bgn-sky text-bgn-navy/g' \
    -e 's/bg-orange-50 border border-orange-200/surface-bgn border/g' \
    -e 's/bg-orange-50 border-orange-200/surface-bgn/g' \
    -e 's/bg-orange-50 border-orange-100/bg-bgn-sky-light border-bgn-sky/g' \
    -e 's/group-hover:text-orange-600/group-hover:text-bgn-gold/g' \
    -e 's/hover:border-orange-300/hover:border-bgn-gold/g' \
    -e 's/hover:bg-orange-50/hover:bg-bgn-sky-light/g' \
    -e 's/text-orange-600/text-bgn-gold/g' \
    -e 's/text-orange-400/text-bgn-gold/g' \
    -e 's/text-orange-700/text-bgn-navy/g' \
    -e 's/text-orange-800/text-bgn-navy/g' \
    -e 's/text-orange-900/text-bgn-navy/g' \
    -e 's/border-orange-200/border-bgn-sky/g' \
    -e 's/border-orange-100/border-bgn-sky\/70/g' \
    -e 's/bg-orange-50/bg-bgn-sky-light/g' \
    -e 's/bg-orange-100/bg-bgn-sky\/50/g' \
    -e 's/bg-orange-500/bg-bgn-navy/g' \
    -e 's/text-orange-500/text-bgn-gold/g' \
    -e 's/from-slate-900 via-slate-800 to-orange-900/from-bgn-navy via-bgn-navy-light to-bgn-navy-dark/g' \
    "$f"
done
echo "BGN theme applied"
