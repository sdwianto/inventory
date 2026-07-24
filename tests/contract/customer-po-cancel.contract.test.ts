/**
 * Contract test P3: Cancel SO from customer PO via IntegrationClient.
 * @see sales/docs/architecture/INTEGRATION-CONTRACT-SPEC.md
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

describe('contract: CancelSalesOrderFromCustomerPo (customer-po/cancel)', () => {
  it('200 + minimum contract fields + Category A headers', async () => {
    const db = mockDb();
    const transport: IntegrationTransport = {
      request: async (req) => {
        expect(req.url).toContain('/api/v1/integrations/customer-po/cancel');
        expect(req.headers?.['Idempotency-Key']).toBe('cpo-cancel:po-1:vendor-a');
        expect(req.headers?.['X-Correlation-Id']).toBeTruthy();
        expect(req.pool).toBe('po');
        return jsonResponse(200, {
          action: 'cancelled',
          salesOrderId: 'so-1',
          noSO: 'SO2607000001',
          vendorTenantId: 'vendor-a',
        });
      },
    };

    const client = new IntegrationClient(db as never, transport);
    const result = await client.cancelSalesOrderFromCustomerPo({
      salesAppUrl: 'http://sales:3000',
      apiKey: 'sk_test',
      idempotencyKey: 'cpo-cancel:po-1:vendor-a',
      correlationId: 'corr-cancel-1',
      customerPoId: 'po-1',
      body: {
        customerTenantId: 'customer-a',
        vendorTenantId: 'vendor-a',
        noPO: 'PO-1',
        customerPoId: 'po-1',
        reason: 'Dibatalkan customer',
      },
    });

    expect(result.action).toBe('cancelled');
    expect(result.salesOrderId).toBe('so-1');
    expect(result.noSO).toBe('SO2607000001');
    expect(db.commands.some((c) => c.commandType === 'CancelSalesOrderFromPo' && c.status === 'SUCCEEDED')).toBe(true);
  });

  it('202 Pending → IntegrationError', async () => {
    const db = mockDb();
    const transport: IntegrationTransport = {
      request: async () => jsonResponse(202, { pending: true }),
    };
    const client = new IntegrationClient(db as never, transport);
    await expect(client.cancelSalesOrderFromCustomerPo({
      salesAppUrl: 'http://sales:3000',
      apiKey: 'sk_test',
      idempotencyKey: 'cpo-cancel:po-x:v',
      body: { customerTenantId: 'c', vendorTenantId: 'v', noPO: 'PO-X' },
    })).rejects.toBeInstanceOf(IntegrationError);
  });

  it('idempotent replay → same salesOrderId/action', async () => {
    const db = mockDb();
    const transport: IntegrationTransport = {
      request: async () => jsonResponse(200, {
        action: 'cancelled',
        salesOrderId: 'so-same',
        noSO: 'SO-SAME',
        vendorTenantId: 'vendor-a',
      }),
    };
    const client = new IntegrationClient(db as never, transport);
    const a = await client.cancelSalesOrderFromCustomerPo({
      salesAppUrl: 'http://sales:3000',
      apiKey: 'sk_test',
      idempotencyKey: 'cpo-cancel:po-same:vendor-a',
      body: { customerTenantId: 'c', vendorTenantId: 'vendor-a', noPO: 'PO-S' },
    });
    const b = await client.cancelSalesOrderFromCustomerPo({
      salesAppUrl: 'http://sales:3000',
      apiKey: 'sk_test',
      idempotencyKey: 'cpo-cancel:po-same:vendor-a',
      body: { customerTenantId: 'c', vendorTenantId: 'vendor-a', noPO: 'PO-S' },
    });
    expect(a.salesOrderId).toBe(b.salesOrderId);
    expect(a.action).toBe('cancelled');
    expect(b.action).toBe('cancelled');
  });
});

describe('contract: GetCustomerPoSalesOrderStatus (customer-po-status)', () => {
  it('200 + minimum fields via SDK (Category B pull)', async () => {
    const db = mockDb();
    const transport: IntegrationTransport = {
      request: async (req) => {
        expect(req.method).toBe('GET');
        expect(req.url).toContain('/api/v1/integrations/customer-po-status');
        expect(req.url).toContain('customerTenantId=customer-a');
        expect(req.headers?.['X-Correlation-Id']).toBeTruthy();
        expect(req.pool).toBe('po');
        return jsonResponse(200, {
          salesOrderId: 'so-2',
          noSO: 'SO2607000002',
          noPO: 'PO-2',
          status: 'DRAFT',
          customerPoId: 'po-2',
          customerTenantId: 'customer-a',
        });
      },
    };

    const client = new IntegrationClient(db as never, transport);
    const result = await client.getCustomerPoSalesOrderStatus({
      salesAppUrl: 'http://sales:3000',
      apiKey: 'sk_test',
      correlationId: 'corr-status-1',
      query: {
        customerTenantId: 'customer-a',
        customerPoId: 'po-2',
        vendorTenantId: 'vendor-a',
      },
    });

    expect(result.salesOrderId).toBe('so-2');
    expect(result.noSO).toBe('SO2607000002');
    expect(result.status).toBe('DRAFT');
    expect(db.commands.some((c) => c.commandType === 'GetCustomerPoSalesOrderStatus' && c.status === 'SUCCEEDED')).toBe(true);
  });
});
