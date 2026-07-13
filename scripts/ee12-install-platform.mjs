#!/usr/bin/env node
/**
 * EE-12 — ensure ./_vendor/sales/packages/{contracts,platform} exist before npm install.
 *
 * Local: symlink package dirs → ../../sales/sales/packages/*
 * CI:    checkout sdwianto/sales to _vendor/sales (real tree)
 */

import { execSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const VENDOR_SALES = join(ROOT, '_vendor/sales');
const LOCAL_SALES = resolve(ROOT, '../../sales/sales');
const CONTRACTS_PKG = join(VENDOR_SALES, 'packages/contracts');
const PLATFORM_PKG = join(VENDOR_SALES, 'packages/platform');
const VERSION = '1.0.0';

const DIST_CANDIDATES = [
  join(VENDOR_SALES, 'packages/dist'),
  join(LOCAL_SALES, 'packages/dist'),
];

function linkDir(target, src) {
  const absSrc = resolve(src);
  mkdirSync(join(target, '..'), { recursive: true });
  if (existsSync(target)) {
    const st = lstatSync(target);
    if (st.isSymbolicLink()) {
      try {
        if (resolve(readlinkSync(target)) === absSrc) return;
      } catch {
        // replace
      }
    }
    rmSync(target, { recursive: true, force: true });
  }
  symlinkSync(absSrc, target, 'dir');
}

function packagesReady() {
  return existsSync(join(CONTRACTS_PKG, 'src/index.ts'))
    && existsSync(join(PLATFORM_PKG, 'src/queue/enqueue.ts'));
}

function ensureLocalPackageLinks() {
  const localContracts = join(LOCAL_SALES, 'packages/contracts');
  const localPlatform = join(LOCAL_SALES, 'packages/platform');
  if (!existsSync(join(localContracts, 'package.json'))) return false;

  if (existsSync(VENDOR_SALES)) {
    const st = lstatSync(VENDOR_SALES);
    if (st.isSymbolicLink()) {
      rmSync(VENDOR_SALES, { recursive: true, force: true });
    }
  }
  mkdirSync(join(VENDOR_SALES, 'packages'), { recursive: true });
  linkDir(CONTRACTS_PKG, localContracts);
  linkDir(PLATFORM_PKG, localPlatform);
  console.info('[ee12-install] _vendor/sales/packages/* → Sales monorepo');
  return packagesReady();
}

function ensureCiCheckout() {
  return packagesReady();
}

function findDistTarballs() {
  for (const base of DIST_CANDIDATES) {
    const contracts = join(base, `sdwianto-contracts-${VERSION}.tgz`);
    const platform = join(base, `sdwianto-platform-${VERSION}.tgz`);
    if (existsSync(contracts) && existsSync(platform)) {
      return { contracts, platform };
    }
  }
  return null;
}

function installFromTarballs(dist) {
  console.info('[ee12-install] installing tarballs into node_modules');
  execSync(
    `npm install --ignore-scripts --no-audit --no-fund --no-save "${dist.contracts}" "${dist.platform}"`,
    { cwd: ROOT, stdio: 'inherit', env: { ...process.env, EE12_INSTALLING: '1' } },
  );
  const nmContracts = join(ROOT, 'node_modules/@sdwianto/contracts');
  const nmPlatform = join(ROOT, 'node_modules/@sdwianto/platform');
  if (existsSync(nmContracts) && existsSync(nmPlatform)) {
    mkdirSync(join(VENDOR_SALES, 'packages'), { recursive: true });
    linkDir(CONTRACTS_PKG, nmContracts);
    linkDir(PLATFORM_PKG, nmPlatform);
  }
}

function installFromRegistry() {
  const token = process.env.NODE_AUTH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('[ee12-install] GITHUB_TOKEN or NODE_AUTH_TOKEN required for SDWIANTO_REGISTRY=github');
    process.exit(1);
  }
  console.info('[ee12-install] GitHub Packages (SDWIANTO_REGISTRY=github)');
  const auth = `--//npm.pkg.github.com/:_authToken=${token}`;
  execSync(
    `npm install --ignore-scripts --no-audit --no-fund --no-save @sdwianto/contracts@${VERSION} @sdwianto/platform@${VERSION} --@sdwianto:registry=https://npm.pkg.github.com ${auth}`,
    {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, EE12_INSTALLING: '1', NODE_AUTH_TOKEN: token },
    },
  );
  const nmContracts = join(ROOT, 'node_modules/@sdwianto/contracts');
  const nmPlatform = join(ROOT, 'node_modules/@sdwianto/platform');
  if (existsSync(nmContracts) && existsSync(nmPlatform)) {
    mkdirSync(join(VENDOR_SALES, 'packages'), { recursive: true });
    linkDir(CONTRACTS_PKG, nmContracts);
    linkDir(PLATFORM_PKG, nmPlatform);
    console.info('[ee12-install] linked node_modules/@dawam/* → _vendor/sales/packages/*');
  }
}

function main() {
  if (process.env.EE12_INSTALLING === '1') return;

  if (process.env.EE12_FORCE_REGISTRY === '1' && process.env.SDWIANTO_REGISTRY === 'github') {
    installFromRegistry();
    return;
  }

  if (ensureCiCheckout()) {
    console.info('[ee12-install] _vendor/sales/packages ready');
    return;
  }

  if (ensureLocalPackageLinks()) return;

  if (process.env.SDWIANTO_REGISTRY === 'github' && (process.env.GITHUB_TOKEN || process.env.NODE_AUTH_TOKEN)) {
    installFromRegistry();
    return;
  }

  const dist = findDistTarballs();
  if (dist) {
    installFromTarballs(dist);
    if (packagesReady()) return;
  }

  console.error('[ee12-install] Cannot resolve @dawam packages.');
  console.error('  Local: ensure ../../sales/sales/packages exists (run: cd ../../sales/sales && git checkout HEAD -- packages)');
  console.error('  Or:    cd ../../sales/sales && npm run ee12:pack');
  console.error('  CI:    checkout sdwianto/sales to _vendor/sales && npm run ee12:pack');
  console.error('  WARN:  never rm -rf _vendor/sales when it symlinks the whole sales repo');
  console.error(`  cwd: ${ROOT}`);
  process.exit(1);
}

main();
