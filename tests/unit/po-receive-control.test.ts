import { describe, expect, it } from 'vitest';
import {
  poOverReceiveApprover,
  poOverReceiveMessage,
  poReceiveAllowedQty,
  poReceiveSameUnit,
  poLineRemaining,
  normalizePoOverReceiveTolerancePct,
} from '@/lib/api/po-receive-control';

describe('kontrol lebih terima PO', () => {
  it('toleransi 0 menolak sisa berlebih', () => {
    expect(poLineRemaining({ qty: 10, qtyReceived: 4 })).toBe(6);
    expect(poReceiveAllowedQty(6, 0)).toBe(6);
    expect(poReceiveAllowedQty(6, 10)).toBe(6.6);
  });

  it('satuan berbeda tidak dianggap sama', () => {
    expect(poReceiveSameUnit({ satuan: 'DUS', uomId: 'u1' }, { satuan: 'DUS', uomId: 'u1' })).toBe(true);
    expect(poReceiveSameUnit({ satuan: 'DUS' }, { satuan: 'KG' })).toBe(false);
  });

  it('penolakan tidak mengurangi sisa', () => {
    expect(poLineRemaining({ qty: 10, qtyReceived: 7 })).toBe(3);
  });

  it('alasan saja tidak cukup tanpa peran penyetuju', () => {
    expect(poOverReceiveApprover('GUDANG')).toBe(false);
    expect(poOverReceiveApprover('SUPERVISOR')).toBe(true);
    expect(poOverReceiveApprover('OWNER')).toBe(true);
  });

  it('nilai di luar 0–100 ditolak', () => {
    expect(normalizePoOverReceiveTolerancePct('2,5')).toBe(2.5);
    expect(normalizePoOverReceiveTolerancePct(101)).toBeNull();
    expect(normalizePoOverReceiveTolerancePct(-1)).toBeNull();
  });

  it('pesan menyebut sisa dan batas', () => {
    const msg = poOverReceiveMessage({
      label: 'Beras', incoming: 8, allowed: 6, remaining: 6, tolerancePct: 0,
    });
    expect(msg).toContain('sisa PO 6');
    expect(msg).toContain('Supervisor');
  });
});
