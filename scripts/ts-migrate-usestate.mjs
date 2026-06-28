#!/usr/bin/env node
/**
 * Add `: unknown` to simple untyped single-param arrow/function patterns in TSX pages.
 * Reduces TS7006/TS7031 noise during migration.
 */
import fs from 'fs';
import path from 'path';

const TARGETS = ['app', 'components', 'lib', 'hooks'];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next') continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

const files = TARGETS.flatMap((d) => walk(path.join(process.cwd(), d)));
let changed = 0;

for (const file of files) {
  let src = fs.readFileSync(file, 'utf8');
  const orig = src;

  // ({ prop1, prop2 }) =>  without types on one-line simple handlers - skip, too risky

  // useState([]) -> useState<unknown[]>([])
  src = src.replace(/useState\(\[\]\)/g, 'useState<unknown[]>([])');
  src = src.replace(/useState\(null\)/g, 'useState<unknown | null>(null)');
  src = src.replace(/useState\(\{\}\)/g, 'useState<Record<string, unknown>>({})');

  if (src !== orig) {
    fs.writeFileSync(file, src);
    changed += 1;
  }
}
console.log(`Patched useState defaults in ${changed} files`);
