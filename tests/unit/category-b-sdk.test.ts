/**
 * H2: Category B pull methods go through IntegrationClient (/api/v1/integrations/…).
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

describe('H2 Category B IntegrationClient', () => {
  it('lookupDeliveryFromSales uses /api/v1/integrations/delivery-lookup', async () => {
    const fake = new FakeTransport([
      {
        match: matchUrlContains('/api/v1/integrations/delivery-lookup', 'GET'),
        response: jsonTransportResponse(200, { deliveryId: 'd1', noDO: 'DO1' }),
      },
    ]);
    const client = createIntegrationClient(mockDb() as never, createIntegrationGateway(fake));
    const data = await client.lookupDeliveryFromSales({
      salesAppUrl: 'http://sales:3000',
      apiKey: 'sk',
      correlationId: 'c1',
      query: { customerTenantId: 'sppg', noDO: 'DO1' },
    });
    expect(data.noDO).toBe('DO1');
    expect(fake.calls[0].headers['X-Api-Key']).toBe('sk');
    expect(fake.calls[0].headers['X-Correlation-Id']).toBe('c1');
    expect(fake.calls[0].headers['Idempotency-Key']).toBeUndefined();
  });

  it('pullPostedInvoicesPage uses customer-invoices', async () => {
    const fake = new FakeTransport([
      {
        match: matchUrlContains('/api/v1/integrations/customer-invoices', 'GET'),
        response: jsonTransportResponse(200, { invoices: [], hasMore: false }),
      },
    ]);
    const client = createIntegrationClient(mockDb() as never, fake);
    const data = await client.pullPostedInvoicesPage({
      salesAppUrl: 'http://sales:3000',
      apiKey: 'sk',
      query: { customerTenantId: 'sppg' },
    });
    expect(data.hasMore).toBe(false);
    expect(fake.calls[0].pool).toBe('invoice');
  });

  it('listCustomerShipments uses customer-shipments', async () => {
    const fake = new FakeTransport([
      {
        match: matchUrlContains('/api/v1/integrations/customer-shipments', 'GET'),
        response: jsonTransportResponse(200, { deliveries: [] }),
      },
    ]);
    const client = createIntegrationClient(mockDb() as never, fake);
    await client.listCustomerShipments({
      salesAppUrl: 'http://sales:3000',
      apiKey: 'sk',
      query: { customerTenantId: 'sppg', vendorTenantId: 'uddawam' },
    });
    expect(fake.calls[0].url).toContain('vendorTenantId=uddawam');
  });

  it('pullCatalogPage uses catalog pool + allTenants', async () => {
    const fake = new FakeTransport([
      {
        match: matchUrlContains('/api/v1/integrations/catalog', 'GET'),
        response: jsonTransportResponse(200, { products: [], count: 0 }),
      },
    ]);
    const client = createIntegrationClient(mockDb() as never, fake);
    await client.pullCatalogPage({
      salesAppUrl: 'http://sales:3000',
      apiKey: 'sk',
      query: { limit: 1 },
    });
    expect(fake.calls[0].url).toContain('allTenants=true');
    expect(fake.calls[0].pool).toBe('catalog');
  });

  it('getCustomerProfile + getVendorProfile (store fallback on 404)', async () => {
    const fake = new FakeTransport([
      {
        match: matchUrlContains('/api/v1/integrations/customer-profile', 'GET'),
        response: jsonTransportResponse(200, { vendors: [{ vendorTenantId: 'v1', tierHargaDefault: 'GROSIR' }] }),
      },
      {
        match: matchUrlContains('/api/v1/integrations/vendor-profile', 'GET'),
        response: jsonTransportResponse(404, { error: 'not found' }),
      },
      {
        match: matchUrlContains('/api/v1/integrations/vendor-store', 'GET'),
        response: jsonTransportResponse(200, { store: { companyName: 'Toko A' } }),
      },
    ]);
    const client = createIntegrationClient(mockDb() as never, fake);
    const profile = await client.getCustomerProfile({
      salesAppUrl: 'http://sales:3000',
      apiKey: 'sk',
      customerTenantId: 'sppg',
    });
    expect((profile.vendors as unknown[]).length).toBe(1);

    const vendor = await client.getVendorProfile({
      salesAppUrl: 'http://sales:3000',
      apiKey: 'sk',
      vendorTenantId: 'uddawam',
    });
    expect((vendor.store as { companyName: string }).companyName).toBe('Toko A');
    expect(fake.calls.map((c) => c.url).some((u) => u.includes('vendor-store'))).toBe(true);
  });
});
