import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPLACEMENTS = [
  ['bg-orange-500 hover:bg-orange-600', 'btn-bgn'],
  ['bg-orange-500/90 text-white font-medium', 'nav-active-bgn'],
  ['bg-orange-500 text-white font-medium', 'nav-active-bgn'],
  ['ring-orange-500/40', 'ring-bgn-gold/50'],
  ['bg-orange-100 text-orange-700', 'bg-bgn-sky text-bgn-navy'],
  ['bg-orange-50 border border-orange-200', 'surface-bgn border'],
  ['bg-orange-50 border-orange-200', 'surface-bgn'],
  ['bg-orange-50 border-orange-100', 'bg-bgn-sky-light border-bgn-sky'],
  ['bg-orange-50/50', 'bg-bgn-sky-light/50'],
  ['group-hover:text-orange-600', 'group-hover:text-bgn-gold'],
  ['hover:border-orange-300', 'hover:border-bgn-gold'],
  ['hover:bg-orange-50', 'hover:bg-bgn-sky-light'],
  ['text-orange-600', 'text-bgn-gold'],
  ['text-orange-400', 'text-bgn-gold'],
  ['text-orange-700', 'text-bgn-navy'],
  ['text-orange-800', 'text-bgn-navy'],
  ['text-orange-900', 'text-bgn-navy'],
  ['text-orange-500', 'text-bgn-gold'],
  ['border-orange-200', 'border-bgn-sky'],
  ['border-orange-100', 'border-bgn-sky/70'],
  ['border-orange-400', 'border-bgn-gold'],
  ['bg-orange-50', 'bg-bgn-sky-light'],
  ['bg-orange-100', 'bg-bgn-sky/50'],
  ['bg-orange-500', 'bg-bgn-navy'],
  ['from-slate-900 via-slate-800 to-orange-900', 'from-bgn-navy via-bgn-navy-light to-bgn-navy-dark'],
  ['rgba(249,115,22,0.5)', 'rgba(197,160,89,0.5)'],
];

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|jsx)$/.test(name)) out.push(p);
  }
  return out;
}

let count = 0;
for (const f of [...walk(path.join(root, 'app')), ...walk(path.join(root, 'components'))]) {
  let s = fs.readFileSync(f, 'utf8');
  let changed = false;
  for (const [from, to] of REPLACEMENTS) {
    if (s.includes(from)) {
      s = s.split(from).join(to);
      changed = true;
    }
  }
  if (changed) {
    fs.writeFileSync(f, s);
    count += 1;
  }
}
console.log(`Updated ${count} files`);
