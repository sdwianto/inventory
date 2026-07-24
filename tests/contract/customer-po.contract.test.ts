/**
 * Contract test P1: CreateSO from customer PO via IntegrationClient + Transport.
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

describe('contract: CreateSalesOrderFromCustomerPo (customer-po)', () => {
  it('200 + minimum contract fields + Category A headers', async () => {
    const db = mockDb();
    const transport: IntegrationTransport = {
      request: async (req) => {
        expect(req.url).toContain('/api/v1/integrations/customer-po');
        expect(req.url).not.toContain('async=1');
        expect(req.headers?.['Idempotency-Key']).toBe('cpo-push:po-1:vendor-a');
        expect(req.headers?.['X-Correlation-Id']).toBeTruthy();
        expect(req.pool).toBe('po');
        return jsonResponse(200, {
          salesOrderId: 'so-1',
          noSO: 'SO2607000001',
          noPO: 'PO-1',
          status: 'DRAFT',
          vendorTenantId: 'vendor-a',
          customerPoId: 'po-1',
          created: true,
        });
      },
    };

    const client = new IntegrationClient(db as never, transport);
    const result = await client.createSalesOrderFromCustomerPo({
      salesAppUrl: 'http://sales:3000',
      apiKey: 'sk_test',
      idempotencyKey: 'cpo-push:po-1:vendor-a',
      correlationId: 'corr-po-1',
      customerPoId: 'po-1',
      body: {
        customerTenantId: 'customer-a',
        vendorTenantId: 'vendor-a',
        noPO: 'PO-1',
        customerPoId: 'po-1',
        items: [],
      },
    });

    expect(result.salesOrderId).toBe('so-1');
    expect(result.noSO).toBe('SO2607000001');
    expect(result.noPO).toBe('PO-1');
    expect(result.status).toBe('DRAFT');
    expect(db.commands.some((c) => c.commandType === 'CreateSalesOrderFromPo' && c.status === 'SUCCEEDED')).toBe(true);
  });

  it('idempotent replay → same salesOrderId', async () => {
    const db = mockDb();
    const transport: IntegrationTransport = {
      request: async () => jsonResponse(200, {
        salesOrderId: 'so-same',
        noSO: 'SO-SAME',
        noPO: 'PO-2',
        status: 'DRAFT',
        vendorTenantId: 'vendor-a',
        customerPoId: 'po-2',
        existing: true,
      }),
    };
    const client = new IntegrationClient(db as never, transport);
    const a = await client.createSalesOrderFromCustomerPo({
      salesAppUrl: 'http://sales:3000',
      apiKey: 'sk_test',
      idempotencyKey: 'cpo-push:po-2:vendor-a',
      body: { customerTenantId: 'c', vendorTenantId: 'vendor-a', noPO: 'PO-2', customerPoId: 'po-2' },
    });
    const b = await client.createSalesOrderFromCustomerPo({
      salesAppUrl: 'http://sales:3000',
      apiKey: 'sk_test',
      idempotencyKey: 'cpo-push:po-2:vendor-a',
      body: { customerTenantId: 'c', vendorTenantId: 'vendor-a', noPO: 'PO-2', customerPoId: 'po-2' },
    });
    expect(a.salesOrderId).toBe(b.salesOrderId);
  });

  it('rejects 202 Pending happy path', async () => {
    const db = mockDb();
    const transport: IntegrationTransport = {
      request: async () => jsonResponse(202, { jobId: 'job-x', async: true, status: 'PENDING' }),
    };
    const client = new IntegrationClient(db as never, transport);
    await expect(client.createSalesOrderFromCustomerPo({
      salesAppUrl: 'http://sales:3000',
      apiKey: 'sk_test',
      idempotencyKey: 'cpo-push:po-3:vendor-a',
      body: { customerTenantId: 'c', vendorTenantId: 'vendor-a', noPO: 'PO-3', customerPoId: 'po-3' },
    })).rejects.toBeInstanceOf(IntegrationError);
  });
});
