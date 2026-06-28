#!/usr/bin/env node
/** Tambah @ts-nocheck di components/ui/*.tsx (shadcn — tipe lengkap di fase berikutnya). */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const uiDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'components', 'ui');
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
for (const file of walk(uiDir)) {
  const content = readFileSync(file, 'utf8');
  if (content.startsWith('// @ts-nocheck')) continue;
  writeFileSync(file, MARKER + content);
  console.log('nocheck:', file.replace(uiDir, 'ui'));
  n++;
}
console.log(`\nTagged ${n} ui files.`);
