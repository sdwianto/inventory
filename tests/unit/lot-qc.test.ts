import { describe, expect, it } from 'vitest';
import {
  lotInspectionSodError,
  lotQcBlockedMessage,
  validateLotInspection,
} from '@/lib/stock-ledger/lot-qc';
import { effectiveLotQcStatus, isLotQcHeld } from '@/lib/food-production/ingredient-lot';

const lot = (extra: Record<string, unknown> = {}) => ({
  qcStatus: 'QUARANTINE' as const, status: 'ACTIVE' as const, qty: 5, qtyRemaining: 5,
  warehouseKode: 'GKERING', productNama: 'Beras', productKode: 'BRS', satuan: 'KG',
  ...extra,
}) as never;

describe('status QC lot', () => {
  it('lot lama tanpa qcStatus dianggap lolos', () => {
    expect(effectiveLotQcStatus({})).toBe('RELEASED');
    expect(isLotQcHeld({ qcStatus: 'QUARANTINE' })).toBe(true);
    expect(isLotQcHeld({ qcStatus: 'REJECTED' })).toBe(true);
    expect(isLotQcHeld({ qcStatus: 'RELEASED' })).toBe(false);
  });
});

describe('validateLotInspection', () => {
  it('lolos penuh valid; hasil dinormalisasi', () => {
    expect(validateLotInspection(lot(), { qtyPassed: 5, qtyFailed: 0, kondisi: 'BAIK' })).toMatchObject({
      qtyPassed: 5, qtyFailed: 0, suhuC: null, kondisi: 'BAIK',
    });
  });

  it('lot bukan karantina → 409', () => {
    expect(validateLotInspection(lot({ qcStatus: 'RELEASED' }), { qtyPassed: 5, qtyFailed: 0, kondisi: 'BAIK' }))
      .toMatchObject({ status: 409 });
  });

  it('jumlah lolos + gagal harus sama dengan sisa lot', () => {
    expect(validateLotInspection(lot(), { qtyPassed: 3, qtyFailed: 1, kondisi: 'BAIK' })).toHaveProperty('error');
    expect(validateLotInspection(lot(), { qtyPassed: -1, qtyFailed: 6, kondisi: 'LAINNYA', alasanTolak: 'x' })).toHaveProperty('error');
  });

  it('gagal > 0 wajib alasan & kondisi bukan BAIK', () => {
    expect(validateLotInspection(lot(), { qtyPassed: 3, qtyFailed: 2, kondisi: 'BUSUK_BERJAMUR' })).toHaveProperty('error');
    expect(validateLotInspection(lot(), { qtyPassed: 3, qtyFailed: 2, kondisi: 'BAIK', alasanTolak: 'busuk' })).toHaveProperty('error');
    expect(validateLotInspection(lot(), { qtyPassed: 3, qtyFailed: 2, kondisi: 'BUSUK_BERJAMUR', alasanTolak: 'busuk' }))
      .toMatchObject({ qtyPassed: 3, qtyFailed: 2 });
  });

  it('kondisi di luar daftar ditolak', () => {
    expect(validateLotInspection(lot(), { qtyPassed: 5, qtyFailed: 0, kondisi: 'MANTAP' })).toHaveProperty('error');
  });

  it('suhu wajib untuk gudang basah; rentang -30..60 untuk semua gudang', () => {
    const wet = lot({ warehouseKode: 'GBASAH' });
    expect(validateLotInspection(wet, { qtyPassed: 5, qtyFailed: 0, kondisi: 'BAIK' })).toHaveProperty('error');
    expect(validateLotInspection(wet, { qtyPassed: 5, qtyFailed: 0, kondisi: 'BAIK', suhuC: '' })).toHaveProperty('error');
    expect(validateLotInspection(wet, { qtyPassed: 5, qtyFailed: 0, kondisi: 'BAIK', suhuC: 4 })).toMatchObject({ suhuC: 4 });
    expect(validateLotInspection(lot(), { qtyPassed: 5, qtyFailed: 0, kondisi: 'BAIK', suhuC: 61 })).toHaveProperty('error');
    expect(validateLotInspection(lot(), { qtyPassed: 5, qtyFailed: 0, kondisi: 'BAIK' })).toMatchObject({ suhuC: null });
  });

  it('lot tanpa sisa tidak bisa diperiksa', () => {
    expect(validateLotInspection(lot({ qtyRemaining: 0 }), { qtyPassed: 0, qtyFailed: 0, kondisi: 'BAIK' })).toHaveProperty('error');
  });
});

describe('lotInspectionSodError', () => {
  it('penerima tidak boleh memeriksa sendiri kecuali ADMIN/MASTER', () => {
    expect(lotInspectionSodError({ userId: 'u1', role: 'SUPERVISOR' }, 'u1')).toMatch(/penerima/);
    expect(lotInspectionSodError({ userId: 'u2', role: 'SUPERVISOR' }, 'u1')).toBeNull();
    expect(lotInspectionSodError({ userId: 'u1', role: 'ADMIN' }, 'u1')).toBeNull();
    expect(lotInspectionSodError({ userId: 'u1', role: 'MASTER', isMaster: true }, 'u1')).toBeNull();
    expect(lotInspectionSodError({ userId: 'u1', role: 'SUPERVISOR' }, undefined)).toBeNull();
  });
});

describe('lotQcBlockedMessage', () => {
  it('menjelaskan stok tersedia, qty tertahan, dan jalan keluarnya', () => {
    const msg = lotQcBlockedMessage({
      label: 'Beras', lokasiKode: 'GKERING', need: 4, releasedAvailable: 1,
      held: { quarantine: 3, rejected: 2 }, satuan: 'KG',
    });
    expect(msg).toMatch(/Beras/);
    expect(msg).toMatch(/karantina QC/);
    expect(msg).toMatch(/ditolak QC/);
    expect(msg).toMatch(/Selesaikan pemeriksaan di menu QC Penerimaan/);
  });
});
