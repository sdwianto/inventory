#!/usr/bin/env node
/** Fix catch (e) { ... e.message } patterns for unknown type. */
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

let changed = 0;
for (const file of walk(ROOT)) {
  let src = fs.readFileSync(file, 'utf8');
  const orig = src;

  // toast.error(e.message) -> toast.error(e instanceof Error ? e.message : String(e))
  src = src.replace(
    /toast\.error\(e\.message\)/g,
    'toast.error(e instanceof Error ? e.message : String(e))',
  );
  src = src.replace(
    /toast\.success\(e\.message\)/g,
    'toast.success(e instanceof Error ? e.message : String(e))',
  );

  // throw new Error(data.error) patterns are fine

  // Generic: catch block using e.message without guard (simple single-line)
  src = src.replace(
    /catch \(e\) \{\s*\n(\s*)toast\.error\(([^)]+)\);/g,
    (m, indent, expr) => {
      if (expr.includes('instanceof')) return m;
      if (expr === 'e.message') {
        return `catch (e) {\n${indent}toast.error(e instanceof Error ? e.message : String(e));`;
      }
      return m;
    },
  );

  if (src !== orig) {
    fs.writeFileSync(file, src);
    changed += 1;
  }
}
console.log(`catch-unknown: ${changed} files`);
