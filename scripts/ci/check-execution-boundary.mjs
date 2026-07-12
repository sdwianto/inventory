#!/usr/bin/env node
/**
 * Execution Platform boundary checks — I12 (CI-1..CI-8)
 * EE-0 scaffold: legacy allowlist in execution-boundary-allowlist.txt
 * EE-3 enforce:  EXECUTION_BOUNDARY_STRICT=1 npm run check:execution-boundary
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(scriptDir, '../..');
const ALLOWLIST_PATH = join(ROOT, 'scripts/ci/execution-boundary-allowlist.txt');
const STRICT = process.env.EXECUTION_BOUNDARY_STRICT === '1';

const SKIP_DIRS = new Set([
  '.git',
  '.next',
  'node_modules',
  'coverage',
  'dist',
  'build',
  '.turbo',
  'vendor',
]);

const COMMON_SKIP_PREFIXES = [
  'lib/execution/',
  'tests/',
  'docs/',
  'scripts/ci/',
];

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

function readAllowlist() {
  if (STRICT) return [];
  try {
    return readFileSync(ALLOWLIST_PATH, 'utf8')
      .split('\n')
      .map((line) => line.replace(/#.*$/, '').trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

const ALLOWLIST = readAllowlist();

function isAllowlisted(relPath) {
  const normalized = relPath.replace(/\\/g, '/');
  return ALLOWLIST.some((entry) => normalized === entry || normalized.startsWith(`${entry}/`));
}

function shouldScanFile(relPath) {
  const normalized = relPath.replace(/\\/g, '/');
  if (isAllowlisted(normalized)) return false;
  if (COMMON_SKIP_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return false;
  if (normalized.startsWith('scripts/migrate-')) return false;
  if (normalized.startsWith('scripts/execution-doctor')) return false;
  if (!CODE_EXT.test(normalized)) return false;
  return true;
}

function walkFiles(dir, files = [], options = {}) {
  const { filter = true } = options;
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const abs = join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      walkFiles(abs, files, options);
      continue;
    }
    const rel = relative(ROOT, abs).replace(/\\/g, '/');
    if (!CODE_EXT.test(rel)) continue;
    if (filter && !shouldScanFile(rel)) continue;
    files.push(abs);
  }
  return files;
}

function scanLines(files, pattern) {
  const hits = [];
  const seen = new Set();
  for (const file of files) {
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!pattern.test(lines[i])) continue;
      const key = `${rel}:${i + 1}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push(`${rel}:${i + 1}:${lines[i].trim()}`);
    }
  }
  return hits;
}

function scanFiles(pattern) {
  return scanLines(walkFiles(ROOT), pattern);
}

function scanExecutionDir(pattern) {
  const dir = join(ROOT, 'lib/execution');
  try {
    return scanLines(walkFiles(dir, [], { filter: false }), pattern);
  } catch {
    return [];
  }
}

function scanHandlers(pattern) {
  const dir = join(ROOT, 'lib/api/handlers');
  try {
    return scanLines(walkFiles(dir, [], { filter: false }), pattern);
  } catch {
    return [];
  }
}

const failures = [];
const warnings = [];

function reportFail(id, message, matches) {
  if (matches.length === 0) return;
  failures.push({ id, message, matches });
}

function reportWarn(id, message, matches) {
  if (matches.length === 0) return;
  warnings.push({ id, message, matches });
}

console.log(`== Execution boundary check (strict=${STRICT ? '1' : '0'}) ==`);

reportFail(
  'CI-8',
  'bg_jobs collection() access outside lib/execution/',
  scanFiles(/collection\(['"]bg_jobs['"]\)/),
);

reportFail(
  'CI-5',
  'direct bg_jobs write outside lib/execution/',
  scanFiles(/collection\(['"]bg_jobs['"]\)\.(insert|update|findOneAndUpdate|delete|replaceOne|bulkWrite)/),
);

reportFail(
  'CI-2',
  'import from @/lib/api/bg-jobs — use @/lib/execution/api',
  scanFiles(/from ['"]@\/lib\/api\/bg-jobs['"]/),
);

reportFail(
  'CI-7',
  'lib/execution imports lib/api/handlers',
  scanExecutionDir(/from ['"]@\/lib\/api\/handlers/),
);

reportWarn(
  'CI-6',
  'handler imports prom-client/redis directly — use ExecutionContext',
  scanHandlers(/from ['"](prom-client|ioredis|redis|@upstash\/redis)/),
);

reportWarn(
  'CI-1',
  'possible direct job.status assignment — use transitionJob()',
  scanFiles(/\bstatus:\s*['"]?(PENDING|DISPATCHED|RUNNING|RETRYING|WAITING_EXTERNAL|DLQ)['"]?/),
);

reportWarn(
  'CI-4',
  'possible complete/fail bypass — use complete() / fail()',
  scanFiles(/['"]status['"]:\s*['"]?(SUCCEEDED|DLQ)['"]?|status:\s*['"]?(SUCCEEDED|DLQ)['"]?/),
);

reportWarn(
  'CI-3',
  'possible claim() bypass — use lib/execution/queue/claim',
  scanFiles(/findOneAndUpdate\(.{0,200}status:\s*['"]?(PENDING|DISPATCHED)['"]?/),
);

for (const item of failures) {
  console.log(`\nFAIL ${item.id}: ${item.message}`);
  for (const line of item.matches) console.log(line);
}

for (const item of warnings) {
  console.log(`\nWARN ${item.id}: ${item.message}`);
  for (const line of item.matches) console.log(line);
}

console.log('');
if (failures.length > 0) {
  console.log(`Boundary check failed: ${failures.length} error(s), ${warnings.length} warning(s)`);
  process.exit(1);
}

console.log(`Boundary check passed: 0 error(s), ${warnings.length} warning(s)`);
process.exit(0);
