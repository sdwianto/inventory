/**
 * H3: integration_commands FAILED enrichment + durationMs + structured logs.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  finishIntegrationCommand,
  startIntegrationCommand,
} from '@/lib/integration/command-log';

function mockDb() {
  const rows: Record<string, unknown>[] = [];
  return {
    rows,
    collection(name: string) {
      if (name !== 'integration_commands') {
        return { insertOne: vi.fn(), updateOne: vi.fn(), findOne: vi.fn() };
      }
      return {
        insertOne: async (doc: Record<string, unknown>) => {
          rows.push(doc);
          return { insertedId: doc.id };
        },
        findOne: async (filter: { id: string }) => rows.find((r) => r.id === filter.id) || null,
        updateOne: async (filter: { id: string }, update: { $set: Record<string, unknown> }) => {
          const row = rows.find((r) => r.id === filter.id);
          if (row) Object.assign(row, update.$set);
          return { matchedCount: row ? 1 : 0 };
        },
      };
    },
  };
}

describe('H3 integration command-log', () => {
  it('FAILED stores errorMessage/errorClass/httpStatus + durationMs', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const db = mockDb();
    const id = await startIntegrationCommand(db as never, {
      correlationId: 'cid-1',
      commandType: 'CreateInvoiceFromGrn',
      grnId: 'grn-1',
    });

    await new Promise((r) => setTimeout(r, 5));
    const { durationMs } = await finishIntegrationCommand(db as never, id, {
      status: 'FAILED',
      errorCode: 'SERVICE_UNAVAILABLE',
      errorMessage: 'Sales unavailable',
      errorClass: 'server',
      httpStatus: 503,
    });

    const row = db.rows[0];
    expect(row.status).toBe('FAILED');
    expect(row.errorCode).toBe('SERVICE_UNAVAILABLE');
    expect(row.errorMessage).toBe('Sales unavailable');
    expect(row.errorClass).toBe('server');
    expect(row.httpStatus).toBe(503);
    expect(durationMs).toBeGreaterThanOrEqual(0);
    expect(row.durationMs).toBe(durationMs);

    const finishLog = info.mock.calls
      .map((c) => JSON.parse(String(c[0])))
      .find((o) => o.event === 'finish');
    expect(finishLog?.scope).toBe('integration_client');
    expect(finishLog?.correlationId).toBe('cid-1');
    expect(finishLog?.httpStatus).toBe(503);
    expect(finishLog?.durationMs).toBe(durationMs);
    info.mockRestore();
  });

  it('SUCCEEDED clears error fields', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const db = mockDb();
    const id = await startIntegrationCommand(db as never, {
      correlationId: 'cid-2',
      commandType: 'PullCatalog',
    });
    await finishIntegrationCommand(db as never, id, {
      status: 'SUCCEEDED',
      errorCode: 'should-ignore',
      errorMessage: 'nope',
    });
    expect(db.rows[0].status).toBe('SUCCEEDED');
    expect(db.rows[0].errorCode).toBeNull();
    expect(db.rows[0].errorMessage).toBeNull();
    expect(db.rows[0].errorClass).toBeNull();
    expect(db.rows[0].httpStatus).toBeNull();
    vi.restoreAllMocks();
  });
});
