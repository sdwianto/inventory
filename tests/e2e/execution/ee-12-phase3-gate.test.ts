/**
 * EE-12 Phase 3 — Inventory consumes @sdwianto/platform from Sales vendor link.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONTRACTS_PACKAGE_VERSION,
  JOB_SCHEMA_VERSION,
  getJobTypeDefaults,
  isPlatformVersionSkew,
} from '@sdwianto/contracts';

const ROOT = resolve(import.meta.dirname, '../../..');

const APP_ONLY_FILES = new Set([
  'workers/register-inventory.ts',
  'workers/register-all.ts',
  'scheduler/default-tasks.ts',
  'scheduler/seed-default-tasks.ts',
  'api.ts',
]);

function listExecutionTsFiles(dir: string, base = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const rel = base ? `${base}/${entry}` : entry;
    const abs = join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      out.push(...listExecutionTsFiles(abs, rel));
    } else if (entry.endsWith('.ts')) {
      out.push(rel.replace(/\\/g, '/'));
    }
  }
  return out;
}

function isShimContent(content: string): boolean {
  return content.includes('@sdwianto/platform')
    || content.includes('@sdwianto/contracts')
    || content.includes('@sdwianto/events');
}

describe('EE-12 Phase 3 — Inventory platform consumer gate', () => {
  it('Sales packages available via _vendor/sales', () => {
    const contractsPath = resolve(ROOT, 'node_modules/@sdwianto/contracts/package.json');
    const platformPath = resolve(ROOT, 'node_modules/@sdwianto/platform/package.json');
    const vendorContracts = resolve(ROOT, '_vendor/sales/packages/contracts/package.json');
    const vendorPlatform = resolve(ROOT, '_vendor/sales/packages/platform/package.json');
    const vendorEvents = resolve(ROOT, '_vendor/sales/packages/events/package.json');
    expect(existsSync(contractsPath) || existsSync(vendorContracts)).toBe(true);
    expect(existsSync(platformPath) || existsSync(vendorPlatform)).toBe(true);
    expect(existsSync(resolve(ROOT, 'node_modules/@sdwianto/events/package.json')) || existsSync(vendorEvents)).toBe(true);
    const contracts = JSON.parse(readFileSync(
      existsSync(contractsPath) ? contractsPath : vendorContracts,
      'utf8',
    ));
    const platform = JSON.parse(readFileSync(
      existsSync(platformPath) ? platformPath : vendorPlatform,
      'utf8',
    ));
    expect(contracts.name).toBe('@sdwianto/contracts');
    expect(platform.name).toBe('@sdwianto/platform');
    expect(platform.dependencies['@sdwianto/contracts']).toBe('1.0.0');
    expect(platform.dependencies['@sdwianto/events']).toBe('1.0.1');
    expect(platform.version).toBe('1.0.3');
  });

  it('package.json depends on _vendor/sales @sdwianto/*', () => {
    const root = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    expect(root.dependencies['@sdwianto/contracts']).toBe('file:./_vendor/sales/packages/contracts');
    expect(root.dependencies['@sdwianto/events']).toBe('file:./_vendor/sales/packages/events');
    expect(root.dependencies['@sdwianto/platform']).toBe('file:./_vendor/sales/packages/platform');
    expect(root.scripts['test:execution:ee12']).toBeTruthy();
    expect(root.scripts['typecheck:packages']).toBeTruthy();
  });

  it('lib/execution/events/publisher shim points to @sdwianto/events', () => {
    const publisher = readFileSync(resolve(ROOT, 'lib/execution/events/publisher.ts'), 'utf8');
    expect(publisher).toContain('@sdwianto/events');
    expect(publisher).not.toContain('@sdwianto/platform/events/publisher');
  });

  it('lib/execution runtime shims point to platform', () => {
    const enqueue = readFileSync(resolve(ROOT, 'lib/execution/queue/enqueue.ts'), 'utf8');
    expect(enqueue).toContain('@sdwianto/platform/queue/enqueue');
    expect(enqueue).not.toContain('sole entry for new jobs');
  });

  it('lib/execution/contracts shims re-export package', () => {
    const job = readFileSync(resolve(ROOT, 'lib/execution/contracts/job.ts'), 'utf8');
    expect(job).toContain('@sdwianto/contracts');
    expect(job).not.toMatch(/export type JobStatus\s*=/);
  });

  it('lib/execution/api.ts re-exports platform + inventory handlers', () => {
    const api = readFileSync(resolve(ROOT, 'lib/execution/api.ts'), 'utf8');
    expect(api).toContain("export * from '@sdwianto/platform'");
    expect(api).toContain('registerInventoryHandlers');
    expect(api).not.toContain('registerIntegrationHandlers');
  });

  it('app-only scheduler wrapper uses DEFAULT_INVENTORY_SCHEDULED_TASKS', () => {
    const seed = readFileSync(resolve(ROOT, 'lib/execution/scheduler/seed-default-tasks.ts'), 'utf8');
    expect(seed).toContain('DEFAULT_INVENTORY_SCHEDULED_TASKS');
    expect(seed).toContain('@sdwianto/platform/scheduler/seed-default-tasks');
  });

  it('@sdwianto/contracts runtime smoke (aligned with Sales)', () => {
    expect(CONTRACTS_PACKAGE_VERSION).toBe('1.0.0');
    expect(JOB_SCHEMA_VERSION).toBe(1);
    expect(getJobTypeDefaults('WEBHOOK_INBOX').domain).toBe('inventory');
    expect(isPlatformVersionSkew('1.0.0', '1.0.0')).toBe(false);
  });

  it('platform extract phase marker matches Sales', () => {
    const platformIndex = resolve(ROOT, 'node_modules/@sdwianto/platform/src/index.ts');
    const vendorIndex = resolve(ROOT, '_vendor/sales/packages/platform/src/index.ts');
    const indexPath = existsSync(platformIndex) ? platformIndex : vendorIndex;
    const index = readFileSync(indexPath, 'utf8');
    expect(index).toContain('DAWAM_PLATFORM_EXTRACT_PHASE = 2');
  });

  it('no duplicate runtime — lib/execution is shims + app wrappers only', () => {
    const execRoot = resolve(ROOT, 'lib/execution');
    const files = listExecutionTsFiles(execRoot);
    const offenders: string[] = [];
    for (const rel of files) {
      if (APP_ONLY_FILES.has(rel) || rel.startsWith('contracts/')) continue;
      const content = readFileSync(join(execRoot, rel), 'utf8');
      if (!isShimContent(content)) offenders.push(rel);
      if (/export (async )?function /.test(content) && !APP_ONLY_FILES.has(rel)) {
        offenders.push(`${rel} (contains export function)`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('execution boundary scripts wired', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['check:execution-boundary']).toBeTruthy();
    expect(pkg.scripts['check:execution-boundary:strict']).toBeTruthy();
    expect(existsSync(resolve(ROOT, 'scripts/ci/check-execution-boundary.mjs'))).toBe(true);
  });

  it('tsconfig + next.config alias @sdwianto packages (_vendor/sales fallback)', () => {
    const ts = JSON.parse(readFileSync(resolve(ROOT, 'tsconfig.json'), 'utf8'));
    expect(ts.compilerOptions.paths['@sdwianto/contracts'][0]).toContain('node_modules/@sdwianto/contracts');
    expect(ts.compilerOptions.paths['@sdwianto/platform'][0]).toContain('node_modules/@sdwianto/platform');
    expect(ts.compilerOptions.paths['@sdwianto/events'][0]).toContain('node_modules/@sdwianto/events');
    expect(ts.compilerOptions.paths['@sdwianto/contracts'][1]).toContain('_vendor/sales/packages/contracts');
    expect(ts.compilerOptions.paths['@sdwianto/events'][1]).toContain('_vendor/sales/packages/events');
    expect(ts.compilerOptions.paths['@sdwianto/platform'][1]).toContain('_vendor/sales/packages/platform');
    const next = readFileSync(resolve(ROOT, 'next.config.js'), 'utf8');
    expect(next).toContain("transpilePackages: ['@sdwianto/contracts', '@sdwianto/events', '@sdwianto/platform']");
  });
});
