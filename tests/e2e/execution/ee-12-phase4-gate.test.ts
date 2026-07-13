/**
 * EE-12 Phase 4 — Inventory semver consumer + pack install gate.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');

describe('EE-12 Phase 4 — Inventory registry consumer gate', () => {
  it('package.json pins @dawam/* via file:_vendor/sales', () => {
    const root = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    expect(root.dependencies['@dawam/contracts']).toBe('file:./_vendor/sales/packages/contracts');
    expect(root.dependencies['@dawam/platform']).toBe('file:./_vendor/sales/packages/platform');
    expect(root.scripts['ee12:install-platform']).toBeTruthy();
  });

  it('@dawam packages installed in node_modules', () => {
    expect(existsSync(resolve(ROOT, 'node_modules/@dawam/contracts/package.json'))).toBe(true);
    expect(existsSync(resolve(ROOT, 'node_modules/@dawam/platform/package.json'))).toBe(true);
    const platform = JSON.parse(readFileSync(resolve(ROOT, 'node_modules/@dawam/platform/package.json'), 'utf8'));
    expect(platform.version).toBe('1.0.0');
    expect(platform.dependencies['@dawam/contracts']).toBe('1.0.0');
  });

  it('tsconfig resolves node_modules @dawam paths', () => {
    const ts = JSON.parse(readFileSync(resolve(ROOT, 'tsconfig.json'), 'utf8'));
    expect(ts.compilerOptions.paths['@dawam/contracts'][0]).toContain('node_modules/@dawam/contracts');
    expect(ts.compilerOptions.paths['@dawam/platform'][0]).toContain('node_modules/@dawam/platform');
  });
});
