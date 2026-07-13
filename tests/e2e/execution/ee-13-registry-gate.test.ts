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
    expect(example).toContain('@dawam:registry=https://npm.pkg.github.com');
    expect(example).toContain('GITHUB_TOKEN');
  });

  it('ee12-install supports DAWAM_REGISTRY=github with scoped registry flags', () => {
    const script = readFileSync(resolve(ROOT, 'scripts/ee12-install-platform.mjs'), 'utf8');
    expect(script).toContain('DAWAM_REGISTRY === \'github\'');
    expect(script).toContain('--@dawam:registry=https://npm.pkg.github.com');
    expect(script).toContain('EE12_FORCE_REGISTRY');
  });

  it('local dev still pins file:_vendor/sales (registry is prod override)', () => {
    const root = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    expect(root.dependencies['@dawam/contracts']).toBe('file:./_vendor/sales/packages/contracts');
    expect(root.dependencies['@dawam/platform']).toBe('file:./_vendor/sales/packages/platform');
  });
});
