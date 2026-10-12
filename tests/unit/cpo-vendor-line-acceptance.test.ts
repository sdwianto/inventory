import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VENDOR_LINE_POLICY,
  evaluateVendorLineAutoAccept,
  isVendorLinePendingDecision,
  normalizeVendorLineAutoAccept,
  normalizeVendorLineAutoAcceptMaxValue,
  normalizeVendorLineAutoAcceptPct,
  poApprovedBaseValue,
  vendorLineAcceptanceStatus,
  vendorLinePolicyFromSettings,
} from '@/lib/api/cpo-vendor-line-acceptance';
import { isVendorSoCommitted } from '@/lib/api/cpo-extra-so-lines';
import { rollupPartialCancelStatus } from '@/lib/api/cpo-line-cancel-sync';
import { matchInvoiceLinesAgainstGrn } from '@/lib/api/three-way-match';
import type { JsonObject } from '@/types/json';

const base: JsonObject[] = [
  { lineId: 'a', kode: 'A', satuan: 'PCS', qty: 10, estimasiHarga: 10_000 },
  { lineId: 'b', kode: 'B', satuan: 'KG', qty: 2, estimasiJumlah: 100_000, estimasiHarga: 1 },
];
const extra = (over: JsonObject = {}): JsonObject => ({
  lineId: 'x', kode: 'GRM', satuan: 'PCS', qty: 5, estimasiHarga: 2250, localStokId: 'p-garam',
  addedFromVendorSo: true, vendorLineAcceptance: { status: 'PENDING' }, ...over,
});
const evaluate = (line: JsonObject, opts: Partial<Parameters<typeof evaluateVendorLineAutoAccept>[0]> = {}) => evaluateVendorLineAutoAccept({
  line,
  items: [...base, line],
  policy: DEFAULT_VENDOR_LINE_POLICY,
  priceTolerancePct: 2,
  ...opts,
});

describe('kebijakan auto-terima barang tambahan vendor', () => {
  it('nilai PO awal hanya baris asli (estimasiJumlah diutamakan, qtyOriginal untuk baris batal)', () => {
    expect(poApprovedBaseValue([...base, extra()])).toBe(200_000);
    expect(poApprovedBaseValue([{ qty: 0, qtyOriginal: 4, estimasiHarga: 500, cancelled: true }])).toBe(2000);
  });

  it('dalam toleransi: min(5% nilai PO, batas nominal)', () => {
    // 5% × 200.000 = 10.000 < 11.250
    expect(evaluate(extra())).toMatchObject({ accept: false, reason: expect.stringContaining('melebihi batas auto-terima') });
    expect(evaluate(extra({ qty: 4 }))).toMatchObject({ accept: true, mode: 'AUTO_TOLERANCE', rule: { value: 9000, limit: 10_000 } });
    const capped = evaluate(extra({ qty: 4 }), { policy: { ...DEFAULT_VENDOR_LINE_POLICY, maxIncreaseValue: 5000 } });
    expect(capped).toMatchObject({ accept: false });
  });

  it('kuota toleransi dipakai bersama oleh tambahan lain yang sudah diterima otomatis', () => {
    const prior = extra({ lineId: 'y', qty: 2, vendorLineAcceptance: { status: 'ACCEPTED', mode: 'AUTO_TOLERANCE' } });
    const manual = extra({ lineId: 'z', qty: 100, vendorLineAcceptance: { status: 'ACCEPTED', mode: 'MANUAL' } });
    const line = extra({ qty: 3 });
    // 4.500 (y) + 6.750 = 11.250 > 10.000; baris diterima manual tidak memakai kuota.
    expect(evaluateVendorLineAutoAccept({
      line, items: [...base, prior, manual, line], policy: DEFAULT_VENDOR_LINE_POLICY, priceTolerancePct: 2,
    })).toMatchObject({ accept: false, reason: expect.stringContaining('sudah diterima otomatis') });
  });

  it('pindahan PO: satuan sama, qty dan harga tidak naik (dengan toleransi harga 3-way)', () => {
    const src = { noPO: 'CPO-77', lineId: 'p77', satuan: 'PCS', qty: 5, estimasiHarga: 2210 };
    expect(evaluate(extra(), { relocationSource: src })).toMatchObject({
      accept: true, mode: 'AUTO_RELOCATION', rule: { fromNoPO: 'CPO-77', fromQty: 5, fromPrice: 2210 },
    });
    expect(evaluate(extra({ qty: 6 }), { relocationSource: src })).toMatchObject({ accept: false, reason: expect.stringContaining('melebihi qty asal') });
    expect(evaluate(extra(), { relocationSource: { ...src, estimasiHarga: 2000 } })).toMatchObject({ accept: false, reason: expect.stringContaining('di atas harga asal') });
    expect(evaluate(extra(), { relocationSource: { ...src, satuan: 'BOX' } })).toMatchObject({ accept: false, reason: expect.stringContaining('Satuan berbeda') });
  });

  it('pindahan yang gagal masih bisa lolos lewat toleransi', () => {
    const src = { noPO: 'CPO-77', lineId: 'p77', satuan: 'PCS', qty: 2, estimasiHarga: 2250 };
    expect(evaluate(extra({ qty: 4 }), { relocationSource: src })).toMatchObject({ accept: true, mode: 'AUTO_TOLERANCE' });
  });

  it('tidak pernah auto-terima: kebijakan mati, produk belum terpetakan, harga kosong', () => {
    expect(evaluate(extra({ qty: 1 }), { policy: { ...DEFAULT_VENDOR_LINE_POLICY, autoAccept: false } }))
      .toEqual({ accept: false, reason: 'Auto-terima dinonaktifkan untuk tenant ini' });
    expect(evaluate(extra({ qty: 1, needsMapping: true }))).toMatchObject({ accept: false, reason: expect.stringContaining('belum terpetakan') });
    expect(evaluate(extra({ qty: 1, localStokId: '' }))).toMatchObject({ accept: false });
    expect(evaluate(extra({ qty: 1, estimasiHarga: 0 }))).toMatchObject({ accept: false, reason: expect.stringContaining('Harga vendor') });
    const line = extra({ qty: 1 });
    expect(evaluateVendorLineAutoAccept({
      line, items: [{ lineId: 'a', qty: 10 }, line], policy: DEFAULT_VENDOR_LINE_POLICY, priceTolerancePct: 2,
    })).toMatchObject({ accept: false, reason: expect.stringContaining('Nilai PO awal belum diketahui') });
    expect(evaluate(extra({ qty: 0 }))).toMatchObject({ accept: false });
  });

  it('status baris: baris lama tanpa status dianggap menunggu; baris PO asli tidak punya status', () => {
    expect(vendorLineAcceptanceStatus({ kode: 'A' })).toBeNull();
    expect(vendorLineAcceptanceStatus({ addedFromVendorSo: true })).toBe('PENDING');
    expect(isVendorLinePendingDecision({ addedFromVendorSo: true })).toBe(true);
    expect(isVendorLinePendingDecision({ addedFromVendorSo: true, cancelled: true })).toBe(false);
    expect(isVendorLinePendingDecision(extra({ vendorLineAcceptance: { status: 'ACCEPTED' } }))).toBe(false);
  });

  it('normalisasi setelan: kosong → null (pakai default), tidak valid → undefined (ditolak)', () => {
    expect(normalizeVendorLineAutoAccept('')).toBeNull();
    expect(normalizeVendorLineAutoAccept('false')).toBe(false);
    expect(normalizeVendorLineAutoAccept('ya')).toBeUndefined();
    expect(normalizeVendorLineAutoAcceptPct('2,5')).toBe(2.5);
    expect(normalizeVendorLineAutoAcceptPct(25)).toBeUndefined();
    expect(normalizeVendorLineAutoAcceptPct(-1)).toBeUndefined();
    expect(normalizeVendorLineAutoAcceptMaxValue('1.000.000')).toBe(1_000_000);
    expect(normalizeVendorLineAutoAcceptMaxValue('abc')).toBeUndefined();
    expect(vendorLinePolicyFromSettings(null)).toEqual(DEFAULT_VENDOR_LINE_POLICY);
    expect(vendorLinePolicyFromSettings({ vendorLineAutoAccept: false, vendorLineAutoAcceptPct: 'x' }))
      .toEqual({ ...DEFAULT_VENDOR_LINE_POLICY, autoAccept: false });
  });
});

