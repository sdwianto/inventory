#!/usr/bin/env node
/** Execution platform worker shim — inventory-app (EE-9C). */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const runner = resolve(__dirname, 'run-execution-worker-run.ts');
const result = spawnSync(
  'npx',
  ['tsx', runner, ...process.argv.slice(2)],
  { stdio: 'inherit', shell: true, cwd: resolve(__dirname, '..') },
);
process.exit(result.status ?? 1);
