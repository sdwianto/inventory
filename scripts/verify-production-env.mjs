#!/usr/bin/env node
/**
 * Wrapper — delegasi ke sales/scripts/verify-production-env.mjs
 * Usage: npm run verify:production
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const salesScript = resolve(here, '../../../sales/sales/scripts/verify-production-env.mjs');

if (!existsSync(salesScript)) {
  console.error('Tidak menemukan:', salesScript);
  console.error('Pastikan repo sales ada di ../sales/sales relatif ke inventory-app');
  process.exit(1);
}

const r = spawnSync(process.execPath, [salesScript, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
  cwd: resolve(here, '..'),
});
process.exit(r.status ?? 1);
