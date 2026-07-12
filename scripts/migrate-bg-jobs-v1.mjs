#!/usr/bin/env node
/** Shim — runs TS migration runner (spec path: migrate-bg-jobs-v1.mjs). */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const runner = resolve(__dirname, 'migrate-bg-jobs-v1-run.ts');
const result = spawnSync(
  'npx',
  ['tsx', runner, ...process.argv.slice(2)],
  { stdio: 'inherit', shell: true, cwd: resolve(__dirname, '..') },
);
process.exit(result.status ?? 1);
