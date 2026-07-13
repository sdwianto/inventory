/**
 * EE-14 Phase 2 — Inventory registry consumer gate (static checks).
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');

describe('EE-14 Phase 2 — Inventory registry consumer gate', () => {
  it('registry smoke runs EE-14 gate after registry install', () => {
    const smoke = readFileSync(resolve(ROOT, 'scripts/ee13-registry-smoke.mjs'), 'utf8');
    expect(smoke).toContain('test:execution:ee14');
    expect(smoke).toContain('typecheck:packages');
    expect(smoke).toContain('restoring local _vendor');
  });

  it('ee12-install pins events + platform versions for registry path', () => {
    const script = readFileSync(resolve(ROOT, 'scripts/ee12-install-platform.mjs'), 'utf8');
    expect(script).toContain("const EVENTS_VERSION = '1.0.0'");
    expect(script).toContain("const PLATFORM_VERSION = '1.0.2'");
    expect(script).toContain('@sdwianto/events@${EVENTS_VERSION}');
    expect(script).toContain('@sdwianto/platform@${PLATFORM_VERSION}');
  });

  it('@sdwianto/events vendor package is 1.0.0', () => {
    const vendor = resolve(ROOT, '_vendor/sales/packages/events/package.json');
    const nm = resolve(ROOT, 'node_modules/@sdwianto/events/package.json');
    const path = existsSync(nm) ? nm : vendor;
    expect(existsSync(path)).toBe(true);
    const pkg = JSON.parse(readFileSync(path, 'utf8'));
    expect(pkg.name).toBe('@sdwianto/events');
    expect(pkg.version).toBe('1.0.0');
  });

  it('platform vendor package is 1.0.2 with events dependency', () => {
    const vendor = resolve(ROOT, '_vendor/sales/packages/platform/package.json');
    const nm = resolve(ROOT, 'node_modules/@sdwianto/platform/package.json');
    const path = existsSync(nm) ? nm : vendor;
    expect(existsSync(path)).toBe(true);
    const pkg = JSON.parse(readFileSync(path, 'utf8'));
    expect(pkg.version).toBe('1.0.2');
    expect(pkg.dependencies['@sdwianto/events']).toBe('1.0.0');
  });

  it('ee13 registry gate documents platform 1.0.2 consumer path', () => {
    const gate = readFileSync(resolve(ROOT, 'tests/e2e/execution/ee-13-registry-gate.test.ts'), 'utf8');
    expect(gate).toContain('packages/events');
    expect(gate).toContain("const PLATFORM_VERSION = '1.0.2'");
  });
});
