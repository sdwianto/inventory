/**
 * EE-13 — Inventory registry prod path gate (static checks).
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');

describe('EE-13 — Inventory registry prod gate', () => {
  it('registry smoke script exists', () => {
    const root = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    expect(root.scripts['ee13:registry-smoke']).toBeTruthy();
    expect(existsSync(resolve(ROOT, 'scripts/ee13-registry-smoke.mjs'))).toBe(true);
  });

  it('.npmrc.example documents GitHub Packages', () => {
    const example = readFileSync(resolve(ROOT, '.npmrc.example'), 'utf8');
    expect(example).toContain('@sdwianto:registry=https://npm.pkg.github.com');
    expect(example).toContain('GITHUB_TOKEN');
  });

  it('ee12-install supports SDWIANTO_REGISTRY=github with scoped registry flags', () => {
    const script = readFileSync(resolve(ROOT, 'scripts/ee12-install-platform.mjs'), 'utf8');
    expect(script).toContain('SDWIANTO_REGISTRY === \'github\'');
    expect(script).toContain('--@sdwianto:registry=https://npm.pkg.github.com');
    expect(script).toContain('EE12_FORCE_REGISTRY');
  });

  it('CI runs EE-13 gate', () => {
    const ci = readFileSync(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('test:execution:ee13');
  });

  it('CI checks out sdwianto/sales for platform packages', () => {
    const ci = readFileSync(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('repository: sdwianto/sales');
  });

  it('typecheck:packages uses app-root TypeScript (registry-safe)', () => {
    const root = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    expect(root.scripts['typecheck:packages']).toContain('typecheck-sdwianto-packages.mjs');
    expect(existsSync(resolve(ROOT, 'scripts/typecheck-sdwianto-packages.mjs'))).toBe(true);
    expect(existsSync(resolve(ROOT, 'scripts/ci/tsconfig.sdwianto-contracts.json'))).toBe(true);
    expect(existsSync(resolve(ROOT, 'scripts/ci/tsconfig.sdwianto-events.json'))).toBe(true);
    expect(existsSync(resolve(ROOT, 'scripts/ci/tsconfig.sdwianto-platform.json'))).toBe(true);
  });

  it('ee12-install vendors contracts, events, and platform', () => {
    const script = readFileSync(resolve(ROOT, 'scripts/ee12-install-platform.mjs'), 'utf8');
    expect(script).toContain('packages/events');
    expect(script).toContain('@sdwianto/events@');
    expect(script).toContain("const EVENTS_VERSION = '1.0.1'");
    expect(script).toContain("const PLATFORM_VERSION = '1.0.3'");
    expect(script).toContain('@sdwianto/platform@${PLATFORM_VERSION}');
  });

  it('CI runs EE-14 gate', () => {
    const ci = readFileSync(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('test:execution:ee14');
  });

  it('local dev pins file:_vendor/sales for all @sdwianto packages', () => {
    const root = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    expect(root.dependencies['@sdwianto/contracts']).toBe('file:./_vendor/sales/packages/contracts');
    expect(root.dependencies['@sdwianto/events']).toBe('file:./_vendor/sales/packages/events');
    expect(root.dependencies['@sdwianto/platform']).toBe('file:./_vendor/sales/packages/platform');
  });
});
