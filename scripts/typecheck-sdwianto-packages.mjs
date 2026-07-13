#!/usr/bin/env node
/**
 * Typecheck @sdwianto/* using app-root TypeScript.
 * Works for file:_vendor installs and GitHub Packages (no tsconfig in tarball).
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const TSC = join(ROOT, 'node_modules/typescript/bin/tsc');
const PACKAGES = ['contracts', 'platform'];

function resolvePackageDir(name) {
  const nm = join(ROOT, 'node_modules/@sdwianto', name);
  if (existsSync(join(nm, 'package.json'))) return nm;
  const vendor = join(ROOT, '_vendor/sales/packages', name);
  if (existsSync(join(vendor, 'package.json'))) return vendor;
  console.error(`[typecheck:packages] @sdwianto/${name} not installed`);
  process.exit(1);
}

function resolveTsconfig(name, pkgDir) {
  const inPkg = join(pkgDir, 'tsconfig.json');
  if (existsSync(inPkg)) {
    return { path: inPkg, cwd: pkgDir };
  }
  const consumer = join(ROOT, 'scripts/ci', `tsconfig.sdwianto-${name}.json`);
  if (existsSync(consumer)) {
    return { path: consumer, cwd: ROOT };
  }
  console.error(`[typecheck:packages] no tsconfig for @sdwianto/${name}`);
  process.exit(1);
}

function main() {
  if (!existsSync(TSC)) {
    console.error('[typecheck:packages] typescript not found — run npm install');
    process.exit(1);
  }

  const only = process.argv[2];
  const names = only ? [only] : PACKAGES;
  if (only && !PACKAGES.includes(only)) {
    console.error(`[typecheck:packages] unknown package: ${only}`);
    process.exit(1);
  }

  for (const name of names) {
    const pkgDir = resolvePackageDir(name);
    const { path, cwd } = resolveTsconfig(name, pkgDir);
    console.info(`[typecheck:packages] @sdwianto/${name}`);
    execSync(`node "${TSC}" --noEmit -p "${path}"`, { cwd, stdio: 'inherit' });
  }

  console.info('[typecheck:packages] OK');
}

main();
