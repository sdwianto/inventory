#!/usr/bin/env node
/**
 * Fase 3: rename lib/* (excl api) + hooks/* dari .js/.jsx ke .ts/.tsx
 */
import { renameSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const renames = [
  ['lib/utils.js', 'lib/utils.ts'],
  ['lib/debounce.js', 'lib/debounce.ts'],
  ['lib/format.js', 'lib/format.ts'],
  ['lib/fetch-json.js', 'lib/fetch-json.ts'],
  ['lib/api-client.js', 'lib/api-client.ts'],
  ['lib/auth-client.js', 'lib/auth-client.ts'],
  ['lib/tenant-api.js', 'lib/tenant-api.ts'],
  ['lib/tenant-client.js', 'lib/tenant-client.ts'],
  ['lib/tenant-query.js', 'lib/tenant-query.ts'],
  ['lib/acting-tenant-client.js', 'lib/acting-tenant-client.ts'],
  ['lib/lokasi-client.js', 'lib/lokasi-client.ts'],
  ['lib/warehouses-client.js', 'lib/warehouses-client.ts'],
  ['lib/export-csv.js', 'lib/export-csv.ts'],
  ['lib/export-table.js', 'lib/export-table.ts'],
  ['lib/doc-print.js', 'lib/doc-print.ts'],
  ['lib/bulk-delete-client.js', 'lib/bulk-delete-client.ts'],
  ['lib/run-list-export.js', 'lib/run-list-export.ts'],
  ['lib/list-scope-columns.js', 'lib/list-scope-columns.ts'],
  ['lib/integration-auto-sync.js', 'lib/integration-auto-sync.ts'],
  ['lib/vendor-display.js', 'lib/vendor-display.ts'],
  ['lib/vendor-price.js', 'lib/vendor-price.ts'],
  ['lib/po-calendar.js', 'lib/po-calendar.ts'],
  ['lib/po-estimasi-harga.js', 'lib/po-estimasi-harga.ts'],
  ['lib/printer-settings.js', 'lib/printer-settings.ts'],
  ['lib/receipt-doc.js', 'lib/receipt-doc.ts'],
  ['lib/stock-trend-chart.js', 'lib/stock-trend-chart.ts'],
  ['lib/b2b-doc-export.js', 'lib/b2b-doc-export.ts'],
  ['lib/hooks/useDebouncedCallback.js', 'lib/hooks/useDebouncedCallback.ts'],
  ['lib/hooks/use-goods-receipts.js', 'lib/hooks/use-goods-receipts.ts'],
  ['lib/hooks/use-vendor-hutang.js', 'lib/hooks/use-vendor-hutang.ts'],
  ['lib/constants/testIds/auth.js', 'lib/constants/testIds/auth.ts'],
  ['lib/constants/testIds/home.js', 'lib/constants/testIds/home.ts'],
  ['lib/constants/testIds/index.js', 'lib/constants/testIds/index.ts'],
  ['hooks/use-toast.js', 'hooks/use-toast.ts'],
  ['hooks/useListSelection.js', 'hooks/useListSelection.ts'],
  ['hooks/use-mobile.jsx', 'hooks/use-mobile.tsx'],
];

let ok = 0;
let skip = 0;
for (const [from, to] of renames) {
  const src = join(root, from);
  const dst = join(root, to);
  if (!existsSync(src)) {
    if (existsSync(dst)) {
      skip++;
      continue;
    }
    console.error(`MISSING: ${from}`);
    process.exit(1);
  }
  if (existsSync(dst)) {
    console.error(`TARGET EXISTS: ${to}`);
    process.exit(1);
  }
  renameSync(src, dst);
  console.log(`${from} → ${to}`);
  ok++;
}

console.log(`\nRenamed ${ok} files (${skip} already migrated).`);
