#!/usr/bin/env node
/** Tambah @ts-nocheck pada components/*.tsx yang belum (fase 4 — tipe lengkap nanti). */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const componentsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'components');
const MARKER = '// @ts-nocheck\n';

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}

let n = 0;
for (const file of walk(componentsDir)) {
  const content = readFileSync(file, 'utf8');
  if (content.startsWith('// @ts-nocheck')) continue;
  writeFileSync(file, MARKER + content);
  console.log('nocheck:', file.replace(componentsDir + '/', ''));
  n++;
}
console.log(`\nTagged ${n} component files.`);
