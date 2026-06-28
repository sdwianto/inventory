#!/usr/bin/env node
/**
 * Fase 4: rename semua components .jsx ke .tsx
 */
import { renameSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const componentsDir = join(root, 'components');

function walkJsx(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...walkJsx(full));
    } else if (entry.endsWith('.jsx')) {
      results.push(full);
    }
  }
  return results;
}

const files = walkJsx(componentsDir).sort();
let ok = 0;
let skip = 0;

for (const src of files) {
  const dst = src.replace(/\.jsx$/, '.tsx');
  if (!existsSync(src)) {
    if (existsSync(dst)) {
      skip++;
      continue;
    }
    console.error(`MISSING: ${src}`);
    process.exit(1);
  }
  if (existsSync(dst)) {
    console.error(`TARGET EXISTS: ${dst}`);
    process.exit(1);
  }
  renameSync(src, dst);
  const rel = src.slice(root.length + 1);
  console.log(`${rel} → ${rel.replace(/\.jsx$/, '.tsx')}`);
  ok++;
}

console.log(`\nRenamed ${ok} files (${skip} already migrated).`);
