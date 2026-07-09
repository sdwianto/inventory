#!/usr/bin/env node
/** Delegasi ke sales/scripts/verify-api-key-match.mjs */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const salesScript = resolve(here, '../../../sales/sales/scripts/verify-api-key-match.mjs');

if (!existsSync(salesScript)) {
  console.error('Tidak menemukan:', salesScript);
  process.exit(1);
}

const r = spawnSync(process.execPath, [salesScript, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
  cwd: resolve(here, '..'),
});
process.exit(r.status ?? 1);
