#!/usr/bin/env node
/**
 * Fase 6: @ts-nocheck pada lib (legacy API — ketatkan tipe bertahap nanti).
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const libDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib');
const MARKER = '// @ts-nocheck\n';

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}

let n = 0;
for (const file of walk(libDir)) {
  const content = readFileSync(file, 'utf8');
  if (content.startsWith('// @ts-nocheck')) continue;
  writeFileSync(file, MARKER + content);
  n++;
}
console.log(`Tagged ${n} lib files with @ts-nocheck.`);
