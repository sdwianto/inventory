#!/usr/bin/env node
/**
 * EE-12 — ensure ./_vendor/sales/packages/{contracts,events,platform} exist before npm install.
 *
 * Local: copy package dirs from ../../sales/sales/packages/* (npm file: rejects symlinks)
 * CI:    checkout sdwianto/sales to _vendor/sales (real tree)
 * Registry: install to node_modules, copy into _vendor (never symlink _vendor → node_modules)
 *
 * preinstall: sync _vendor only
 * postinstall / ee12:repair: link node_modules/@sdwianto → _vendor
 */

import { execSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const VENDOR_SALES = join(ROOT, '_vendor/sales');
const LOCAL_SALES = resolve(ROOT, '../../sales/sales');
const CONTRACTS_PKG = join(VENDOR_SALES, 'packages/contracts');
const EVENTS_PKG = join(VENDOR_SALES, 'packages/events');
const PLATFORM_PKG = join(VENDOR_SALES, 'packages/platform');
const NM_CONTRACTS = join(ROOT, 'node_modules/@sdwianto/contracts');
const NM_EVENTS = join(ROOT, 'node_modules/@sdwianto/events');
const NM_PLATFORM = join(ROOT, 'node_modules/@sdwianto/platform');
const CONTRACTS_VERSION = '1.0.0';
const EVENTS_VERSION = '1.0.1';
const PLATFORM_VERSION = '1.0.3';
const REGISTRY = 'https://npm.pkg.github.com';

const DIST_CANDIDATES = [
  join(VENDOR_SALES, 'packages/dist'),
  join(LOCAL_SALES, 'packages/dist'),
];

function removePath(path) {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
}

function linkDir(target, src) {
  const absSrc = resolve(src);
  if (!existsSync(absSrc)) {
    throw new Error(`[ee12-install] link source missing: ${absSrc}`);
  }
  mkdirSync(join(target, '..'), { recursive: true });
  removePath(target);
  symlinkSync(absSrc, target, 'dir');
}

/** Real directory tree — npm 11 rejects file: targets that are symlinks. */
function syncDir(target, src) {
  const absSrc = resolve(src);
  if (!existsSync(absSrc)) {
    throw new Error(`[ee12-install] sync source missing: ${absSrc}`);
  }
  mkdirSync(join(target, '..'), { recursive: true });
  removePath(target);
  cpSync(absSrc, target, { recursive: true });
}

function packagesReady() {
  try {
    return existsSync(join(CONTRACTS_PKG, 'package.json'))
      && existsSync(join(EVENTS_PKG, 'package.json'))
      && existsSync(join(PLATFORM_PKG, 'package.json'))
      && existsSync(join(CONTRACTS_PKG, 'src/index.ts'))
      && existsSync(join(EVENTS_PKG, 'src/publisher.ts'))
      && existsSync(join(PLATFORM_PKG, 'src/queue/enqueue.ts'));
  } catch {
    return false;
  }
}

function nodeModulesLinksOk() {
  if (!existsSync(join(NM_CONTRACTS, 'package.json'))) return false;
  if (!existsSync(join(NM_EVENTS, 'package.json'))) return false;
  if (!existsSync(join(NM_PLATFORM, 'package.json'))) return false;
  if (!packagesReady()) return false;
  try {
    return realpathSync(NM_CONTRACTS) === realpathSync(CONTRACTS_PKG)
      && realpathSync(NM_EVENTS) === realpathSync(EVENTS_PKG)
      && realpathSync(NM_PLATFORM) === realpathSync(PLATFORM_PKG);
  } catch {
    return false;
  }
}

function assertPackagesReadyOrExit() {
  if (packagesReady()) return;
  console.error('[ee12-install] _vendor packages not ready:');
  console.error(`  contracts → ${CONTRACTS_PKG}`);
  console.error(`  events    → ${EVENTS_PKG}`);
  console.error(`  platform  → ${PLATFORM_PKG}`);
  console.error('  Local: ensure ../../sales/sales/packages exists');
  console.error('  CI:    checkout sales to _vendor/sales && npm run ee12:pack');
  process.exit(1);
}

function ensureLocalPackageCopies() {
  const localContracts = join(LOCAL_SALES, 'packages/contracts');
  const localEvents = join(LOCAL_SALES, 'packages/events');
  const localPlatform = join(LOCAL_SALES, 'packages/platform');
  if (!existsSync(join(localContracts, 'package.json'))) return false;

  mkdirSync(join(VENDOR_SALES, 'packages'), { recursive: true });
  syncDir(CONTRACTS_PKG, localContracts);
  syncDir(EVENTS_PKG, localEvents);
  syncDir(PLATFORM_PKG, localPlatform);
  console.info('[ee12-install] _vendor/sales/packages/* copied from Sales monorepo');
  return packagesReady();
}

function findDistTarballs() {
  for (const base of DIST_CANDIDATES) {
    const contracts = join(base, `sdwianto-contracts-${CONTRACTS_VERSION}.tgz`);
    const events = join(base, `sdwianto-events-${EVENTS_VERSION}.tgz`);
    const platform = join(base, `sdwianto-platform-${PLATFORM_VERSION}.tgz`);
    if (existsSync(contracts) && existsSync(events) && existsSync(platform)) {
      return { contracts, events, platform };
    }
  }
  return null;
}

function copyRegistryIntoVendor(nmContracts, nmEvents, nmPlatform) {
  mkdirSync(join(VENDOR_SALES, 'packages'), { recursive: true });
  syncDir(CONTRACTS_PKG, nmContracts);
  syncDir(EVENTS_PKG, nmEvents);
  syncDir(PLATFORM_PKG, nmPlatform);
}

function installFromTarballs(dist) {
  console.info('[ee12-install] installing tarballs into node_modules');
  execSync(
    `npm install --ignore-scripts --no-audit --no-fund --no-save "${dist.contracts}" "${dist.events}" "${dist.platform}"`,
    { cwd: ROOT, stdio: 'inherit', env: { ...process.env, EE12_INSTALLING: '1' } },
  );
  if (existsSync(NM_CONTRACTS) && existsSync(NM_EVENTS) && existsSync(NM_PLATFORM)) {
    copyRegistryIntoVendor(NM_CONTRACTS, NM_EVENTS, NM_PLATFORM);
  }
}

function installFromRegistry() {
  const token = process.env.NODE_AUTH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('[ee12-install] GITHUB_TOKEN or NODE_AUTH_TOKEN required for SDWIANTO_REGISTRY=github');
    process.exit(1);
  }
  console.info('[ee12-install] GitHub Packages (SDWIANTO_REGISTRY=github)');
  // Quote scoped packages; auth via // config flag (not --@scope:registry CLI).
  execSync(
    `npm install --ignore-scripts --no-audit --no-fund --no-save "@sdwianto/contracts@${CONTRACTS_VERSION}" "@sdwianto/events@${EVENTS_VERSION}" "@sdwianto/platform@${PLATFORM_VERSION}" --registry "${REGISTRY}" --//npm.pkg.github.com/:_authToken=${token}`,
    {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, EE12_INSTALLING: '1', NODE_AUTH_TOKEN: token },
    },
  );
  if (existsSync(NM_CONTRACTS) && existsSync(NM_EVENTS) && existsSync(NM_PLATFORM)) {
    copyRegistryIntoVendor(NM_CONTRACTS, NM_EVENTS, NM_PLATFORM);
    console.info('[ee12-install] copied node_modules/@sdwianto/* → _vendor/sales/packages/*');
  }
}

