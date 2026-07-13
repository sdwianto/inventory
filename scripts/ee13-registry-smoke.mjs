#!/usr/bin/env node
/**
 * EE-13 — smoke test GitHub Packages install (prod path).
 *
 * Usage:
 *   GITHUB_TOKEN=<read:packages> npm run ee13:registry-smoke
 *
 * Skips local Sales symlinks; forces registry install into node_modules.
 */

import { execSync } from 'node:child_process';
import { existsSync, lstatSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const VENDOR_SALES = join(ROOT, '_vendor/sales');
const CONTRACTS_PKG = join(VENDOR_SALES, 'packages/contracts');
const PLATFORM_PKG = join(VENDOR_SALES, 'packages/platform');

function removeIfSymlink(path) {
  if (!existsSync(path)) return;
  if (lstatSync(path).isSymbolicLink()) {
    rmSync(path, { recursive: true, force: true });
  }
}

function removeVendorPackages() {
  removeIfSymlink(CONTRACTS_PKG);
  removeIfSymlink(PLATFORM_PKG);
  if (existsSync(CONTRACTS_PKG)) rmSync(CONTRACTS_PKG, { recursive: true, force: true });
  if (existsSync(PLATFORM_PKG)) rmSync(PLATFORM_PKG, { recursive: true, force: true });
}

function main() {
  const token = process.env.GITHUB_TOKEN || process.env.NODE_AUTH_TOKEN;
  if (!token) {
    console.error('[ee13-registry-smoke] GITHUB_TOKEN or NODE_AUTH_TOKEN required');
    process.exit(1);
  }

  removeVendorPackages();

  const env = {
    ...process.env,
    SDWIANTO_REGISTRY: 'github',
    EE12_FORCE_REGISTRY: '1',
    NODE_AUTH_TOKEN: token,
  };

  console.info('[ee13-registry-smoke] installing @sdwianto/* from GitHub Packages…');
  execSync('node scripts/ee12-install-platform.mjs', { cwd: ROOT, stdio: 'inherit', env });

  console.info('[ee13-registry-smoke] typecheck @sdwianto packages…');
  execSync('npm run typecheck:packages', { cwd: ROOT, stdio: 'inherit', env });

  console.info('[ee13-registry-smoke] EE-12 gate…');
  execSync('npm run test:execution:ee12', { cwd: ROOT, stdio: 'inherit', env });

  console.info('[ee13-registry-smoke] OK');
}

main();
