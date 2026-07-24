import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { withCircuitBreaker, resetCircuitBreakers, getCircuitState } from '@/lib/integration/circuit-breaker';
import { withBulkhead, resetBulkheads, bulkheadInFlight } from '@/lib/integration/bulkhead';
import { HttpTransport } from '@/lib/integration/transport/http';
import { IntegrationError } from '@/lib/integration/errors';

describe('integration transport primitives', () => {
  beforeEach(() => {
    resetCircuitBreakers();
    resetBulkheads();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens circuit after failure threshold', async () => {
    const name = 'sales:invoice-test';
    for (let i = 0; i < 5; i++) {
      await expect(withCircuitBreaker(name, async () => {
        throw new Error('down');
      })).rejects.toThrow('down');
    }
    expect(getCircuitState(name)).toBe('OPEN');
    await expect(withCircuitBreaker(name, async () => 'ok')).rejects.toThrow(/Circuit breaker OPEN/);
  });

  it('bulkhead saturates invoice pool separately', async () => {
    const blockers: Promise<void>[] = [];
    const release: Array<() => void> = [];
    for (let i = 0; i < 8; i++) {
      blockers.push(withBulkhead('invoice', () => new Promise<void>((r) => {
        release.push(r);
      })));
    }
    expect(bulkheadInFlight('invoice')).toBe(8);
    await expect(withBulkhead('invoice', async () => 'x')).rejects.toThrow(/Bulkhead saturated/);
    // Catalog pool still free.
    await expect(withBulkhead('catalog', async () => 'ok')).resolves.toBe('ok');
    release.forEach((r) => r());
    await Promise.all(blockers);
  });

  it('HttpTransport trips CB on HTTP 5xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'down' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    })));
    const transport = new HttpTransport();
    for (let i = 0; i < 5; i++) {
      await expect(transport.request({
        method: 'POST',
        url: 'http://sales.test/api/v1/integrations/grn-posted',
        pool: 'invoice',
        maxAttempts: 1,
        timeoutMs: 1000,
      })).rejects.toBeInstanceOf(IntegrationError);
    }
    expect(getCircuitState('sales:invoice')).toBe('OPEN');
  });
});