describe('isVendorSoCommitted', () => {
  it('tambahan vendor yang ditolak purchasing tidak membuat PO "batal sebagian"', () => {
    const own = { lineId: 'a', qty: 2 };
    const rejected = { lineId: 'x', addedFromVendorSo: true, cancelled: true, cancelledSource: 'purchasing_rejected' };
    expect(rollupPartialCancelStatus([own, rejected], 'CONFIRMED')).toBe('CONFIRMED');
    expect(rollupPartialCancelStatus([own, { lineId: 'b', cancelled: true }, rejected], 'CONFIRMED')).toBe('PARTIAL_CANCELLED');
  });

  it('hanya SO terkonfirmasi yang boleh menambah baris PO', () => {
    expect(isVendorSoCommitted('sales_order.confirmed', 'DRAFT')).toBe(true);
    expect(isVendorSoCommitted('sales_order.updated', 'DRAFT')).toBe(false);
    expect(isVendorSoCommitted('sales_order.updated', '')).toBe(false);
    expect(isVendorSoCommitted('sales_order.updated', undefined)).toBe(false);
    expect(isVendorSoCommitted(null, 'cancelled')).toBe(false);
    expect(isVendorSoCommitted(null, 'CONFIRMED')).toBe(true);
    expect(isVendorSoCommitted(null, 'PARTIAL')).toBe(true);
  });
});

describe('3-way match baris tambahan vendor yang ditahan', () => {
  const grns = [{ items: [{ vendorKode: 'A', qtyReceived: 1, harga: 10_000 }, { vendorKode: 'GRM', qtyReceived: 5, harga: 2250 }] }];
  const payload = { noDO: 'DO-1', total: 21_250, items: [{ kode: 'A', qty: 1 }, { kode: 'GRM', qty: 5, satuan: 'PCS' }] };
  const poLines = [{ kode: 'A', qty: 1 }];

  it('menunggu persetujuan → PO_LINE_PENDING_ACCEPTANCE; ditolak → PO_LINE_REJECTED', () => {
    expect(matchInvoiceLinesAgainstGrn(grns, payload, { poLines, poHeldLines: [{ kode: 'GRM', qty: 5, satuan: 'PCS', held: 'PENDING' }] }))
      .toMatchObject({ ok: false, code: 'PO_LINE_PENDING_ACCEPTANCE' });
    expect(matchInvoiceLinesAgainstGrn(grns, payload, { poLines, poHeldLines: [{ kode: 'GRM', qty: 5, satuan: 'PCS', held: 'REJECTED' }] }))
      .toMatchObject({ ok: false, code: 'PO_LINE_REJECTED' });
  });

  it('setelah diterima (masuk poLines) → cocok', () => {
    expect(matchInvoiceLinesAgainstGrn(grns, payload, { poLines: [...poLines, { kode: 'GRM', qty: 5, satuan: 'PCS' }] }))
      .toMatchObject({ ok: true });
  });
});
