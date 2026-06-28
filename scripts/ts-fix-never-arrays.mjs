#!/usr/bin/env node
/**
 * Fix const x = [] inferred as never[] and similar patterns in TS files.
 */
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const SKIP = new Set(['node_modules', '.next', '.git', 'scripts']);

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

const REPLACEMENTS = [
  [/const listeners = \[\]/g, 'const listeners: Array<(state: unknown) => void> = []'],
  [/const results = \[\]/g, 'const results: Record<string, unknown>[] = []'],
  [/const items = \[\]/g, 'const items: Record<string, unknown>[] = []'],
  [/const errors = \[\]/g, 'const errors: Record<string, unknown>[] = []'],
  [/const submissions = \[\]/g, 'const submissions: Record<string, unknown>[] = []'],
  [/const synced = \[\]/g, 'const synced: Record<string, unknown>[] = []'],
  [/const failed = \[\]/g, 'const failed: Record<string, unknown>[] = []'],
  [/const rows = \[\]/g, 'const rows: Record<string, unknown>[] = []'],
  [/const persistPatches = \[\]/g, 'const persistPatches: Record<string, unknown>[] = []'],
  [/const lineInputs = \[\]/g, 'const lineInputs: Record<string, unknown>[] = []'],
  [/const kartuDocs = \[\]/g, 'const kartuDocs: Record<string, unknown>[] = []'],
  [/const itemsFull = \[\]/g, 'const itemsFull: Record<string, unknown>[] = []'],
  [/const stokLokasiBulk = \[\]/g, 'const stokLokasiBulk: Record<string, unknown>[] = []'],
  [/const productBulk = \[\]/g, 'const productBulk: Record<string, unknown>[] = []'],
  [/const enriched = \[\]/g, 'const enriched: Record<string, unknown>[] = []'],
  [/let grns = \[\]/g, 'let grns: Record<string, unknown>[] = []'],
  [/let po = null/g, 'let po: Record<string, unknown> | null = null'],
  [/let grn = null/g, 'let grn: Record<string, unknown> | null = null'],
  [/let catalogSync = null/g, 'let catalogSync: Record<string, unknown> | null = null'],
  [/let prod = null/g, 'let prod: Record<string, unknown> | null = null'],
  [/React\.createContext\(null\)/g, 'React.createContext<unknown>(null)'],
];

let changed = 0;
for (const file of walk(ROOT)) {
  let src = fs.readFileSync(file, 'utf8');
  const orig = src;
  for (const [re, rep] of REPLACEMENTS) {
    src = src.replace(re, rep);
  }
  if (src !== orig) {
    fs.writeFileSync(file, src);
    changed += 1;
  }
}
console.log(`never-arrays: ${changed} files`);
