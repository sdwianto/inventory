/**
 * W1-2 slice 2: ENSURE_PUSH_CANCEL_SO — drain sync-only; recovery outside drain.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  INTEGRATION_OUTBOX_TYPES,
  insertEnsurePushCancelSoOutbox,
  drainEnsurePushCancelSo,
} from '@/lib/api/integration-outbox';

const notifySalesPoCancelled = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api/customer-po-cancel-sales', () => ({
  notifySalesPoCancelled: (...args: unknown[]) => notifySalesPoCancelled(...args),
}));

vi.mock('@/lib/api/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function createMockDb() {
  const outbox: Record<string, unknown>[] = [];
  const pos: Record<string, unknown>[] = [
    {
      id: 'po-1',
      tenantId: 'sppg',
      noPO: 'PO-1',
      status: 'CANCELLED',
      vendorTenantId: 'vendor-1',
    },
  ];
  return {
    outbox,
    collection(name: string) {
      if (name === 'customer_purchase_orders') {
        return {
          findOne: async (filter: { id: string }) =>
            pos.find((p) => p.id === filter.id) || null,
        };
      }
      if (name !== 'integration_outbox') {
        throw new Error(`unexpected ${name}`);
      }
      return {
        insertOne: async (doc: Record<string, unknown>) => {
          const dup = outbox.find(
            (d) => d.type === doc.type && d.aggregateId === doc.aggregateId,
          );
          if (dup) {
            const err = new Error('dup') as Error & { code: number };
            err.code = 11000;
            throw err;
          }
          outbox.push({ ...doc });
          return { insertedId: doc.id };
        },
        findOne: async (filter: Record<string, unknown>) =>
          outbox.find((d) => {
            if (filter.type && d.type !== filter.type) return false;
            if (filter.aggregateId && d.aggregateId !== filter.aggregateId) return false;
            if (filter.id && d.id !== filter.id) return false;
            return true;
          }) || null,
        findOneAndUpdate: async (
          filter: Record<string, unknown>,
          update: { $set?: Record<string, unknown>; $inc?: Record<string, number> },
        ) => {
          const idx = outbox.findIndex((d) => {
            if (d.type !== filter.type || d.aggregateId !== filter.aggregateId) return false;
            return d.status === 'PENDING' || d.status === 'FAILED';
          });
          if (idx < 0) return null;
          const next = {
            ...outbox[idx],
            ...(update.$set || {}),
            attempts: Number(outbox[idx].attempts || 0) + (update.$inc?.attempts || 0),
          };
          outbox[idx] = next;
          return next;
        },
        updateOne: async (
          filter: { id: string },
          update: { $set: Record<string, unknown> },
        ) => {
          const idx = outbox.findIndex((d) => d.id === filter.id);
          if (idx < 0) return { matchedCount: 0 };
          outbox[idx] = { ...outbox[idx], ...update.$set };
          return { matchedCount: 1 };
        },
      };
    },
  };
}

describe('W1-2 ENSURE_PUSH_CANCEL_SO', () => {
  beforeEach(() => {
    notifySalesPoCancelled.mockReset();
  });

  it('exports type', () => {
    expect(INTEGRATION_OUTBOX_TYPES.ENSURE_PUSH_CANCEL_SO).toBe('ENSURE_PUSH_CANCEL_SO');
  });

  it('drain marks DONE on notify success and does not enqueue', async () => {
    const db = createMockDb();
    await insertEnsurePushCancelSoOutbox(db as never, {
      tenantId: 'sppg',
      poId: 'po-1',
      reason: 'cancel',
    });
    notifySalesPoCancelled.mockResolvedValue({
      cancelled: [{ vendorTenantId: 'vendor-1' }],
      errors: [],
      correlationId: 'c1',
    });

    const src = readFileSync(join(process.cwd(), 'lib/api/integration-outbox.ts'), 'utf8');
    expect(src).not.toMatch(/enqueueAndKickCancelSoPushRecovery/);
    expect(src).not.toMatch(/enqueueJob/);

    const result = await drainEnsurePushCancelSo(db as never, {
      tenantId: 'sppg',
      poId: 'po-1',
      reason: 'cancel',
    });
    expect(result.ok).toBe(true);
    expect(db.outbox[0].status).toBe('DONE');
    expect(notifySalesPoCancelled).toHaveBeenCalledOnce();
  });

  it('drain marks FAILED when notify has errors (no enqueue)', async () => {
    const db = createMockDb();
    await insertEnsurePushCancelSoOutbox(db as never, {
      tenantId: 'sppg',
      poId: 'po-1',
    });
    notifySalesPoCancelled.mockResolvedValue({
      cancelled: [],
      errors: [{ vendorTenantId: 'vendor-1', error: 'sales down' }],
    });

    const result = await drainEnsurePushCancelSo(db as never, {
      tenantId: 'sppg',
      poId: 'po-1',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/sales down/);
    expect(db.outbox[0].status).toBe('FAILED');
  });

  it('static wiring: cancel TX insert + orchestrator; recovery job registered', () => {
    const handler = readFileSync(join(process.cwd(), 'lib/api/handlers/customer-po.ts'), 'utf8');
    const orch = readFileSync(join(process.cwd(), 'lib/api/cpo-cancel-push-integration.ts'), 'utf8');
    const worker = readFileSync(
      join(process.cwd(), 'lib/execution/workers/register-inventory.ts'),
      'utf8',
    );
    expect(handler).toMatch(/insertEnsurePushCancelSoOutbox/);
    expect(handler).toMatch(/orchestrateEnsurePushCancelSoAfterCommit/);
    expect(handler).not.toMatch(/notifySalesPoCancelled/);
    expect(orch).toMatch(/drainEnsurePushCancelSo/);
    expect(orch).toMatch(/enqueueAndKickCancelSoPushRecovery/);
    expect(worker).toMatch(/CANCEL_SO_PUSH_RECOVERY/);
  });
});
