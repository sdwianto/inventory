#!/usr/bin/env node
/**
 * EE-12 Phase 3 — symlink @dawam/* packages from Sales repo into ./vendor/
 *
 * Local: ../../sales/sales/packages
 * CI:    ./_vendor/sales/packages (checkout sales repo to _vendor/sales)
 */

import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const VENDOR = join(ROOT, 'vendor');

const CANDIDATES = [
  join(ROOT, '../../sales/sales/packages'),
  join(ROOT, '_vendor/sales/packages'),
];

function resolveSalesPackages() {
  for (const base of CANDIDATES) {
    if (existsSync(join(base, 'contracts/package.json')) && existsSync(join(base, 'platform/package.json'))) {
      return base;
    }
  }
  return null;
}

function linkDir(name, srcBase) {
  const target = join(VENDOR, name);
  const src = join(srcBase, name);
  if (!existsSync(src)) {
    throw new Error(`[ee12-vendor] missing ${src}`);
  }
  if (existsSync(target)) {
    const st = lstatSync(target);
    if (st.isSymbolicLink()) return;
    rmSync(target, { recursive: true, force: true });
  }
  symlinkSync(src, target, 'dir');
}

function main() {
  const pkgs = resolveSalesPackages();
  if (!pkgs) {
    console.error('[ee12-vendor] Sales packages not found. Expected one of:');
    for (const c of CANDIDATES) console.error(`  - ${c}`);
    console.error('Clone sdwianto/sales beside inventory-app or set CI checkout to _vendor/sales');
    process.exit(1);
  }
  mkdirSync(VENDOR, { recursive: true });
  linkDir('contracts', pkgs);
  linkDir('platform', pkgs);
  console.info(`[ee12-vendor] linked vendor/* ← ${pkgs}`);
}

main();
