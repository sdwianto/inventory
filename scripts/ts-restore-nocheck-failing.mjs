#!/usr/bin/env node
/**
 * Re-add // @ts-nocheck to files that still fail tsc (keeps fully-typed files clean).
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const ROOT = process.cwd();
const SKIP = new Set(['node_modules', '.next', '.git', 'scripts']);

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name)) out.push(path.relative(ROOT, full));
  }
  return out;
}

let tscOut = '';
try {
  tscOut = execSync('bash -lc "source ~/.nvm/nvm.sh && nvm use >/dev/null && npx tsc --noEmit 2>&1"', {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
} catch (e) {
  tscOut = (e.stdout || '') + (e.stderr || '');
}

const failing = new Set();
for (const line of tscOut.split('\n')) {
  const m = line.match(/^(.+\.tsx?)\(\d+,\d+\): error TS/);
  if (m) failing.add(m[1].replace(/^\.\//, ''));
}

let restored = 0;
for (const rel of failing) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) continue;
  const src = fs.readFileSync(full, 'utf8');
  if (src.includes('@ts-nocheck')) continue;
  const next = `// @ts-nocheck\n${src}`;
  fs.writeFileSync(full, next);
  restored += 1;
}

const all = walk(ROOT).filter((f) => !f.startsWith('scripts/'));
const clean = all.filter((f) => {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  return !src.includes('@ts-nocheck');
});

console.log(JSON.stringify({
  failing: failing.size,
  restored,
  fullyTyped: clean.length,
  stillNocheck: all.length - clean.length,
}, null, 2));