function ensureNodeModulesSdwianto() {
  if (!packagesReady()) return;
  if (nodeModulesLinksOk()) {
    console.info('[ee12-install] node_modules/@sdwianto/* OK');
    return;
  }
  console.info('[ee12-install] linking node_modules/@sdwianto/* → _vendor');
  mkdirSync(join(ROOT, 'node_modules/@sdwianto'), { recursive: true });
  linkDir(NM_CONTRACTS, CONTRACTS_PKG);
  linkDir(NM_EVENTS, EVENTS_PKG);
  linkDir(NM_PLATFORM, PLATFORM_PKG);
}

function resolveVendorPackages() {
  if (process.env.EE12_FORCE_REGISTRY === '1' && process.env.SDWIANTO_REGISTRY === 'github') {
    installFromRegistry();
    return packagesReady();
  }

  const localContracts = join(LOCAL_SALES, 'packages/contracts/package.json');
  if (!process.env.CI && existsSync(localContracts)) {
    return ensureLocalPackageCopies();
  }

  if (packagesReady()) {
    console.info('[ee12-install] _vendor/sales/packages ready');
    return true;
  }

  if (process.env.SDWIANTO_REGISTRY === 'github' && (process.env.GITHUB_TOKEN || process.env.NODE_AUTH_TOKEN)) {
    installFromRegistry();
    return packagesReady();
  }

  const dist = findDistTarballs();
  if (dist) {
    installFromTarballs(dist);
    return packagesReady();
  }

  return false;
}

function main() {
  if (process.env.EE12_INSTALLING === '1') return;

  if (!resolveVendorPackages()) {
    console.error('[ee12-install] Cannot resolve @sdwianto packages.');
    console.error('  Local: ensure ../../sales/sales/packages exists');
    console.error('  Or:    cd ../../sales/sales && npm run ee12:pack');
    console.error('  CI:    checkout sdwianto/sales to _vendor/sales && npm run ee12:pack');
    console.error(`  cwd: ${ROOT}`);
    process.exit(1);
  }

  assertPackagesReadyOrExit();

  const lifecycle = process.env.npm_lifecycle_event;
  if (lifecycle === 'preinstall') {
    console.info('[ee12-install] _vendor ready — npm will link @sdwianto/*');
    return;
  }

  ensureNodeModulesSdwianto();

  if (lifecycle === 'postinstall') return;

  if (!nodeModulesLinksOk()) {
    console.error('[ee12-install] node_modules/@sdwianto/* missing or stale');
    console.error('  Try: npm run ee12:repair');
    process.exit(1);
  }
}

main();
