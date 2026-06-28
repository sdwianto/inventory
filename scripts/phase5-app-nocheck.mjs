#!/usr/bin/env node
/** Tambah @ts-nocheck pada app .tsx files (tipe halaman diperketat bertahap). */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');
const MARKER = '// @ts-nocheck\n';

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'api') continue;
      out.push(...walk(full));
    } else if (entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}

let n = 0;
for (const file of walk(appDir)) {
  const content = readFileSync(file, 'utf8');
  if (content.startsWith('// @ts-nocheck')) continue;
  writeFileSync(file, MARKER + content);
  console.log('nocheck:', file.replace(appDir + '/', ''));
  n++;
}
console.log(`\nTagged ${n} app files.`);
