/**
 * Contract test: CreateCreditNote from RTV via IntegrationClient.
 * @see sales/docs/architecture/INTEGRATION-CONTRACT-SPEC.md v9
 */
import { describe, expect, it, vi } from 'vitest';
import { IntegrationClient } from '@/lib/integration/client';
import type { IntegrationTransport, TransportResponse } from '@/lib/integration/transport/types';
import { IntegrationError } from '@/lib/integration/errors';

function mockDb() {
  const commands: Record<string, unknown>[] = [];
  return {
    commands,
    collection(name: string) {
      if (name !== 'integration_commands') {
        return { insertOne: vi.fn(), updateOne: vi.fn(), findOne: vi.fn() };
      }
      return {
        insertOne: async (doc: Record<string, unknown>) => {
          commands.push(doc);
          return { insertedId: doc.id };
        },
        updateOne: async (filter: { id: string }, update: { $set: Record<string, unknown> }) => {
          const row = commands.find((c) => c.id === filter.id);
          if (row) Object.assign(row, update.$set);
          return { matchedCount: row ? 1 : 0 };
        },
        findOne: async (filter: { id: string }) => commands.find((c) => c.id === filter.id) || null,
      };
    },
  };
}

function jsonResponse(status: number, body: Record<string, unknown>): TransportResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('contract: CreateCreditNoteFromGoodsReturn (goods-return-posted)', () => {
  it('200 + minimum contract fields', async () => {
    const db = mockDb();
    const transport: IntegrationTransport = {
      request: async (req) => {
        expect(req.url).toContain('/api/v1/integrations/goods-return-posted');
        expect(req.headers?.['Idempotency-Key']).toBe('rtv-1');
        expect(req.headers?.['X-Correlation-Id']).toBeTruthy();
        return jsonResponse(200, {
          creditNoteId: 'cn-1',
          noCN: 'CN2608000001',
          amount: 370000,
          currency: 'IDR',
          status: 'POSTED',
          invoiceId: 'inv-1',
          noInvoice: 'INV-001',
          created: true,
          posted: true,
        });
      },
    };
    const client = new IntegrationClient(db as never, transport);
    const result = await client.postGoodsReturnPosted({
      salesAppUrl: 'http://sales:3000',
      apiKey: 'sk_test',
      idempotencyKey: 'rtv-1',
      correlationId: 'corr-1',
      body: { returnId: 'rtv-1', noInvoice: 'INV-001' },
      returnId: 'rtv-1',
    });
    expect(result.creditNoteId).toBe('cn-1');
    expect(result.noCN).toBe('CN2608000001');
    expect(result.amount).toBe(370000);
    expect(result.status).toBe('POSTED');
    expect(db.commands.some((c) => c.status === 'SUCCEEDED')).toBe(true);
  });

  it('idempotent replay → same creditNoteId', async () => {
    const db = mockDb();
    const transport: IntegrationTransport = {
      request: async () => jsonResponse(200, {
        creditNoteId: 'cn-same',
        noCN: 'CN-SAME',
        amount: 500,
        currency: 'IDR',
        status: 'POSTED',
        invoiceId: 'inv-2',
        noInvoice: 'INV-2',
      }),
    };
    const client = new IntegrationClient(db as never, transport);
    const a = await client.postGoodsReturnPosted({
      salesAppUrl: 'http://sales:3000',
      apiKey: 'sk_test',
      idempotencyKey: 'rtv-2',
      body: { returnId: 'rtv-2' },
    });
    const b = await client.postGoodsReturnPosted({
      salesAppUrl: 'http://sales:3000',
      apiKey: 'sk_test',
      idempotencyKey: 'rtv-2',
      body: { returnId: 'rtv-2' },
    });
    expect(a.creditNoteId).toBe(b.creditNoteId);
  });

  it('rejects 202 Pending happy path', async () => {
    const db = mockDb();
    const transport: IntegrationTransport = {
      request: async () => jsonResponse(202, { jobId: 'job-x', async: true, status: 'PENDING' }),
    };
    const client = new IntegrationClient(db as never, transport);
    await expect(client.postGoodsReturnPosted({
      salesAppUrl: 'http://sales:3000',
      apiKey: 'sk_test',
      idempotencyKey: 'rtv-4',
      body: { returnId: 'rtv-4' },
    })).rejects.toBeInstanceOf(IntegrationError);
  });

  it('400 surfaces IntegrationError errorClass=validation (non-retryable)', async () => {
    const db = mockDb();
    const transport: IntegrationTransport = {
      request: async () => jsonResponse(400, { error: 'returnId wajib', code: 'VALIDATION' }),
    };
    const client = new IntegrationClient(db as never, transport);
    try {
      await client.postGoodsReturnPosted({
        salesAppUrl: 'http://sales:3000',
        apiKey: 'sk_test',
        idempotencyKey: 'rtv-val',
        body: { returnId: '' },
      });
      expect.fail('expected IntegrationError');
    } catch (e) {
      expect(e).toBeInstanceOf(IntegrationError);
      expect((e as IntegrationError).errorClass).toBe('validation');
      expect((e as IntegrationError).retryable).toBe(false);
    }
  });

  it('503 surfaces IntegrationError errorClass=server (retryable)', async () => {
    const db = mockDb();
    const transport: IntegrationTransport = {
      request: async () => jsonResponse(503, { error: 'unavailable' }),
    };
    const client = new IntegrationClient(db as never, transport);
    try {
      await client.postGoodsReturnPosted({
        salesAppUrl: 'http://sales:3000',
        apiKey: 'sk_test',
        idempotencyKey: 'rtv-503',
        body: { returnId: 'rtv-503' },
      });
      expect.fail('expected IntegrationError');
    } catch (e) {
      expect(e).toBeInstanceOf(IntegrationError);
      expect((e as IntegrationError).errorClass).toBe('server');
      expect((e as IntegrationError).retryable).toBe(true);
    }
  });
});
