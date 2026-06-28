#!/usr/bin/env node
/**
 * Remove // @ts-nocheck from all .ts/.tsx source files (not node_modules/.next).
 */
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const SKIP = new Set(['node_modules', '.next', '.git']);

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

let changed = 0;
for (const file of walk(ROOT)) {
  const rel = path.relative(ROOT, file);
  if (rel.startsWith('scripts/strip-ts-nocheck')) continue;
  let src = fs.readFileSync(file, 'utf8');
  if (!src.includes('@ts-nocheck')) continue;
  const next = src
    .replace(/^\s*\/\/\s*@ts-nocheck\s*\r?\n/gm, '')
    .replace(/^\s*\/\*\s*@ts-nocheck\s*\*\/\s*\r?\n/gm, '');
  if (next !== src) {
    fs.writeFileSync(file, next);
    changed += 1;
  }
}
console.log(`Removed @ts-nocheck from ${changed} files`);
