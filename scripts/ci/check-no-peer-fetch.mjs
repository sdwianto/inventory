#!/usr/bin/env node
/**
 * W1-7: fail if lib/api uses fetch() outside allowlist.
 * Peer Category A/B HTTP belongs in IntegrationClient → Transport.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(scriptDir, '../..');
const ALLOWLIST_PATH = join(ROOT, 'scripts/ci/no-peer-fetch-allowlist.txt');
const SCAN_ROOT = join(ROOT, 'lib/api');
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const FETCH_RE = /\bfetch\s*\(/;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage']);

function readAllowlist() {
  try {
    return new Set(
      readFileSync(ALLOWLIST_PATH, 'utf8')
        .split('\n')
        .map((line) => line.replace(/#.*$/, '').trim())
        .filter(Boolean)
        .map((p) => p.replace(/\\/g, '/')),
    );
  } catch {
    return new Set();
  }
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const abs = join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      walk(abs, files);
      continue;
    }
    if (CODE_EXT.test(entry)) files.push(abs);
  }
  return files;
}

const allow = readAllowlist();
const hits = [];

for (const abs of walk(SCAN_ROOT)) {
  const rel = relative(ROOT, abs).replace(/\\/g, '/');
  if (allow.has(rel)) continue;
  const lines = readFileSync(abs, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!FETCH_RE.test(line)) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('hint:')) continue;
    if (/['"`].*fetch\s*\(/.test(line) && !/\bawait\s+fetch\s*\(|=\s*fetch\s*\(/.test(line)) continue;
    hits.push(`${rel}:${i + 1}:${trimmed}`);
  }
}

console.log('== W1-7 no-peer-fetch check (lib/api) ==');
if (hits.length) {
  console.log(`FAIL: ${hits.length} fetch() outside allowlist:`);
  for (const h of hits) console.log(h);
  console.log('\nUse IntegrationClient → Transport, or add a documented allowlist entry.');
  process.exit(1);
}
console.log('OK: no disallowed fetch() in lib/api');
process.exit(0);
