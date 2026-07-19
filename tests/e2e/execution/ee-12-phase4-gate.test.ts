/**
 * EE-12 Phase 4 — Inventory semver consumer + pack install gate.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');

describe('EE-12 Phase 4 — Inventory registry consumer gate', () => {
  it('package.json pins @sdwianto/* via file:_vendor/sales', () => {
    const root = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    expect(root.dependencies['@sdwianto/contracts']).toBe('file:./_vendor/sales/packages/contracts');
    expect(root.dependencies['@sdwianto/events']).toBe('file:./_vendor/sales/packages/events');
    expect(root.dependencies['@sdwianto/metrics']).toBe('file:./_vendor/sales/packages/metrics');
    expect(root.dependencies['@sdwianto/platform']).toBe('file:./_vendor/sales/packages/platform');
    expect(root.scripts['ee12:install-platform']).toBeTruthy();
  });

  it('@sdwianto packages installed in node_modules', () => {
    expect(existsSync(resolve(ROOT, 'node_modules/@sdwianto/contracts/package.json'))).toBe(true);
    expect(existsSync(resolve(ROOT, 'node_modules/@sdwianto/events/package.json'))).toBe(true);
    expect(existsSync(resolve(ROOT, 'node_modules/@sdwianto/metrics/package.json'))).toBe(true);
    expect(existsSync(resolve(ROOT, 'node_modules/@sdwianto/platform/package.json'))).toBe(true);
    const platform = JSON.parse(readFileSync(resolve(ROOT, 'node_modules/@sdwianto/platform/package.json'), 'utf8'));
    expect(platform.version).toBe('1.0.4');
    expect(platform.dependencies['@sdwianto/contracts']).toBe('1.0.0');
    expect(platform.dependencies['@sdwianto/events']).toBe('1.0.1');
    expect(platform.dependencies['@sdwianto/metrics']).toBe('1.0.0');
  });

  it('tsconfig resolves node_modules @sdwianto paths', () => {
    const ts = JSON.parse(readFileSync(resolve(ROOT, 'tsconfig.json'), 'utf8'));
    expect(ts.compilerOptions.paths['@sdwianto/contracts'][0]).toContain('node_modules/@sdwianto/contracts');
    expect(ts.compilerOptions.paths['@sdwianto/events'][0]).toContain('node_modules/@sdwianto/events');
    expect(ts.compilerOptions.paths['@sdwianto/metrics'][0]).toContain('node_modules/@sdwianto/metrics');
    expect(ts.compilerOptions.paths['@sdwianto/platform'][0]).toContain('node_modules/@sdwianto/platform');
  });
});
