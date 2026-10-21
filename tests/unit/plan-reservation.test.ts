import { describe, expect, it } from 'vitest';
import {
  consumeReservationPool,
  isPlanCookDayPast,
  isReservationPlanBlocking,
  reservationBlockedMessage,
  reservationBlockedQty,
  reservationReasonOk,
  type ReservationPool,
} from '@/lib/stock-ledger/plan-reservation';

describe('cadangan stok rencana', () => {
  const pool = (): ReservationPool => ({
    totalReleased: 8,
    byPlan: new Map([['plan-a', 5], ['plan-b', 3]]),
    planNoById: new Map([['plan-a', 'RPN-A'], ['plan-b', 'RPN-B']]),
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

  it('pesan memuat sisa tersedia, qty terkunci, dan nomor RPN', () => {
    const msg = reservationBlockedMessage({
      label: 'Beras',
      lokasiKode: 'GKERING',
      need: 6,
      usable: 2,
      blocked: 4,
      satuan: 'KG',
      blockingPlanNos: ['RPN2610000031'],
    });
    expect(msg).toContain('bebas 2 KG');
    expect(msg).toContain('4 KG terkunci di RPN2610000031');
    expect(msg).toContain('alasan ambil cadangan');
  });

  it('pemakaian mengurangi pool pemilik lebih dulu', () => {
    const p = pool();
    consumeReservationPool(p, 6, 'plan-a');
    expect(p.totalReleased).toBe(2);
    expect(p.byPlan.get('plan-a')).toBe(0);
    expect(p.byPlan.get('plan-b')).toBe(2);
  });

  it('cadangan RPN tidak mengunci setelah hari masak lewat', () => {
    // 2026-10-21 00:30 WIB = 2026-10-20 17:30 UTC
    const afterCookDay = new Date('2026-10-20T17:30:00.000Z');
    expect(isPlanCookDayPast('2026-10-20', afterCookDay)).toBe(true);
    expect(isReservationPlanBlocking('2026-10-20', afterCookDay)).toBe(false);

    const duringCookDay = new Date('2026-10-20T10:00:00.000+07:00');
    expect(isPlanCookDayPast('2026-10-20', duringCookDay)).toBe(false);
    expect(isReservationPlanBlocking('2026-10-20', duringCookDay)).toBe(true);

    expect(isReservationPlanBlocking('', afterCookDay)).toBe(true);
  });
});
