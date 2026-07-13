/**
 * EE-14 Phase 1 — Inventory consumes @sdwianto/events from Sales vendor.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { publishJobEnqueuedEvent, setExecutionEventBus } from '@sdwianto/events';
import { buildJobDocument } from '@/lib/execution/queue/enqueue';

const ROOT = resolve(import.meta.dirname, '../../..');

describe('EE-14 Phase 1 — Inventory events consumer gate', () => {
  it('package.json depends on @sdwianto/events via _vendor', () => {
    const root = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    expect(root.dependencies['@sdwianto/events']).toBe('file:./_vendor/sales/packages/events');
    expect(root.scripts['test:execution:ee14']).toBeTruthy();
  });

  it('@sdwianto/events installed from vendor', () => {
    const nm = resolve(ROOT, 'node_modules/@sdwianto/events/package.json');
    const vendor = resolve(ROOT, '_vendor/sales/packages/events/package.json');
    const path = existsSync(nm) ? nm : vendor;
    expect(existsSync(path)).toBe(true);
    const pkg = JSON.parse(readFileSync(path, 'utf8'));
    expect(pkg.name).toBe('@sdwianto/events');
    expect(pkg.version).toBe('1.0.1');
  });

  it('lib/execution/events/publisher re-exports @sdwianto/events', () => {
    const publisher = readFileSync(resolve(ROOT, 'lib/execution/events/publisher.ts'), 'utf8');
    expect(publisher).toContain('@sdwianto/events');
    expect(publisher).not.toContain('@sdwianto/platform/events/publisher');
  });

  it('typecheck consumer tsconfig for events exists', () => {
    expect(existsSync(resolve(ROOT, 'scripts/ci/tsconfig.sdwianto-events.json'))).toBe(true);
  });

  it('@sdwianto/events runtime smoke', async () => {
    const published: unknown[] = [];
    setExecutionEventBus({
      async publish(_channel, payload) {
        published.push(payload);
      },
    });
    await publishJobEnqueuedEvent(
      buildJobDocument({
        type: 'WEBHOOK_DELIVERY',
        domain: 'integration',
        tenantId: 't1',
        payload: {},
      }),
    );
    expect(published).toHaveLength(1);
    setExecutionEventBus(null);
  });
});
