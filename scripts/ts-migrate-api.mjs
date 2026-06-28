#!/usr/bin/env node
/**
 * Add minimal Db typing to lib/api/*.ts function signatures.
 */
import fs from 'fs';
import path from 'path';

const API_DIR = path.join(process.cwd(), 'lib/api');

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

let changed = 0;
for (const file of walk(API_DIR)) {
  let src = fs.readFileSync(file, 'utf8');
  const orig = src;

  if (!src.includes("from 'mongodb'") && !src.includes('from "mongodb"')) {
    if (/\bfunction\s+\w+\(\s*db\b|\(\s*db\s*,/.test(src)) {
      src = `import type { Db } from 'mongodb';\n${src}`;
    }
  }

  src = src.replace(/\bexport async function (\w+)\(\s*db\s*,/g, 'export async function $1(db: Db,');
  src = src.replace(/\bexport function (\w+)\(\s*db\s*,/g, 'export function $1(db: Db,');
  src = src.replace(/\basync function (\w+)\(\s*db\s*,/g, 'async function $1(db: Db,');

  if (src !== orig) {
    fs.writeFileSync(file, src);
    changed += 1;
  }
}
console.log(`Patched Db types in ${changed} lib/api files`);
