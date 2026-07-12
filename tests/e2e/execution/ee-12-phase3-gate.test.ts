/**
 * EE-12 Phase 3 — Inventory consumes @dawam/platform from Sales vendor link.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONTRACTS_PACKAGE_VERSION,
  JOB_SCHEMA_VERSION,
  getJobTypeDefaults,
  isPlatformVersionSkew,
} from '@dawam/contracts';

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
  return content.includes("@dawam/platform") || content.includes("@dawam/contracts");
}

describe('EE-12 Phase 3 — Inventory platform consumer gate', () => {
  it('vendor packages linked from Sales', () => {
    expect(existsSync(resolve(ROOT, 'vendor/contracts/package.json'))).toBe(true);
    expect(existsSync(resolve(ROOT, 'vendor/platform/package.json'))).toBe(true);
    const contracts = JSON.parse(readFileSync(resolve(ROOT, 'vendor/contracts/package.json'), 'utf8'));
    const platform = JSON.parse(readFileSync(resolve(ROOT, 'vendor/platform/package.json'), 'utf8'));
    expect(contracts.name).toBe('@dawam/contracts');
    expect(platform.name).toBe('@dawam/platform');
    expect(platform.dependencies['@dawam/contracts']).toBe('1.0.0');
  });

  it('package.json depends on vendored @dawam/*', () => {
    const root = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    expect(root.dependencies['@dawam/contracts']).toBe('file:./vendor/contracts');
    expect(root.dependencies['@dawam/platform']).toBe('file:./vendor/platform');
    expect(root.scripts['test:execution:ee12']).toBeTruthy();
    expect(root.scripts['typecheck:packages']).toBeTruthy();
  });

  it('lib/execution runtime shims point to platform', () => {
    const enqueue = readFileSync(resolve(ROOT, 'lib/execution/queue/enqueue.ts'), 'utf8');
    expect(enqueue).toContain('@dawam/platform/queue/enqueue');
    expect(enqueue).not.toContain('sole entry for new jobs');
  });

  it('lib/execution/contracts shims re-export package', () => {
    const job = readFileSync(resolve(ROOT, 'lib/execution/contracts/job.ts'), 'utf8');
    expect(job).toContain('@dawam/contracts');
    expect(job).not.toMatch(/export type JobStatus\s*=/);
  });

  it('lib/execution/api.ts re-exports platform + inventory handlers', () => {
    const api = readFileSync(resolve(ROOT, 'lib/execution/api.ts'), 'utf8');
    expect(api).toContain("export * from '@dawam/platform'");
    expect(api).toContain('registerInventoryHandlers');
    expect(api).not.toContain('registerIntegrationHandlers');
  });

  it('app-only scheduler wrapper uses DEFAULT_INVENTORY_SCHEDULED_TASKS', () => {
    const seed = readFileSync(resolve(ROOT, 'lib/execution/scheduler/seed-default-tasks.ts'), 'utf8');
    expect(seed).toContain('DEFAULT_INVENTORY_SCHEDULED_TASKS');
    expect(seed).toContain('@dawam/platform/scheduler/seed-default-tasks');
  });

  it('@dawam/contracts runtime smoke (aligned with Sales)', () => {
    expect(CONTRACTS_PACKAGE_VERSION).toBe('1.0.0');
    expect(JOB_SCHEMA_VERSION).toBe(1);
    expect(getJobTypeDefaults('WEBHOOK_INBOX').domain).toBe('inventory');
    expect(isPlatformVersionSkew('1.0.0', '1.0.0')).toBe(false);
  });

  it('platform extract phase marker matches Sales', () => {
    const index = readFileSync(resolve(ROOT, 'vendor/platform/src/index.ts'), 'utf8');
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

  it('tsconfig + next.config alias workspace packages', () => {
    const ts = JSON.parse(readFileSync(resolve(ROOT, 'tsconfig.json'), 'utf8'));
    expect(ts.compilerOptions.paths['@dawam/contracts'][0]).toContain('vendor/contracts');
    expect(ts.compilerOptions.paths['@dawam/platform'][0]).toContain('vendor/platform');
    const next = readFileSync(resolve(ROOT, 'next.config.js'), 'utf8');
    expect(next).toContain("transpilePackages: ['@dawam/contracts', '@dawam/platform']");
  });
});
