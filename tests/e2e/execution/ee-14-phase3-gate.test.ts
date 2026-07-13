/**
 * EE-14 Phase 3 — Inventory consumer outbox gate (static checks).
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');

function platformSrcPath(): string {
  const nm = resolve(ROOT, 'node_modules/@sdwianto/platform/src/events/execution-outbox.ts');
  const vendor = resolve(ROOT, '_vendor/sales/packages/platform/src/events/execution-outbox.ts');
  return existsSync(nm) ? nm : vendor;
}

describe('EE-14 Phase 3 — Inventory outbox consumer gate', () => {
  it('vendor platform includes execution outbox module', () => {
    const path = platformSrcPath();
    expect(existsSync(path)).toBe(true);
    const src = readFileSync(path, 'utf8');
    expect(src).toContain('drainExecutionOutbox');
    expect(src).toContain('writeAuditAndOutboxEntry');
    expect(src).toContain('executionEventDeliveryLagSeconds');
  });

  it('test:execution:ee14 includes Phase 3 gate', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['test:execution:ee14']).toContain('ee-14-phase3-gate.test.ts');
  });
});
