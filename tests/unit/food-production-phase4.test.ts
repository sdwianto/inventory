import { describe, expect, it } from 'vitest';
import { FP_DOC_PREFIX, FP_DOC_TYPES } from '@/lib/food-production/document';
import {
  assertKitchenHubLink,
  normalizeKitchenKode,
  normalizeKitchenType,
} from '@/lib/food-production/kitchen';
import {
  assertKitchenTransferPair,
  normalizeXferLines,
  summarizeXferLines,
} from '@/lib/food-production/kitchen-transfer';
import {
  buildProductionCalendar,
  eachIsoDate,
} from '@/lib/food-production/production-calendar';
import {
  buildBatchNo,
  defaultExpiryDate,
  daysUntilExpiry,
  isExpired,
} from '@/lib/food-production/production-batch';
import { resolveKitchenIdFilter } from '@/lib/food-production/kitchen-scope';
import { requireApiScope } from '@/lib/api/require-scope';
import { requireRole, rejectApiKey } from '@/lib/api/require-auth';
import { resolveOperationalScope } from '@/lib/api/tenant-master';
import { apiKeyRouteDenied, dispatchRoute } from '@/lib/api/route-dispatch';
import { hashApiKey, generateApiKey } from '@/lib/api/api-key';
import type { AuthContext } from '@/types/auth';
import type { HandlerContext } from '@/types/api/handler';

