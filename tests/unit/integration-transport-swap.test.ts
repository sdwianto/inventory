/**
 * Principal P4 exit proof: swap FakeTransport under IntegrationClient
 * without changing domain method contracts (CreateInvoice / CreateSO).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  FakeTransport,
  createIntegrationGateway,
  jsonTransportResponse,
  matchUrlContains,
} from '@sdwianto/integration';
import { createIntegrationClient } from '@/lib/integration/client';

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

describe('P4 transport swap (Inventory IntegrationClient)', () => {
  it('FakeTransport via Gateway: createInvoiceFromGrn unchanged', async () => {
    const fake = new FakeTransport([
      {
        match: matchUrlContains('/api/v1/integrations/grn-posted', 'POST'),
        response: jsonTransportResponse(200, {
          invoiceId: 'inv-1',
          invoiceNo: 'INV2607000001',
          amount: 1000,
          currency: 'IDR',
          status: 'POSTED',
          createdAt: '2026-07-24T00:00:00.000Z',
          noDO: 'DO1',
          vendorTenantId: 'uddawam',
        }),
      },
    ]);

    const client = createIntegrationClient(mockDb() as never, createIntegrationGateway(fake));
    const result = await client.createInvoiceFromGrn({
      salesAppUrl: 'http://sales:3000',
      apiKey: 'sk_test',
      idempotencyKey: 'grn-1',
      correlationId: 'corr-p4',
      grnId: 'grn-1',
      body: { grnId: 'grn-1', noGRN: 'GRN1', items: [] },
    });

    expect(result.invoiceId).toBe('inv-1');
    expect(result.noInvoice).toBe('INV2607000001');
    expect(fake.calls[0].pool).toBe('invoice');
  });

  it('FakeTransport: createSalesOrderFromCustomerPo unchanged', async () => {
    const fake = new FakeTransport([
      {
        match: matchUrlContains('/api/v1/integrations/customer-po', 'POST'),
        response: (req) => {
          expect(req.url).not.toContain('async=1');
          return jsonTransportResponse(200, {
            salesOrderId: 'so-1',
            noSO: 'SO2607000001',
            noPO: 'PO-1',
            status: 'DRAFT',
            vendorTenantId: 'uddawam',
            customerPoId: 'po-1',
            created: true,
          });
        },
      },
    ]);

    const client = createIntegrationClient(mockDb() as never, fake);
    const result = await client.createSalesOrderFromCustomerPo({
      salesAppUrl: 'http://sales:3000',
      apiKey: 'sk_test',
      idempotencyKey: 'cpo-push:po-1:uddawam',
      body: {
        customerTenantId: 'sppg',
        vendorTenantId: 'uddawam',
        noPO: 'PO-1',
        customerPoId: 'po-1',
        items: [],
      },
    });

    expect(result.salesOrderId).toBe('so-1');
    expect(result.noSO).toBe('SO2607000001');
  });
});
