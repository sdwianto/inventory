#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

const TARGETS = ['app', 'components', 'lib', 'hooks'];
const SKIP = new Set(['node_modules', '.next', '.git']);
const IMPORT_LINE = "import type { JsonObject } from '@/types/json';\n";

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
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
for (const file of walk(path.join(process.cwd(), ...TARGETS[0] ? [] : []))) {}
// fix walk call
const files = [];
for (const t of TARGETS) {
  files.push(...walk(path.join(process.cwd(), t)));
}

for (const file of files) {
  let src = fs.readFileSync(file, 'utf8');
  const orig = src;

  src = src.replace(/useState<unknown\[\]>\(\[\]\)/g, 'useState<JsonObject[]>([])');
  src = src.replace(/useState<unknown \| null>\(null\)/g, 'useState<JsonObject | null>(null)');
  src = src.replace(/useState<Record<string, unknown>>\(\{\}\)/g, 'useState<JsonObject>({})');

  if (src !== orig && src.includes('JsonObject') && !src.includes("from '@/types/json'")) {
    const useClient = src.startsWith("'use client'") || src.startsWith('"use client"');
    if (useClient) {
      src = src.replace(/^(['"])use client\1;\s*\n/, (m) => `${m}${IMPORT_LINE}`);
    } else {
      src = `${IMPORT_LINE}${src}`;
    }
  }

  if (src !== orig) {
    fs.writeFileSync(file, src);
    changed += 1;
  }
}
console.log(`JsonObject useState patch: ${changed} files`);