describe('food-production phase 4', () => {
  it('registers XFR doc prefix for kitchen transfer', () => {
    expect(FP_DOC_PREFIX[FP_DOC_TYPES.KITCHEN_TRANSFER]).toBe('XFR');
  });

  it('normalizes kitchen kode/type and hub link rules', () => {
    expect(normalizeKitchenType('central')).toBe('CENTRAL');
    expect(normalizeKitchenType('x')).toBe('SATELLITE');
    expect(normalizeKitchenKode(' ck jkt ')).toBe('CK-JKT');
    expect(assertKitchenHubLink({ kitchenType: 'CENTRAL', centralKitchenId: 'c1' })).toMatch(/tidak boleh/);
    expect(assertKitchenHubLink({
      kitchenType: 'SATELLITE',
      kitchenId: 's1',
      centralKitchenId: 's1',
    })).toMatch(/dirinya/);
    expect(assertKitchenHubLink({
      kitchenType: 'SATELLITE',
      kitchenId: 's1',
      centralKitchenId: 'c1',
    })).toBeNull();
  });

  it('kitchen transfer: same warehouse = allocation-only; rejects same kitchen', () => {
    expect(assertKitchenTransferPair({
      fromKitchenId: 'a',
      toKitchenId: 'a',
      fromWarehouseKode: 'GKERING',
      toWarehouseKode: 'GKERING',
    })).toEqual({ error: 'Dapur asal dan tujuan tidak boleh sama' });

    const sameWh = assertKitchenTransferPair({
      fromKitchenId: 'a',
      toKitchenId: 'b',
      fromWarehouseKode: 'GKERING',
      toWarehouseKode: 'GKERING',
    });
    expect(sameWh).toEqual({ allocationOnly: true });

    const diffWh = assertKitchenTransferPair({
      fromKitchenId: 'a',
      toKitchenId: 'b',
      fromWarehouseKode: 'GKERING',
      toWarehouseKode: 'GBASAH',
    });
    expect(diffWh).toEqual({ allocationOnly: false });
  });

  it('normalizes transfer lines and summarizes qty', () => {
    const lines = normalizeXferLines([
      { productId: 'p1', qty: 2.5 },
      { productId: 'p2', qty: 1 },
    ]);
    expect('error' in (lines as object)).toBe(false);
    if ('error' in (lines as object)) return;
    expect(summarizeXferLines(lines).qtyTotal).toBe(3.5);
    expect(normalizeXferLines([{ productId: 'p1', qty: 0 }])).toMatchObject({ error: expect.any(String) });
  });

  it('builds production calendar day cells', () => {
    const dates = eachIsoDate('2026-07-14', '2026-07-15');
    expect(dates).toEqual(['2026-07-14', '2026-07-15']);

    const cal = buildProductionCalendar({
      from: '2026-07-14',
      to: '2026-07-15',
      kitchenId: 'k1',
      plans: [
        {
          id: '1',
          noDokumen: 'RPN-1',
          tanggal: '2026-07-14',
          kitchenId: 'k1',
          status: 'APPROVED',
          totalTargetPorsi: 100,
        },
        {
          id: '2',
          noDokumen: 'RPN-2',
          tanggal: '2026-07-14',
          kitchenId: 'k2',
          status: 'DRAFT',
          totalTargetPorsi: 50,
        },
      ],
    });
    expect('error' in (cal as object)).toBe(false);
    if ('error' in (cal as object)) return;
    expect(cal.summary.planCount).toBe(1);
    expect(cal.days[0].totalTargetPorsi).toBe(100);
    expect(cal.days[1].planCount).toBe(0);
  });

  it('builds batch numbers and expiry helpers', () => {
    expect(buildBatchNo({
      tanggal: '2026-07-15',
      resultNo: 'HSL-20260715-001',
      kitchenKode: 'CK',
    })).toBe('B-CK-20260715-001');
    expect(defaultExpiryDate('2026-07-15', 3)).toBe('2026-07-18');
    expect(isExpired('2026-07-14', new Date('2026-07-15T12:00:00.000Z'))).toBe(true);
    expect(daysUntilExpiry('2026-07-18', new Date('2026-07-15T12:00:00.000Z'))).toBe(3);
  });

  it('resolves kitchen filter from query then header', () => {
    const url = new URL('http://x/api/x?kitchenId=from-q');
    const req = new Request('http://x/api/x', {
      headers: { 'x-acting-kitchen-id': 'from-h' },
    });
    expect(resolveKitchenIdFilter(url, req)).toBe('from-q');
    expect(resolveKitchenIdFilter(new URL('http://x/api/x'), req)).toBe('from-h');
  });

  it('api key hash is stable; requireApiScope gates keyed clients', () => {
    const raw = generateApiKey();
    expect(raw.startsWith('sk_')).toBe(true);
    expect(hashApiKey(raw)).toBe(hashApiKey(raw));
    expect(hashApiKey(raw)).not.toBe(hashApiKey(`${raw}x`));

    const keyedOk: AuthContext = {
      userId: 'apikey:1',
      email: 'i@api',
      name: 'API',
      role: 'INTEGRATION',
      tenantId: 't1',
      isMaster: false,
      isApiKey: true,
      scopes: ['food-production:read'],
    };
    expect(requireApiScope(keyedOk, 'food-production:read')).toBeNull();
    expect(rejectApiKey(keyedOk)?.status).toBe(403);
    expect(requireRole(keyedOk, ['ADMIN', 'OWNER'])?.status).toBe(403);

    const keyedBad = { ...keyedOk, scopes: ['integrations'] };
    expect(requireApiScope(keyedBad, 'food-production:read')?.status).toBe(403);

    const session: AuthContext = {
      userId: 'u1',
      email: 'a@x',
      name: 'Admin',
      role: 'ADMIN',
      tenantId: 't1',
      isMaster: false,
      isApiKey: false,
    };
    expect(requireApiScope(session, 'food-production:read')).toBeNull();
    expect(rejectApiKey(session)).toBeNull();
    expect(requireRole(session, ['ADMIN'])).toBeNull();

    // Defense-in-depth: scope helper rejects keys unless allowApiKey.
    expect(resolveOperationalScope(keyedOk).denied?.status).toBe(403);
    expect(resolveOperationalScope(keyedOk, { allowApiKey: true }).denied).toBeNull();
  });

  it('dispatchRoute sandboxes API keys to fp-public only', async () => {
    expect(apiKeyRouteDenied(true, '/kitchens')).toBe(true);
    expect(apiKeyRouteDenied(true, '/api-keys')).toBe(true);
    expect(apiKeyRouteDenied(true, '/fp-public/plans')).toBe(false);
    expect(apiKeyRouteDenied(true, '/fp-public')).toBe(false);
    expect(apiKeyRouteDenied(false, '/kitchens')).toBe(false);

    const keyed: AuthContext = {
      userId: 'apikey:1',
      email: 'i@api',
      name: 'API',
      role: 'INTEGRATION',
      tenantId: 't1',
      isMaster: false,
      isApiKey: true,
      scopes: ['food-production:read'],
    };
    const blocked = await dispatchRoute({
      request: new Request('http://x/api/kitchens'),
      db: {} as HandlerContext['db'],
      method: 'GET',
      url: new URL('http://x/api/kitchens'),
      path: ['kitchens'],
      body: null,
      auth: keyed,
      route: '/kitchens',
    });
    expect(blocked?.status).toBe(403);
  });
});
