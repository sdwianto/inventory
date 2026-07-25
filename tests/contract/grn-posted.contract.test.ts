/**
 * Contract test P0: CreateInvoice from GRN via IntegrationClient + Transport.
 * @see docs/architecture/INTEGRATION-CONTRACT-SPEC.md (Sales companion)
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
        return {
          insertOne: vi.fn(),
          updateOne: vi.fn(),
          findOne: vi.fn(),
        };
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

describe('contract: CreateInvoiceFromGrn (grn-posted)', () => {
  it('200 + minimum contract fields', async () => {
    const db = mockDb();
    const transport: IntegrationTransport = {
      request: async (req) => {
        expect(req.url).toContain('/api/v1/integrations/grn-posted');
        expect(req.url).not.toContain('async=1');
        expect(req.headers?.['Idempotency-Key']).toBe('grn-1');
        expect(req.headers?.['X-Correlation-Id']).toBeTruthy();
        expect(req.pool).toBe('invoice');
        return jsonResponse(200, {
          invoiceId: 'inv-1',
          invoiceNo: 'INV-001',
          noInvoice: 'INV-001',
          amount: 1000,
          currency: 'IDR',
          status: 'POSTED',
          createdAt: '2026-07-24T00:00:00.000Z',
          noDO: 'DO-1',
          vendorTenantId: 'vendor-a',
        });
      },
    };

    const client = new IntegrationClient(db as never, transport);
    const result = await client.createInvoiceFromGrn({
      salesAppUrl: 'http://sales:3000',
      apiKey: 'sk_test',
      idempotencyKey: 'grn-1',
      correlationId: 'corr-1',
      body: { grnId: 'grn-1', noDO: 'DO-1' },
      grnId: 'grn-1',
    });

    expect(result.invoiceId).toBe('inv-1');
    expect(result.invoiceNo).toBe('INV-001');
    expect(result.amount).toBe(1000);
    expect(result.currency).toBe('IDR');
    expect(result.status).toBe('POSTED');
    expect(db.commands.some((c) => c.status === 'SUCCEEDED')).toBe(true);
  });

  it('idempotent replay → same invoiceId', async () => {
    const db = mockDb();
    const transport: IntegrationTransport = {
      request: async () => jsonResponse(200, {
        invoiceId: 'inv-same',
        invoiceNo: 'INV-SAME',
        amount: 500,
        currency: 'IDR',
        status: 'POSTED',
        createdAt: '2026-07-24T00:00:00.000Z',
        noDO: 'DO-2',
        vendorTenantId: 'vendor-a',
      }),
    };
    const client = new IntegrationClient(db as never, transport);
    const a = await client.createInvoiceFromGrn({
      salesAppUrl: 'http://sales:3000',
      apiKey: 'sk_test',
      idempotencyKey: 'grn-2',
      body: { grnId: 'grn-2' },
    });
    const b = await client.createInvoiceFromGrn({
      salesAppUrl: 'http://sales:3000',
      apiKey: 'sk_test',
      idempotencyKey: 'grn-2',
      body: { grnId: 'grn-2' },
    });
    expect(a.invoiceId).toBe(b.invoiceId);
  });

  it('push-side failure still 200 + invoice fields', async () => {
    const db = mockDb();
    const transport: IntegrationTransport = {
      request: async () => jsonResponse(200, {
        invoiceId: 'inv-3',
        invoiceNo: 'INV-003',
        amount: 200,
        currency: 'IDR',
        status: 'POSTED',
        createdAt: '2026-07-24T00:00:00.000Z',
        noDO: 'DO-3',
        vendorTenantId: 'vendor-a',
        hutangPushed: false,
        hutangPushError: 'inventory timeout',
      }),
    };
    const client = new IntegrationClient(db as never, transport);
    const result = await client.createInvoiceFromGrn({
      salesAppUrl: 'http://sales:3000',
      apiKey: 'sk_test',
      idempotencyKey: 'grn-3',
      body: { grnId: 'grn-3' },
    });
    expect(result.invoiceId).toBe('inv-3');
    expect(result.hutangPushed).toBe(false);
  });

  it('rejects 202 Pending happy path', async () => {
    const db = mockDb();
    const transport: IntegrationTransport = {
      request: async () => jsonResponse(202, { jobId: 'job-x', async: true, status: 'PENDING' }),
    };
    const client = new IntegrationClient(db as never, transport);
    await expect(client.createInvoiceFromGrn({
      salesAppUrl: 'http://sales:3000',
      apiKey: 'sk_test',
      idempotencyKey: 'grn-4',
      body: { grnId: 'grn-4' },
    })).rejects.toBeInstanceOf(IntegrationError);
  });

  it('400 surfaces IntegrationError errorClass=validation (non-retryable)', async () => {
    const db = mockDb();
    const transport: IntegrationTransport = {
      request: async () => jsonResponse(400, { error: 'grnId wajib' }),
    };
    const client = new IntegrationClient(db as never, transport);
    try {
      await client.createInvoiceFromGrn({
        salesAppUrl: 'http://sales:3000',
        apiKey: 'sk_test',
        idempotencyKey: 'grn-val',
        body: { grnId: 'grn-bad' },
      });
      expect.fail('expected IntegrationError');
    } catch (e) {
      expect(e).toBeInstanceOf(IntegrationError);
      const err = e as IntegrationError;
      expect(err.errorClass).toBe('validation');
      expect(err.retryable).toBe(false);
    }
  });

  it('503 surfaces IntegrationError errorClass=server (retryable)', async () => {
    const db = mockDb();
    const transport: IntegrationTransport = {
      request: async () => jsonResponse(503, { error: 'unavailable' }),
    };
    const client = new IntegrationClient(db as never, transport);
    try {
      await client.createInvoiceFromGrn({
        salesAppUrl: 'http://sales:3000',
        apiKey: 'sk_test',
        idempotencyKey: 'grn-503',
        body: { grnId: 'grn-503' },
      });
      expect.fail('expected IntegrationError');
    } catch (e) {
      expect(e).toBeInstanceOf(IntegrationError);
      const err = e as IntegrationError;
      expect(err.errorClass).toBe('server');
      expect(err.retryable).toBe(true);
    }
  });
});
