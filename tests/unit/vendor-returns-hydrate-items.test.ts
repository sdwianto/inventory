import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/uom/resolve-line-qty', () => ({
  resolveLineQtyBase: async () => ({
    qty: 1,
    qtyBase: 1,
    uomId: 'u-local',
    satuan: 'PCS',
    factorToBase: 1,
  }),
}));

import { hydrateDraftItems } from '@/lib/api/handlers/vendor-returns';

const baseLine = {
  lineId: 'inv:l1',
  invoiceLineId: 'l1',
  localStokId: 'p1',
  localKode: 'B1',
  localNama: 'Beras',
  satuan: 'PCS',
  uomId: 'u-local',
  qty: 1,
  qtyBase: 1,
  harga: 1000,
  jumlah: 1000,
  gudangKode: 'GKERING',
  maxQty: 1,
};

describe('hydrateDraftItems — ADR-006 per-line reason (regression)', () => {
  it('menyimpan reason baru yang dikirim client', async () => {
    const result = await hydrateDraftItems({} as never, 'sppg', [
      { ...baseLine, reason: 'Barang penyok' },
    ], [baseLine]);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result[0].reason).toBe('Barang penyok');
    }
  });

  it('mempertahankan reason lama kalau client tidak mengirim field reason sama sekali', async () => {
    const prevWithReason = { ...baseLine, reason: 'Alasan sebelumnya' };
    const { reason: _omit, ...rowWithoutReason } = prevWithReason;
    void _omit;
    const result = await hydrateDraftItems({} as never, 'sppg', [rowWithoutReason], [prevWithReason]);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result[0].reason).toBe('Alasan sebelumnya');
    }
  });

  it('mengosongkan reason jadi null kalau client mengirim string kosong (dikosongkan sengaja)', async () => {
    const prevWithReason = { ...baseLine, reason: 'Alasan lama' };
    const result = await hydrateDraftItems({} as never, 'sppg', [
      { ...baseLine, reason: '' },
    ], [prevWithReason]);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result[0].reason).toBeNull();
    }
  });

  it('reason tetap null/undefined kalau tidak pernah diisi sama sekali', async () => {
    const result = await hydrateDraftItems({} as never, 'sppg', [baseLine], [baseLine]);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result[0].reason ?? null).toBeNull();
    }
  });
});
