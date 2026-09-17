import { describe, it, expect } from 'vitest';
import { resolveVendorUomId, vendorBaseUomIdIfCompatible } from '@/lib/api/customer-po-vendor';
import type { ProductUom } from '@/lib/uom/types';

const uoms = [
  {
    id: 'local-ons',
    tenantId: 'sppg',
    productId: 'p1',
    satuan: 'ONS',
    factorToBase: 1,
    vendorUomId: 'sales-ons',
    isBase: true,
    hargaEcer: 0,
    hargaGrosir: 0,
    hargaSpesial: 0,
    barcode: '',
    sortOrder: 0,
    aktif: true,
  },
  {
    id: 'local-kg',
    tenantId: 'sppg',
    productId: 'p1',
    satuan: 'KG',
    factorToBase: 10,
    vendorUomId: 'sales-kg',
    isBase: false,
    hargaEcer: 0,
    hargaGrosir: 0,
    hargaSpesial: 0,
    barcode: '',
    sortOrder: 1,
    aktif: true,
  },
] as ProductUom[];

const prod = {
  id: 'p1',
  satuan: 'ONS',
  vendorStokId: 'vp1',
  vendorBaseUomId: 'sales-ons',
  syncSource: 'sales.app',
};

describe('resolveVendorUomId satuan guard', () => {
  it('rebinds KG line away from stamped ONS vendorUomId', () => {
    const kg = uoms.find((u) => u.satuan === 'KG')!;
    const id = resolveVendorUomId(prod, kg, uoms, 'KG', 'sales-ons');
    expect(id).toBe('sales-kg');
  });

  it('keeps matching line vendorUomId when satuan cocok', () => {
    const kg = uoms.find((u) => u.satuan === 'KG')!;
    const id = resolveVendorUomId(prod, kg, uoms, 'KG', 'sales-kg');
    expect(id).toBe('sales-kg');
  });

  it('vendorBaseUomIdIfCompatible rejects ONS base for KG want', () => {
    expect(vendorBaseUomIdIfCompatible(prod, 'KG', false)).toBe('');
    expect(vendorBaseUomIdIfCompatible(prod, 'ONS', true)).toBe('sales-ons');
  });

  it('OPEN_CPO_STATUSES includes SUBMITTED (post-push), not SENT', async () => {
    const { OPEN_CPO_STATUSES_FOR_UOM_REMATCH } = await import('@/lib/api/rematch-open-po-uoms');
    expect(OPEN_CPO_STATUSES_FOR_UOM_REMATCH).toContain('SUBMITTED');
    expect(OPEN_CPO_STATUSES_FOR_UOM_REMATCH).toContain('PARTIAL_CANCELLED');
    expect(OPEN_CPO_STATUSES_FOR_UOM_REMATCH).not.toContain('SENT');
  });

  it('applyEnrichedBindingsToPoItems writes vendorUomId + local uomId', async () => {
    const { applyEnrichedBindingsToPoItems } = await import('@/lib/api/customer-po-vendor');
    const next = applyEnrichedBindingsToPoItems(
      [{ localStokId: 'p1', satuan: 'KG', uomId: 'stale', vendorUomId: 'sales-ons', qty: 1 }],
      [{ satuan: 'KG', uomId: 'sales-kg', localUomId: 'local-kg' }],
    );
    expect(next[0]).toMatchObject({
      satuan: 'KG',
      vendorUomId: 'sales-kg',
      uomId: 'local-kg',
      qty: 1,
    });
  });
});
