import { describe, expect, it } from 'vitest';
import {
  consumeReservationPool,
  reservationBlockedMessage,
  reservationBlockedQty,
  reservationReasonOk,
  type ReservationPool,
} from '@/lib/stock-ledger/plan-reservation';

describe('cadangan stok rencana', () => {
  const pool = (): ReservationPool => ({
    totalReleased: 8,
    byPlan: new Map([['plan-a', 5], ['plan-b', 3]]),
  });

  it('rencana pemilik hanya terhalang cadangan rencana lain', () => {
    expect(reservationBlockedQty(pool(), { planId: 'plan-a' })).toBe(3);
    expect(reservationBlockedQty(pool(), { planId: 'plan-b' })).toBe(5);
    expect(reservationBlockedQty(pool(), {})).toBe(8);
    expect(reservationBlockedQty(pool(), { override: true })).toBe(0);
  });

  it('alasan override minimal 3 karakter', () => {
    expect(reservationReasonOk('ok')).toBe(false);
    expect(reservationReasonOk('  ya ')).toBe(false);
    expect(reservationReasonOk('porsi tamu')).toBe(true);
  });

  it('pesan memuat sisa tersedia dan qty terkunci', () => {
    const msg = reservationBlockedMessage({
      label: 'Beras', lokasiKode: 'GKERING', need: 6, usable: 2, blocked: 4, satuan: 'KG',
    });
    expect(msg).toContain('tersedia 2 KG');
    expect(msg).toContain('4 KG dikunci');
    expect(msg).toContain('alasan ambil cadangan');
  });

  it('pemakaian mengurangi pool pemilik lebih dulu', () => {
    const p = pool();
    consumeReservationPool(p, 6, 'plan-a');
    expect(p.totalReleased).toBe(2);
    expect(p.byPlan.get('plan-a')).toBe(0);
    expect(p.byPlan.get('plan-b')).toBe(2);
  });
});
