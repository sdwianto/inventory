#!/usr/bin/env node
/**
 * Pragmatic TS fixes for shadcn forwardRef + untyped component props.
 * Uses explicit `any` on destructured props (noImplicitAny is false).
 */
import fs from 'fs';
import path from 'path';

const DIRS = ['components', 'app', 'hooks', 'lib'];
const SKIP = new Set(['node_modules', '.next', '.git', 'scripts']);

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

function fixForwardRef(src) {
  if (src.includes('React.forwardRef<')) return src;

  // Multiline forwardRef: React.forwardRef((\n  { ... },\n  ref\n) =>
  src = src.replace(
    /React\.forwardRef\(\(\s*(\{[\s\S]*?\})\s*,\s*ref\s*\)\s*=>/g,
    (m, destruct) => {
      if (destruct.includes(': any')) return m;
      return `React.forwardRef((${destruct}: any, ref: any) =>`;
    },
  );

  // Single-line: React.forwardRef(({ a, b }, ref) =>
  src = src.replace(
    /React\.forwardRef\(\(\{([^}]+)\},\s*ref\)\s*=>/g,
    (m, props) => {
      if (props.includes(': any')) return m;
      return `React.forwardRef(({ ${props} }: any, ref: any) =>`;
    },
  );

  return src;
}

function fixArrowComponentProps(src) {
  // const Foo = ({ className, ...props }) =>  (not forwardRef)
  src = src.replace(
    /^const ([A-Z][A-Za-z0-9]*) = \(\{([^}]+)\}\) =>/gm,
    (m, name, props) => {
      if (props.includes(':') || m.includes('forwardRef')) return m;
      return `const ${name} = ({ ${props} }: any) =>`;
    },
  );
  return src;
}

function fixAppHandlers(src) {
  let s = src;
  s = s.replace(/async \(id\) =>/g, 'async (id: string) =>');
  s = s.replace(/async \(row\) =>/g, 'async (row: Record<string, unknown>) =>');
  s = s.replace(/\(event\) =>/g, '(event: Event) =>');
  s = s.replace(/useCallback\(\(value\) =>/g, 'useCallback((value: boolean | ((prev: boolean) => boolean)) =>');
  s = s.replace(/\bsetOpen\(\(open\) =>/g, 'setOpen((open: boolean) =>');
  s = s.replace(/\bsetOpenMobile\(\(open\) =>/g, 'setOpenMobile((open: boolean) =>');
  s = s.replace(/catch \(e\) \{\s*\n(\s*)toast\.error\(e\.message\)/g,
    'catch (e) {\n$1toast.error(e instanceof Error ? e.message : String(e))');
  s = s.replace(/catch \(e\) \{\s*\n(\s*)throw new Error\(e\.message\)/g,
    'catch (e) {\n$1throw new Error(e instanceof Error ? e.message : String(e))');
  return s;
}

function fixNeverArrays(src) {
  const reps = [
    [/const listeners = \[\]/g, 'const listeners: Array<(s: unknown) => void> = []'],
    [/const (\w+) = \[\](?!\s*as)/g, 'const $1: Record<string, unknown>[] = []'],
    [/let po = null/g, 'let po: Record<string, unknown> | null = null'],
    [/let grn = null/g, 'let grn: Record<string, unknown> | null = null'],
    [/let prod = null/g, 'let prod: Record<string, unknown> | null = null'],
    [/let catalogSync = null/g, 'let catalogSync: Record<string, unknown> | null = null'],
    [/React\.createContext\(null\)/g, 'React.createContext<any>(null)'],
  ];
  let s = src;
  for (const [re, rep] of reps) s = s.replace(re, rep);
  return s;
}

let changed = 0;
for (const d of DIRS) {
  for (const file of walk(path.join(process.cwd(), d))) {
    let src = fs.readFileSync(file, 'utf8');
    const orig = src;
    src = fixNeverArrays(src);
    src = fixForwardRef(src);
    src = fixArrowComponentProps(src);
    if (file.includes('/app/') || file.endsWith('.tsx')) {
      src = fixAppHandlers(src);
    }
    if (src !== orig) {
      fs.writeFileSync(file, src);
      changed += 1;
    }
  }
}
console.log(`ts-fix-complete: ${changed} files patched`);
