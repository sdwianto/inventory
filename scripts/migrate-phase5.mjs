#!/usr/bin/env node
/**
 * Fase 5: rename app .js (recursive) ke .tsx (layout, providers, pages)
 */
import { renameSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const appDir = join(root, 'app');

function walkAppJs(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'api') continue;
      results.push(...walkAppJs(full));
    } else if (entry.endsWith('.js') && !entry.endsWith('.config.js')) {
      results.push(full);
    }
  }
  return results;
}

const files = walkAppJs(appDir).sort();
let ok = 0;
let skip = 0;

for (const src of files) {
  const dst = src.replace(/\.js$/, '.tsx');
  if (!existsSync(src)) {
    if (existsSync(dst)) { skip++; continue; }
    console.error(`MISSING: ${src}`);
    process.exit(1);
  }
  if (existsSync(dst)) {
    console.error(`TARGET EXISTS: ${dst}`);
    process.exit(1);
  }
  renameSync(src, dst);
  console.log(`${src.slice(root.length + 1)} → ${dst.slice(root.length + 1)}`);
  ok++;
}

console.log(`\nRenamed ${ok} app files (${skip} already migrated).`);
